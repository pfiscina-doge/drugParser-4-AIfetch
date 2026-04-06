import { normalizeSectionText } from "./question-extractor.mjs";
import { findTrumpRxPdfLinkWithAgentBrowser } from "./trumprx-agent-browser.mjs";

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function stripHtmlTags(text) {
  return String(text || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function toAbsoluteUrl(href, baseUrl) {
  try {
    return new URL(String(href || "").trim(), baseUrl).href;
  } catch {
    return "";
  }
}

function extractPdfUrls(text, baseUrl) {
  const matches = Array.from(String(text || "").matchAll(/https?:\/\/[^\s"'<>]+\.pdf(?:\?[^\s"'<>]*)?/gi));
  return Array.from(new Set(matches.map((match) => toAbsoluteUrl(match[0], baseUrl)).filter(Boolean)));
}

function extractPatientInfoPdfUrlFromHtml(html, baseUrl) {
  const anchorRegex = /<a\b[^>]*href=("([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/a>/gi;
  let bestPatientInfo = "";
  let bestMedicationGuide = "";
  let anyPdf = "";

  for (const match of html.matchAll(anchorRegex)) {
    const href = match[2] || match[3] || "";
    const absoluteHref = toAbsoluteUrl(href, baseUrl);
    if (!/\.pdf(?:\?|$)/i.test(absoluteHref)) {
      continue;
    }

    const linkText = stripHtmlTags(match[4]);
    if (/view\s+patient\s+information\s*\(pdf\)/i.test(linkText)) {
      return absoluteHref;
    }

    if (!bestPatientInfo && /patient\s+information/i.test(linkText)) {
      bestPatientInfo = absoluteHref;
      continue;
    }

    if (!bestMedicationGuide && /medication\s+guide/i.test(linkText)) {
      bestMedicationGuide = absoluteHref;
      continue;
    }

    if (!anyPdf) {
      anyPdf = absoluteHref;
    }
  }

  return bestPatientInfo || bestMedicationGuide || anyPdf || "";
}

async function findTrumpRxPatientInfoPdfUrl({ browser, trumpRxUrl, page }) {
  if (browser.name === "agent-browser") {
    try {
      const extracted = await findTrumpRxPdfLinkWithAgentBrowser({ trumpRxUrl });
      const preferredHref = toAbsoluteUrl(extracted?.pdfLink || "", trumpRxUrl);
      if (preferredHref) {
        return preferredHref;
      }
    } catch {
      // Fall back to text and html inspection below.
    }
  }

  const htmlCandidate = extractPatientInfoPdfUrlFromHtml(page.rawHtml || page.rawText || "", trumpRxUrl);
  if (htmlCandidate) {
    return htmlCandidate;
  }

  const textCandidates = extractPdfUrls([page.rawHtml || "", page.rawText || "", page.text || ""].join("\n"), trumpRxUrl);
  const prioritizedTextMatch = textCandidates.find((url) => /patient|medication|medguide|pi\.lilly\.com/i.test(url));
  if (prioritizedTextMatch) {
    return prioritizedTextMatch;
  }

  return textCandidates[0] || "";
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
        const medGuideUrl = await findTrumpRxPatientInfoPdfUrl({
          browser,
          trumpRxUrl: url,
          page
        });

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
              detail: "Fetched TrumpRX product page."
            },
            {
              step: "find-patient-information-pdf",
              status: medGuideUrl ? "success" : "warning",
              detail: medGuideUrl || "No TrumpRX patient information PDF link detected."
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

export async function loadTrumpRxQa({
  drugName,
  trumpRxUrl,
  browser,
  qaExtractor,
  questionPatterns
}) {
  const page = await browser.loadWebPageText(trumpRxUrl);
  const patientInfoPdfUrl = await findTrumpRxPatientInfoPdfUrl({
    browser,
    trumpRxUrl,
    page
  });

  if (!patientInfoPdfUrl) {
    return [];
  }

  const pdfDocument = await browser.loadCatalogEntry({
    drugName: `${drugName}-trumprx-pdf`,
    catalogEntry: {
      url: patientInfoPdfUrl,
      contentType: /\.pdf(\?|$)/i.test(patientInfoPdfUrl) ? "pdf" : "html",
      attributionType: "patient-info"
    }
  });

  return qaExtractor.extract({
    drugName: `${drugName}-trumprx`,
    documentUrl: patientInfoPdfUrl,
    text: normalizeSectionText(pdfDocument.text),
    questionPatterns,
    attributionType: "patient-info"
  });
}
