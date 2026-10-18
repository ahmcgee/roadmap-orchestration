# How the shelf is built

Small on purpose: one person keeps it, on a laptop and a tiny always-on box under the stairs.

- Node 24 and nothing else. No packages, no build step, no database: the shelf is one JSON file.
- The server renders every page. The pages work without client-side JavaScript, so an old phone or a reader mode
  shows them whole.
- The server listens on 127.0.0.1, on `PORT` (default 3000), and reads the shelf from `SWAPSHELF_DATA` (default
  `data/shelf.json`). `npm start` runs it.
- `npm test` runs the tests with `node --test`.

```rules
T-15: The product has no runtime dependencies; it runs on Node 24 alone.
T-16: Every page is rendered on the server and works without client-side JavaScript.
T-17: The books live in one JSON file (`SWAPSHELF_DATA`, default `data/shelf.json`); every write replaces it atomically, so a reader never sees half a file.
```
