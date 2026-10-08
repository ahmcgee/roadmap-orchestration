// The skill text against the code (M4a plan, step D4).
//
// skill-lint.cli-forms: every code span in skills/orchestrate/reference.md that starts `roadmap ` is a CLI form, and
//   every concrete command it expands to parses (`parseCommand`); together they cover every `Command` kind. A form's
//   grammar: `[x]` optional, `(a | b)` one of the groups, `a|b` one of the literals, `<name>` a placeholder (a sample
//   value from PLACEHOLDERS; an unknown name fails), `<name>...` one or more.
// skill-lint.no-model-ids: no model id (a catalogue key, or a token shaped like one) in any file under skills/; and in
//   the files an agent loads at run time (each SKILL.md, reference.md, the templates) no display name or model family
//   name either. RATIONALE-1.0.md is maintainer text that cites the models arc 1 ran on as evidence.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { type Command, parseCommand } from '../src/input/cli.ts';
import { MODELS } from '../src/routing/models.ts';

const SKILLS = fileURLToPath(new URL('../../skills/', import.meta.url));
const REFERENCE = join(SKILLS, 'orchestrate', 'reference.md');

const PLACEHOLDERS: Readonly<Record<string, string>> = {
  path: '/tmp/repo', 'plan.json': 'plan.json', file: 'out.json', 'record.json': 'ruling.json', ms: '1000', min: '30',
  n: '2', K: '3', unit: 'u-1', arc: 'arc-1', edge: 'e-1', text: 'the lane passed', name: 'db', 'needs-user-id': 'nu-7',
  'option-id': 'apply', 'D-n': 'D-1', lenses: 'invariants,vision', ref: 'HEAD', sha: 'a'.repeat(40), briefId: '0123456789abcdef', dir: 'export', 'P-n': 'P-1',
};

/** Every command kind, so a kind added to `Command` fails typecheck here until reference.md documents it. */
const KINDS: { readonly [K in Command['command']]: true } = {
  version: true, start: true, status: true, watch: true, stop: true, pause: true, ack: true, resume: true, sweep: true, apply: true,
  'resolve-edge': true, 'run-only': true, rule: true, reverse: true, steer: true, 'merge-in': true, audit: true, 'close-admissions': true,
  gc: true, 'phase0-check': true, 'corpus-pin': true, brief: true, pr: true, issues: true, 'chain-status': true, answer: true,
  'witness-check': true, 'resume-arc': true, 'inputs-export': true,
};

type Node = Readonly<{ type: 'word'; text: string }> | Readonly<{ type: 'optional'; groups: readonly (readonly Node[])[] }> | Readonly<{ type: 'choice'; groups: readonly (readonly Node[])[] }>;

function tokens(form: string): string[] {
  return form.replace(/([[\]()])/g, ' $1 ').split(/\s+/).filter((t) => t !== '');
}

/** Parses a sequence up to `end` (`]`, `)` or the end of input); `|` splits a `(…)` group. */
function sequence(ts: string[], end: string | null, form: string): Node[][] {
  const groups: Node[][] = [[]];
  for (;;) {
    const t = ts.shift();
    if (t === undefined) {
      if (end !== null) throw new Error(`unclosed ${end === ']' ? '[' : '('} in ${form}`);
      return groups;
    }
    if (t === end) return groups;
    if (t === ']' || t === ')') throw new Error(`stray ${t} in ${form}`);
    const current = groups.at(-1) as Node[];
    if (t === '|') groups.push([]);
    else if (t === '[') current.push({ type: 'optional', groups: sequence(ts, ']', form) });
    else if (t === '(') current.push({ type: 'choice', groups: sequence(ts, ')', form) });
    else current.push({ type: 'word', text: t });
  }
}

function placeholder(name: string, form: string): string {
  const v = PLACEHOLDERS[name];
  if (v === undefined) throw new Error(`unknown placeholder <${name}> in ${form}`);
  return v;
}

