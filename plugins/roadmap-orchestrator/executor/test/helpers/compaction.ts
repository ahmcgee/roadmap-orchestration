// Scripted golden application, exclusively a free-test oracle. Never staged or used by the paid driver.
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from '../../src/core/json.ts';
import { pinSha256 } from '../../src/corpus/pin.ts';
import { ruleTextSha256 } from '../../src/corpus/rules.ts';
import { parseObligations, parseRulingSidecar } from '../../src/holistic/types.ts';
import { parsePhase0Record } from '../../src/phase0/types.ts';
import { parseRulings } from '../../src/spec/rulings.ts';
import { CORPUS_FILE, git, json, loadSidecars, obligation, pin, readJson, sidecar, write, type Fixture } from '../../evals/compaction/fixture.ts';
import { parseRecord } from '../../evals/compaction/record.ts';

type Obj = Record<string, unknown>;
export async function applyGolden(f: Fixture): Promise<void> {
  const decisions = parseRecord(readFileSync(join(f.l.dir, 'golden-compaction.md'), 'utf8'));
  const previous = parseObligations(readJson(join(f.next, 'obligations.json')));
  let obligations = [...previous.obligations];
  let census = [...previous.census!];
  let corpus = readFileSync(join(f.l.product, CORPUS_FILE), 'utf8');
  let ledger = [...parseRulings(readFileSync(join(f.next, 'rulings.md'), 'utf8'), 'rulings.md')];
  let sidecars = [...loadSidecars(f.next)];
  const phase0 = JSON.parse(json(parsePhase0Record(readJson(join(f.next, 'phase0.json'))))) as Obj;
  const curation = phase0['curation'] as Obj[];
  const debt = phase0['debt'] as { id: string; disposition: unknown }[];
  let nextC = 41;
  let nextI = 61;
  for (const d of decisions) {
    const p = f.key.plants.find((p) => p.ids.every((id) => d.ids.includes(id)))!;
    const kind = p.ids[0]![0];
    let removed = obligations.filter((o) => p.ids.includes(o.id) || (kind === 'T' && p.ids.includes(o.rule?.id ?? ''))).map((o) => o.id);
    if (d.action === 'tighten') removed = [];
    // Full split-family closure, including children whose source rule is different.
    for (let changed = true; changed;) {
      const expanded = obligations.filter((o) => removed.includes(o.id) || (o.parent !== undefined && removed.includes(o.parent)) || (o.state.type === 'split' && o.state.children.some((id) => removed.includes(id)))).map((o) => o.id);
      changed = expanded.length !== removed.length; removed = expanded;
    }
    if (kind === 'T') {
      for (const id of p.ids) {
        if (d.action === 'tighten' || id === p.replacement?.id) {
          corpus = corpus.replace(new RegExp(`^${id}: .+$`, 'm'), `${id}: ${p.replacement!.text}`);
        } else corpus = corpus.replace(new RegExp(`^${id}: .+\\n`, 'm'), '');
      }
      census = census.filter((e) => !p.ids.includes(e.rule));
      if (d.action === 'tighten') {
        const old = previous.census!.find((e) => e.rule === p.ids[0])!;
        census.push(old);
        obligations = obligations.map((o) => 'rule' in o && o.rule !== undefined && o.rule.id === p.ids[0] ? { ...o, rule: { id: o.rule.id, textSha256: ruleTextSha256(p.replacement!.text) } } : o);
        sidecars = sidecars.map((s) => parseRulingSidecar({ ...s, docRefs: s.docRefs.map((ref) => 'rule' in ref && ref.rule === p.ids[0] ? { ...ref, textSha256: ruleTextSha256(p.replacement!.text) } : ref) }));
      }
      if (d.action === 'merge') {
        const id = `I-${nextI++}`;
        obligations.push(parseObligations({ ...previous, obligations: [obligation(id, p.replacement!.id, p.replacement!.text)], mapping: { paths: [] }, census: [{ rule: p.replacement!.id, state: { type: 'obligation', id } }] }).obligations[0]!);
        census.push({ rule: p.replacement!.id as typeof census[number]['rule'], state: { type: 'obligation', id: id as typeof obligations[number]['id'] } });
      }
      curation.push({ tier: p.name === 'removed module' || p.name === 'answered assumption' ? 'fact-currency' : 'structural', what: `compaction ${d.id}: ${p.name}${p.trivia ? '; owner retires a claim still true' : ''}`, files: ['register.md'], rules: p.replacement ? [p.replacement.id] : p.ids });
    }
    if (kind === 'I') census = census.map((e) => e.state.type === 'obligation' && removed.includes(e.state.id) ? { rule: e.rule, state: { type: 'untestable' } } : e);
    obligations = obligations.filter((o) => !removed.includes(o.id));
    if (kind === 'C' && ['retire', 'fold'].includes(d.action)) {
      ledger = ledger.filter((r) => !p.ids.includes(r.id));
      sidecars = sidecars.filter((s) => !p.ids.includes(s.id));
      for (const id of p.ids) rmSync(join(f.next, 'rulings.md.d', `${id}.json`));
    }
    if (d.action === 'fold') {
      corpus = corpus.replace('\n```\n', `\n${p.replacement!.id}: ${p.replacement!.text}\n\`\`\`\n\nArchive policy folded from ${p.ids[0]}, ${d.id}.\n`);
      census.push({ rule: p.replacement!.id as typeof census[number]['rule'], state: { type: 'prod-only' } });
      curation.push({ tier: 'structural', what: `compaction ${d.id}: ${p.name}`, files: ['register.md'], rules: [p.replacement!.id] });
    }
    if (d.action !== 'tighten') {
      const id = `C-${nextC++}`;
      const statement = kind === 'C' && d.action === 'merge' ? p.replacement!.text : `${d.id}: ${p.ids.join(', ')}: ${d.why} Gives up: ${d.givesUp}`;
      if (kind === 'C' && d.action === 'merge') {
        ledger = ledger.map((r) => p.ids.includes(r.id) ? { id: r.id, status: 'withdrawn', by: id as typeof r.id } : r);
        sidecars = sidecars.map((s) => p.ids.includes(s.id) ? { ...s, status: 'superseded' } : s);
      }
      const s = sidecar(id, statement, git(f.l.product, 'rev-parse', 'HEAD'), { kind: 'disposition', lifetime: 'arc', trigger: `compaction ${d.id}`,
        obligations: removed, obligationDispositions: removed.map((id) => ({ id, disposition: 'retired' })), supersedes: kind === 'C' && d.action === 'merge' ? p.ids.map((id) => ({ id, part: null })) : [] });
      sidecars.push(s);
      ledger.push({ id: s.id, status: 'active', text: s.statement });
      if (kind === 'B') for (const b of debt) if (p.ids.includes(b.id)) b.disposition = { type: 'resolve', ruling: id };
      if (kind === 'C' && d.action === 'merge') {
        const spec = readJson(join(f.next, 'slips.json')) as { cites: { contracts: string[]; rulings: string[] } };
        spec.cites.rulings = [...new Set(spec.cites.rulings.map((r) => p.ids.includes(r) ? id : r))];
        write(join(f.next, 'slips.json'), json(spec));
      }
    }
  }
  census.sort((a, b) => Number(a.rule.slice(2)) - Number(b.rule.slice(2)));
  const remaining = new Set(obligations.map((o) => o.id));
  const next = parseObligations({ ...previous, obligations, census, mapping: { paths: previous.mapping.paths.map((p) => ({ ...p, obligations: p.obligations.filter((id) => remaining.has(id)) })).filter((p) => p.obligations.length) } });
  write(join(f.next, 'obligations.json'), json(next));
  for (const specFile of ['slips.json']) {
    const spec = readJson(join(f.next, specFile)) as Obj;
    const declared = (spec['obligations'] as string[]).filter((id) => remaining.has(id as typeof obligations[number]['id']));
    if (declared.length) spec['obligations'] = declared; else delete spec['obligations'];
    write(join(f.next, specFile), json(spec));
  }
  write(join(f.next, 'phase0.json'), json(parsePhase0Record(phase0)));
  const ledgerBytes = '# Rulings\n\n' + ledger.map((r) => `${r.id} — ${r.status === 'active' ? r.text : `withdrawn by ${r.by}`}`).join('\n') + '\n';
  write(join(f.next, 'rulings.md'), ledgerBytes);
  write(join(f.l.product, CORPUS_FILE), corpus);
  git(f.l.product, 'add', CORPUS_FILE);
  git(f.l.product, 'commit', '--quiet', '--amend', '--no-edit');
  const baseline = git(f.l.product, 'rev-parse', 'HEAD');
  git(f.l.product, 'branch', '-f', 'arc/next', baseline);
  const plan = readJson(join(f.next, 'plan.json')) as Obj;
  plan['baseline'] = baseline;
  write(join(f.next, 'plan.json'), json(plan));
  const pinned = await pin(f.l, f.next);
  // Bind every new ruling to the exact final inputs, keeping original provenance unchanged.
  const revs = { head: baseline, ledgerSha256: sha256Hex(ledgerBytes), obligationsSha256: sha256Hex(json(next)), visionSha256: sha256Hex(readFileSync(join(f.l.product, '.roadmap/vision.json'))), corpusSha256: pinSha256(pinned), contracts: [] };
  for (const s of sidecars) write(join(f.next, 'rulings.md.d', `${s.id}.json`), json(parseRulingSidecar(Number(s.id.slice(2)) > 40 ? { ...s, consistency: { ...s.consistency, judgedRevs: revs } } : s)));
  write(join(f.l.inputs, '_next/compaction.md'), readFileSync(join(f.l.dir, 'golden-compaction.md'), 'utf8').replace(/(Approved: [^\n]+)/g, '$1\nApplied: arc-next'));
}
