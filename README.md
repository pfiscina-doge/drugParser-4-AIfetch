# Agentic Drug Label Load Diff

This project ingests a shared full drug catalog resource and can run either the whole catalog or a comma-separated subset of drug names.

## Notes

- The code is adapter-based because the requested browser workflow depends on an external browser agent runtime that is not present in this workspace.
- A built-in `fetch` document parser is included for basic HTML/PDF download workflows.
- A built-in `heuristic` diff engine is included so the pipeline runs end-to-end without an LLM.
- A built-in `rule-based` document QA extractor is the default.
- An `ai` document QA extractor can be enabled with Perplexity by default, while the endpoint and model remain configurable.
- TrumpRX parsing can use either the linked PDF path or an `agent-browser` accordion-expansion path.
- The default TrumpRX parse mode is `agent-browser`.
- A `perplexity` engine stub is included as a configurable placeholder for future browser/LLM automation.

## Run

Run the whole shared catalog resource:

```bash
npm start -- --all-drugs --output ./output/results.json --save-intermediate
```

Run a comma-separated subset from the shared catalog resource:

```bash
npm start -- --drugs duavee,zepbound --output ./output/results.json --save-intermediate
```

Use a custom catalog file explicitly:

```bash
npm start -- --catalog ./examples/catalog.sample.json --output ./output/results.json --save-intermediate
```

At the start of each drug run, `chooseQAExtractionMethod` picks the document parser automatically unless you override it with `--new-doc-parse-method`:

- catalog URL ending in `.pdf`: uses the Mayzent-style `fetch` path
- catalog URL not ending in `.pdf`: uses the Chantix-style `agent-browser` path

You can still override that choice explicitly with `--new-doc-parse-method <fetch|agent-browser>`.

Choose how document text is turned into question/answer pairs with `--doc-qa-extractor`:

- `rule-based`: default, uses the local parser heuristics
- `ai`: uses the configured LLM endpoint to extract question/answer pairs from already-loaded document text
- `agentic`: asks the configured LLM to extract question/answer pairs from the already-loaded document text snapshot and return JSON

How these two switches apply:

- `--doc-qa-extractor` controls question/answer extraction for both the source catalog document and the TrumpRX patient-information PDF

Use AI extraction with the default Perplexity config. If `llm.apiKeyFile` is set in runtime config, the CLI will preload that key automatically:

```bash
npm start --   --drugs duavee,zepbound   --output ./output/results.json   --doc-qa-extractor ai
```

Ask Perplexity a direct question and parse the response into JSON output:

```bash
PERPLEXITY_API_KEY=your_key_here npm run ask:perplexity -- --question "What is the capital of France?"
```

If you want structured output, ask for JSON in the prompt. The helper returns:

- `answer`: parsed text content
- `parsedJson`: JSON object when the model answered with valid JSON, otherwise `null`
- `citations`: citations array when present
- `usage`: token usage metadata when present

TrumpRX now follows the same document-parsing methodology as the source catalog document. The pipeline loads the TrumpRX patient-information PDF and runs it through the configured document parser and QA extractor.

```bash
npm start --   --drugs duavee,zepbound   --output ./output/results.json
```


Update `config/question-patterns.json` from discovered questions in a saved run output:

```bash
npm run update:question-patterns -- --input ./examples/mayzent/trumprx-pdf.output.json
```

Example files are saved in `examples/mayzent` and `examples/chantix`.

Rule-based examples:

Generate the Mayzent rule-based example output with:

```bash
node src/cli.mjs --drugs mayzent --output ./examples/mayzent/trumprx-pdf.output.json
```

Files in `examples/mayzent`:

- `trumprx-pdf.command.txt`: saved command for the Mayzent rule-based example
- `trumprx-pdf.output.json`: captured output from that run
- `agentic-only-from-catalog.command.txt`: saved command for the Mayzent agentic example
- `agentic-only-from-catalog.output.json`: captured output from the Mayzent agentic example
- The rule-based example uses `docQaExtractor=rule-based` and `diffEngine=heuristic`
- The agentic example uses `docQaExtractor=agentic` with `--only-from-catalog-url`

