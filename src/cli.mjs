import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runPipeline } from "./pipeline.mjs";

const DEFAULT_CATALOG_RESOURCE = "./config/catalog.full.json";

function parseArgs(argv) {
  const args = {
    catalog: "",
    drugs: "",
    allDrugs: false,
    output: "./output/summary.json",
    intermediateDir: "./output/intermediate",
    saveIntermediate: false,
    agenticDebug: false,
    onlyFromCatalogURL: false,
    skipTrumpRx: false,
    newDocParseMethod: "",
    diffEngine: "heuristic",
    docQaExtractor: "",
    llmBaseUrl: "",
    llmApiKey: "",
    llmModel: "",
    sourceHtmlDir: "",
    trumpRxBaseUrl: "https://trumprx.gov/p",
    perplexityBaseUrl: "https://www.perplexity.ai/"
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];

    if (token === "--catalog" && next) {
      args.catalog = next;
      index += 1;
    } else if (token === "--drugs" && next) {
      args.drugs = next;
      index += 1;
    } else if (token === "--all-drugs") {
      args.allDrugs = true;
    } else if (token === "--output" && next) {
      args.output = next;
      index += 1;
    } else if (token === "--intermediate-dir" && next) {
      args.intermediateDir = next;
      index += 1;
    } else if (token === "--new-doc-parse-method" && next) {
      args.newDocParseMethod = next;
      index += 1;
    } else if (token === "--diff-engine" && next) {
      args.diffEngine = next;
      index += 1;
    } else if (token === "--doc-qa-extractor" && next) {
      args.docQaExtractor = next;
      index += 1;
    } else if (token === "--llm-base-url" && next) {
      args.llmBaseUrl = next;
      index += 1;
    } else if (token === "--llm-api-key" && next) {
      args.llmApiKey = next;
      index += 1;
    } else if (token === "--llm-model" && next) {
      args.llmModel = next;
      index += 1;
    } else if (token === "--source-html-dir" && next) {
      args.sourceHtmlDir = next;
      index += 1;
    } else if (token === "--trumprx-base-url" && next) {
      args.trumpRxBaseUrl = next;
      index += 1;
    } else if (token === "--perplexity-base-url" && next) {
      args.perplexityBaseUrl = next;
      index += 1;
    } else if (token === "--save-intermediate") {
      args.saveIntermediate = true;
    } else if (token === "--agentic-debug") {
      args.agenticDebug = true;
    } else if (token === "--only-from-catalog-url") {
      args.onlyFromCatalogURL = true;
    } else if (token === "--skip-trumprx") {
      args.skipTrumpRx = true;
    }
  }

  if (!args.catalog && !args.drugs && !args.allDrugs) {
    args.allDrugs = true;
  }

  return args;
}


async function clearDirectory(dirPath) {
  await mkdir(dirPath, { recursive: true });
  const entries = await readdir(dirPath);
  await Promise.all(entries.map((entry) => rm(path.join(dirPath, entry), { recursive: true, force: true })));
}

function buildPerDrugWrapper(results, result) {
  return {
    generatedAt: results.generatedAt,
    configUsed: results.configUsed,
    summaryCounts: [
      {
        drugName: result.drugName,
        sourceQuestionCount: result.sourceQuestionCount || 0,
        status: result.status
      }
    ],
    results: [result]
  };
}

function buildStandardSummary({ results, catalogPath, outputDir, intermediateDir }) {
  return {
    generatedAt: results.generatedAt,
    catalogPath,
    configUsed: results.configUsed,
    results: results.results.map((result) => ({
      drugName: result.drugName,
      runtimeSeconds: result.runtimeSeconds ?? null,
      questionCount: result.sourceQuestionCount || 0,
      promptPath: result.sourcePromptPath || "none",
      status: result.status,
      outputJson: path.join(outputDir, `${result.drugName}.run.json`),
      sourceQaJson: path.join(intermediateDir, `${result.drugName}.source-qa.json`)
    }))
  };
}

