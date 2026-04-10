import { Document, Settings, SummaryIndex } from "llamaindex";
import { SimpleDocumentStore } from "llamaindex/storage";
import { SimpleIndexStore } from "@llamaindex/core/storage/index-store";
import { getResponseSynthesizer } from "@llamaindex/core/response-synthesizers";
import { OpenAI } from "@llamaindex/openai";
import { Anthropic } from "@llamaindex/anthropic";

export function buildExtractionPrompt() {
  return [
    "Look for a section in this document called Medical Information.",
    "Find all questions and answers in that section.",
    "Return JSON only with this exact schema:",
    '{"qaPairs":[{"question":"...","answer":"..."}]}',
    "Use exact text copied from the source section.",
    "Do not summarize or paraphrase.",
    "If the section does not exist, fallback to the closest patient-facing section and still return exact copied text.",
    "If nothing is found, return {\"qaPairs\":[]}."
  ].join("\n");
}

function getConfiguredValue(primary, fallback = "") {
  const value = String(primary || fallback || "").trim();
  return value;
}

function createPerplexityLlm(config) {
  const apiKey = getConfiguredValue(
    config.llamaAgenticQaApiKey,
    config.llmApiKey || process.env[config.llmApiKeyEnvVar || "PERPLEXITY_API_KEY"] || process.env.PERPLEXITY_API_KEY
  );
  const baseURL = getConfiguredValue(
    config.llamaAgenticQaBaseUrl,
    config.llmBaseUrl || "https://api.perplexity.ai"
  );
  const model = getConfiguredValue(
    config.llamaAgenticQaModel,
    config.llmModel || "sonar"
  );

  if (!apiKey) {
    throw new Error("Perplexity is selected for llama-agentic-qa-extraction, but no API key was provided.");
  }

  return {
    provider: "perplexity",
    model,
    llm: new OpenAI({
      apiKey,
      baseURL,
      model,
      temperature: 0
    })
  };
}

function createClaudeLlm(config) {
  const apiKey = getConfiguredValue(
    config.llamaAgenticQaApiKey,
    config.anthropicApiKey || process.env[config.anthropicApiKeyEnvVar || "ANTHROPIC_API_KEY"] || process.env.ANTHROPIC_API_KEY
  );
  const model = getConfiguredValue(
    config.llamaAgenticQaModel,
    config.anthropicModel || "claude-3-5-sonnet-latest"
  );

  if (!apiKey) {
    throw new Error("Claude is selected for llama-agentic-qa-extraction, but no Anthropic API key was provided.");
  }

  return {
    provider: "claude",
    model,
    llm: new Anthropic({
      apiKey,
      model,
      temperature: 0
    })
  };
}

function createOpenAiLlm(config) {
  const apiKey = getConfiguredValue(
    config.llamaAgenticQaApiKey,
    config.openAiApiKey || process.env.OPENAI_API_KEY
  );
  const model = getConfiguredValue(
    config.llamaAgenticQaModel,
    config.openAiModel || "gpt-4o-mini"
  );
  const baseURL = getConfiguredValue(
    config.llamaAgenticQaBaseUrl,
    config.openAiBaseUrl
  );

  if (!apiKey) {
    throw new Error("OpenAI is selected for llama-agentic-qa-extraction, but no OpenAI API key was provided.");
  }

  return {
    provider: "openai",
    model,
    llm: new OpenAI({
      apiKey,
      baseURL: baseURL || undefined,
      model,
      temperature: 0
    })
  };
}

function createLlmForAgenticQa(config) {
  const provider = getConfiguredValue(
    config.llamaAgenticQaProvider,
    "perplexity"
  ).toLowerCase();

  if (provider === "claude" || provider === "anthropic") {
    return createClaudeLlm(config);
  }

  if (provider === "openai") {
    return createOpenAiLlm(config);
  }

  return createPerplexityLlm(config);
}

async function createSummaryIndexWithoutEmbeddings(document) {
  const nodes = await Settings.nodeParser.getNodesFromDocuments([document]);

  return SummaryIndex.init({
    nodes,
    storageContext: {
      docStore: new SimpleDocumentStore(),
      indexStore: new SimpleIndexStore(),
      vectorStores: {}
    }
  });
}

export async function runLlamaAgenticQaExtraction({ drugName, markdownText, config }) {
  const query = getConfiguredValue(config.llamaAgenticQaQuery, buildExtractionPrompt());
  const { provider, model, llm } = createLlmForAgenticQa(config);
  const document = new Document({
    id_: `${drugName}-llama-path-markdown`,
    text: String(markdownText || "")
  });
  const index = await createSummaryIndexWithoutEmbeddings(document);
  const responseSynthesizer = getResponseSynthesizer("compact", { llm });
  const queryEngine = index.asQueryEngine({
    retriever: index.asRetriever({ mode: "default" }),
    responseSynthesizer
  });
  const response = await queryEngine.query({ query });
  const answer = String(
    response?.response
    || (response?.toString ? response.toString() : response || "")
  ).trim();

  return {
    provider,
    model,
    query,
    answer
  };
}
