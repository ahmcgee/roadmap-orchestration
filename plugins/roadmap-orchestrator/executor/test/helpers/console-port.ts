// Allocate a free explicit test port without ever binding the product default on this host.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
export function freeConsolePort(): number {
  return Number(execFileSync(process.execPath, ['-e', "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>{if(p===4747)process.exit(1);process.stdout.write(String(p))})})"], { encoding: 'utf8' }));
}

/** Retry the actual bind, not merely the probe: another process may claim the port after close. */
async function retryBind<T>(bind: () => Promise<T>, collision: () => void): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await bind(); }
    catch (error) {
      if (attempt >= 7 || !(error instanceof Error) || !/\bEADDRINUSE\b/.test(error.message)) throw error;
      collision();
    }
  }
}
export async function withConsolePort<T>(bind: (port: number) => Promise<T>): Promise<T> {
  let port = freeConsolePort();
  return retryBind(() => bind(port), () => { port = freeConsolePort(); });
}
/** Keep an existing setting unless the real startup reports a collision (including stop/restart). */
export async function withConfiguredConsolePort<T>(repo: string, bind: () => Promise<T>): Promise<T> {
  return retryBind(bind, () => {
    const path = join(repo, '.roadmap', 'config.json'), config = JSON.parse(readFileSync(path, 'utf8'));
    config.webConsole = { ...config.webConsole, port: freeConsolePort() };
    writeFileSync(path, JSON.stringify(config));
  });
}
