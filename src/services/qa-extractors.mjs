import { extractQaPairs as extractQaPairsRuleBased } from "./question-extractor.mjs";

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
          content: `${prompt}\n\nReturn only this wrapper object shape: {"qaPairs":[{"question":"...","answer":"..."}]}`
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

function normalizeQaPairs(drugName, qaPairs) {
  return qaPairs.map((pair, index) => ({
    id: `${drugName}-${index + 1}`,
    question: String(pair.question || "").trim(),
    answer: String(pair.answer || "").trim()
  })).filter((pair) => pair.question);
}

function createRuleBasedExtractor() {
  return {
    name: "rule-based",
    async extract({ drugName, documentUrl, text, questionPatterns, attributionType }) {
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

export function createQaExtractor(config) {
  if (config.docQaExtractor === "ai") {
    return createAiExtractor(config);
  }

  return createRuleBasedExtractor();
}