Generate the Chantix `agent-browser` rule-based example output with:

```bash
node src/cli.mjs --drugs chantix --new-doc-parse-method agent-browser --output ./examples/chantix/agent-browser.output.json
```

Generate the Chantix agentic example output with:

```bash
node src/cli.mjs --drugs chantix --doc-qa-extractor agentic --only-from-catalog-url --output ./examples/chantix/agentic-only-from-catalog.output.json
```

Files in `examples/chantix`:

- `agent-browser.command.txt`: saved command for the Chantix `agent-browser` rule-based example
- `agent-browser.output.json`: captured output from that run
- `agentic-only-from-catalog.command.txt`: saved command for the Chantix agentic example
- `agentic-only-from-catalog.output.json`: captured output from the Chantix agentic example
- The Chantix rule-based example follows the TrumpRx `View Patient Information (PDF).` href and then parses that target with the same `agent-browser` document-loading flow used for the source document
- The Chantix agentic example uses `docQaExtractor=agentic` with `--only-from-catalog-url`

## CLI options

- `--catalog <path>`
- `--drugs <comma,separated,names>`
- `--all-drugs`
- `--output <path>`
- `--intermediate-dir <path>`
- `--save-intermediate`
- `--agentic-debug`: when using `agentic`, writes the exact prompt and raw response under the intermediate directory
- `--only-from-catalog-url`: when using `agentic`, tells the LLM to use only the parsed content from the source URL and not follow links
- `--new-doc-parse-method <fetch|agent-browser>`: optional override for `chooseQAExtractionMethod`
- `--diff-engine <heuristic|perplexity>`
- `--doc-qa-extractor <rule-based|ai|agentic>`
- `--llm-base-url <url>`
- `--llm-api-key <key>`
- `--llm-model <model>`
- `--source-html-dir <path>`
- `--trumprx-base-url <url>`
- `--perplexity-base-url <url>`

## Key files

- `config/catalog.full.json`: shared full catalog resource
- `config/aliases.json`: name-to-alias mapping for TrumpRX lookup
- `config/question-patterns.json`: known question prefixes and matching rules
- `config/runtime.json`: runtime endpoints such as the TrumpRX base URL
  - includes `trumpRxBaseUrl` and `llm` settings
- `src/cli.mjs`: command-line entrypoint
- `src/pipeline.mjs`: main orchestration
- `src/perplexity-ask.mjs`: small CLI utility for direct Perplexity questions
- `src/services/perplexity-client.mjs`: shared Perplexity API caller and response parser
- `src/services/qa-extractors.mjs`: switchable rule-based and AI-backed document QA extraction
- `src/services/trumprx-agent-browser.mjs`: TrumpRX `agent-browser` helpers for locating the patient-information href on the product page

## Output shape

The main output file contains one record per drug with:

- `drugName`
- `catalogEntry`
- `sourceExtraction`
- `trumpRx`
- `status`
- `diff`

The `trumpRx` object also includes:

- `medGuideUrl`
- `medGuideMatchesCatalogUrl`
- `retrievalSteps`

When a product is not found on TrumpRX, `status` is set to `new product`.

## Runtime config

`config/runtime.json` holds shared runtime settings:

```json
{
  "trumpRxBaseUrl": "https://trumprx.gov/p",
  "llm": {
    "baseUrl": "https://api.perplexity.ai",
    "model": "sonar",
    "apiKeyEnvVar": "PERPLEXITY_API_KEY",
    "apiKeyFile": "./config/perplexity-key-pf.txt"
  }
}
```

- `llm.baseUrl`: Perplexity API base URL used when `--doc-qa-extractor ai`
- `llm.model`: Perplexity model name sent to the chat completions API
- `llm.apiKeyEnvVar`: environment variable name to read the API key from, defaulting to `PERPLEXITY_API_KEY`
- `llm.apiKeyFile`: optional local file path used by the CLI to preload the API key for document QA extraction
