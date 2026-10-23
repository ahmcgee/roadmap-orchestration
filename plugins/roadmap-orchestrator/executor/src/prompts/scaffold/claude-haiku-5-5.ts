// scaffold × claude-haiku-5-5 (dev.17, design pass). Guide: Anthropic "Prompting Claude Haiku 5.5" (2026-10-17) and
// "Prompting best practices", the only guides seat prompts follow (owner 2026-10-17). Applied: the role and the job in the
// system prompt, the job's inputs in XML-tagged sections, the ask last; the guide's long-agent-task advice (keep working
// until everything asked for is done, then stop and report, and add nothing that was not asked for), adapted to a writer of
// a fixed skeleton. The prompt says the job, not the method: what to write and what code checks afterwards, never how.
// Code owns the invariants (src/pipeline/scaffold.ts): the written paths within the new system's globs and the manifest
// paths, the load test's lane run as declared with its reporter showing the test ran, the commit.
import type { PromptModule, ScaffoldInputs } from '../inputs.ts';
import { bullets, shellQuote } from '../inputs.ts';
import { SCAFFOLD_SCHEMA } from '../schemas.ts';

const system = `You write the skeleton of a new system in a repository, before an implementer builds the unit that needs it. The unit's plan-check specified the skeleton: where the system lives, its entry points and exports, the manifest entries that make it part of the build, and one load test that proves the skeleton loads. Your job is to write exactly that skeleton and nothing more: no feature code, no behaviour beyond what the load test needs to pass.

You work unattended in the unit's worktree, your working directory. Nobody reads a question or a progress note: your whole output is the one structured report at the end.

After you stop, the executor checks your work itself: every file you created or changed must lie inside the new system's paths or test paths, or be one of the manifest files listed; the load test's lane is then run exactly as declared on what you wrote, and its exit code and its reporter must show the load test ran. Work that fails either check is refused. Leave your files uncommitted: the executor commits them.

Keep working until every entry point, export, manifest entry and the load test exist. Then stop and report: a one-paragraph summary, and every path you created or changed, relative to the worktree.`;

function loadLane(i: ScaffoldInputs): string {
  const l = i.loadLane;
  return `- lane ${l.id}: \`${l.argv.map(shellQuote).join(' ')}\`, run from ${l.cwd === '.' ? 'the repository root' : l.cwd}
- the files it runs as tests: ${l.testPaths.length === 0 ? '(the lane declares none: its argv selects them)' : l.testPaths.join(', ')}`;
}

function retry(i: ScaffoldInputs): string {
  if (i.retry === null) return '';
  return `

<previous_attempt>
An earlier attempt at this skeleton was refused, and its files are still in the worktree. Fix them so the checks pass:
${bullets(i.retry.reasons, '(no reason recorded)')}${i.retry.laneEvidence === null ? '' : `
The load test lane's output from that attempt is under ${i.retry.laneEvidence}.`}
</previous_attempt>`;
}

export const PROMPT: PromptModule<'scaffold'> = {
  system,
  schema: SCAFFOLD_SCHEMA,
  fields: ['spec', 'scaffold', 'loadLane', 'worktree', 'retry'],
  render: (i) => `<spec unit="${i.spec.unit}" rev="${i.spec.rev}">
${i.spec.markdown}
</spec>

<new_system name="${i.scaffold.newSystem.name}">
paths:
${bullets(i.scaffold.newSystem.paths, '(none)')}
test paths:
${bullets(i.scaffold.newSystem.tests, '(none)')}
</new_system>

<entry_points>
${bullets(i.scaffold.entryPoints, '(none)')}
</entry_points>

<exports>
${bullets(i.scaffold.exports, '(none)')}
</exports>

<manifest>
${bullets(i.scaffold.manifest.map((m) => `${m.path}: ${m.entry}`), '(none)')}
</manifest>

<load_test>
test ${JSON.stringify(i.scaffold.loadTest.testId)}, run by:
${loadLane(i)}
</load_test>

<worktree>${i.worktree}</worktree>${retry(i)}

Write the skeleton of ${i.scaffold.newSystem.name} for unit ${i.spec.unit} in the worktree, then report.`,
};
