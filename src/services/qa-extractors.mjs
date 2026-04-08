import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { askPerplexity } from "./perplexity-client.mjs";
import { extractQaPairs as extractQaPairsRuleBased, normalizeSectionText } from "./question-extractor.mjs";

function sectionInstruction(attributionType) {
  if (attributionType === "medguide" || attributionType === "medlabel") {
    return "Look for the section called Medication Guide or Medical Guide. Under that section, find the patient-facing questions for this drug.";
  }

  return "Look for the section called PATIENT INFORMATION or Patient Information. Under that section, find the patient-facing questions for this drug.";
}

function buildAgenticPrompt({ drugName, documentUrl, text, attributionType, onlyFromCatalogURL }) {
  return [
    `For the drug ${drugName}, read the document content gathered from: ${documentUrl || ""}`,
    "Produce JSON in this format:",
    '{"qaPairs":[{"id":"DRUG_SLUG-1","question":"...","answer":"..."}]}',
    "Task:",
    sectionInstruction(attributionType),
    "In that section, identify each patient-facing question heading and the answer text that belongs to it.",
    "The questions are typically visually distinct from the answers, such as bolded or shown in a different font.",
    "Rules:",
    "- Return valid JSON only.",
    "- Use only the document text below; do not rely on prior knowledge.",
    ...(onlyFromCatalogURL
      ? ["- Only use the content parsed from the source URL above.", "- Do not follow links or use content from any other URLs."]
      : []),
    "- Preserve the exact question text from the document.",
    "- Preserve the exact answer text from the document.",
    "- Preserve formatting in the answer text, including bullets, numbering, and line breaks whenever they appear in the sourced text.",
    "- Treat the answer as the text following that question up to the next clearly distinct question heading in the same section.",
    "- Only extract questions from the target section for the attribution type above.",
    "- If there are no matching questions, return {\"qaPairs\":[]}.",
    "- Use ids in the output if you want, but they will be normalized by the caller.",
    `Attribution type: ${attributionType || ""}`,
    "Document text:",
    text
  ].join("\n");
}

function buildNoGuideFallbackPrompt({ drugName, documentUrl, text, attributionType }) {
  return [
    "You extract fallback question and answer pairs from sourced drug-label text when no Medication Guide or Patient Information questions were found.",
    "Return only valid JSON.",
    "Output shape:",
    '{"qaPairs":[{"question":"...","answer":"...","type":"type-noguide-found"}]}',
    "Task:",
    "The first extraction pass found no question-and-answer pairs in the expected guide section.",
    "Use only the document content parsed from the Document URL below.",
    "Do not use outside knowledge, search results, or content from any other URLs.",
    "Do not follow links.",
    "Look for headings like Description, Descriptions, Contraindication, Contraindications, Contradiction, Contradictions, Warning, Warnings, Precautions, Storage, Dosage, Dosage and Administration, or similar section headings.",
    "Use those headings as the question text.",
    'For every returned pair, set "type" to "type-noguide-found".',
    "Use the text that follows each heading as the answer text until the next clearly distinct heading.",
    "Rules:",
    "- Use only text that appears in the document text below.",
    "- Copy the answer text exactly as it appears in the document.",
    "- Preserve formatting in the answer text, including paragraph breaks, bullets, numbering, and line breaks whenever they appear in the sourced text.",
    "- Do not paraphrase the question or the answer.",
    "- Do not summarize.",
    "- Do not invent missing text.",
    '- If you cannot find suitable fallback headings with answer text, return {"qaPairs":[]}.',
    `Drug name: ${drugName}`,
    `Document URL: ${documentUrl || ""}`,
    `Attribution type: ${attributionType || ""}`,
    "Sourced document text follows:",
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
    attributionType: catalogEntry?.attributionType,
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
      answer: String(pair.answer || "").trim(),
      ...(pair.type ? { type: String(pair.type).trim() } : {})
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

function createAgenticExtractor(config) {
  return {
    name: "agentic",
    constructPrompt,
    async extract({ drugName, documentUrl, text, attributionType }) {
      const normalizedText = normalizeSectionText(text);
      const prompt = buildAgenticPrompt({
        drugName,
        documentUrl,
        text: normalizedText,
        attributionType,
        onlyFromCatalogURL: config.onlyFromCatalogURL
      });
      const qaPairs = await callAgenticExtractor({
        config,
        drugName,
        prompt
      });
      const normalized = normalizeQaPairs(drugName, qaPairs);
      if (normalized.length > 0) {
        return normalized;
      }

      const fallbackPrompt = buildNoGuideFallbackPrompt({
        drugName,
        documentUrl,
        text: normalizedText,
        attributionType
      });
      const fallbackQaPairs = await callAgenticExtractor({
        config,
        drugName,
        prompt: fallbackPrompt
      });
      return normalizeQaPairs(drugName, fallbackQaPairs);
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
      let normalized = normalizeQaPairs(drugName, qaPairs);

      if (normalized.length === 0) {
        const fallbackPrompt = buildNoGuideFallbackPrompt({
          drugName,
          documentUrl: catalogEntry?.url,
          text: sourceDocument.text,
          attributionType: catalogEntry?.attributionType
        });
        const fallbackQaPairs = await callAgenticExtractor({
          config,
          drugName,
          prompt: fallbackPrompt
        });
        normalized = normalizeQaPairs(drugName, fallbackQaPairs);
      }

      return {
        sourceDocument,
        qaPairs: normalized
      };
    }
  };
}

export function createQaExtractor(config) {
  if (config.docQaExtractor === "agentic" || config.docQaExtractor === "ai") {
    return createAgenticExtractor(config);
  }

  return createRuleBasedExtractor();
}
