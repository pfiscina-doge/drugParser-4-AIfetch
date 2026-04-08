# Full Catalog Agentic

This folder contains a source-only `agentic` catalog run snapshot with TrumpRX parsing disabled.

## Command

```bash
node src/cli.mjs --all-drugs --doc-qa-extractor agentic --skip-trumprx --save-intermediate --output ./examples/full-catalog-agentic/full-catalog-agentic.output.json
```

## Outputs

- `full-catalog-agentic.output.json`: snapshot of per-drug question counts assembled from the latest completed source QA outputs
- `drug-question-counts.csv`: CSV list of drug names and question counts

## Summary

- Total drugs: 81
- Parsed: 76
- Missing: 5
- Invalid JSON: 0

## Unfinished Drugs

- cetrotide
- gonal-f
- jentadueto
- ovidrel
- wegovy

The long-running aggregate CLI output did not flush a final JSON file in this session, so this package was assembled from the completed per-drug source QA files under `output/intermediate/` after running the command above.
