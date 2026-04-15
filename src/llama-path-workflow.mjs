import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseDocumentWithLlamaParse } from "./services/llama-parse-client.mjs";
import {
  buildMarkdownDebugInfo,
  preprocessMarkdownForQa,
  runLlamaAgenticQaExtraction
} from "./services/llama-agentic-qa-extraction.mjs";

const QA_WAIT_NOTICE_DELAY_MS = 60_000;
const QA_WAIT_NOTICE_INTERVAL_MS = 30_000;
const CATALOG_PROGRESS_INTERVAL_MS = 5 * 60_000;

async function writeOptionalMarkdown({ config, drugName, markdownText }) {
  if (!config.agenticDebug) {
    return null;
  }

  await mkdir(config.intermediateDir, { recursive: true });
  const markdownPath = path.join(config.intermediateDir, `${drugName}.source-document.md`);
  await writeFile(markdownPath, markdownText, "utf8");
  return markdownPath;
}

async function writeOptionalProcessedMarkdown({ config, drugName, markdownText }) {
  if (!config.agenticDebug) {
    return null;
  }

  const processed = preprocessMarkdownForQa(markdownText);
  const processedDir = path.join(config.intermediateDir, "processed-markdown");
  await mkdir(processedDir, { recursive: true });
  const processedMarkdownPath = path.join(processedDir, `${drugName}.processed.md`);
  await writeFile(processedMarkdownPath, processed.text, "utf8");

  return {
    processedMarkdownPath,
    processedMarkdownStrategy: processed.strategy,
    processedMarkdownStartLine: processed.startLine,
    processedMarkdownEndLine: processed.endLine
  };
}

function getQaJsonPath(config, drugName) {
  return path.join(config.intermediateDir, `${drugName}.source-qa.json`);
}

function getQaStatusPath(config, drugName) {
  return path.join(config.intermediateDir, `${drugName}.llama-agentic-qa-status.txt`);
}

function getQaRawResponsePath(config, drugName) {
  return path.join(config.intermediateDir, `${drugName}.source-qa.raw.json`);
}

async function writeQaResultFile({ config, drugName, qaResult }) {
  await mkdir(config.intermediateDir, { recursive: true });
  const filePath = getQaJsonPath(config, drugName);
  const payload = qaResult?.parsedAnswer ?? { rawAnswer: qaResult?.answer || "" };
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return filePath;
}

async function writeQaRawResponseFile({ config, drugName, qaResult }) {
  await mkdir(config.intermediateDir, { recursive: true });
  const filePath = getQaRawResponsePath(config, drugName);
  await writeFile(filePath, `${String(qaResult?.rawResponse || "")}\n`, "utf8");
  return filePath;
}

async function writeQaStatusFile({ config, drugName, text }) {
  await mkdir(config.intermediateDir, { recursive: true });
  await writeFile(getQaStatusPath(config, drugName), `${text}\n`, "utf8");
}

function formatDebugSummary(drugName, debugInfo, query) {
  const headingPreview = (debugInfo.headingPreview || []).join(" | ") || "none";
  return [
    `[llama-path] ${drugName}: starting llama-agentic-qa-extraction`,
    `query=${query}`,
    `markdownChars=${debugInfo.markdownChars}`,
    `markdownLines=${debugInfo.markdownLines}`,
    `headingCount=${debugInfo.headingCount}`,
    `containsMedicalInformation=${debugInfo.containsMedicalInformation}`,
    `medicalInformationLine=${debugInfo.medicalInformationLine ?? "none"}`,
    `patientInformationLine=${debugInfo.patientInformationLine ?? "none"}`,
    `medicationGuideLine=${debugInfo.medicationGuideLine ?? "none"}`,
    `qaPreprocessStrategy=${debugInfo.qaPreprocessStrategy ?? "none"}`,
    `qaPreprocessStartLine=${debugInfo.qaPreprocessStartLine ?? "none"}`,
    `qaPreprocessEndLine=${debugInfo.qaPreprocessEndLine ?? "none"}`,
    `qaPreprocessChars=${debugInfo.qaPreprocessChars ?? 0}`,
    `headingPreview=${headingPreview}`
  ].join("\n");
}

async function runQaExtractionWithProgress({ config, drugName, markdownText }) {
  let waitStarted = false;
  let intervalId = null;
  let timeoutId = null;
  const query = String(config.llamaAgenticQaQuery || "").trim();
  const debugInfo = buildMarkdownDebugInfo(markdownText);
  const initialDebugSummary = formatDebugSummary(drugName, debugInfo, query);

  console.log(initialDebugSummary);
  await writeQaStatusFile({
    config,
    drugName,
    text: initialDebugSummary
  });

  const startWaitNotices = () => {
    waitStarted = true;
    const firstMessage = `[llama-path] ${drugName}: llama-agentic-qa-extraction is still running after 60s. Waiting for the LLM response...`;
    console.log(firstMessage);
    void writeQaStatusFile({ config, drugName, text: firstMessage });

    intervalId = setInterval(() => {
      const waitedSeconds = Math.round((Date.now() - startedAt) / 1000);
      const message = `[llama-path] ${drugName}: still waiting on llama-agentic-qa-extraction (${waitedSeconds}s elapsed).`;
      console.log(message);
      void writeQaStatusFile({ config, drugName, text: message });
    }, QA_WAIT_NOTICE_INTERVAL_MS);
  };

  const startedAt = Date.now();
  timeoutId = setTimeout(startWaitNotices, QA_WAIT_NOTICE_DELAY_MS);

  try {
    const qaResult = await runLlamaAgenticQaExtraction({
      drugName,
      markdownText,
      config
    });
    const qaJsonPath = await writeQaResultFile({
      config,
      drugName,
      qaResult
    });
    const qaRawResponsePath = await writeQaRawResponseFile({
      config,
      drugName,
      qaResult
    });
    const completionMessage = waitStarted
      ? `[llama-path] ${drugName}: llama-agentic-qa-extraction completed after ${Math.round((Date.now() - startedAt) / 1000)}s.`
      : `[llama-path] ${drugName}: llama-agentic-qa-extraction completed.`;
    await writeQaStatusFile({ config, drugName, text: completionMessage });

    return {
      qaResult,
      qaJsonPath,
      qaRawResponsePath
    };
  } finally {
    clearTimeout(timeoutId);
    if (intervalId) {
      clearInterval(intervalId);
    }
  }
}

