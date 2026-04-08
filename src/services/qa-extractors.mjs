import { extractQaPairs as extractQaPairsRuleBased } from "./question-extractor.mjs";
import { createPerplexityAgenticExtractor } from "./perplexity-agentic-extractor.mjs";

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

export function createQaExtractor(config) {
  if (config.docQaExtractor === "agentic" || config.docQaExtractor === "ai") {
    return createPerplexityAgenticExtractor(config);
  }

  return createRuleBasedExtractor();
}
