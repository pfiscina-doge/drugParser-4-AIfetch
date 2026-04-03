import { askPerplexity } from "./services/perplexity-client.mjs";

function parseArgs(argv) {
  const args = {
    question: "",
    apiKey: "",
    model: "sonar",
    baseUrl: "https://api.perplexity.ai",
    systemPrompt: ""
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];

    if (token === "--question" && next) {
      args.question = next;
      index += 1;
    } else if (token === "--api-key" && next) {
      args.apiKey = next;
      index += 1;
    } else if (token === "--model" && next) {
      args.model = next;
      index += 1;
    } else if (token === "--base-url" && next) {
      args.baseUrl = next;
      index += 1;
    } else if (token === "--system-prompt" && next) {
      args.systemPrompt = next;
      index += 1;
    }
  }

  if (!args.question) {
    throw new Error("Missing required argument: --question");
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const result = await askPerplexity({
    question: args.question,
    apiKey: args.apiKey,
    model: args.model,
    baseUrl: args.baseUrl,
    systemPrompt: args.systemPrompt || undefined
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