/** The argv alternatives of one word: literal alternatives `a|b`, placeholders substituted, `<x>...` twice. */
function words(text: string, form: string): string[][] {
  const repeated = /^<([^>]+)>\.\.\.$/.exec(text);
  if (repeated !== null) return [[placeholder(repeated[1] as string, form)], [placeholder(repeated[1] as string, form), 'u-2']];
  return text.split('|').map((alt) => [alt.replace(/<([^>]+)>/g, (_, name: string) => placeholder(name, form))]);
}

function expand(nodes: readonly Node[], form: string): string[][] {
  let out: string[][] = [[]];
  for (const node of nodes) {
    const alts = node.type === 'word' ? words(node.text, form) : node.type === 'optional' ? [[], ...node.groups.flatMap((g) => expand(g, form))] : node.groups.flatMap((g) => expand(g, form));
    out = out.flatMap((prefix) => alts.map((alt) => [...prefix, ...alt]));
  }
  return out;
}

function argvsOf(form: string): string[][] {
  const ts = tokens(form);
  assert.equal(ts.shift(), 'roadmap', form);
  return expand(sequence(ts, null, form).flat(), form);
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]));
}

describe('skill-lint', () => {
  it('skill-lint.cli-forms: every CLI form in reference.md parses, and every command is documented', () => {
    const forms = [...readFileSync(REFERENCE, 'utf8').matchAll(/`(roadmap [^`]+)`/g)].map((m) => m[1] as string);
    assert.ok(forms.length > 0, 'reference.md documents no CLI form');
    const seen = new Set<string>();
    for (const form of forms) {
      for (const argv of argvsOf(form)) {
        let parsed: Command;
        try {
          parsed = parseCommand(argv);
        } catch (error) {
          throw new Error(`${form}: ${JSON.stringify(argv)} does not parse: ${(error as Error).message}`);
        }
        seen.add(parsed.command);
      }
    }
    assert.deepEqual([...seen].sort(), Object.keys(KINDS).sort());
  });

  it('skill-lint.form-grammar: optional groups, choices, literal alternatives and repeats expand', () => {
    assert.deepEqual(argvsOf('roadmap pause (<unit> | --all)'), [['pause', 'u-1'], ['pause', '--all']]);
    assert.deepEqual(argvsOf('roadmap resume [<unit> | --backend claude|codex]'), [['resume'], ['resume', 'u-1'], ['resume', '--backend', 'claude'], ['resume', '--backend', 'codex']]);
    assert.deepEqual(argvsOf('roadmap run-only <unit>...'), [['run-only', 'u-1'], ['run-only', 'u-1', 'u-2']]);
    assert.throws(() => argvsOf('roadmap ack <nobody>'), /unknown placeholder <nobody>/);
    assert.throws(() => argvsOf('roadmap stop [--wait'), /unclosed \[/);
  });

  it('skill-lint.no-model-ids: no model id in skill text; no model name in the files an agent loads', () => {
    const ids = Object.keys(MODELS);
    const names = Object.values(MODELS).flatMap((m) => [m.displayName, ...m.displayName.split(' ').filter((w) => /^[A-Z][a-z]+$/.test(w) && w !== 'Claude')]);
    const idShaped = /\b(?:claude-(?:opus|sonnet|fable|haiku)|gpt-\d)/i;
    const hits: string[] = [];
    for (const file of filesUnder(SKILLS)) {
      const rel = relative(SKILLS, file);
      const text = readFileSync(file, 'utf8');
      for (const id of ids) if (text.includes(id)) hits.push(`${rel}: ${id}`);
      if (idShaped.test(text)) hits.push(`${rel}: ${idShaped.exec(text)?.[0]}`);
      if (rel === join('orchestrate', 'RATIONALE-1.0.md')) continue;
      for (const name of names) if (new RegExp(`\\b${name.replace(/[.]/g, '\\.')}\\b`).test(text)) hits.push(`${rel}: ${name}`);
    }
    assert.deepEqual(hits, []);
  });
});
