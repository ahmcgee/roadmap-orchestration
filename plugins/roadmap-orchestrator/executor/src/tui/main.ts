import { emitKeypressEvents, type Key } from 'node:readline';
import { Worker } from 'node:worker_threads';
import { CliError, type RunLocator } from '../input/cli.ts';
import type { AbsPath } from '../core/values.ts';
import { Terminal } from './terminal.ts';
import { ViewState } from './state.ts';
import { contentHeight } from './view.ts';
import type { ObserveReply, ObserveRequest } from './types.ts';

/** The terminal thread does no filesystem or Git reads. Only one observation is ever in flight. */
export async function tui(locator: RunLocator, hostDir: AbsPath): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new CliError('tui needs an interactive terminal on stdin and stdout; use roadmap status or roadmap watch for piped output');
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { stdout: true, stderr: true });
  const state = new ViewState();
  const terminal = new Terminal();
  const previousRaw = process.stdin.isRaw;
  const color = process.env['NO_COLOR'] === undefined && process.env['TERM'] !== 'dumb';
  const ascii = process.env['ROADMAP_TUI_ASCII'] === '1' || process.env['TERM'] === 'dumb' || process.env['LC_ALL'] === 'C';
  let inFlight = false; let token = 0; let finished = false; let interval: NodeJS.Timeout | undefined;
  let fail: (e: Error) => void = () => {};
  let finish: () => void = () => {};
  const height = (): number => contentHeight(process.stdout.rows || 24);
  const draw = (): void => terminal.draw(state.renderFrame(process.stdout.columns || 80, process.stdout.rows || 24, ascii), process.stdout.columns || 80, process.stdout.rows || 24, color);
  const request = (): void => {
    if (inFlight || finished) return;
    inFlight = true;
    const message: ObserveRequest = { locator, hostDir, pinned: state.canFollowHost() ? null : state.display?.run ?? null, log: state.help ? null : state.logRequest, token };
    worker.postMessage(message);
  };
  const reply = (message: ObserveReply): void => {
    if (finished) return;
    inFlight = false;
    if (message.token === token) {
      if (message.usage) state.usage = message.usage;
      if (message.display) state.accept(message.display);
      if (message.error) state.error = message.error;
      if (message.log && state.logRequest) state.acceptLog(message.log, height());
      draw();
    } else request();
  };
  const keypress = (text: string | undefined, key: Key): void => {
    if (key.ctrl && key.name === 'c') { finish(); return; }
    const before = state.observationKey();
    if (state.key(key.name === 'tab' && key.shift ? 'backtab' : key.name ?? '', text ?? '', height())) { finish(); return; }
    const changed = before !== state.observationKey();
    if (changed) token++;
    draw();
    if (changed) request();
  };
  const resize = (): void => { terminal.invalidate(); draw(); };
  const restore = (): void => {
    if (finished) return;
    finished = true;
    if (interval) clearInterval(interval);
    process.stdin.removeListener('keypress', keypress);
    process.stdout.removeListener('resize', resize);
    process.stdin.setRawMode(previousRaw); process.stdin.pause();
    process.stdout.write('\x1b[0m\x1b[?25h\x1b[?1049l');
  };
  const onExit = (): void => restore();
  const onSignal = (): void => finish();
  const onError = (error: Error): void => fail(error);
  const onWorkerExit = (code: number): void => { if (!finished) fail(new Error(`TUI observation worker exited (${code})`)); };
  try {
    await new Promise<void>((resolve, reject) => {
      finish = resolve; fail = reject;
      process.once('exit', onExit);
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGTSTP'] as const) process.on(signal, onSignal);
      const diagnostic = (bytes: Buffer, stream: 'stdout' | 'stderr'): void => {
        if (finished) return;
        state.diagnostics.accept(bytes, stream); draw();
      };
      worker.stderr.on('data', (bytes: Buffer) => diagnostic(bytes, 'stderr')); worker.stdout.on('data', (bytes: Buffer) => diagnostic(bytes, 'stdout'));
      worker.on('message', reply); worker.on('error', onError); worker.on('exit', onWorkerExit);
      process.stdout.on('error', onError); process.stdin.on('error', onError);
      process.stdout.write('\x1b[?1049h\x1b[?25l');
      emitKeypressEvents(process.stdin);
      process.stdin.setRawMode(true); process.stdin.resume();
      process.stdin.on('keypress', keypress); process.stdout.on('resize', resize);
      draw(); request(); interval = setInterval(request, 1000);
    });
  } finally {
    restore();
    process.removeListener('exit', onExit);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGTSTP'] as const) process.removeListener(signal, onSignal);
    process.stdout.removeListener('error', onError); process.stdin.removeListener('error', onError);
    await worker.terminate();
  }
}
