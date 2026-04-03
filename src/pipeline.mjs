import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createBrowserAdapter } from "./services/browser-adapters.mjs";
import { createDiffEngine } from "./services/diff-engines.mjs";
import { normalizeSectionText } from "./services/question-extractor.mjs";
import { createQaExtractor } from "./services/qa-extractors.mjs";
import { findLocalHtmlRecord } from "./services/local-html.mjs";
import { findTrumpRxProduct, loadTrumpRxQa } from "./services/trumprx.mjs";

export async function runPipeline({ catalog, config }) {
  const browser = createBrowserAdapter(config);
  const diffEngine = createDiffEngine(config);
  const qaExtractor = createQaExtractor(config);
  const results = [];
  const discoveredQuestionFormats = new Set();

  if (config.saveIntermediate) {
    await mkdir(config.intermediateDir, { recursive: true });
  }

  for (const [drugName, catalogEntry] of Object.entries(catalog)) {
    try {
      const result = await withTimeout(
        processDrug({
          drugName,
          catalogEntry,
          config,
          browser,
          qaExtractor,
          diffEngine,
          discoveredQuestionFormats
        }),
        120000,
        `Timed out processing ${drugName}`
      );
      results.push(result);
    } catch (error) {
      results.push({
        drugName,
        catalogEntry,
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
        setSimilarityScore: 0,
        diff: []
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    configUsed: {
      newDocParseMethod: config.newDocParseMethod,
      diffEngine: config.diffEngine,
      docQaExtractor: config.docQaExtractor,
      trumpRxBaseUrl: config.trumpRxBaseUrl
    },
    discoveredQuestionFormats: Array.from(discoveredQuestionFormats).sort(),
    results
  };
}

function normalizeUrl(value) {
  return String(value || "").replace(/^>+|<+$/g, "").trim();
}

async function processDrug({
  drugName,
  catalogEntry,
  config,
  browser,
  qaExtractor,
  diffEngine,
  discoveredQuestionFormats
}) {
  const sourceDocument = await browser.loadCatalogEntry({
    drugName,
    catalogEntry
  });

  const sourceText = normalizeSectionText(sourceDocument.text);
  const extractedQa = await qaExtractor.extract({
    drugName,
    documentUrl: catalogEntry.url,
    text: sourceText,
    questionPatterns: config.questionPatterns,
    attributionType: catalogEntry.attributionType
  });
  const localHtmlRecord = await findLocalHtmlRecord({
    drugName,
    aliases: config.aliases,
    sourceHtmlDir: config.sourceHtmlDir
  });

  for (const pair of extractedQa) {
    discoveredQuestionFormats.add(pair.question);
  }

  if (config.saveIntermediate) {
    const filePath = path.join(config.intermediateDir, `${drugName}.source-qa.json`);
    await writeFile(filePath, JSON.stringify(extractedQa, null, 2));
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
      localSourceFile: localHtmlRecord,
      sourceExtraction: {
        sourceUrl: catalogEntry.url,
        headingDetected: sourceDocument.headingDetected,
        qaPairs: extractedQa
      },
      trumpRx: {
        found: false,
        status: "new drug- not found on trumpRX",
        url: null,
        medGuideUrl: null,
        medGuideMatchesCatalogUrl: false,
        retrievalSteps: trumpRxMatch.retrievalSteps,
        qaPairs: []
      },
      status: "new drug- not found on trumpRX",
      setSimilarityScore: 0,
      diff: []
    };
  }

  const productionQa = await loadTrumpRxQa({
    drugName,
    trumpRxUrl: trumpRxMatch.url,
    browser,
    qaExtractor,
    trumpRxParseMode: config.trumpRxParseMode
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
    localSourceFile: localHtmlRecord,
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
