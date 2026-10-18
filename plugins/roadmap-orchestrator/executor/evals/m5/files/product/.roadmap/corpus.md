# Corpus guide

The target state of Swapshelf is the design record in `docs/corpus/` of this repository: the shelf's page, the keeper's
tools, how it is built, and the vision document `vision.md`, which Dev, the shelf's keeper, owns.

Standards:
- The documents are written for people first: plain prose, short sections, the street's own words.
- Normative claims live in `rules` blocks, one claim per line, under the section they belong to; the prose around
  them is the rationale.
- The vision document carries no rules block.

```json roadmap-corpus
{
  "schema": "roadmap/corpus-guide-m4",
  "source": { "kind": "same-repo", "root": "docs/corpus" },
  "include": ["**/*.md"],
  "vision": "vision.md"
}
```
