// Stands in for the runner in contain.cgroup-real: launches one workload through cgroup containment (which
// moves this process into runner/), prints the child identity as JSON and exits, so the test can kill the
// workload and remove runner/ and the leaf the way the executor does after a runner has exited.
// argv: <root> <rootCgroup> <invDir> <launch.json>
import { readFileSync } from 'node:fs';
import { cgroupContainment } from '../../src/contain/cgroup.ts';
import { launchFile } from '../../src/core/records.ts';
import { absPath } from '../../src/core/values.ts';

const [root, rootCgroup, invDir, launchPath] = process.argv.slice(2);
if (root === undefined || rootCgroup === undefined || invDir === undefined || launchPath === undefined) {
  throw new Error('usage: cgroup-real-runner.ts <root> <rootCgroup> <invDir> <launch.json>');
}
const launch = launchFile(JSON.parse(readFileSync(launchPath, 'utf8')), 'launch.json');
const child = await cgroupContainment(absPath(root), rootCgroup).launch(launch, absPath(invDir));
process.stdout.write(`${JSON.stringify(child)}\n`);