function selectCatalogEntries(catalog, args) {
  if (args.allDrugs || !args.drugs) {
    return catalog;
  }

  const requested = args.drugs
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  const missing = requested.filter((name) => !(name in catalog));
  if (missing.length > 0) {
    throw new Error(`Unknown drug names requested: ${missing.join(", ")}`);
  }

  return Object.fromEntries(requested.map((name) => [name, catalog[name]]));
}

async function main() {
  const args = parseArgs(process.argv);
  const rootDir = process.cwd();
  const catalogPath = path.resolve(rootDir, args.catalog || DEFAULT_CATALOG_RESOURCE);
  const outputRoot = path.resolve(rootDir, "./output");
  const outputPath = path.resolve(rootDir, args.output);
  const intermediateDir = path.resolve(rootDir, args.intermediateDir);

  const [catalogRaw, aliasRaw, questionPatternRaw, runtimeRaw] = await Promise.all([
    readFile(catalogPath, "utf8"),
    readFile(path.resolve(rootDir, "config/aliases.json"), "utf8"),
    readFile(path.resolve(rootDir, "config/question-patterns.json"), "utf8"),
    readFile(path.resolve(rootDir, "config/runtime.json"), "utf8")
  ]);

  await clearDirectory(outputRoot);
  await clearDirectory(intermediateDir);

  const runtimeConfig = JSON.parse(runtimeRaw);
  const llmConfig = runtimeConfig.llm || {};
  const fullCatalog = JSON.parse(catalogRaw);
  const selectedCatalog = selectCatalogEntries(fullCatalog, args);
  const llmApiKeyFile = llmConfig.apiKeyFile
    ? path.resolve(rootDir, llmConfig.apiKeyFile)
    : "";
  const llmApiKeyFromFile = !args.llmApiKey && llmApiKeyFile
    ? (await readFile(llmApiKeyFile, "utf8")).trim()
    : "";

  const results = await runPipeline({
    catalog: selectedCatalog,
    config: {
      aliases: JSON.parse(aliasRaw),
      questionPatterns: JSON.parse(questionPatternRaw),
      newDocParseMethod: args.newDocParseMethod,
      diffEngine: args.diffEngine,
      docQaExtractor: args.docQaExtractor || runtimeConfig.docQaExtractor || "rule-based",
      llmBaseUrl: args.llmBaseUrl || llmConfig.baseUrl || "",
      llmApiKey: args.llmApiKey || llmApiKeyFromFile,
      llmApiKeyEnvVar: llmConfig.apiKeyEnvVar || "PERPLEXITY_API_KEY",
      llmModel: args.llmModel || llmConfig.model || "",
      saveIntermediate: args.saveIntermediate,
      agenticDebug: args.agenticDebug,
      onlyFromCatalogURL: args.onlyFromCatalogURL,
      skipTrumpRx: args.skipTrumpRx,
      intermediateDir,
      sourceHtmlDir: args.sourceHtmlDir ? path.resolve(rootDir, args.sourceHtmlDir) : "",
      trumpRxBaseUrl: args.trumpRxBaseUrl || runtimeConfig.trumpRxBaseUrl,
      perplexityBaseUrl: args.perplexityBaseUrl,
      maxQuestionsPerDrug: runtimeConfig.maxQuestionsPerDrug
    }
  });

  await Promise.all(results.results.map((result) => writeFile(
    path.join(outputRoot, `${result.drugName}.run.json`),
    JSON.stringify(buildPerDrugWrapper(results, result), null, 2)
  )));

  const standardSummary = buildStandardSummary({
    results,
    catalogPath,
    outputDir: outputRoot,
    intermediateDir
  });

  await writeFile(path.join(outputRoot, "full-run.json"), JSON.stringify(results, null, 2));
  await writeFile(outputPath, JSON.stringify(standardSummary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
