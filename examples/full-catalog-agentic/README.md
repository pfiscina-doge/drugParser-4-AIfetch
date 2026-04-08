# Full Catalog Agentic

This folder contains a source-only `agentic` catalog run snapshot with TrumpRX parsing disabled.

## Command

```bash
node src/cli.mjs --catalog ./examples/full-catalog-agentic/catalog.excluding-unfinished.json --doc-qa-extractor agentic --skip-trumprx --save-intermediate --output ./examples/full-catalog-agentic/full-catalog-agentic.output.json
```

## Outputs

- `catalog.excluding-unfinished.json`: filtered catalog used for this example run
- `full-catalog-agentic.output.json`: snapshot of per-drug question counts assembled from the latest completed source QA outputs for the filtered catalog
- `drug-question-counts.csv`: CSV list of drug names and question counts for the filtered catalog

## Summary

- Total drugs in filtered catalog: 76
- Parsed: 76
- Missing: 0
- Invalid JSON: 0

## Excluded Unfinished Drugs

- cetrotide
- gonal-f
- jentadueto
- ovidrel
- wegovy

This package was regenerated from the current per-drug source QA files under `output/intermediate/` using the filtered catalog above.
