import { enableCompileCache } from 'node:module';
enableCompileCache();
const [{ serveConsole }, { publishConsoleLease, releaseConsoleLease }, { consoleUrl }, { selfIdentity }, { readBootId }, { absPath, nonce }, { CONSOLE_PROTOCOL }] = await Promise.all([
  import('../console/http.ts'), import('../console/lease.ts'), import('../console/settings.ts'), import('../host/liveness.ts'), import('../contain/proc.ts'), import('../core/values.ts'), import('../observation/protocol.ts'),
]);
const [repoArg, commonArg, hostArg, host, portArg, nonceArg] = process.argv.slice(2);
if (!repoArg || !commonArg || !hostArg || !host || !portArg || !nonceArg) throw new Error('console service needs repo, common, hostDir, host, port, nonce');
const repo = absPath(repoArg), common = absPath(commonArg), hostDir = absPath(hostArg), port = Number(portArg);
let lease: import('../console/lease.ts').ConsoleLease | null = null;
const console = await serveConsole({ repo, common, hostDir, host, port, instance: nonceArg });
lease = { ...selfIdentity(), bootId: readBootId(), nonce: nonce(nonceArg), executorVersion: CONSOLE_PROTOCOL, repo, common, hostDir, configSource: `${repo}/.roadmap/config.json`,
  host, port: console.port, bindUrl: consoleUrl(host, console.port, false), url: console.url, ready: true, startedAt: new Date().toISOString() };
publishConsoleLease(lease);
let closing = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => {
  if (closing) return; closing = true;
  void console.close().then(() => { if (lease) releaseConsoleLease(lease); });
});
