import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyGlobalTlsRuntimeConfig } from "../src/services/network-runtime.mjs";
import {
  buildExtractionPrompt,
  preprocessMarkdownForQa,
  runLlamaAgenticQaExtraction
} from "../src/services/llama-agentic-qa-extraction.mjs";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = path.join(ROOT_DIR, "test", "fixtures", "llama-path-markdown");
const OUTPUT_DIR = path.join(ROOT_DIR, "test", "output");
const RUNTIME_PATH = path.join(ROOT_DIR, "config", "runtime.json");

function parseApiKeyFileContents(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) {
    return "";
  }

  const assignmentMatch = trimmed.match(/^(?:export\s+)?api_key\s*=\s*["']?([^"'\n]+)["']?\s*$/i);
  if (assignmentMatch) {
    return assignmentMatch[1].trim();
  }

  return trimmed;
}

async function readOptionalParsedKeyFile(filePath) {
  if (!filePath) {
    return "";
  }

  try {
    return parseApiKeyFileContents(await readFile(filePath, "utf8"));
  } catch {
    return "";
  }
}

export async function loadLlamaFixtureRuntimeConfig() {
  const runtime = JSON.parse(await readFile(RUNTIME_PATH, "utf8"));
  applyGlobalTlsRuntimeConfig(runtime);

  const llmConfig = runtime.llm || {};
  const anthropicConfig = runtime.anthropic || {};
  const llmApiKeyFile = llmConfig.apiKeyFile ? path.resolve(ROOT_DIR, llmConfig.apiKeyFile) : "";
  const anthropicApiKeyFile = anthropicConfig.apiKeyFile ? path.resolve(ROOT_DIR, anthropicConfig.apiKeyFile) : "";
  const llmApiKey = await readOptionalParsedKeyFile(llmApiKeyFile);
  const anthropicApiKey = await readOptionalParsedKeyFile(anthropicApiKeyFile);

  return {
    llamaAgenticQaProvider: runtime?.llamaAgenticQa?.llmProvider || "perplexity",
    llamaAgenticQaModel: runtime?.llamaAgenticQa?.llmModel || llmConfig.model || "sonar",
    llamaAgenticQaQuery: buildExtractionPrompt(),
    llmBaseUrl: llmConfig.baseUrl || "https://api.perplexity.ai",
    llmModel: llmConfig.model || "sonar",
    llmApiKeyEnvVar: llmConfig.apiKeyEnvVar || "PERPLEXITY_API_KEY",
    llmApiKey,
    anthropicApiKeyEnvVar: anthropicConfig.apiKeyEnvVar || "ANTHROPIC_API_KEY",
    anthropicApiKey,
    anthropicModel: anthropicConfig.model || "claude-3-5-sonnet-latest"
  };
}

export async function listLlamaFixtureNames() {
  const entries = await readdir(FIXTURE_DIR);
  return entries
    .filter((entry) => entry.endsWith(".source-document.md"))
    .map((entry) => entry.replace(/\.source-document\.md$/u, ""))
    .sort();
}

export async function runLlamaFixtureQaExample(fixtureName, overrides = {}) {
  const runtimeConfig = {
    ...(await loadLlamaFixtureRuntimeConfig()),
    ...overrides
  };
  const markdownPath = path.join(FIXTURE_DIR, `${fixtureName}.source-document.md`);
  const markdownText = await readFile(markdownPath, "utf8");
  const processedMarkdown = preprocessMarkdownForQa(markdownText);
  const qaResult = await runLlamaAgenticQaExtraction({
    drugName: fixtureName,
    markdownText,
    config: runtimeConfig
  });

  await mkdir(OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(OUTPUT_DIR, `${fixtureName}.qa-result.json`);
  await writeFile(outputPath, `${JSON.stringify({
    fixtureName,
    markdownPath,
    processedMarkdown,
    qaResult
  }, null, 2)}\n`, "utf8");

  return {
    fixtureName,
    markdownPath,
    processedMarkdown,
    qaResult,
    outputPath
  };
}
