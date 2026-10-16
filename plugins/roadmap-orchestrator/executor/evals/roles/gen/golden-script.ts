// Regenerates goldens/<package>.json from every module under packages/<package>/{src,core,legacy}/: one JSON line per
// package listing each module's exported functions, their parameters and the imported helpers each one calls. Goldens
// are only ever written by this script, never by hand.
//
//   node tools/gen-goldens.ts
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MODULE = /^packages\/([^/]+)\/(src|core|legacy)\/[^/]+\.ts$/;

type Export = { name: string; params: string; calls: string[] };

function exportsOf(text: string): Export[] {
  const imported = new Set<string>();
  for (const m of text.matchAll(/import \{([^}]*)\} from/g)) for (const n of m[1]!.split(',')) if (n.trim() !== '') imported.add(n.trim());
  const starts = [...text.matchAll(/^export function /gm)].map((m) => m.index);
  return starts.map((start, i) => {
    const body = text.slice(start, starts[i + 1] ?? text.length);
    const head = /^export function (\w+)\(([^)]*)\)/.exec(body);
    if (head === null) throw new Error(`an export without a signature: ${body.slice(0, 80)}`);
    const calls = [...new Set([...body.slice(head[0].length).matchAll(/\b(\w+)\(/g)].map((c) => c[1]!).filter((n) => imported.has(n)))].sort();
    return { name: head[1]!, params: head[2]!, calls };
  });
}

/** Every golden file (path to content) the modules in `files` (path to content) produce. */
export function goldensOf(files: ReadonlyMap<string, string>): Map<string, string> {
  const byPackage = new Map<string, { path: string; exports: Export[] }[]>();
  for (const path of [...files.keys()].sort()) {
    const m = MODULE.exec(path);
    if (m === null) continue;
    const list = byPackage.get(m[1]!) ?? [];
    list.push({ path, exports: exportsOf(files.get(path)!) });
    byPackage.set(m[1]!, list);
  }
  const out = new Map<string, string>();
  for (const [pkg, modules] of byPackage) out.set(`goldens/${pkg}.json`, `${JSON.stringify({ package: pkg, modules })}\n`);
  return out;
}

function main(): void {
  const files = new Map<string, string>();
  for (const pkg of readdirSync('packages')) {
    for (const dir of ['src', 'core', 'legacy']) {
      const at = join('packages', pkg, dir);
      if (!existsSync(at)) continue;
      for (const f of readdirSync(at)) if (f.endsWith('.ts')) files.set(`packages/${pkg}/${dir}/${f}`, readFileSync(join(at, f), 'utf8'));
    }
  }
  rmSync('goldens', { recursive: true, force: true });
  mkdirSync('goldens');
  for (const [path, text] of goldensOf(files)) writeFileSync(path, text);
}

if (import.meta.main) main();
