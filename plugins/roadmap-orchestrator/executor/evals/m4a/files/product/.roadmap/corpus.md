# Corpus guide

The target state of Tidewater is the design record in `docs/corpus/` of this repository: numbered documents, two
of them with a sub-folder of the same name, the decision records in `0070_ADRs/`, and the vision document
`0005_Vision.md`, which the harbour master owns.

Standards:
- The documents are written for people first: plain prose, short sections, the harbour's own words.
- Normative claims live in `rules` blocks, one claim per line, under the section they belong to; the prose around
  them is the rationale.
- The decision records are history. They are not edited after acceptance and carry no rules blocks.
- The vision document carries no rules block.

```json roadmap-corpus
{
  "schema": "roadmap/corpus-guide-m4",
  "source": { "kind": "same-repo", "root": "docs/corpus" },
  "include": ["**/*.md"],
  "vision": "0005_Vision.md"
}
```
