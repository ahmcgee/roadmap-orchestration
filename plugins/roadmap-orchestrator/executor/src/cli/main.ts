// CLI entry. M1 step 0 stub: only `--version` exists. Every command lands in step 13; until then
// the executor refuses loudly rather than pretending to run.
import { createRequire } from 'node:module';

const pkg = createRequire(import.meta.url)('../../package.json') as { version: string };

export async function main(argv: readonly string[]): Promise<void> {
  const [command] = argv;
  if (command === '--version' || command === 'version') {
    process.stdout.write(`${pkg.version}\n`);
    return;
  }
  process.stderr.write(`roadmap: not implemented (M1 step 13): ${JSON.stringify(argv)}\n`);
  process.exitCode = 64;
}
