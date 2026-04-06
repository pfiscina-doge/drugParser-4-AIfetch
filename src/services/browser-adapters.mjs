import { mkdtemp, readFile, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REQUEST_TIMEOUT_MS = 45000;

function summarizeError(error) {
  if (!error) {
    return "unknown error";
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function extractSnapshotLineText(line) {
  const text = String(line || "").trim();
  if (!text) {
    return "";
  }

  const quoted = text.match(/^[\s\-]*[a-z]+\s+"([\s\S]+?)"\s*(?:\[[^\]]+\])?$/i);
  if (quoted) {
    return quoted[1].replace(/\"/g, '"').trim();
  }

  return text.replace(/^[\s\-]+/, "").trim();
}

function normalizeAgentBrowserSnapshot(snapshotText) {
  return String(snapshotText || "")
    .split("\n")
    .map(extractSnapshotLineText)
    .filter(Boolean)
    .join("\n");
}

async function loadTextWithAgentBrowser(url) {
  await execFileAsync("agent-browser", ["open", url], {
    maxBuffer: 10 * 1024 * 1024
  });

  const { stdout } = await execFileAsync("agent-browser", ["snapshot", "-i"], {
    maxBuffer: 20 * 1024 * 1024
  });

  const bodyText = normalizeAgentBrowserSnapshot(stdout);
  if (!bodyText.trim()) {
    throw new Error(`No text extracted from agent-browser snapshot for ${url}`);
  }

  return {
    contentType: "text/html",
    bodyText,
    html: ""
  };
}

async function fetchText(url) {
  let fetchError = null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const response = await fetch(url, {
      headers: {
        "user-agent": "agentic-drug-label-load-diff/0.1"
      },
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status}`);
    }

    return {
      contentType: response.headers.get("content-type") || "",
      bodyText: await response.text()
    };
  } catch (error) {
    fetchError = error;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "drug-label-fetch-"));
  const targetPath = path.join(tempDir, "payload");
  let curlError = null;

  try {
    await execFileAsync("curl", ["--http1.1", "--max-time", "45", "-L", "-sS", "-D", "-", "-o", targetPath, url], {
      maxBuffer: 10 * 1024 * 1024
    });

    const bodyText = await readFile(targetPath, "utf8");
    const contentType = url.toLowerCase().endsWith(".pdf") ? "application/pdf" : "text/html";
    return {
      contentType,
      bodyText
    };
  } catch (error) {
    curlError = error;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  try {
    return await loadTextWithAgentBrowser(url);
  } catch (agentError) {
    throw new Error(
      `Failed to fetch ${url}. fetch: ${summarizeError(fetchError)}. curl: ${summarizeError(curlError)}. agent-browser: ${summarizeError(agentError)}`
    );
  }
}

async function extractPdfText(url) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "drug-label-pdf-"));
  const pdfPath = path.join(tempDir, "source.pdf");
  const pythonScript = [
    "import sys",
    "from pypdf import PdfReader",
    "reader = PdfReader(sys.argv[1])",
    "parts = []",
    "for page in reader.pages:",
    "    parts.append(page.extract_text() or '')",
    "print('\\n'.join(parts))"
  ].join("\n");

  try {
    await execFileAsync("curl", ["--http1.1", "--max-time", "45", "-L", "-sS", "-o", pdfPath, url], {
      maxBuffer: 10 * 1024 * 1024
    });

    const { stdout } = await execFileAsync(
      "python3",
      ["-c", pythonScript, pdfPath],
      {
        env: {
          ...process.env,
          PYTHONPATH: path.resolve(process.cwd(), "vendor")
        },
        maxBuffer: 20 * 1024 * 1024
      }
    );

    return stdout;
  } catch (error) {
    try {
      const snapshot = await loadTextWithAgentBrowser(url);
      return snapshot.bodyText;
    } catch (agentError) {
      throw new Error(
        `Failed to extract PDF text from ${url}. curl/python: ${summarizeError(error)}. agent-browser: ${summarizeError(agentError)}`
      );
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function stripMarkup(text) {
  return text
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
}

function detectHeading(text, attributionType) {
  const lowered = text.toLowerCase();
  const hasPatientInfo = lowered.includes("patient information");
  const hasMedicationGuide = lowered.includes("medication guide") || lowered.includes("medical guide");

  if (attributionType === "patient-info" && hasPatientInfo) {
    return "Patient Information";
  }

  if ((attributionType === "medguide" || attributionType === "medlabel") && hasMedicationGuide) {
    return hasMedicationGuide ? "Medication Guide" : null;
  }

  if (hasPatientInfo) {
    return "Patient Information";
  }

  if (hasMedicationGuide) {
    return "Medication Guide";
  }

  return null;
}

function extractAttributedHtmlSection(text, attributionType) {
  const normalized = text.replace(/\r/g, "\n");
  const headingCandidates = attributionType === "patient-info"
    ? ["Patient Information", "Medication Guide", "Medical Guide"]
    : ["Medication Guide", "Medical Guide", "Patient Information"];

  let selectedHeading = null;
  let startIndex = -1;

  for (const heading of headingCandidates) {
    const index = normalized.toLowerCase().indexOf(heading.toLowerCase());
    if (index !== -1) {
      selectedHeading = heading;
      startIndex = index;
      break;
    }
  }

  if (startIndex === -1) {
    return {
      text: normalized,
      headingDetected: null
    };
  }

  const sectionText = normalized.slice(startIndex).trim();
  return {
    text: sectionText,
    headingDetected: selectedHeading === "Medical Guide" ? "Medication Guide" : selectedHeading
  };
}

function createFetchBrowserAdapter() {
  return {
    name: "fetch",

    async loadCatalogEntry({ catalogEntry }) {
      const cleanUrl = String(catalogEntry.url).replace(/^>+|<+$/g, "").trim();
      const payload = await fetchText(cleanUrl);
      const rawText = payload.contentType.includes("pdf")
        ? await extractPdfText(cleanUrl)
        : payload.contentType.includes("html")
          ? stripMarkup(payload.bodyText)
          : payload.bodyText;
      const attributedSection = payload.contentType.includes("html")
        ? extractAttributedHtmlSection(rawText, catalogEntry.attributionType)
        : {
            text: rawText,
            headingDetected: detectHeading(rawText, catalogEntry.attributionType)
          };

      return {
        url: cleanUrl,
        text: attributedSection.text,
        rawText: payload.bodyText,
        headingDetected: attributedSection.headingDetected
      };
    },

    async loadWebPageText(url) {
      const payload = await fetchText(url);
      const text = payload.contentType.includes("pdf")
        ? await extractPdfText(url)
        : payload.contentType.includes("html")
          ? stripMarkup(payload.bodyText)
          : payload.bodyText;

      return {
        url,
        text,
        rawText: payload.bodyText
      };
    }
  };
}

function createAgentBrowserAdapter() {
  return {
    name: "agent-browser",

    async loadCatalogEntry({ catalogEntry }) {
      const cleanUrl = String(catalogEntry.url).replace(/^>+|<+$/g, "").trim();
      const payload = await loadTextWithAgentBrowser(cleanUrl);
      const htmlSnapshot = payload.html || "";
      const textSnapshot = payload.bodyText || "";
      const htmlText = htmlSnapshot ? stripMarkup(htmlSnapshot).replace(/\s+/g, " ").trim() : "";
      const extractedText = textSnapshot || htmlText;
      const attributedSection = payload.contentType.includes("html")
        ? extractAttributedHtmlSection(extractedText, catalogEntry.attributionType)
        : {
            text: extractedText,
            headingDetected: detectHeading(extractedText, catalogEntry.attributionType)
          };

      return {
        url: cleanUrl,
        text: attributedSection.text,
        rawText: textSnapshot,
        rawHtml: htmlSnapshot,
        headingDetected: attributedSection.headingDetected || detectHeading(extractedText, catalogEntry.attributionType)
      };
    },

    async loadWebPageText(url) {
      const payload = await loadTextWithAgentBrowser(url);
      return {
        url,
        text: payload.bodyText,
        rawText: payload.bodyText,
        rawHtml: payload.html || ""
      };
    }
  };
}

export function createBrowserAdapter(config) {
  if (config.newDocParseMethod === "agent-browser") {
    return createAgentBrowserAdapter();
  }

  return createFetchBrowserAdapter();
}
