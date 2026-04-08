import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { askPerplexity } from "./perplexity-client.mjs";
import { normalizeSectionText } from "./question-extractor.mjs";

function sectionInstruction(attributionType) {
  if (attributionType === "medguide" || attributionType === "medlabel") {
    return "Look for the section called Medication Guide or Medical Guide. Under that section, find the patient-facing questions for this drug.";
  }

  return "Look for the section called PATIENT INFORMATION or Patient Information. Under that section, find the patient-facing questions for this drug.";
}

function buildPrimaryHeadingPrompt({ drugName, documentUrl, text, attributionType, onlyFromCatalogURL }) {
  return [
    `For the drug ${drugName}, read the document content gathered from: ${documentUrl || ""}`,
    "Return JSON with this shape:",
    '{"headings":[{"question":"..."}]}',
    "Task:",
    sectionInstruction(attributionType),
    "In that section, identify each patient-facing question heading only.",
    "Do not include answers in this step.",
    "Rules:",
    "- Return valid JSON only.",
    "- Use only the document text below; do not rely on prior knowledge.",
    ...(onlyFromCatalogURL
      ? ["- Only use the content parsed from the source URL above.", "- Do not follow links or use content from any other URLs."]
      : []),
    "- Preserve the exact question text from the document.",
    "- Only extract headings from the target section for the attribution type above.",
    '- If there are no matching question headings, return {"headings":[]}.',
    `Attribution type: ${attributionType || ""}`,
    "Document text:",
    text
  ].join("\n");
}

function buildFallbackHeadingPrompt({ drugName, documentUrl, text, attributionType, onlyFromCatalogURL }) {
  return [
    `For the drug ${drugName}, read the document content gathered from: ${documentUrl || ""}`,
    "Return JSON with this shape:",
    '{"headings":[{"question":"...","type":"type-noguide-found"}]}',
    "Task:",
    "The first extraction pass found no question-and-answer pairs in the expected guide section.",
    "Use only the document content parsed from the Document URL below.",
    "Do not use outside knowledge, search results, or content from any other URLs.",
    ...(onlyFromCatalogURL ? ["- Do not follow links or use content from any other URLs."] : ["Do not follow links."]),
    "Look for headings like Description, Descriptions, Contraindication, Contraindications, Contradiction, Contradictions, Warning, Warnings, Precautions, Storage, Dosage, Dosage and Administration, Highlights, or similar section headings.",
    "Also look for highlights and headings that begin a line with several dashes or m-dashes.",
    "Use those dashed or m-dash headings as the question text.",
    'For every returned heading, set "type" to "type-noguide-found".',
    "Rules:",
    "- Return valid JSON only.",
    "- Preserve the exact heading text from the document.",
    '- If you cannot find suitable fallback headings, return {"headings":[]}.',
    `Drug name: ${drugName}`,
    `Document URL: ${documentUrl || ""}`,
    `Attribution type: ${attributionType || ""}`,
    "Document text:",
    text
  ].join("\n");
}

function buildAnswerPrompt({ drugName, documentUrl, text, question, attributionType, type, onlyFromCatalogURL }) {
  return [
    `For the drug ${drugName}, read the document content gathered from: ${documentUrl || ""}`,
    "Return JSON with this shape:",
    '{"answer":"..."}',
    "Task:",
    `Find the exact answer text in the document for this heading/question: ${question}`,
    "Use the text that follows this heading/question up to the next clearly distinct heading.",
    ...(type === "type-noguide-found"
      ? ["Treat dashed heading lines, m-dash heading lines, and highlight heading lines as valid boundaries."]
      : []),
    "Rules:",
    "- Return valid JSON only.",
    "- Use only the document text below; do not rely on prior knowledge.",
    ...(onlyFromCatalogURL
      ? ["- Only use the content parsed from the source URL above.", "- Do not follow links or use content from any other URLs."]
      : []),
    "- Copy the answer text exactly as it appears in the document.",
    "- Preserve formatting in the answer text, including bullets, numbering, paragraph breaks, and line breaks whenever they appear in the sourced text.",
    "- Do not paraphrase.",
    "- Do not summarize.",
    'If no answer text exists for that heading, return {"answer":""}.',
    `Attribution type: ${attributionType || ""}`,
    "Document text:",
    text
  ].join("\n");
}

