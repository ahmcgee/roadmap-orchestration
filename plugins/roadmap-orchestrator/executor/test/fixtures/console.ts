import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { arcId } from '../../src/core/ids.ts';
import { absPath } from '../../src/core/values.ts';
import { gitCommonDir } from '../../src/git/git.ts';
import { parityArc } from './status-parity.ts';
export function consoleFixture() {
  const f = parityArc();
  const repo = absPath(f.d.repo);
  const common = gitCommonDir(repo);
  const runDir = absPath(join(common, 'roadmap-runtime', f.d.arc));
  mkdirSync(join(common, 'roadmap-runtime'), { recursive: true });
  cpSync(f.runDir, runDir, { recursive: true });
  return { repo, common, runDir, hostDir: f.hostDir, arc: arcId(f.d.arc) };
}
export function setConsolePort(repo: string, port: number): void {
  const path = join(repo, '.roadmap', 'config.json');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...raw, webConsole: { host: '127.0.0.1', port } }));
}
