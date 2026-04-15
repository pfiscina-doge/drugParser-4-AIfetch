if (process.env.LLAMAPARSE_INSECURE_TLS === "1") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline as streamPipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import LlamaCloud from "@llamaindex/llama-cloud";
import { getCurlTlsArgs } from "./network-runtime.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_RESULT_TYPE = "markdown";

function summarizeError(error) {
  if (!error) {
    return "unknown error";
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function buildStageError(stage, detail, extra = {}) {
  const error = new Error(detail);
  error.stage = stage;
  error.extra = extra;
  return error;
}

function formatStageDiagnostics({ url, stage, detail, extra = {} }) {
  const diagnostics = [
    `url=${url}`,
    `stage=${stage}`,
    `detail=${detail}`,
    `nodeTlsRejectUnauthorized=${process.env.NODE_TLS_REJECT_UNAUTHORIZED || "unset"}`,
    `drugLabelInsecureTls=${process.env.DRUG_LABEL_INSECURE_TLS || "unset"}`,
    `llamaParseInsecureTls=${process.env.LLAMAPARSE_INSECURE_TLS || "unset"}`
  ];

  for (const [key, value] of Object.entries(extra)) {
    diagnostics.push(`${key}=${value}`);
  }

  return diagnostics.join(" | ");
}

function getApiKey(config) {
  const directKey = String(config?.llamaPathApiKey || "").trim();
  if (directKey) {
    return directKey;
  }

  const configuredEnvVar = String(config?.llamaPathApiKeyEnvVar || "").trim();
  const configuredEnvValue = configuredEnvVar ? String(process.env[configuredEnvVar] || "").trim() : "";
  if (configuredEnvValue) {
    return configuredEnvValue;
  }

  return String(
    process.env.LLAMA_CLOUD_API_KEY
    || process.env.LLAMAPARSE_API_KEY
    || ""
  ).trim();
}

function getResultType(config) {
  const resultType = String(config?.llamaPathResultType || DEFAULT_RESULT_TYPE).trim().toLowerCase();
  return resultType || DEFAULT_RESULT_TYPE;
}

function inferDownloadExtension(url) {
  const normalizedUrl = String(url || "").toLowerCase();

  if (/\.pdf(?:\?|$)/i.test(normalizedUrl)) {
    return ".pdf";
  }

  if (/\.html?(?:\?|$)/i.test(normalizedUrl)) {
    return ".html";
  }

  return ".html";
}

async function downloadUrlToFile(url, filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });

  let fetchError = null;
  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; drug-label-parser/1.0)"
      }
    });

    if (response.ok && response.body) {
      await streamPipeline(response.body, createWriteStream(filePath));
      return;
    }
    throw buildStageError(
      "source-fetch",
      `Fetch returned ${response.status} for ${url}.`,
      {
        fetchStatus: response.status,
        fetchContentType: response.headers.get("content-type") || "unknown"
      }
    );
  } catch (error) {
    fetchError = error;
    // curl handles some TLS and redirect combinations better in this environment.
  }

  try {
    await execFileAsync("curl", [
      ...getCurlTlsArgs(),
      "--http1.1",
      "--max-time", "120",
      "-L",
      "-sS",
      "-A", "Mozilla/5.0 (compatible; drug-label-parser/1.0)",
      "-o", filePath,
      url
    ], {
      maxBuffer: 20 * 1024 * 1024
    });
  } catch (curlError) {
    throw buildStageError(
      "source-download",
      `Failed to download ${url}. fetch: ${summarizeError(fetchError)}. curl: ${summarizeError(curlError)}`,
      {
        curlTlsArgs: getCurlTlsArgs().join(" ") || "none"
      }
    );
  }
}

export async function parseDocumentWithLlamaParse({ url, config }) {
  const apiKey = getApiKey(config);
  if (!apiKey) {
    throw new Error("LlamaPath is configured but no API key was provided. Set --llama-path-api-key, config/runtime.json llamaPath.apiKey, LLAMA_CLOUD_API_KEY, or LLAMAPARSE_API_KEY.");
  }

  process.env.LLAMA_CLOUD_API_KEY = apiKey;
  process.env.LLAMAPARSE_API_KEY = apiKey;

  const resultType = getResultType(config);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "drug-label-llama-parse-"));
  const sourcePath = path.join(tempDir, `source${inferDownloadExtension(url)}`);

  try {
    await downloadUrlToFile(url, sourcePath);
    const sourceStats = await stat(sourcePath);

    const client = new LlamaCloud({
      apiKey,
      timeout: 180000,
      maxRetries: 0
    });

    const result = await client.parsing.parse({
      tier: "agentic",
      version: "latest",
      upload_file: createReadStream(sourcePath),
      expand: ["markdown", "text"]
    }, {
      verbose: false
    });

    const markdownText = String(
      result?.markdown_full
      || result?.markdown?.pages?.map((page) => String(page?.markdown || "")).join("\n\n")
      || ""
    ).trim();
    const plainText = String(
      result?.text_full
      || result?.text?.pages?.map((page) => String(page?.text || "")).join("\n\n")
      || ""
    ).trim();
    const text = resultType === "text" ? (plainText || markdownText) : (markdownText || plainText);

    if (!text) {
      throw buildStageError(
        "llama-parse-empty-result",
        `LlamaParse returned no ${resultType} content for ${url}.`,
        {
          downloadedBytes: sourceStats.size,
          sourcePath
        }
      );
    }

    return {
      text,
      resultType
    };
  } catch (error) {
    const stage = error?.stage || "llama-parse";
    const detail = summarizeError(error);
    const extra = {
      ...(error?.extra || {}),
      resultType,
      tempSourcePath: sourcePath
    };
    throw new Error(formatStageDiagnostics({
      url,
      stage,
      detail,
      extra
    }));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