function headingListSchema() {
  return {
    type: "json_schema",
    json_schema: {
      name: "qa_heading_list",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          headings: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                question: { type: "string" },
                type: { type: "string" }
              },
              required: ["question"]
            }
          }
        },
        required: ["headings"]
      }
    }
  };
}

function answerSchema() {
  return {
    type: "json_schema",
    json_schema: {
      name: "qa_answer",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          answer: { type: "string" }
        },
        required: ["answer"]
      }
    }
  };
}

function sanitizeLabel(label) {
  return String(label || "prompt").replace(/[^a-z0-9._-]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase();
}

async function writeDebugArtifacts({ config, drugName, label, prompt, result, error, commandEquivalent }) {
  if (!config.agenticDebug) {
    return;
  }

  const debugDir = path.resolve(config.intermediateDir, "agentic-debug");
  await mkdir(debugDir, { recursive: true });
  const safeLabel = sanitizeLabel(label);
  await writeFile(path.join(debugDir, `${drugName}.${safeLabel}.prompt.txt`), prompt, "utf8");

  const payload = {
    commandEquivalent,
    onlyFromCatalogURL: Boolean(config.onlyFromCatalogURL),
    raw: result?.raw || null,
    parsedJson: result?.parsedJson || null,
    answer: result?.answer || ""
  };

  if (error) {
    payload.error = error instanceof Error ? error.message : String(error || "");
  }

  await writeFile(path.join(debugDir, `${drugName}.${safeLabel}.response.json`), JSON.stringify(payload, null, 2), "utf8");
}

async function askPerplexityJson({ config, drugName, label, prompt, responseFormat, maxTokens = 2048 }) {
  const apiKey = config.llmApiKey
    || process.env.LLM_API_KEY
    || process.env[config.llmApiKeyEnvVar || "PERPLEXITY_API_KEY"]
    || process.env.PERPLEXITY_API_KEY;
  const baseUrl = config.llmBaseUrl || process.env.LLM_BASE_URL || "https://api.perplexity.ai";
  const model = config.llmModel || process.env.LLM_MODEL || "sonar";

  if (!apiKey) {
    throw new Error("Agentic extraction is enabled, but no API key was provided. Set --llm-api-key or the env var named in config/runtime.json llm.apiKeyEnvVar.");
  }

  const commandEquivalent = `NODE_TLS_REJECT_UNAUTHORIZED=0 npm run ask:perplexity -- --api-key \"${apiKey}\" --model \"${model}\" --base-url \"${baseUrl}\" --question @${path.resolve(config.intermediateDir, "agentic-debug", `${drugName}.${sanitizeLabel(label)}.prompt.txt`)}`;
  const previousTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  let result = null;
  try {
    result = await askPerplexity({
      question: prompt,
      apiKey,
      model,
      baseUrl,
      systemPrompt: "Read the supplied drug label text, use only the provided document content, and return strict JSON only.",
      temperature: 0,
      disableSearch: true,
      responseFormat,
      maxTokens
    });

    await writeDebugArtifacts({ config, drugName, label, prompt, result, commandEquivalent });

    if (!result?.parsedJson) {
      throw new Error("Agentic extraction response did not include parseable JSON.");
    }

    return result.parsedJson;
  } catch (error) {
    await writeDebugArtifacts({ config, drugName, label, prompt, result, error, commandEquivalent });
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
      answer: String(pair.answer || "").trim(),
      ...(pair.type ? { type: String(pair.type).trim() } : {})
    };
  }).filter((pair) => pair.question);
}

