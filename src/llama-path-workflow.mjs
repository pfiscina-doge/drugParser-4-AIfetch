import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseDocumentWithLlamaParse } from "./services/llama-parse-client.mjs";
import { runLlamaAgenticQaExtraction } from "./services/llama-agentic-qa-extraction.mjs";

async function writeOptionalMarkdown({ config, drugName, markdownText }) {
  if (!config.llamaPathSaveMarkdown) {
    return null;
  }

  await mkdir(config.intermediateDir, { recursive: true });
  const markdownPath = path.join(config.intermediateDir, `${drugName}.source-document.md`);
  await writeFile(markdownPath, markdownText, "utf8");
  return markdownPath;
}

export async function runLlamaPathWorkflow({ catalog, config }) {
  const results = [];

  if (config.llamaPathSaveMarkdown) {
    await mkdir(config.intermediateDir, { recursive: true });
  }

  for (const [drugName, catalogEntry] of Object.entries(catalog)) {
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
      const qaResult = await runLlamaAgenticQaExtraction({
        drugName,
        markdownText,
        config
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
    }
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
