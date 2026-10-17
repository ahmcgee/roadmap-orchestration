// Process entry of a regenerate lane (src/input/derived.ts `regenerateLane` runs `node src/entry/regenerate.ts <git>
// <request json>` from the root of the lane's checkout): the check of src/pipeline/regenerate.ts, its exit code the lane's.
const [git, request] = process.argv.slice(2);
if (git === undefined || request === undefined) throw new Error('usage: regenerate.ts <git> <request json>');
const { runRegenerateCheck } = await import('../pipeline/regenerate.ts');
process.exitCode = runRegenerateCheck(git, process.cwd(), JSON.parse(request), (line) => process.stdout.write(`${line}\n`));
