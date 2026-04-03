function parseLine(line) {
  const trimmed = line.replace(/\s+/g, " ").trim();
  const wasBulleted = /^[•\-\u2022]\s*/.test(trimmed);
  const text = trimmed.replace(/^[•\-\u2022]\s*/, "").trim();

  return {
    text,
    wasBulleted
  };
}

function isQuestionCandidate(line, compiledRegexes, knownStarts) {
  if (!line.text || line.wasBulleted) {
    return false;
  }

  if (knownStarts.some((prefix) => line.text.startsWith(prefix))) {
    return true;
  }

  return compiledRegexes.some((regex) => regex.test(line.text));
}

function shouldTreatAsAnswerContinuation(line, currentQuestion) {
  if (!currentQuestion || !line?.text) {
    return false;
  }

  return (
    /^Tell your healthcare provider /i.test(line.text)
    || /^Before taking .+, tell your healthcare provider /i.test(line.text)
  );
}

export function normalizeSectionText(text) {
  return text
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

export function extractQaPairs({ drugName, text, questionPatterns }) {
  const lines = text
    .split("\n")
    .map(parseLine)
    .filter((line) => line.text);

  const compiledRegexes = questionPatterns.questionRegexes.map((pattern) => new RegExp(pattern, "i"));
  const qaPairs = [];
  let current = null;

  for (const line of lines) {
    if (shouldTreatAsAnswerContinuation(line, current?.question)) {
      current.answer = current.answer ? `${current.answer}\n${line.text}` : line.text;
      continue;
    }

    if (isQuestionCandidate(line, compiledRegexes, questionPatterns.knownQuestionStarts)) {
      if (current) {
        qaPairs.push(current);
      }

      current = {
        question: line.text.endsWith(":") ? line.text.slice(0, -1) : line.text,
        answer: ""
      };
      continue;
    }

    if (current) {
      current.answer = current.answer ? `${current.answer}\n${line.text}` : line.text;
    }
  }

  if (current) {
    qaPairs.push(current);
  }

  const mergedPairs = mergeContinuationQuestions(qaPairs);

  return mergedPairs.map((pair, index) => ({
    id: `${drugName}-${index + 1}`,
    question: pair.question.trim(),
    answer: pair.answer.trim()
  }));
}

function mergeContinuationQuestions(pairs) {
  const merged = [];

  for (const pair of pairs) {
    const previous = merged[merged.length - 1];

    if (
      previous
      && /^Before using .+, tell your healthcare provider about all of your medical conditions/i.test(previous.question)
      && (
        /^Tell your healthcare provider about all the medicines you take/i.test(pair.question)
        || /^Before using .+, talk to your healthcare provider about low blood sugar and how to manage it/i.test(pair.question)
      )
    ) {
      previous.answer = `${previous.answer}\n${pair.question} ${pair.answer}`.trim();
      continue;
    }

    merged.push({ ...pair });
  }

  return merged;
}
