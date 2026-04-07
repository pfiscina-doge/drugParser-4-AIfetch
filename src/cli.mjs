import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runPipeline } from "./pipeline.mjs";

const DEFAULT_CATALOG_RESOURCE = "./config/catalog.full.json";

function parseArgs(argv) {
  const args = {
    catalog: "",
    drugs: "",
    allDrugs: false,
    output: "",
    intermediateDir: "./output/intermediate",
    saveIntermediate: false,
    newDocParseMethod: "",
    diffEngine: "heuristic",
    docQaExtractor: "rule-based",
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
    }
  }

  if (!args.output) {
    throw new Error("Missing required argument: --output");
  }

  if (!args.catalog && !args.drugs && !args.allDrugs) {
    args.allDrugs = true;
  }

  return args;
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
  const outputPath = path.resolve(rootDir, args.output);
  const intermediateDir = path.resolve(rootDir, args.intermediateDir);

  const [catalogRaw, aliasRaw, questionPatternRaw, runtimeRaw] = await Promise.all([
    readFile(catalogPath, "utf8"),
    readFile(path.resolve(rootDir, "config/aliases.json"), "utf8"),
    readFile(path.resolve(rootDir, "config/question-patterns.json"), "utf8"),
    readFile(path.resolve(rootDir, "config/runtime.json"), "utf8")
  ]);

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
      docQaExtractor: args.docQaExtractor,
      llmBaseUrl: args.llmBaseUrl || llmConfig.baseUrl || "",
      llmApiKey: args.llmApiKey || llmApiKeyFromFile,
      llmApiKeyEnvVar: llmConfig.apiKeyEnvVar || "PERPLEXITY_API_KEY",
      llmModel: args.llmModel || llmConfig.model || "",
      saveIntermediate: args.saveIntermediate,
      intermediateDir,
      sourceHtmlDir: args.sourceHtmlDir ? path.resolve(rootDir, args.sourceHtmlDir) : "",
      trumpRxBaseUrl: args.trumpRxBaseUrl || runtimeConfig.trumpRxBaseUrl,
      perplexityBaseUrl: args.perplexityBaseUrl
    }
  });

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(results, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
