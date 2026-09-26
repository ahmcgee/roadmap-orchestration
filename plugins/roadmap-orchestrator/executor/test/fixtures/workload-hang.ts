// argv: [--ignore-term]. Runs until killed. With --ignore-term it survives SIGTERM.
if (process.argv[2] === '--ignore-term') process.on('SIGTERM', () => {});
setInterval(() => {}, 60_000);