function uniqueHeadings(headings = []) {
  const seen = new Set();
  const deduped = [];
  for (const item of headings) {
    const question = String(item?.question || "").trim();
    if (!question) continue;
    const key = question.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ question, ...(item?.type ? { type: item.type } : {}) });
  }
  return deduped;
}

async function extractAnswersForHeadings({ config, drugName, documentUrl, text, attributionType, onlyFromCatalogURL, headings, labelPrefix }) {
  const qaPairs = [];

  for (let index = 0; index < headings.length; index += 1) {
    const item = headings[index];
    const prompt = buildAnswerPrompt({
      drugName,
      documentUrl,
      text,
      question: item.question,
      attributionType,
      type: item.type,
      onlyFromCatalogURL
    });

    const parsed = await askPerplexityJson({
      config,
      drugName,
      label: `${labelPrefix}.answer.${index + 1}`,
      prompt,
      responseFormat: answerSchema(),
      maxTokens: 4096
    });

    qaPairs.push({
      question: item.question,
      answer: String(parsed?.answer || ""),
      ...(item.type ? { type: item.type } : {})
    });
  }

  return qaPairs;
}

async function extractAgenticQaPairs({ config, drugName, documentUrl, text, attributionType }) {
  const normalizedText = normalizeSectionText(text);

  const primaryPrompt = buildPrimaryHeadingPrompt({
    drugName,
    documentUrl,
    text: normalizedText,
    attributionType,
    onlyFromCatalogURL: config.onlyFromCatalogURL
  });
  const primaryHeadingsJson = await askPerplexityJson({
    config,
    drugName,
    label: "primary.headings",
    prompt: primaryPrompt,
    responseFormat: headingListSchema(),
    maxTokens: 2048
  });
  const primaryHeadings = uniqueHeadings(primaryHeadingsJson?.headings || []);

  if (primaryHeadings.length > 0) {
    const qaPairs = await extractAnswersForHeadings({
      config,
      drugName,
      documentUrl,
      text: normalizedText,
      attributionType,
      onlyFromCatalogURL: config.onlyFromCatalogURL,
      headings: primaryHeadings,
      labelPrefix: "primary"
    });
    return normalizeQaPairs(drugName, qaPairs);
  }

  const fallbackPrompt = buildFallbackHeadingPrompt({
    drugName,
    documentUrl,
    text: normalizedText,
    attributionType,
    onlyFromCatalogURL: config.onlyFromCatalogURL
  });
  const fallbackHeadingsJson = await askPerplexityJson({
    config,
    drugName,
    label: "fallback.headings",
    prompt: fallbackPrompt,
    responseFormat: headingListSchema(),
    maxTokens: 3072
  });
  const fallbackHeadings = uniqueHeadings((fallbackHeadingsJson?.headings || []).map((item) => ({ ...item, type: item?.type || "type-noguide-found" })));
  const fallbackQaPairs = await extractAnswersForHeadings({
    config,
    drugName,
    documentUrl,
    text: normalizedText,
    attributionType,
    onlyFromCatalogURL: config.onlyFromCatalogURL,
    headings: fallbackHeadings,
    labelPrefix: "fallback"
  });
  return normalizeQaPairs(drugName, fallbackQaPairs);
}

export function createPerplexityAgenticExtractor(config) {
  return {
    name: "agentic",
    async extract({ drugName, documentUrl, text, attributionType }) {
      return extractAgenticQaPairs({
        config,
        drugName,
        documentUrl,
        text,
        attributionType
      });
    },
    async extractCatalogEntry({ drugName, catalogEntry, browser }) {
      const sourceDocument = await browser.loadCatalogEntry({
        drugName,
        catalogEntry
      });
      const qaPairs = await extractAgenticQaPairs({
        config,
        drugName,
        documentUrl: catalogEntry?.url,
        text: sourceDocument.text,
        attributionType: catalogEntry?.attributionType
      });

      return {
        sourceDocument,
        qaPairs
      };
    }
  };
}
