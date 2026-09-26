// argv: <delayMs> <everyMs> <path>. After delayMs appends a line to <path>; with everyMs > 0 keeps
// appending every everyMs until killed, otherwise exits after the one write.
import { appendFileSync } from 'node:fs';

const [delay, every, path] = process.argv.slice(2);
if (delay === undefined || every === undefined || path === undefined) {
  throw new Error(`usage: workload-write-later <delayMs> <everyMs> <path>, got ${JSON.stringify(process.argv.slice(2))}`);
}
const write = (): void => appendFileSync(path, `${Date.now()}\n`);
setTimeout(() => {
  write();
  if (Number(every) > 0) setInterval(write, Number(every));
}, Number(delay));
