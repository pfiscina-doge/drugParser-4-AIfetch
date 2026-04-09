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
  const trimmedHref = String(href || "").trim();
  if (!trimmedHref) {
    return "";
  }

  try {
    return new URL(trimmedHref, baseUrl).href;
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

function isTrumpRxNotFoundError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /\b404\b/.test(message);
}

function isTrumpRxSoftNotFoundPage(page) {
  const text = String(page?.text || "");
  const rawText = String(page?.rawText || "");
  const normalizedText = text.replace(/s+/g, " ").trim();

  if (/__next_error__|global-error|content="noindex"/i.test(rawText)) {
    return true;
  }

  return normalizedText === "TrumpRx" || normalizedText === "Trump Rx";
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

export async function findTrumpRxProduct({ drugName, aliases = {}, browser, trumpRxBaseUrl }) {
  const candidates = [drugName, ...(aliases[drugName] || [])]
    .map(slugify)
    .filter(Boolean);
  let sawNotFound = false;
  let lastNotFoundUrl = null;

  for (const candidate of candidates) {
    const url = `${trumpRxBaseUrl}/${candidate}`;
    try {
      try {
        const extracted = await findTrumpRxPdfLinkWithAgentBrowser({ trumpRxUrl: url });
        const directAgentBrowserPdfUrl = toAbsoluteUrl(extracted?.pdfLink || "", url);
        if (directAgentBrowserPdfUrl) {
          return {
            found: true,
            url,
            aliasUsed: candidate,
            medGuideUrl: directAgentBrowserPdfUrl,
            retrievalSteps: [
              {
                step: "construct-url",
                status: "success",
                detail: url
              },
              {
                step: "fetch-page",
                status: "success",
                detail: "agent-browser located the TrumpRX product page."
              },
              {
                step: "find-patient-information-pdf",
                status: "success",
                detail: directAgentBrowserPdfUrl
              }
            ]
          };
        }
      } catch {
        // Fall back to the configured browser path below.
      }

      const page = await browser.loadWebPageText(url);
      if (browser.name === "agent-browser") {
        try {
          const extracted = await findTrumpRxPdfLinkWithAgentBrowser({ trumpRxUrl: url });
          if (!toAbsoluteUrl(extracted?.pdfLink || "", url) && String(extracted?.title || "").trim() === "TrumpRx") {
            sawNotFound = true;
            lastNotFoundUrl = url;
            continue;
          }
        } catch {
          // Fall back to page-shape detection below.
        }
      }

      if (isTrumpRxSoftNotFoundPage(page)) {
        sawNotFound = true;
        lastNotFoundUrl = url;
        continue;
      }

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
    } catch (error) {
      if (isTrumpRxNotFoundError(error)) {
        try {
          const extracted = await findTrumpRxPdfLinkWithAgentBrowser({ trumpRxUrl: url });
          const fallbackMedGuideUrl = toAbsoluteUrl(extracted?.pdfLink || "", url);
          if (fallbackMedGuideUrl) {
            return {
              found: true,
              url,
              aliasUsed: candidate,
              medGuideUrl: fallbackMedGuideUrl,
              retrievalSteps: [
                {
                  step: "construct-url",
                  status: "success",
                  detail: url
                },
                {
                  step: "fetch-page",
                  status: "warning",
                  detail: "Direct TrumpRX fetch returned 404; agent-browser fallback located the product page."
                },
                {
                  step: "find-patient-information-pdf",
                  status: "success",
                  detail: fallbackMedGuideUrl
                }
              ]
            };
          }
        } catch {
          sawNotFound = true;
          lastNotFoundUrl = url;
          continue;
        }

        sawNotFound = true;
        lastNotFoundUrl = url;
        continue;
      }

      continue;
    }
  }

  if (sawNotFound) {
    return {
      found: false,
      status: "Drug not found on trump RX",
      url: lastNotFoundUrl,
      aliasUsed: null,
      medGuideUrl: null,
      retrievalSteps: [
        {
          step: "construct-url",
          status: "success",
          detail: lastNotFoundUrl || "No TrumpRX URL constructed."
        },
        {
          step: "fetch-page",
          status: "not_found",
          detail: lastNotFoundUrl
            ? `TrumpRX returned 404 for ${lastNotFoundUrl}.`
            : "TrumpRX returned 404 for the attempted product URL."
        }
      ]
    };
  }

  return {
    found: false,
    status: "new drug- not found on trumpRX",
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
  medGuideUrl,
  browser,
  qaExtractor,
  questionPatterns
}) {
  const patientInfoPdfUrl = medGuideUrl || await (async () => {
    const page = await browser.loadWebPageText(trumpRxUrl);
    return findTrumpRxPatientInfoPdfUrl({
      browser,
      trumpRxUrl,
      page
    });
  })();

  if (!patientInfoPdfUrl) {
    return [];
  }

  const trumpRxCatalogEntry = {
    url: patientInfoPdfUrl,
    contentType: /\.pdf(\?|$)/i.test(patientInfoPdfUrl) ? "pdf" : "html",
    attributionType: "patient-info"
  };

  if (qaExtractor.name === "agentic" && typeof qaExtractor.extractCatalogEntry === "function") {
    const agenticResult = await qaExtractor.extractCatalogEntry({
      drugName: `${drugName}-trumprx`,
      catalogEntry: trumpRxCatalogEntry,
      browser,
      questionPatterns,
      attributionType: "patient-info"
    });
    return agenticResult.qaPairs;
  }

  const pdfDocument = await browser.loadCatalogEntry({
    drugName: `${drugName}-trumprx-pdf`,
    catalogEntry: trumpRxCatalogEntry
  });

  return qaExtractor.extract({
    drugName: `${drugName}-trumprx`,
    documentUrl: patientInfoPdfUrl,
    text: normalizeSectionText(pdfDocument.text),
    questionPatterns,
    attributionType: "patient-info"
  });
}
