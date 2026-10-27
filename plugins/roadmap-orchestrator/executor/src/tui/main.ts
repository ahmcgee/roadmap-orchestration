import { emitKeypressEvents, type Key } from 'node:readline';
import { Worker } from 'node:worker_threads';
import { CliError, type RunLocator } from '../input/cli.ts';
import type { AbsPath } from '../core/values.ts';
import { Terminal } from './terminal.ts';
import { ViewState } from './state.ts';
import { contentHeight } from './view.ts';
import type { LogReadRequest, LogReply, ObserveReply, ObserveRequest } from './types.ts';

/** Each reader polls at most once a second and spends at most a fifth of its time reading.
 * Changed selections request immediately, independently of the polling cadence. */
const POLL_MS = 1000;
const POLL_DUTY = 5;

/** The terminal thread does no filesystem or Git reads. Each worker has one request in flight. */
export async function tui(locator: RunLocator, hostDir: AbsPath): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new CliError('tui needs an interactive terminal on stdin and stdout; use roadmap status or roadmap watch for piped output');
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { stdout: true, stderr: true });
  const logWorker = new Worker(new URL('./log-worker.ts', import.meta.url), { stdout: true, stderr: true });
  const state = new ViewState();
  const terminal = new Terminal();
  const previousRaw = process.stdin.isRaw;
  const color = process.env['NO_COLOR'] === undefined && process.env['TERM'] !== 'dumb';
  const ascii = process.env['ROADMAP_TUI_ASCII'] === '1' || process.env['TERM'] === 'dumb' || process.env['LC_ALL'] === 'C';
  let inFlight = false; let token = 0; let finished = false; let next: NodeJS.Timeout | undefined; let sentAt = 0;
  let logInFlight = false; let logToken = 0; let logKey = 'null'; let logNext: NodeJS.Timeout | undefined; let logSentAt = 0;
  let pendingDraw: NodeJS.Immediate | undefined;
  let fail: (e: Error) => void = () => {};
  let finish: () => void = () => {};
  // A handler that throws ends the viewer through fail(): the terminal is restored before the error is printed.
  const guarded = <A extends unknown[]>(handler: (...args: A) => void) => (...args: A): void => {
    try { handler(...args); } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
  };
  const height = (): number => contentHeight(process.stdout.rows || 24);
  const draw = (): void => terminal.draw(state.renderFrame(process.stdout.columns || 80, process.stdout.rows || 24, ascii), process.stdout.columns || 80, process.stdout.rows || 24, color);
  const scheduleDraw = (): void => {
    if (pendingDraw || finished) return;
    pendingDraw = setImmediate(guarded(() => { pendingDraw = undefined; if (!finished) draw(); }));
  };
  const pinned = () => state.canFollowHost() ? null : state.display?.run ?? null;
  const currentLogKey = (): string => JSON.stringify(state.help || !state.logRequest || !state.display ? null : {
    run: state.display.run, log: state.logKey(),
    // A result projection also depends on the selected row (settlement, model and assessment).
    selected: state.logRequest.source === 'result' ? state.display.invocations.find((i) => i.id === state.logRequest!.inv) : null,
  });
  const requestLog = (): void => {
    if (logInFlight || finished || state.help || !state.logRequest || !state.display) return;
    const selected = state.display.invocations.find((i) => i.id === state.logRequest!.inv);
    if (!selected) throw new Error(`Log invocation ${state.logRequest.inv} is absent from the display`);
    clearTimeout(logNext);
    logInFlight = true; logSentAt = performance.now();
    const message: LogReadRequest = { run: state.display.run, selected, log: state.logRequest, token: logToken };
    logWorker.postMessage(message);
  };
  const syncLog = (): void => {
    const key = currentLogKey();
    if (key === logKey) return;
    logKey = key; logToken++; clearTimeout(logNext);
    requestLog();
  };
  const request = (): void => {
    if (inFlight || finished) return;
    clearTimeout(next);
    inFlight = true; sentAt = performance.now();
    const message: ObserveRequest = { locator, hostDir, pinned: pinned(), token };
    worker.postMessage(message);
  };
  const reply = guarded((message: ObserveReply): void => {
    if (finished) return;
    inFlight = false;
    if (message.token === token) {
      if (message.usage) state.usage = message.usage;
      if (message.display) state.accept(message.display);
      if (message.error) state.error = message.error;
      syncLog(); scheduleDraw();
      next = setTimeout(guarded(request), Math.max(POLL_MS, POLL_DUTY * (performance.now() - sentAt)));
    } else request();
  });
  const logReply = guarded((message: LogReply): void => {
    if (finished) return;
    logInFlight = false;
    if (message.token !== logToken) { requestLog(); return; }
    if (message.error) state.error = message.error;
    if (message.log && state.logRequest) state.acceptLog(message.log, height());
    scheduleDraw();
    // Paused pages poll too: their size counts new bytes.
    if (!state.help && state.logRequest) logNext = setTimeout(guarded(requestLog), Math.max(POLL_MS, POLL_DUTY * (performance.now() - logSentAt)));
  });
  const keypress = guarded((text: string | undefined, key: Key): void => {
    if (key.ctrl && key.name === 'c') { finish(); return; }
    const before = JSON.stringify(pinned());
    if (state.key(key.name === 'tab' && key.shift ? 'backtab' : key.name ?? '', text ?? '', height())) { finish(); return; }
    const changed = before !== JSON.stringify(pinned());
    if (changed) token++;
    syncLog(); scheduleDraw();
    if (changed) request();
  });
  const resize = guarded((): void => { terminal.invalidate(); scheduleDraw(); });
  const restore = (): void => {
    if (finished) return;
    finished = true;
    clearTimeout(next); clearTimeout(logNext); clearImmediate(pendingDraw);
    process.stdin.removeListener('keypress', keypress);
    process.stdout.removeListener('resize', resize);
    process.stdin.setRawMode(previousRaw); process.stdin.pause();
    process.stdout.write('\x1b[0m\x1b[?25h\x1b[?1049l');
  };
  const onExit = (): void => restore();
  const onSignal = (): void => finish();
  const onError = (error: Error): void => fail(error);
  const onWorkerExit = (code: number): void => { if (!finished) fail(new Error(`TUI observation worker exited (${code})`)); };
  const onLogWorkerExit = (code: number): void => { if (!finished) fail(new Error(`TUI log worker exited (${code})`)); };
  try {
    await new Promise<void>((resolve, reject) => {
      finish = resolve; fail = reject;
      process.once('exit', onExit);
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGTSTP'] as const) process.on(signal, onSignal);
      const diagnostic = guarded((bytes: Buffer, stream: 'stdout' | 'stderr'): void => {
        if (finished) return;
        state.diagnostics.accept(bytes, stream); scheduleDraw();
      });
      for (const source of [worker, logWorker]) {
        source.stderr.on('data', (bytes: Buffer) => diagnostic(bytes, 'stderr')); source.stdout.on('data', (bytes: Buffer) => diagnostic(bytes, 'stdout'));
      }
      worker.on('message', reply); worker.on('error', onError); worker.on('exit', onWorkerExit);
      logWorker.on('message', logReply); logWorker.on('error', onError); logWorker.on('exit', onLogWorkerExit);
      process.stdout.on('error', onError); process.stdin.on('error', onError);
      process.stdout.write('\x1b[?1049h\x1b[?25l');
      emitKeypressEvents(process.stdin);
      process.stdin.setRawMode(true); process.stdin.resume();
      process.stdin.on('keypress', keypress); process.stdout.on('resize', resize);
      draw(); request();
    });
  } finally {
    restore();
    process.removeListener('exit', onExit);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGTSTP'] as const) process.removeListener(signal, onSignal);
    process.stdout.removeListener('error', onError); process.stdin.removeListener('error', onError);
    await Promise.all([worker.terminate(), logWorker.terminate()]);
  }
}
