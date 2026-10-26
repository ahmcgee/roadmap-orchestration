import { randomUUID } from 'node:crypto';
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, linkSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = '# Managed by roadmap-orchestrator: launcher v1';
const PREFIX = `#!/bin/sh\n${MARKER}\n`;
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
const entry = fileURLToPath(new URL('../../bin/roadmap', import.meta.url));

/** Install only a launcher; the plugin remains the source of code and version identity. */
export function installLauncher(binDir = '/usr/local/bin') {
  const destination = resolve(binDir, 'roadmap');
  const launcher = `${PREFIX}exec ${quote(process.execPath)} ${quote(entry)} "$@"\n`;
  let previous: string | null = null; let mode: number | null = null;
  try {
    const stat = lstatSync(destination);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing to replace ${destination}: it is not a managed Roadmap launcher.`);
    mode = stat.mode & 0o777;
    previous = readFileSync(destination, 'utf8');
    if (!previous.startsWith(PREFIX)) throw new Error(`Refusing to replace ${destination}: it belongs to another command. Choose another --bin-dir.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const changed = previous !== launcher || mode !== 0o755;
  if (changed) {
    mkdirSync(dirname(destination), { recursive: true });
    const temp = join(dirname(destination), `.roadmap-launcher-${randomUUID()}`);
    try {
      writeFileSync(temp, launcher, { flag: 'wx', mode: 0o755 });
      chmodSync(temp, 0o755);
      if (previous === null) linkSync(temp, destination); // Atomic no-clobber installation, including concurrent installers.
      else {
        const stat = lstatSync(destination);
        if (!stat.isFile() || readFileSync(destination, 'utf8') !== previous) throw new Error(`Launcher changed during installation: ${destination}. Run the installer again.`);
        renameSync(temp, destination);
      }
    } finally { rmSync(temp, { force: true }); }
  }
  let resolved: string | null = null;
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    const candidate = resolve(dir || '.', 'roadmap');
    try {
      if (lstatSync(candidate).isDirectory()) continue;
      accessSync(candidate, constants.X_OK); resolved = candidate; break;
    } catch { /* Not an executable command in this PATH entry. */ }
  }
  return { path: destination, entry, changed, onPath: resolved !== null && realpathSync(resolved) === realpathSync(destination), resolved };
}

export function installCli(argv: readonly string[]): void {
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write('Usage: install-roadmap [--bin-dir <directory>]\nInstalls a managed roadmap launcher (default /usr/local/bin). Run again after plugin updates.\n');
    return;
  }
  if (argv.length !== 0 && !(argv.length === 2 && argv[0] === '--bin-dir' && argv[1])) throw new Error('Usage: install-roadmap [--bin-dir <directory>]');
  if (!existsSync(entry)) throw new Error(`Plugin entry point is missing: ${entry}`);
  const result = installLauncher(argv[1]);
  process.stdout.write(`${result.changed ? 'Installed' : 'Already current'}: ${result.path}\n`);
  if (result.onPath) process.stdout.write('Ready: roadmap --version\nViewer: roadmap tui\n');
  else {
    process.stdout.write(result.resolved ? `PATH currently resolves roadmap to ${result.resolved}.\n` : 'The launcher directory is not on this terminal’s PATH.\n');
    process.stdout.write(`For this terminal: export PATH=${quote(dirname(result.path))}:"$PATH"\nAdd that directory to the container environment for future terminals.\n`);
  }
}
