# ledgerly CI

`ci/pipeline.yml` is the pipeline; CI runs it on every push, and `node ci/run.js` runs exactly the same steps locally,
from the project root, with nothing to install. A green local run means a green CI run.

## Format

A YAML subset: `name:`, then `steps:`, each step a `- name:` line followed by an indented `run:` line. A step's command
runs without a shell; `node --test` expands its own globs.

```yaml
name: ledgerly
steps:
  - name: config
    run: node bin/ledgerly.js config check
  - name: unit
    run: node --test test/*.test.js
```

## Output

One line per step that passed (`  unit       ok      0.84s`), then `Pipeline passed in 1.02s.` The runner stops at the
first failing step and exits with that step's exit code.

A failure must let the person fix it without opening CI's logs:

- the step that failed, with its command and the command's line in `ci/pipeline.yml` (the `run:` line);
- for a test step, each failing test file, the tail of its output, and the command that reruns just that file;
- for any other step, the tail of its output and the command that reruns it.

```
ledgerly: 2 steps
  config     ok      0.11s
  unit       FAILED  0.92s (exit 1)

Step "unit" failed (ci/pipeline.yml:9): node --test test/*.test.js
1 test file failed:
  test/report.test.js
    ...the test's own failure output...
  rerun it locally: node --test test/report.test.js
```

## Rules

- Time to feedback: the whole pipeline runs in seconds; a step that needs more is split.
- No step needs the network or a secret, and no step echoes one.
- One way to run CI locally: `node ci/run.js`.
