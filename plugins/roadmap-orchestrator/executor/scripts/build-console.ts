// The executor runs from source. Only these committed browser assets are compiled.
import { build } from 'esbuild';
import { readFile, writeFile, mkdir, readdir, rm, copyFile } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--out')) throw new Error('Usage: node scripts/build-console.ts [--out <dir>]');
const out = resolve(root, args[1] ?? 'web');
await mkdir(out, { recursive: true });
// Remove only generated files from a previous build, including retired fonts.
try { for (const file of JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8')) as string[]) await rm(join(out, file), { force: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const result = await build({ absWorkingDir: root, entryPoints: ['web-src/main.tsx'], outfile: join(out, 'app.js'), bundle: true, minify: true, format: 'iife', target: 'es2022', platform: 'browser', legalComments: 'external', metafile: true, write: true, define: { 'process.env.NODE_ENV': '"production"' } });
const css = spawnSync(process.execPath, ['node_modules/@tailwindcss/cli/dist/index.mjs', '-i', 'web-src/styles.css', '-o', join(out, 'app.css'), '--minify'], { cwd: root, encoding: 'utf8' });
if (css.status !== 0) throw new Error(css.stderr || css.stdout);
const packages = new Map<string, { name: string; version: string; license: string; text: string }>();
async function notice(path: string) {
  let dir = path;
  while (dir !== dirname(dir)) {
    try {
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { name: string; version: string; license?: string };
      if (!pkg.name || packages.has(pkg.name)) return;
      const names = (await readdir(dir)).filter(name => /^(licen[cs]e|copying|ofl)(\.|$)/i.test(name)).sort();
      const supplemental = join(root, 'web-src/licenses', pkg.name.replaceAll('/', '__') + '.txt');
      const text = (names.length ? (await Promise.all(names.map(name => readFile(join(dir, name), 'utf8')))).join('\n') : await readFile(supplemental, 'utf8')).replaceAll('\r\n', '\n').trim();
      packages.set(pkg.name, { name: pkg.name, version: pkg.version, license: pkg.license ?? 'See licence text', text }); return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    dir = dirname(dir);
  }
  throw new Error(`Package not found for ${relative(root, path)}`);
}
for (const pkg of ['react', 'react-dom', 'radix-ui', 'cmdk', 'cytoscape', 'lucide-react', 'class-variance-authority', 'clsx', 'tailwind-merge']) await notice(join(root, 'node_modules', pkg));
for (const input of Object.entries(Object.values(result.metafile.outputs).find(output => output.entryPoint)?.inputs ?? {}).filter(([path, info]) => path.includes('node_modules/') && info.bytesInOutput > 0).map(([path]) => path).sort()) await notice(dirname(resolve(root, input)));
const fonts: [string, number[]][] = [['barlow', [400, 500, 600]], ['barlow-semi-condensed', [500, 600]], ['jetbrains-mono', [400, 500]]];
await mkdir(join(out, 'fonts'), { recursive: true });
for (const [family, weights] of fonts) {
  await notice(join(root, 'node_modules/@fontsource', family));
  for (const weight of weights) { const name = `${family}-latin-${weight}-normal.woff2`; await copyFile(join(root, 'node_modules/@fontsource', family, 'files', name), join(out, 'fonts', name)); }
}
await notice(join(root, 'node_modules/tailwindcss'));
await notice(join(root, 'node_modules/tw-animate-css'));
const legalPath = join(out, 'app.js.LEGAL.txt');
const legal = (await readFile(legalPath, 'utf8')).trim();
await rm(legalPath);
const notices = [...packages.values()].sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).map(pkg => `${pkg.name} ${pkg.version}\nLicence: ${pkg.license}\n\n${pkg.text}`).join('\n\n' + '='.repeat(72) + '\n\n');
const componentsLicense = await readFile(join(root, 'web-src/components/ui/LICENSE'), 'utf8');
await writeFile(join(out, 'THIRD-PARTY-NOTICES.txt'), `${notices}\n\nshadcn/ui new-york adapted source components\nLicence: MIT\n\n${componentsLicense}\nCollected bundle notices\n\n${legal}\n`);
await writeFile(join(out, 'index.html'), `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta name="roadmap-protocol" content="__PROTOCOL__">\n<title>Roadmap</title>\n<link rel="icon" href="data:,">\n<link rel="stylesheet" href="__ASSET_ROOT__/app.css">\n<script defer src="__ASSET_ROOT__/app.js"></script>\n</head>\n<body><div id="root"></div><noscript>Roadmap requires JavaScript to display observations.</noscript></body>\n</html>\n`);
const files: string[] = [];
async function walk(dir: string) { for (const entry of await readdir(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) await walk(path); else if (entry.name !== 'manifest.json') files.push(relative(out, path).replaceAll('\\', '/')); } }
await walk(out);
await writeFile(join(out, 'manifest.json'), JSON.stringify(files.sort(), null, 2) + '\n');
console.log(`Built console: ${files.length} files`);
