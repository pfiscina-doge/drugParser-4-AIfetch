import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    input: "",
    patterns: "./config/question-patterns.json",
    dryRun: false
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];

    if (token === "--input" && next) {
      args.input = next;
      index += 1;
    } else if (token === "--patterns" && next) {
      args.patterns = next;
      index += 1;
    } else if (token === "--dry-run") {
      args.dryRun = true;
    }
  }

  if (!args.input) {
    throw new Error("Missing required argument: --input");
  }

  return args;
}

function normalizeComparable(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[,:]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function collectDrugNames(output) {
  return unique((output.results || []).map((result) => result.drugName).filter(Boolean));
}

function collectDiscoveredQuestions(output) {
  const discovered = Array.isArray(output.discoveredQuestionFormats)
    ? output.discoveredQuestionFormats
    : [];
  const sourceQuestions = (output.results || []).flatMap((result) =>
    (result?.sourceExtraction?.qaPairs || []).map((pair) => pair.question)
  );

  return unique([...discovered, ...sourceQuestions].map((question) => String(question || "").trim()));
}

function shouldSkipDiscoveredQuestion(question) {
  const normalized = String(question || "").trim();

  return /^Tell your healthcare provider /i.test(normalized);
}

function replaceDrugNames(value, drugNames, replacement) {
  let updated = String(value || "");

  for (const drugName of [...drugNames].sort((left, right) => right.length - left.length)) {
    updated = updated.replace(new RegExp(escapeRegex(drugName), "gi"), replacement);
  }

  return updated;
}

function deriveStartCandidate(question, knownStarts, drugNames) {
  const raw = String(question || "").trim().replace(/[?.:]+$/, "").trim();
  if (!raw) {
    return null;
  }

  const comparableRaw = normalizeComparable(raw);
  if (knownStarts.some((start) => comparableRaw.startsWith(normalizeComparable(start)))) {
    return null;
  }

  const withoutDrugNames = replaceDrugNames(raw, drugNames, " ")
    .replace(/\s+,/g, ",")
    .replace(/,\s+/g, ", ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[,:-]+$/, "")
    .trim();

  if (!withoutDrugNames) {
    return null;
  }

  const comparableCandidate = normalizeComparable(withoutDrugNames);
  if (knownStarts.some((start) => comparableCandidate.startsWith(normalizeComparable(start)))) {
    return null;
  }

  return withoutDrugNames;
}

function deriveRegexCandidate(question, drugNames) {
  const raw = String(question || "").trim();
  if (!raw) {
    return null;
  }

  const withoutTrailingPunctuation = raw.replace(/[?.:]+$/, "").trim();
  const generalized = replaceDrugNames(withoutTrailingPunctuation, drugNames, "__DRUG__");
  const escaped = escapeRegex(generalized).replace(/__DRUG__/g, ".+");

  return `^(${escaped}[?.:]?)$`;
}

async function main() {
  const args = parseArgs(process.argv);
  const rootDir = process.cwd();
  const inputPath = path.resolve(rootDir, args.input);
  const patternsPath = path.resolve(rootDir, args.patterns);

  const [inputRaw, patternsRaw] = await Promise.all([
    readFile(inputPath, "utf8"),
    readFile(patternsPath, "utf8")
  ]);

  const output = JSON.parse(inputRaw);
  const patterns = JSON.parse(patternsRaw);
  const knownStarts = Array.isArray(patterns.knownQuestionStarts) ? patterns.knownQuestionStarts : [];
  const questionRegexes = Array.isArray(patterns.questionRegexes) ? patterns.questionRegexes : [];
  const drugNames = collectDrugNames(output);
  const discoveredQuestions = collectDiscoveredQuestions(output)
    .filter((question) => !shouldSkipDiscoveredQuestion(question));

  const newStarts = unique(discoveredQuestions
    .map((question) => deriveStartCandidate(question, knownStarts, drugNames))
    .filter(Boolean));
  const newRegexes = unique(discoveredQuestions
    .map((question) => deriveRegexCandidate(question, drugNames))
    .filter((pattern) => pattern && !questionRegexes.includes(pattern)));

  const updated = {
    knownQuestionStarts: [...knownStarts, ...newStarts],
    questionRegexes: [...questionRegexes, ...newRegexes]
  };

  if (!args.dryRun) {
    await writeFile(patternsPath, `${JSON.stringify(updated, null, 2)}\n`);
  }

  console.log(JSON.stringify({
    inputPath,
    patternsPath,
    discoveredQuestionCount: discoveredQuestions.length,
    addedKnownQuestionStarts: newStarts,
    addedQuestionRegexes: newRegexes,
    dryRun: args.dryRun
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
