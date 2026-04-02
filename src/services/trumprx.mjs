import { normalizeSectionText } from "./question-extractor.mjs";
import { findTrumpRxPdfLinkWithAgentBrowser, loadTrumpRxQaWithAgentBrowser } from "./trumprx-agent-browser.mjs";

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function findTrumpRxProduct({ drugName, aliases, browser, trumpRxBaseUrl }) {
  const candidates = [drugName, ...(aliases[drugName] || [])]
    .map(slugify)
    .filter(Boolean);

  for (const candidate of candidates) {
    const url = `${trumpRxBaseUrl}/${candidate}`;

    try {
      const page = await browser.loadWebPageText(url);
      if (page.text && page.text.trim()) {
        const medGuideUrl = extractTrumpRxMedicationGuideUrl(page.rawText || page.text);
        return {
          found: true,
          url,
          aliasUsed: candidate,
          medGuideUrl,
          retrievalSteps: [
            {
              step: "construct-url",
              status: "success",
              detail: url
            },
            {
              step: "fetch-page",
              status: "success",
              detail: "Fetched TrumpRX product page HTML."
            },
            {
              step: "detect-details-section",
              status: page.text.includes("Medication Guide")
                ? "success"
                : "warning",
              detail: page.text.includes("Medication Guide")
                ? "Medication Guide details section detected."
                : "Medication Guide details section not detected in page HTML."
            },
            {
              step: "detect-medguide-link",
              status: medGuideUrl ? "success" : "warning",
              detail: medGuideUrl || "No TrumpRX medication-guide PDF link detected."
            },
            {
              step: "expand-data-state-sections",
              status: "pending_browser_interaction",
              detail: "TrumpRX Q&A appears to require hydrated browser interaction and expanding data-state sections."
            }
          ]
        };
      }
    } catch {
      continue;
    }
  }

  return {
    found: false,
    url: null,
    aliasUsed: null,
    medGuideUrl: null,
    retrievalSteps: [
      {
        step: "construct-url",
        status: "failed",
        detail: "No candidate TrumpRX product URL returned a usable page."
      }
    ]
  };
}

export async function loadTrumpRxQa({ drugName, trumpRxUrl, browser, qaExtractor, trumpRxParseMode }) {
  if (trumpRxParseMode === "agent-browser") {
    return loadTrumpRxQaWithAgentBrowser({ drugName, trumpRxUrl });
  }

  const page = await browser.loadWebPageText(trumpRxUrl);
  let medGuideUrl = extractTrumpRxMedicationGuideUrl(page.rawText || page.text);
  const fallbackQuestionPatterns = {
    knownQuestionStarts: [
      "What",
      "How",
      "Do not",
      "Before",
      "General information"
    ],
    questionRegexes: [
      "^(What .+\\?)$",
      "^(How .+\\?)$",
      "^(Do not .+?:?)$",
      "^(Before .+?:?)$",
      "^(General information .+)$"
    ]
  };

  if (medGuideUrl) {
    const pdfDocument = await browser.loadCatalogEntry({
      drugName: `${drugName}-trumprx-pdf`,
      catalogEntry: {
        url: medGuideUrl,
        contentType: "pdf",
        attributionType: "medguide"
      }
    });

    return qaExtractor.extract({
      drugName: `${drugName}-trumprx`,
      documentUrl: medGuideUrl,
      text: normalizeSectionText(pdfDocument.text),
      questionPatterns: fallbackQuestionPatterns
    });
  }

  const normalizedText = normalizeSectionText(page.text);

  return qaExtractor.extract({
    drugName: `${drugName}-trumprx`,
    documentUrl: trumpRxUrl,
    text: normalizedText,
    questionPatterns: fallbackQuestionPatterns
  });
}

function extractTrumpRxMedicationGuideUrl(text) {
  const allPdfUrls = Array.from(text.matchAll(/https:\/\/[^\s"'<>]+\.pdf/gi)).map((match) => match[0]);
  const prioritized = allPdfUrls.find((url) => /mg|medguide|medication-guide|pi\.lilly\.com/i.test(url));
  return prioritized || allPdfUrls[0] || null;
}
