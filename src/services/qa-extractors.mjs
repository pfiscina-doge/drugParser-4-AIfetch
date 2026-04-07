import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { askPerplexity } from "./perplexity-client.mjs";
import { extractQaPairs as extractQaPairsRuleBased, normalizeSectionText } from "./question-extractor.mjs";

function buildExtractionPrompt({ drugName, documentUrl, text, questionPatterns }) {
  const knownStarts = (questionPatterns?.knownQuestionStarts || []).join("; ");
  const questionRegexes = (questionPatterns?.questionRegexes || []).join("; ");

  return [
    "You extract patient-facing question and answer pairs from sourced drug-label text.",
    "Return only valid JSON.",
    "Output shape:",
    '{"qaPairs":[{"question":"...","answer":"..."}]}',
    "Task:",
    "- Given this text and the known question patterns, find every question in the Medication Guide or Patient Information section that matches the known patterns.",
    "- For each matched question, output the question text and the answer text directly as they appear in the document text.",
    "- There may be multiple matching questions; extract all of them.",
    "Rules:",
    "- Use only text that appears in the document text below.",
    "- Copy questions and answers exactly as written in the text.",
    "- Do not paraphrase the question or answer.",
    "- Do not summarize.",
    "- Do not invent missing text.",
    "- Bullets under a question belong to that question's answer and do not start a new question.",
    "- Continuation lines that belong to the current answer must remain in that answer.",
    "- Only start a new item when the document clearly presents a new top-level question or heading.",
    "- If no matching section or questions exist, return {\"qaPairs\":[]}.",
    `Drug name: ${drugName}`,
    `Document URL: ${documentUrl || ""}`,
    `Known question starts: ${knownStarts}`,
    `Known question regexes: ${questionRegexes}`,
    "Sourced document text follows:",
    text
  ].join("\n");
}

function buildAgenticPrompt({ drugName, documentUrl, text, questionPatterns, onlyFromCatalogURL }) {
  const knownQuestions = questionPatterns?.knownQuestionStarts || [];

  return [
    "Using this list of known questions:",
    JSON.stringify(knownQuestions, null, 2),
    `for the ${drugName}`,
    `read the document content gathered from: ${documentUrl || ""}`,
    "produce a json that contains the text of the questions in this format:",
    '{"qaPairs":[{"id":"DRUG_SLUG-1","question":"...","answer":"..."}]}',
    "Rules:",
    "- Return valid JSON only.",
    "- Use the exact drug slug and source URL provided above.",
    "- Use only the document text below; do not rely on prior knowledge.",
    ...(onlyFromCatalogURL
      ? ["- Only use the content parsed from the source URL above.", "- Do not follow links or use content from any other URLs."]
      : []),
    "- Questions should end in a '?'.",
    "- The answer text should be the text following that question up to the next question.",
    "- Preserve bullet points in the answer text.",
    "- Preserve the wording from the document whenever possible.",
    "- If there are no matching questions, return {\"qaPairs\":[]}.",
    "- Use ids in the output if you want, but they will be normalized by the caller.",
    "Document text:",
    text
  ].join("\n");
}

async function constructPrompt({ drugName, catalogEntry, browser, questionPatterns, config }) {
  const sourceDocument = await browser.loadCatalogEntry({
    drugName,
    catalogEntry
  });
  const sourceText = normalizeSectionText(sourceDocument.text);
  const prompt = buildAgenticPrompt({
    drugName,
    documentUrl: catalogEntry?.url,
    text: sourceText,
    questionPatterns,
    onlyFromCatalogURL: config.onlyFromCatalogURL
  });

  return {
    prompt,
    sourceDocument,
    sourceText
  };
}

async function writeAgenticDebugArtifacts({ config, drugName, prompt, result, error, commandEquivalent }) {
  if (!config.agenticDebug) {
    return;
  }

  const debugDir = path.resolve(config.intermediateDir, "agentic-debug");
  await mkdir(debugDir, { recursive: true });
  await writeFile(path.join(debugDir, `${drugName}.prompt.txt`), prompt, "utf8");

  const payload = error
    ? {
        commandEquivalent,
        error: error instanceof Error ? error.message : String(error || ""),
        onlyFromCatalogURL: Boolean(config.onlyFromCatalogURL),
        raw: result?.raw || null,
        parsedJson: result?.parsedJson || null,
        answer: result?.answer || ""
      }
    : {
        commandEquivalent,
        onlyFromCatalogURL: Boolean(config.onlyFromCatalogURL),
        raw: result?.raw || null,
        parsedJson: result?.parsedJson || null,
        answer: result?.answer || ""
      };

  await writeFile(
    path.join(debugDir, `${drugName}.response.json`),
    JSON.stringify(payload, null, 2),
    "utf8"
  );
}

