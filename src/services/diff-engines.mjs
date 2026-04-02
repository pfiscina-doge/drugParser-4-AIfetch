function tokenize(value) {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((token) => token.trim())
      .filter(Boolean)
  );
}

function jaccard(left, right) {
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);
  const union = new Set([...leftTokens, ...rightTokens]);

  if (union.size === 0) {
    return 1;
  }

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }

  return intersection / union.size;
}

function bestMatch(sourcePair, productionQa) {
  let winner = null;

  for (const target of productionQa) {
    const questionScore = jaccard(sourcePair.question, target.question);
    const answerScore = jaccard(sourcePair.answer, target.answer);
    const combined = Number(((questionScore * 0.4) + (answerScore * 0.6)).toFixed(3));

    if (!winner || combined > winner.similarityScore) {
      winner = {
        currentProductionQuestion: target.question,
        currentProductionAnswer: target.answer,
        similarityScore: combined
      };
    }
  }

  return winner || {
    currentProductionQuestion: null,
    currentProductionAnswer: null,
    similarityScore: 0
  };
}

function createHeuristicEngine() {
  return {
    name: "heuristic",

    async compareQaSets({ drugName, sourceQa, productionQa }) {
      return sourceQa.map((pair, index) => {
        const match = bestMatch(pair, productionQa);
        return {
          drugName,
          questionRef: `${drugName}#q${index + 1}`,
          sourceQuestion: pair.question,
          sourceAnswer: pair.answer,
          oldText: match.currentProductionAnswer,
          newText: pair.answer,
          ...match
        };
      });
    }
  };
}

function createPerplexityPlaceholder(config) {
  return {
    name: "perplexity",

    async compareQaSets() {
      throw new Error(
        `The Perplexity diff engine is configured, but no automation client is implemented yet. Configure a browser-backed adapter for ${config.perplexityBaseUrl}.`
      );
    }
  };
}

export function createDiffEngine(config) {
  if (config.diffEngine === "perplexity") {
    return createPerplexityPlaceholder(config);
  }

  return createHeuristicEngine();
}
