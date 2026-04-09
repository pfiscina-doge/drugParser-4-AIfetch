import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createBrowserAdapter } from "./services/browser-adapters.mjs";
import { createDiffEngine } from "./services/diff-engines.mjs";
import { normalizeSectionText } from "./services/question-extractor.mjs";
import { createQaExtractor } from "./services/qa-extractors.mjs";
import { findLocalHtmlRecord } from "./services/local-html.mjs";
import { findTrumpRxProduct, loadTrumpRxQa } from "./services/trumprx.mjs";

function isPdfCatalogUrl(url) {
  return /\.pdf(?:\?|$)/i.test(String(url || ""));
}

export function chooseQAExtractionMethod({ catalogEntry, overrideMethod }) {
  if (overrideMethod) {
    return overrideMethod;
  }

  return isPdfCatalogUrl(catalogEntry?.url) ? "fetch" : "agent-browser";
}

export async function runPipeline({ catalog, config }) {
  const diffEngine = createDiffEngine(config);
  const qaExtractor = createQaExtractor(config);
  const results = [];

  if (config.saveIntermediate) {
    await mkdir(config.intermediateDir, { recursive: true });
  }

  for (const [drugName, catalogEntry] of Object.entries(catalog)) {
    const startedAt = Date.now();
    try {
      const result = await withTimeout(
        processDrug({
          drugName,
          catalogEntry,
          config,
          qaExtractor,
          diffEngine,
        }),
        120000,
        `Timed out processing ${drugName}`
      );
      result.runtimeSeconds = Number(((Date.now() - startedAt) / 1000).toFixed(3));
      result.sourcePromptPath = inferSourcePromptPath({
        qaExtractorName: qaExtractor.name,
        extractedQa: result.sourceExtraction?.qaPairs || []
      });
      results.push(result);
    } catch (error) {
      results.push({
        drugName,
        catalogEntry,
        qaExtractionMethod: chooseQAExtractionMethod({
          catalogEntry,
          overrideMethod: config.newDocParseMethod
        }),
        localSourceFile: null,
        sourceExtraction: {
          sourceUrl: catalogEntry.url,
          headingDetected: null,
          qaPairs: []
        },
        trumpRx: {
          found: false,
          status: "processing error",
          url: null,
          medGuideUrl: null,
          medGuideMatchesCatalogUrl: false,
          retrievalSteps: [
            {
              step: "processing",
              status: "error",
              detail: error instanceof Error ? error.message : String(error)
            }
          ],
          qaPairs: []
        },
        status: "processing error",
        sourcePromptPath: "none",
        runtimeSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
        setSimilarityScore: 0,
        diff: []
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    configUsed: {
      newDocParseMethod: config.newDocParseMethod || "auto",
      diffEngine: config.diffEngine,
      docQaExtractor: config.docQaExtractor,
      trumpRxBaseUrl: config.trumpRxBaseUrl,
      skipTrumpRx: Boolean(config.skipTrumpRx)
    },
    summaryCounts: results.map((result) => ({
      drugName: result.drugName,
      sourceQuestionCount: result.sourceQuestionCount || 0,
      status: result.status
    })),
    results
  };
}

function normalizeUrl(value) {
  return String(value || "").replace(/^>+|<+$/g, "").trim();
}

function inferSourcePromptPath({ qaExtractorName, extractedQa }) {
  if (!Array.isArray(extractedQa) || extractedQa.length === 0) {
    return "none";
  }

  if (qaExtractorName !== "agentic") {
    return qaExtractorName || "none";
  }

  return extractedQa.some((pair) => pair?.type === "type-noguide-found") ? "secondary" : "primary";
}

async function processDrug({
  drugName,
  catalogEntry,
  config,
  qaExtractor,
  diffEngine,
}) {
  const qaExtractionMethod = chooseQAExtractionMethod({
    catalogEntry,
    overrideMethod: config.newDocParseMethod
  });
  const browser = createBrowserAdapter({
    ...config,
    newDocParseMethod: qaExtractionMethod
  });

  let sourceDocument;
  let extractedQa;

  if (qaExtractor.name === "agentic" && typeof qaExtractor.extractCatalogEntry === "function") {
    const agenticResult = await qaExtractor.extractCatalogEntry({
      drugName,
      catalogEntry,
      browser,
      questionPatterns: config.questionPatterns,
      attributionType: catalogEntry.attributionType
    });
    sourceDocument = agenticResult.sourceDocument;
    extractedQa = agenticResult.qaPairs;
  } else {
    sourceDocument = await browser.loadCatalogEntry({
      drugName,
      catalogEntry
    });

    const sourceText = normalizeSectionText(sourceDocument.text);
    extractedQa = await qaExtractor.extract({
      drugName,
      documentUrl: catalogEntry.url,
      text: sourceText,
      questionPatterns: config.questionPatterns,
      attributionType: catalogEntry.attributionType
    });
  }
  const localHtmlRecord = await findLocalHtmlRecord({
    drugName,
    aliases: config.aliases,
    sourceHtmlDir: config.sourceHtmlDir
  });


  if (config.saveIntermediate) {
    const filePath = path.join(config.intermediateDir, `${drugName}.source-qa.json`);
    await writeFile(filePath, JSON.stringify(extractedQa, null, 2));
  }

  if (config.skipTrumpRx) {
    return {
      drugName,
      catalogEntry,
      qaExtractionMethod,
      localSourceFile: localHtmlRecord,
      sourceQuestionCount: extractedQa.length,
      sourceExtraction: {
        sourceUrl: catalogEntry.url,
        headingDetected: sourceDocument.headingDetected,
        qaPairs: extractedQa
      },
      trumpRx: {
        found: false,
        status: "skipped",
        url: null,
        medGuideUrl: null,
        medGuideMatchesCatalogUrl: false,
        retrievalSteps: [
          {
            step: "skip-trumprx",
            status: "skipped",
            detail: "TrumpRX lookup and diff were skipped for this source-only run."
          }
        ],
        qaPairs: []
      },
      status: extractedQa.length > 0 ? "source questions found" : "no source questions found",
      setSimilarityScore: 0,
      diff: []
    };
  }

  const trumpRxMatch = await findTrumpRxProduct({
    drugName,
    aliases: config.aliases,
    browser,
    trumpRxBaseUrl: config.trumpRxBaseUrl
  });

  if (!trumpRxMatch.found) {
    return {
      drugName,
      catalogEntry,
      qaExtractionMethod,
      localSourceFile: localHtmlRecord,
      sourceExtraction: {
        sourceUrl: catalogEntry.url,
        headingDetected: sourceDocument.headingDetected,
        qaPairs: extractedQa
      },
      trumpRx: {
        found: false,
        status: trumpRxMatch.status || "new drug- not found on trumpRX",
        url: trumpRxMatch.url,
        medGuideUrl: null,
        medGuideMatchesCatalogUrl: false,
        retrievalSteps: trumpRxMatch.retrievalSteps,
        qaPairs: []
      },
      status: trumpRxMatch.status || "new drug- not found on trumpRX",
      setSimilarityScore: 0,
      diff: []
    };
  }

  const productionQa = await loadTrumpRxQa({
    drugName,
    trumpRxUrl: trumpRxMatch.url,
    medGuideUrl: trumpRxMatch.medGuideUrl,
    browser,
    qaExtractor,
    questionPatterns: config.questionPatterns
  });

  const diffResult = await diffEngine.compareQaSets({
    drugName,
    sourceQa: extractedQa,
    productionQa
  });

  if (config.saveIntermediate) {
    const filePath = path.join(config.intermediateDir, `${drugName}.trumprx-qa.json`);
    await writeFile(filePath, JSON.stringify(productionQa, null, 2));
  }

  const sourceQuestionsFound = extractedQa.length > 0;
  const trumpQuestionsFound = productionQa.length > 0;
  const status = !trumpQuestionsFound
    ? "no questions found on trumpRx"
    : sourceQuestionsFound
      ? "both questionsfound"
      : "questions found on trumpRx only";

  return {
    drugName,
    catalogEntry,
    qaExtractionMethod,
    localSourceFile: localHtmlRecord,
    sourceQuestionCount: extractedQa.length,
    sourceExtraction: {
      sourceUrl: catalogEntry.url,
      headingDetected: sourceDocument.headingDetected,
      qaPairs: extractedQa
    },
    trumpRx: {
      found: true,
      status,
      url: trumpRxMatch.url,
      medGuideUrl: trumpRxMatch.medGuideUrl,
      medGuideMatchesCatalogUrl: normalizeUrl(trumpRxMatch.medGuideUrl) === normalizeUrl(catalogEntry.url),
      retrievalSteps: trumpRxMatch.retrievalSteps,
      qaPairs: productionQa
    },
    status,
    setSimilarityScore: status === "both questionsfound" ? diffResult.setSimilarityScore : 0,
    diff: status === "both questionsfound" ? diffResult.questionDiffs : []
  };
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}
