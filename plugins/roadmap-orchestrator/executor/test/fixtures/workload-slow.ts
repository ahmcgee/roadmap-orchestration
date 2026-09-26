// argv: <print|spin> <totalMs>. A slow workload that keeps making progress, then exits 0: `print` writes a
// line to stdout every 200 ms and uses almost no CPU; `spin` burns CPU and writes nothing.
const [mode, total] = process.argv.slice(2);
if ((mode !== 'print' && mode !== 'spin') || total === undefined) throw new Error(`usage: workload-slow <print|spin> <totalMs>, got ${JSON.stringify(process.argv.slice(2))}`);
const end = Date.now() + Number(total);
if (mode === 'print') {
  const timer = setInterval(() => {
    process.stdout.write(`${Date.now()}\n`);
    if (Date.now() >= end) clearInterval(timer);
  }, 200);
} else {
  while (Date.now() < end) { /* spin */ }
}