async function callLlmExtractor({ config, prompt }) {
  const apiKey = config.llmApiKey
    || process.env.LLM_API_KEY
    || process.env[config.llmApiKeyEnvVar || "PERPLEXITY_API_KEY"]
    || process.env.PERPLEXITY_API_KEY;
  const baseUrl = config.llmBaseUrl || process.env.LLM_BASE_URL || "https://api.perplexity.ai";
  const model = config.llmModel || process.env.LLM_MODEL || "sonar";

  if (!apiKey) {
    throw new Error(
      "AI extraction is enabled, but no API key was provided. Set --llm-api-key or the env var named in config/runtime.json llm.apiKeyEnvVar."
    );
  }

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: {
        type: "json_object"
      },
      messages: [
        {
          role: "system",
          content: "Extract medication-guide or patient-information question and answer pairs from supplied text and return strict JSON."
        },
        {
          role: "user",
          content: `${prompt}\n\nReturn only this wrapper object shape: {\"qaPairs\":[{\"question\":\"...\",\"answer\":\"...\"}]}`
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`AI extraction request failed: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("AI extraction response did not include message content.");
  }

  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed.qaPairs)) {
    throw new Error("AI extraction response did not include a qaPairs array.");
  }

  return parsed.qaPairs;
}

async function callAgenticExtractor({ config, drugName, prompt }) {
  const apiKey = config.llmApiKey
    || process.env.LLM_API_KEY
    || process.env[config.llmApiKeyEnvVar || "PERPLEXITY_API_KEY"]
    || process.env.PERPLEXITY_API_KEY;
  const baseUrl = config.llmBaseUrl || process.env.LLM_BASE_URL || "https://api.perplexity.ai";
  const model = config.llmModel || process.env.LLM_MODEL || "sonar";

  if (!apiKey) {
    throw new Error(
      "Agentic extraction is enabled, but no API key was provided. Set --llm-api-key or the env var named in config/runtime.json llm.apiKeyEnvVar."
    );
  }

  const commandEquivalent = `NODE_TLS_REJECT_UNAUTHORIZED=0 npm run ask:perplexity -- --api-key \"${apiKey}\" --model \"${model}\" --base-url \"${baseUrl}\" --system-prompt \"Read the supplied drug label text, extract matching question and answer pairs, and return strict JSON only.\" --question @${path.resolve(config.intermediateDir, "agentic-debug", `${drugName}.prompt.txt`)}`;
  const previousTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  let result = null;
  try {
    result = await askPerplexity({
      question: prompt,
      apiKey,
      model,
      baseUrl,
      systemPrompt: "Read the supplied drug label text, extract matching question and answer pairs, and return strict JSON only.",
      temperature: 0
    });

    await writeAgenticDebugArtifacts({ config, drugName, prompt, result, commandEquivalent });

    const parsed = result?.parsedJson;
    if (!parsed || !Array.isArray(parsed.qaPairs)) {
      throw new Error("Agentic extraction response did not include a qaPairs array.");
    }

    return parsed.qaPairs;
  } catch (error) {
    await writeAgenticDebugArtifacts({ config, drugName, prompt, result, error, commandEquivalent });
    throw error;
  } finally {
    if (previousTlsSetting === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsSetting;
    }
  }
}

function normalizeQaPairs(drugName, qaPairs) {
  return qaPairs.map((pair, index) => {
    const question = String(pair.question || "").trim();
    return {
      id: `${drugName}-${index + 1}`,
      question: question && !question.endsWith("?") ? `${question}?` : question,
      answer: String(pair.answer || "").trim()
    };
  }).filter((pair) => pair.question);
}

function createRuleBasedExtractor() {
  return {
    name: "rule-based",
    async extract({ drugName, text, questionPatterns, attributionType }) {
      return extractQaPairsRuleBased({
        drugName,
        text,
        questionPatterns,
        attributionType
      });
    }
  };
}

function createAiExtractor(config) {
  return {
    name: "ai",
    async extract({ drugName, documentUrl, text, questionPatterns }) {
      const prompt = buildExtractionPrompt({ drugName, documentUrl, text, questionPatterns });
      const qaPairs = await callLlmExtractor({ config, prompt });
      return normalizeQaPairs(drugName, qaPairs);
    }
  };
}

function createAgenticExtractor(config) {
  return {
    name: "agentic",
    constructPrompt,
    async extract({ drugName, documentUrl, text, questionPatterns }) {
      const prompt = buildAgenticPrompt({
        drugName,
        documentUrl,
        text: normalizeSectionText(text),
        questionPatterns,
        onlyFromCatalogURL: config.onlyFromCatalogURL
      });
      const qaPairs = await callAgenticExtractor({
        config,
        drugName,
        prompt
      });
      return normalizeQaPairs(drugName, qaPairs);
    },
    async extractCatalogEntry({ drugName, catalogEntry, browser, questionPatterns }) {
      const { prompt, sourceDocument } = await constructPrompt({
        drugName,
        catalogEntry,
        browser,
        questionPatterns,
        config
      });
      const qaPairs = await callAgenticExtractor({
        config,
        drugName,
        prompt
      });

      return {
        sourceDocument,
        qaPairs: normalizeQaPairs(drugName, qaPairs)
      };
    }
  };
}

export function createQaExtractor(config) {
  if (config.docQaExtractor === "ai") {
    return createAiExtractor(config);
  }

  if (config.docQaExtractor === "agentic") {
    return createAgenticExtractor(config);
  }

  return createRuleBasedExtractor();
}
