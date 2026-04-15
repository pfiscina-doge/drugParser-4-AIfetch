import assert from "node:assert/strict";
import test from "node:test";
import { listLlamaFixtureNames, loadLlamaFixtureRuntimeConfig, runLlamaFixtureQaExample } from "./llama-path-fixture-runner.mjs";

const fixtureNames = await listLlamaFixtureNames();
const runtimeConfig = await loadLlamaFixtureRuntimeConfig();
const hasProviderKey = Boolean(
  runtimeConfig.llmApiKey
  || process.env[runtimeConfig.llmApiKeyEnvVar || "PERPLEXITY_API_KEY"]
  || runtimeConfig.anthropicApiKey
  || process.env[runtimeConfig.anthropicApiKeyEnvVar || "ANTHROPIC_API_KEY"]
  || process.env.OPENAI_API_KEY
);

for (const fixtureName of fixtureNames) {
  test(`llama-path fixture QA: ${fixtureName}`, { timeout: 10 * 60_000 }, async (t) => {
    if (!hasProviderKey) {
      t.skip("No LLM API key available for the configured provider.");
      return;
    }

    const result = await runLlamaFixtureQaExample(fixtureName);

    assert.ok(result.processedMarkdown.text.length > 0, "processed markdown should not be empty");
    assert.ok(result.qaResult.rawResponse.length > 0, "raw response should not be empty");
    assert.ok(result.outputPath.endsWith(".json"), "result should be written to a json file");
  });
}

