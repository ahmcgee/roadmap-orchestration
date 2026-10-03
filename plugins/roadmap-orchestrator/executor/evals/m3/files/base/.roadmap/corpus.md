# Corpus guide

The corpus is the ledger CLI's target state: one rules document and the vision document, under `docs/corpus/`.

```json roadmap-corpus
{
  "schema": "roadmap/corpus-guide-m4",
  "source": { "kind": "same-repo", "root": "docs/corpus" },
  "include": ["**/*.md"],
  "vision": "vision.md"
}
```
