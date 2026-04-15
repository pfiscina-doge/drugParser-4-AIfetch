import { Document, Settings, SummaryIndex } from "llamaindex";
import { SimpleDocumentStore } from "llamaindex/storage";
import { SimpleIndexStore } from "@llamaindex/core/storage/index-store";
import { getResponseSynthesizer } from "@llamaindex/core/response-synthesizers";
import { OpenAI } from "@llamaindex/openai";
import { Anthropic } from "@llamaindex/anthropic";

export function buildExtractionPrompt() {
  return [
    "Find all questions and answers in this markdown.",
    "Return JSON only with this exact schema:",
    '{"qaPairs":[{"question":"...","answer":"..."}]}',
    "Use exact text copied from the source section.",
    "Do not summarize or paraphrase."
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

function parseJsonIfPossible(text) {
  try {
    return JSON.parse(String(text || ""));
  } catch {
    return null;
  }
}

function collectHeadingLines(markdownText) {
  return String(markdownText || "")
    .split("\n")
    .map((line) => String(line || "").trim())
    .filter((line) => /^#{1,6}\s+/.test(line));
}

function findFirstMatchingLineNumber(markdownText, pattern) {
  const lines = String(markdownText || "").split("\n");
  const loweredPattern = String(pattern || "").trim().toLowerCase();
  if (!loweredPattern) {
    return null;
  }

  for (let index = 0; index < lines.length; index += 1) {
    if (String(lines[index] || "").toLowerCase().includes(loweredPattern)) {
      return index + 1;
    }
  }

  return null;
}

function findLineIndex(lines, matcher, startIndex = 0) {
  for (let index = Math.max(0, startIndex); index < lines.length; index += 1) {
    if (matcher(String(lines[index] || ""), index)) {
      return index;
    }
  }

  return -1;
}

function isHeadingLine(line, headingText) {
  const normalizedLine = String(line || "").trim().toLowerCase();
  const normalizedHeading = String(headingText || "").trim().toLowerCase();
  return normalizedLine === `# ${normalizedHeading}`;
}

export function preprocessMarkdownForQa(markdownText) {
  const normalizedText = String(markdownText || "");
  const lines = normalizedText.split("\n");

  const medicationGuideStart = findLineIndex(lines, (line) => isHeadingLine(line, "MEDICATION GUIDE"));
  if (medicationGuideStart >= 0) {
    const medicationGuideEnd = findLineIndex(
      lines,
      (line) => String(line || "").includes("This Medication Guide has been approved by the U.S. Food and Drug Administration"),
      medicationGuideStart
    );
    const endIndex = medicationGuideEnd >= 0 ? medicationGuideEnd + 1 : lines.length;

    return {
      strategy: "medication-guide",
      startLine: medicationGuideStart + 1,
      endLine: endIndex,
      text: lines.slice(medicationGuideStart, endIndex).join("\n").trim()
    };
  }

  const patientInformationStart = findLineIndex(lines, (line) => isHeadingLine(line, "Patient Information"));
  if (patientInformationStart >= 0) {
    const patientInformationEnd = findLineIndex(
      lines,
      (line) => String(line || "").toLowerCase().includes("approved by the u.s. food and drug administration"),
      patientInformationStart
    );
    const endIndex = patientInformationEnd >= 0 ? patientInformationEnd + 1 : lines.length;

    return {
      strategy: "patient-information",
      startLine: patientInformationStart + 1,
      endLine: endIndex,
      text: lines.slice(patientInformationStart, endIndex).join("\n").trim()
    };
  }

  const fullPrescribingInformationStart = findLineIndex(lines, (line) => isHeadingLine(line, "FULL PRESCRIBING INFORMATION"));
  if (fullPrescribingInformationStart >= 0) {
    const fullPrescribingInformationEnd = findLineIndex(
      lines,
      (line, index) => index > fullPrescribingInformationStart && String(line || "").trim() === "# FULL PRESCRIBING INFORMATION:",
      fullPrescribingInformationStart
    );
    const endIndex = fullPrescribingInformationEnd >= 0 ? fullPrescribingInformationEnd : lines.length;

    return {
      strategy: "full-prescribing-information",
      startLine: fullPrescribingInformationStart + 1,
      endLine: endIndex,
      text: lines.slice(fullPrescribingInformationStart, endIndex).join("\n").trim()
    };
  }

  return {
    strategy: "full-document",
    startLine: 1,
    endLine: lines.length,
    text: normalizedText.trim()
  };
}

export function buildMarkdownDebugInfo(markdownText) {
  const normalizedText = String(markdownText || "");
  const lines = normalizedText.split("\n");
  const headingLines = collectHeadingLines(normalizedText);
  const medicalInformationLine = findFirstMatchingLineNumber(normalizedText, "Medical Information");
  const patientInformationLine = findFirstMatchingLineNumber(normalizedText, "Patient Information");
  const medicationGuideLine = findFirstMatchingLineNumber(normalizedText, "Medication Guide");
  const preprocessed = preprocessMarkdownForQa(normalizedText);

  return {
    markdownChars: normalizedText.length,
    markdownLines: lines.length,
    headingCount: headingLines.length,
    headingPreview: headingLines.slice(0, 10),
    containsMedicalInformation: medicalInformationLine !== null,
    medicalInformationLine,
    patientInformationLine,
    medicationGuideLine,
    qaPreprocessStrategy: preprocessed.strategy,
    qaPreprocessStartLine: preprocessed.startLine,
    qaPreprocessEndLine: preprocessed.endLine,
    qaPreprocessChars: preprocessed.text.length
  };
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
  const debugInfo = buildMarkdownDebugInfo(markdownText);
  const preprocessed = preprocessMarkdownForQa(markdownText);
  const document = new Document({
    id_: `${drugName}-llama-path-markdown`,
    text: preprocessed.text
  });
  const index = await createSummaryIndexWithoutEmbeddings(document);
  const responseSynthesizer = getResponseSynthesizer("compact", { llm });
  const queryEngine = index.asQueryEngine({
    retriever: index.asRetriever({ mode: "default" }),
    responseSynthesizer
  });
  const responseStream = await queryEngine.query({ query, stream: true });
  let rawResponse = "";

  for await (const chunk of responseStream) {
    rawResponse += String(chunk?.response || "");
  }

  const answer = rawResponse.trim();
  const parsedAnswer = parseJsonIfPossible(answer);

  return {
    provider,
    model,
    query,
    debugInfo,
    rawResponse,
    answer,
    parsedAnswer
  };
}
