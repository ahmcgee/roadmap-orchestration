// The slow-capture fixture of the dev.71 lag tests: a git that waits while a flag file exists, and an event-stream reader.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type Frame = { event: string; data: unknown; at: number };
/** Every frame of one event stream, as it arrives. */
export function frames(body: ReadableStream<Uint8Array>, into: Frame[]): void {
  const reader = body.getReader(), decoder = new TextDecoder(); let buffer = '';
  void (async () => {
    for (;;) {
      let chunk; try { chunk = await reader.read(); } catch { return; }
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      for (let i = buffer.indexOf('\n\n'); i >= 0; i = buffer.indexOf('\n\n')) {
        const block = buffer.slice(0, i); buffer = buffer.slice(i + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1];
        if (event && data) into.push({ event, data: JSON.parse(data), at: Date.now() });
      }
    }
  })();
}
/** A git that waits up to `perSpawnS` seconds, in tenths, while `flag` exists, then runs the real git. */
export function slowGit(): { dir: string; flag: string; slow(on: boolean): void; moveRef(repo: string): void; close(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-lag-git-')), flag = join(dir, 'slow');
  const real = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
  writeFileSync(join(dir, 'git'), `#!/bin/sh\nn=0\nwhile [ -e '${flag}' ] && [ $n -lt 16 ]; do sleep 0.1; n=$((n+1)); done\nexec '${real}' "$@"\n`);
  chmodSync(join(dir, 'git'), 0o755);
  let refs = 0;
  return {
    dir, flag, slow(on) { if (on) writeFileSync(flag, ''); else rmSync(flag, { force: true }); },
    // dev.78: a capture asks the refs again (through this git) only once they moved: a new ref, by the real git, at once.
    moveRef(repo) { execFileSync(real, ['-C', repo, 'update-ref', `refs/heads/console-lag-${++refs}`, 'HEAD']); },
    close() { rmSync(dir, { recursive: true, force: true }); },
  };
}
