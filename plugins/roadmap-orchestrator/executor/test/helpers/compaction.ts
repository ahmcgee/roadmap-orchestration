// Scripted golden application, exclusively a free-test oracle. Never staged or used by the paid driver.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORPUS_FILE,git,json,obligation,pin,readJson,write,type Fixture } from '../../evals/compaction/fixture.ts';
import { parseRecord } from '../../evals/compaction/record.ts';
import { ruleTextSha256 } from '../../src/corpus/rules.ts';
import { parseRulesRegistryBlock } from '../../src/docs/invariants.ts';
import { parseObligations } from '../../src/holistic/types.ts';
import { parsePhase0Record } from '../../src/phase0/types.ts';
import { parseRulings } from '../../src/spec/rulings.ts';

type Obj = Record<string, unknown>;
export async function applyGolden(f: Fixture, replacementsFirst = false): Promise<void> {
  const decisions = parseRecord(readFileSync(join(f.l.dir, 'golden-compaction.md'), 'utf8'));
  const previous = parseObligations(readJson(join(f.next, 'obligations.json')));
  let obligations = [...previous.obligations];
  let census = [...previous.census!];
  let corpus = readFileSync(join(f.l.product, CORPUS_FILE), 'utf8');
  let ledger = [...parseRulings(readFileSync(join(f.next, 'rulings.md'), 'utf8'), 'rulings.md')];
  const phase0 = JSON.parse(json(parsePhase0Record(readJson(join(f.next, 'phase0.json'))))) as Obj;
  const curation = phase0['curation'] as Obj[];
  const debt = phase0['debt'] as { id: string; disposition: unknown }[];
  let nextC = Math.max(...parseRulings(readFileSync(join(f.previous, 'rulings.md'), 'utf8'), 'rulings.md').map((r) => Number(r.id.slice(2)))) + 1;
  let nextI = Math.max(...parseObligations(readJson(join(f.previous, 'obligations.json'))).obligations.map((o) => Number(o.id.slice(2)))) + 1;
  let nextT = parseRulesRegistryBlock(git(f.l.product, 'show', `${f.previousHead}:.roadmap/invariants.md`))!.highWater + 1;
  const allocated = new Map(replacementsFirst ? decisions.filter((d) => d.ids[0]?.startsWith('C-') && ['merge', 'tighten'].includes(d.action)).map((d) => [d.id, `C-${nextC++}`]) : []);
  for (const d of decisions) {
    const plant = f.key.plants.find((p) => p.ids.every((id) => d.ids.includes(id)))!;
    const p = { ...plant, replacement: plant.replacement === null ? null : { ...plant.replacement,
      id: plant.replacement.id === 'T-?' ? `T-${nextT++}` : plant.replacement.id === 'C-?' ? allocated.get(d.id) ?? `C-${nextC}` : plant.replacement.id } };
    const kind = p.ids[0]![0];
    let removed = obligations.filter((o) => p.ids.includes(o.id) || (kind === 'T' && p.ids.includes(o.rule?.id ?? '') && !(d.action === 'merge' && o.rule?.id === p.replacement?.id))).map((o) => o.id);
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
      }
      if (d.action === 'merge') {
        if (!p.ids.includes(p.replacement!.id)) corpus = corpus.replace('\n```\n', `\n${p.replacement!.id}: ${p.replacement!.text}\n\`\`\`\n`);
        const kept = obligations.find((o) => o.rule?.id === p.replacement!.id && !removed.includes(o.id));
        const id = kept?.id ?? `I-${nextI++}`;
        if (!kept) obligations.push(parseObligations({ ...previous, obligations: [obligation(id, p.replacement!.id, p.replacement!.text)], mapping: { systems: [] }, census: [{ rule: p.replacement!.id, state: { type: 'obligation', id } }] }).obligations[0]!);
        census.push({ rule: p.replacement!.id as typeof census[number]['rule'], state: { type: 'obligation', id: id as typeof obligations[number]['id'] } });
      }
      curation.push({ tier: p.name === 'removed module' || p.name === 'answered assumption' ? 'fact-currency' : 'structural', what: `compaction ${d.id}: ${p.ids.join(', ')} ${p.name}${p.replacement ? ` to ${p.replacement.id}` : ''}${p.trivia ? '; owner retires a claim still true' : ''}`, files: ['register.md'], rules: p.replacement ? [p.replacement.id] : p.ids });
    }
    if (kind === 'I') curation.push({ tier: 'structural', what: `compaction ${d.id}: ${p.ids.join(', ')} retired; ${d.why} Gives up: ${d.givesUp}`, files: ['register.md'], rules: [] });
    if (kind === 'I') census = census.map((e) => e.state.type === 'obligation' && removed.includes(e.state.id) ? { rule: e.rule, state: { type: 'untestable' } } : e);
    obligations = obligations.map((o) => {
      if (!removed.includes(o.id)) return o;
      // Retired families no longer have split edges. The retired parent keeps
      // the children's witness references with an honest insufficient judgment;
      // it does not invent a passing proof for an exempt requirement.
      const { parent: _parent, ...retired } = o;
      const child = o.state.type === 'split' ? obligations.find((c) => c.parent === o.id)! : null;
      const witness = o.witness ?? child!.witness!;
      return { ...retired, witness, proofJudgment: o.proofJudgment ?? { verdict: 'insufficient' as const, obligationRev: o.rev,
        witness: { testIds: witness.testIds, ...('files' in witness ? { files: witness.files } : {}) } },
        state: { type: 'retired' as const, reason: `compaction ${d.id}: ${p.ids.join(', ')}: ${d.why} Gives up: ${d.givesUp} Owner approved ${d.approved}.`, rev: o.rev } };
    });
    if (kind === 'C' && ['retire', 'fold'].includes(d.action)) {
      ledger = ledger.filter((r) => !p.ids.includes(r.id));
      if (d.action === 'retire') curation.push({ tier: 'structural', what: `compaction ${d.id}: ${p.ids.join(', ')} retired; ${d.why} Gives up: ${d.givesUp}`, files: ['register.md'], rules: [] });
    }
    if (d.action === 'fold') {
      corpus = corpus.replace('\n```\n', `\n${p.replacement!.id}: ${p.replacement!.text}\n\`\`\`\n\nArchive policy folded from ${p.ids[0]}, ${d.id}.\n`);
      census.push({ rule: p.replacement!.id as typeof census[number]['rule'], state: { type: 'prod-only' } });
      curation.push({ tier: 'structural', what: `compaction ${d.id}: ${p.ids.join(', ')} ${p.name}${p.replacement ? ` to ${p.replacement.id}` : ''}`, files: ['register.md'], rules: [p.replacement!.id] });
    }
    const replacesRuling = kind === 'C' && ['merge', 'tighten'].includes(d.action);
    if ((kind === 'B' && d.action === 'resolve') || replacesRuling) {
      const id = replacesRuling ? p.replacement!.id : `C-${nextC}`;
      nextC = Math.max(nextC, Number(id.slice(2)) + 1);
      const statement = replacesRuling ? p.replacement!.text : `${d.id}: ${p.ids.join(', ')}: ${d.why} Gives up: ${d.givesUp}`;
      if (replacesRuling) {
        ledger = ledger.map((r) => p.ids.includes(r.id) ? { id: r.id, status: 'withdrawn', by: id as typeof r.id } : r);
      }
      ledger.push({ id: id as typeof ledger[number]['id'], status: 'active', text: statement });
      curation.push({ tier: 'structural', what: `compaction ${d.id}: ${p.ids.join(', ')} ${d.action} to ${id}; ${d.why} Gives up: ${d.givesUp}`, files: ['register.md'], rules: [] });
      if (kind === 'B') for (const b of debt) if (p.ids.includes(b.id)) b.disposition = { type: 'resolve', ruling: id };
      if (replacesRuling) {
        const spec = readJson(join(f.next, 'slips.json')) as { cites: { contracts: string[]; rulings: string[] } };
        spec.cites.rulings = [...new Set(spec.cites.rulings.map((r) => p.ids.includes(r) ? id : r))];
        write(join(f.next, 'slips.json'), json(spec));
      }
    }
  }
  census.sort((a, b) => Number(a.rule.slice(2)) - Number(b.rule.slice(2)));
  const remaining = new Set(obligations.filter((o) => o.state.type !== 'retired').map((o) => o.id));
  const next = parseObligations({ ...previous, obligations, census, mapping: { systems: previous.mapping.systems.map((p) => ({ ...p, obligations: p.obligations.filter((id) => remaining.has(id)) })).filter((p) => p.obligations.length) } });
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
  await pin(f.l, f.next);
  write(join(f.l.inputs, 'drafts/compaction.md'), readFileSync(join(f.l.dir, 'golden-compaction.md'), 'utf8').replace(/(Approved: [^\n]+)/g, '$1\nApplied: arc-next'));
}
