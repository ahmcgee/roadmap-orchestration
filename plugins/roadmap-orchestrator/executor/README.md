# Executor console

The executor runs TypeScript directly with Node and has no build step or runtime dependencies.
The read-only web console is prebuilt from `web-src/` using `npm run build:console`;
commit the generated `web/` output along with source changes. `test/console-web-build.test.ts`
rebuilds into a temporary directory and checks every byte and the complete file set.

Browser code uses React, copied shadcn/ui new-york components, unified Radix primitives,
Tailwind v4, Cytoscape and dagre. These are pinned development dependencies. No package
is downloaded at runtime. Fonts are the Latin subsets of Barlow (400/500/600), Barlow
Semi Condensed (500/600), and JetBrains Mono (400/500). The generated
`web/THIRD-PARTY-NOTICES.txt` includes package versions and licence texts. One upstream
package omits its licence from the published tarball; its upstream licence is retained
in `web-src/licenses/` so clean builds stay offline and deterministic.

The asset manifest is the static server's only file allowlist. HTML retains its protocol
and content-hash placeholders; script loading uses external files under the same-origin CSP.
`npm run typecheck` checks executor and browser configurations separately.

The landing view is the milestone line map and full dependency graph. The arc switcher
searches retained arcs. Search (`/`), focus (`Enter`), fit (`f`), filters, zoom, and arrow-key
selection work without changing the current tab. Double-clicking or pressing Enter on a
selected node opens a non-modal, resizable drawer. On small screens the drawer fills the
screen. Invocation history retains native file diffs, parsed briefs, verdicts and live tail.
Other tabs provide plain recorded tables/lists pending the next design phase.

Routes are `#/arcs/<arc>/<tab>[/units/<id>|/invocations/<id>]`; the read-only API is
`/api/<protocol>/arcs`. Old route names have no aliases.

Verification: `npm run typecheck`, `npm run build:console`, then
`node --test --test-concurrency=4 test/console-*.test.ts`. Run each
`test/serial/console-*.test.ts` alone, one file at a time.