export async function runLlamaPathWorkflow({ catalog, config }) {
  const results = [];
  const drugEntries = Object.entries(catalog);
  const totalDrugs = drugEntries.length;
  let completedDrugs = 0;

  if (config.agenticDebug || config.intermediateDir) {
    await mkdir(config.intermediateDir, { recursive: true });
  }

  const progressIntervalId = setInterval(() => {
    console.log(`[llama-path] progress: ${completedDrugs}/${totalDrugs} drugs completed.`);
  }, CATALOG_PROGRESS_INTERVAL_MS);

  try {
    for (const [drugName, catalogEntry] of drugEntries) {
      const startedAt = Date.now();

      try {
        const parsed = await parseDocumentWithLlamaParse({
          url: String(catalogEntry.url || "").replace(/^>+|<+$/g, "").trim(),
          config
        });
        const markdownText = String(parsed.text || "");
        const markdownPath = await writeOptionalMarkdown({
          config,
          drugName,
          markdownText
        });
        const processedMarkdown = await writeOptionalProcessedMarkdown({
          config,
          drugName,
          markdownText
        });
        const {
          qaResult,
          qaJsonPath,
          qaRawResponsePath
        } = await runQaExtractionWithProgress({
          config,
          drugName,
          markdownText,
        });

        results.push({
          drugName,
          catalogEntry,
          qaExtractionMethod: "llama-path",
          sourceQuestionCount: 0,
          sourceExtraction: {
            sourceUrl: catalogEntry.url,
            headingDetected: null,
            qaPairs: []
          },
          llamaPath: {
            markdownSaved: Boolean(markdownPath),
            markdownPath,
            markdownChars: markdownText.length,
            processedMarkdownPath: processedMarkdown?.processedMarkdownPath || null,
            processedMarkdownStrategy: processedMarkdown?.processedMarkdownStrategy || null,
            processedMarkdownStartLine: processedMarkdown?.processedMarkdownStartLine || null,
            processedMarkdownEndLine: processedMarkdown?.processedMarkdownEndLine || null,
            qaJsonPath,
            qaRawResponsePath,
            agenticQa: qaResult
          },
          trumpRx: {
            found: false,
            status: "skipped",
            url: null,
            medGuideUrl: null,
            medGuideMatchesCatalogUrl: false,
            retrievalSteps: [
              {
                step: "llama-path-parse",
                status: "success",
                detail: markdownPath || "Parsed markdown in memory."
              },
              {
                step: "llama-agentic-qa-extraction",
                status: "success",
                detail: `${qaResult.provider}:${qaResult.model}`
              }
            ],
            qaPairs: []
          },
          status: "llama-path qa extracted",
          setSimilarityScore: 0,
          diff: [],
          runtimeSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
          sourcePromptPath: "none"
        });
      } catch (error) {
        results.push({
          drugName,
          catalogEntry,
          qaExtractionMethod: "llama-path",
          sourceQuestionCount: 0,
          sourceExtraction: {
            sourceUrl: catalogEntry.url,
            headingDetected: null,
            qaPairs: []
          },
          llamaPath: {
            markdownSaved: false,
            markdownPath: null,
            markdownChars: 0,
            agenticQa: null
          },
          trumpRx: {
            found: false,
            status: "processing error",
            url: null,
            medGuideUrl: null,
            medGuideMatchesCatalogUrl: false,
            retrievalSteps: [
              {
                step: "llama-path",
                status: "error",
                detail: error instanceof Error ? error.message : String(error)
              }
            ],
            qaPairs: []
          },
          status: "processing error",
          setSimilarityScore: 0,
          diff: [],
          runtimeSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
          sourcePromptPath: "none"
        });
      } finally {
        completedDrugs += 1;
      }
    }
  } finally {
    clearInterval(progressIntervalId);
    console.log(`[llama-path] progress: ${completedDrugs}/${totalDrugs} drugs completed.`);
  }

  return {
    generatedAt: new Date().toISOString(),
    configUsed: {
      newDocParseMethod: "llama-path",
      diffEngine: config.diffEngine,
      docQaExtractor: config.docQaExtractor,
      trumpRxBaseUrl: config.trumpRxBaseUrl,
      skipTrumpRx: true,
      llamaPathSaveMarkdown: Boolean(config.llamaPathSaveMarkdown),
      llamaAgenticQaProvider: config.llamaAgenticQaProvider,
      llamaAgenticQaModel: config.llamaAgenticQaModel,
      llamaAgenticQaQuery: config.llamaAgenticQaQuery
    },
    summaryCounts: results.map((result) => ({
      drugName: result.drugName,
      sourceQuestionCount: result.sourceQuestionCount || 0,
      status: result.status
    })),
    results
  };
}
