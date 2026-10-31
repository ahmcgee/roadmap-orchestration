import { methodModules } from '../method/index.ts';
// 2026-10-29 (1.0.0-dev.31): embed unit anchors and universally binding rules; other corpus rules remain readable.
// gate × claude-opus-5-5. Guide: Anthropic "Prompting best practices" and "Prompting Claude Opus 5.5"
// (platform.claude.com, reviewed 2026-09-25). Applied: role in the system prompt; XML sections; long
// inputs first, the ask last; the implementer's diff wrapped in <pasted_content> with the guide's note
// (5.5 resists injected instructions best when pasted text is marked); read broadly before ruling; no
// reasoning field (reasons is the justification). Distilled from 0.20's gates: grade each acceptance
// clause individually (anti-gestalt); FINDING_BAR with its symmetry clause; quote the clause violated;
// scope growth adjudicated per path, never a licence; later rounds re-check prior directives only (sf16);
// Direction as a subordinate tie-breaker; HOST_BAR. LANE_BAR is gone: "every spec lane ran verbatim" is
// a code assertion in 1.0, so the gate judges what the lanes prove, not whether they ran. From arc 1
// (feedback items 6, 12, 14, 15, 26, 28c, 29): cited documents in full and an index for the rest; the
// pre-build's notes as facts; correctness-or-acceptance only; bounded, batched reads; premises with
// evidence as the round handoff, and a later round rules on its prior round's conclusions and the delta.
// M3 (reviewed 2026-09-30 against the same guides): the candidate's selected obligations with their
// observations for direct selections and only id and statement for standing ones, never their vision clauses
// (R17: the gate grades spec and contracts, not the vision).
// M4a (reviewed 2026-10-03 against the same guides): the `target` input, the architecture doc or, in a corpus arc,
// the corpus rules index (T-n) with the pinned files read on demand; the doc's role carries over to the rules.
// M4a rev 3 (reviewed 2026-10-06 against the same guides): the executable checks run before the gate (witness presence,
// mutation smoke with killed, survived and inconclusive; D1, D2, R38), reused lanes; the defect classes of D3 (real
// clock or host time zone, a fixed date the change invalidates, a real wait in a fast lane, a negative witness that
// bypasses the entry point) and of H1 (a transaction step moved without a failure matrix).
// Paid M4b run 5: a gate Globbed the parent of its evidence dirs, was refused, and approved on the ledger alone; the
// readable dirs were named exactly and a refused read voided an approve. 2026-10-16: the read surface is the repository and
// the run dir (dispatch.ts `judgmentReadDirs`), which hold every evidence dir, and a refused read voids nothing.
// W3 (2026-10-16; re-reviewed 2026-10-17 against "Prompting best practices" and "Prompting Claude Opus 5.5" alone, the
// 5.5-generation guides being the only binding ones): the "report only what affects correctness" filter is gone: report
// every real defect, classified, and code filters (notes never block). Evidence: the paid gate role eval (2026-10-17,
// synthetic size-3000 monorepo) with this wording caught 17 of 18 plants with 0 false alarms in 12 clean trials and 95%
// of blocking findings localised to the plant. The bounded diff
// (<orientation> a map, <diff> inlined, <not_inlined> readable .diff files): the verdict covers the whole diff, read before
// the decision, derived outputs judged through their sources. Delegation (withdrawn 2026-10-17), and at the
// escalation seat a preface with the seat below's reasons (escalationText).
// dev.12 round 2 (2026-10-17, reviewed against "Prompting Claude Opus 5.5" and "Prompting Claude Sonnet 5.5": explain why,
// no shouting): the paid gate role eval's one miss was a hand edit inside a regenerated golden, so a changed derived output
// is checked against what its generator would produce (unless <executable_checks> reports it verified by regeneration, R3), with the reason given; a third finding class, pre-existing (a real
// defect present at the base: recorded, never blocking); and `unreviewed`, the gate's own account of what it did not read
// (recorded, never enforced: the role evals compare it with the trace).
// The large-diff gate (1.0.0-dev.12, 2026-10-17; written against "Prompting Claude Opus 5.5" and "Prompting best practices"
// alone: plain prose that explains why, no checklist, no shouting; the guides note 5.5 models delegate natively, so the text
// says what each subagent is for and on which model): a diff over the large-diff threshold (code: the bounded diff left
// files out for size) gets <large_diff>, the owner's method. Evidence: the paid gate role eval of 2026-10-17 (size-3000
// sweep, plant in an omitted file shaped like the substitution): Sonnet and Haiku gates missed 11 of 12 and listed ~2,700
// files unreviewed; Opus caught 5 of 6 by fanning out to subagents that inherited its model ($6-61 a trial); a Haiku reader
// with a closed brief (the expected substitution, every departing hunk listed) caught 6 of 6 at ~$0.45 a chunk. So the
// section names a model on every subagent call, gives mechanical describers the executor's substitutions, keeps deviations
// verbatim, and asks for the cluster map code checks. Under the threshold the prompt is unchanged but for one line saying
// clusters is null.
// dev.13 (contract input): a milestone unit's design references as documents and its milestones block (`milestonesText`).
// dev.13 (owner 2026-10-18; written against "Prompting Claude Opus 5.5" and "Prompting best practices" alone): the gate
// runs as an acting judge with a shell in a throwaway checkout of the unit's tip. <your_checkout> (GATE_CHECKOUT) says what
// is and is not its job: the lanes are the test verdict and are in front of it, broad testing is not its work, and when it
// suspects a bug it may write and run ad hoc experiments to confirm or rule it out, citing each one a finding rests on
// (command and output) in the finding's `experiments`. No other method is prescribed. Code keeps the invariants: an
// approve still stands on the spec, diff and lanes, and a finding must still localise. The Sonnet and Haiku rows derive.
// dev.13 (the convergence tail, owner ruling 2026-10-20: debt is for substantive issues that drag down future work, never
// test nitpicks or status remarks): each finding's `debt`, the contract only (the field, and which notes are debt); code
// banks a note only when its drag is given (src/pipeline/gate.ts `gateDebtNotes`). The Fable, Sonnet and Haiku rows inherit it.
// dev.17 proportional review (owner 2026-10-22; written against "Prompting Claude Opus 5.5" and "Prompting best practices"
// alone: the job and why, no method): <finding_bar> states what may block, as the closed defect classes a blocking finding
// names (code refuses one without), test-inadequate defined by the test being cited as proof, and comments and docs as
// ride-along, which never blocks. <findings_ledger>, <disputes> and <delta> are the contract of src/pipeline/review.ts:
// a settled finding is raised again only once its file changed, each dispute is ruled once, and on a delta a blocking
// finding on an unchanged file rests on a changed hunk or a moved target, else code records it as a note.
import type { GateInputs } from '../inputs.ts';
import { boundedDiffText, bullets, milestoneDocuments, milestonesText, documentsXml, escalationText, findingsText, laneLedgerText, obligationsText, standingObligationsText, premisesText, systemNotesText, targetDocument, gateChecksText } from '../inputs.ts';
import { GATE_SCHEMA } from '../schemas.ts';

/**
 * The gate's working directory and what its shell is for (dev.13). One section, so the read-only comparison arm of the gate
 * role eval (evals/roles/gate/readonly.ts) can put the dev.12 gate's sentence in its place.
 */
export const GATE_CHECKOUT = `<your_checkout>
Your working directory is a checkout of the unit's tip, the commit the lanes ran at, made for this session alone and removed once you answer. You have a shell in it and may write there.

The executor's lanes are the test verdict, and their results are in front of you in the lane ledger. Testing the change broadly is not your job. When you suspect a bug, you may write and run ad hoc experiments in this checkout to confirm it or rule it out. Cite each experiment a finding rests on in that finding's experiments: the command as you ran it and the output that shows the result. A finding that rests on reading alone has none. A suspicion an experiment ruled out is not a finding.

Write only in this checkout and in temporary files of your own. The repository, its branches and the run directory belong to the executor: you read them and change nothing in them.
</your_checkout>`;

export const system = `You are the independent verifier of one unit. Use the supplied mode.
In pre-build mode, review the spec's premises, boundaries and proof, then annotate the build with evidence-backed findings. You cannot amend the plan, split, scaffold or start a proof of concept; the root decides those. A review never holds a unit.
In diagnosis mode, explain the repeated failures and useful next steps, grounded in code and evidence. Your output becomes a note for the next build; do not amend the plan.
In gate mode, nothing merges without approval. Judge the change against the spec, intent, non-goals, contracts and cited corpus rules. Green lanes are evidence, not a substitute for judgment. Verify the behavior and the adequacy of its witnesses, and distinguish pre-existing defects from regressions. Paths outside the unit's systems are fine when they serve its intent and violate no non-goal; otherwise report a finding. reachTraits and builder touches are a backstop for persistence/redaction review when dispatch traits missed a touched system.

${GATE_CHECKOUT}

Findings carry severity, evidence (experiments or path:line) and a defect classification when useful. A missing defect category does not invalidate a finding. Blocking findings require revise and actionable directives. Notes and pre-existing defects do not block. Reasons and premises may be brief; never claim evidence you did not inspect. Run only local experiments in your detached checkout; executor-only environments and suites belong to the executor.

Pre-build findings are standing items. In gate mode, return one standing response per supplied item, addressed or rebutted, each with concrete evidence. Refuse approval until every item is addressed or rebutted with evidence. Rule on every builder dispute once. Name reraises when repeating a ledger finding: the executor refuses a settled finding raised as blocking on unchanged code. Review repairs and regressions in the changed code; reconsider prior premises only when their files changed or evidence contradicts them.

The corpus remains normative. System notes are non-normative build memory (gotchas, seams, rigs), not claims. Contracts change through unit diffs, reviewed here; ask the root to amend the plan via apply --reason. Do not read a rulings ledger.

Work unattended to one structured answer. If your last paragraph promises more investigation, do it before answering. For a large diff, report clusters covering every changed path exactly once; read the attached files where the inline diff overflows. clusters is null unless the message includes <large_diff>. Final decision: approve, revise with directives, or escalate with reasons. Never invent coverage or weaken a test to justify approval.`;

function undeclaredContractsText(i: GateInputs): string {
  return i.undeclaredContracts.length === 0 ? '' : `

<undeclared_contracts>
The diff changes these contracts, which the spec's design record does not name as interfaces:
${bullets(i.undeclaredContracts, '(none)')}
</undeclared_contracts>`;
}

function largeDiff(i: GateInputs): string {
  const l = i.largeDiff;
  return l === null ? '' : `\n<large_diff>\n${l.overflow} files overflow the inline diff; ${l.changed} changed paths are listed in ${l.list}. Read the attachments and return clusters covering every changed path exactly once. Each cluster has an id, paths and review depth: description, routine or close. The verdict covers all clusters and their interactions.\n</large_diff>`;
}

function review(i: GateInputs): string {
  const r = i.review;
  const ledger = r.ledger.length === 0 ? '' : `

<findings_ledger>
Your earlier findings on this unit, each with its id, how it settled (open until it does) and whether its file changed since it was raised. A finding is settled once it is fixed, released, banked, or a dispute about it is ruled. A settled finding may block again only once its file has changed: the executor refuses a blocking finding that raises a settled one again (reraises) while its file is unchanged. Name the earlier finding in reraises whenever you raise one again, open or settled.
${r.ledger.map((e) => `- ${e.id} [${e.outcome ?? 'open'}${e.anchorChanged ? ', file changed since' : ', file unchanged'}] ${e.path}: ${e.text}`).join('\n')}
</findings_ledger>`;
  const disputes = r.disputes.length === 0 ? '' : `

<disputes>
The implementer disputes these open findings instead of fixing them, with its reasons. Rule on each once, in rulings: upheld when the finding stands (raise it again, naming it in reraises, if the merge still cannot carry it), overruled when it falls, with the reason. Your ruling is final: the finding is not disputed again.
${r.disputes.map((d) => `- ${d.finding}: ${d.text}\n  Dispute: ${d.reason}`).join('\n')}
</disputes>`;
  const d = r.delta;
  const delta = d === null ? '' : `

<delta>
You approved this unit at ${d.approved.head}. Since then the files below changed, or name a target your approval bound that has moved; they are under review:
${bullets(d.review, '(none)')}
These files you approved are unchanged. They are in your checkout to read for context, and they are not under review:
${bullets(d.unchanged, '(none)')}
Targets your approval bound that moved since (contracts, rulings, requirements):
${bullets(d.moved, '(none)')}
A blocking finding on an unchanged file must rest on what moved: a changed hunk, cited in hunk (a path under review and a line on the head's side), or a moved target, named in contractRef. The executor records any other blocking finding on an unchanged file as a note.
</delta>`;
  return `${ledger}${disputes}${delta}`;
}

function priorRound(i: GateInputs): string {
  const p = i.priorRound;
  if (p === null) return '';
  return `

<prior_round>
You gated this unit before and revised. This round rules on that round's conclusions against the fixed code; it is not a fresh review. Your directives were:
${bullets(p.directives, '(none)')}
Your findings:
${findingsText(p.findings)}
The premises your decision relied on:
${premisesText(p.premises)}
Paths the fix changed since:
${bullets(p.fixPaths, '(none)')}
Premise files changed since:
${bullets(p.changedPremiseFiles, '(none)')}
Rules for this round:
1. Rule on each prior directive and finding: resolved or unresolved against the new code.
2. Review the changed paths for regressions.
3. Re-verify only premises whose files changed. Trust the rest, but overturn any premise you have evidence against.
4. A new finding on unchanged code is blocking only if it affects correctness or stated acceptance; every other new finding is a note or pre-existing, never a directive.
</prior_round>`;
}

export const render = (i: GateInputs) => `${documentsXml([
    { source: `spec.json for unit ${i.spec.unit}, revision ${i.spec.rev} (rendered)`, content: i.spec.markdown },
    ...i.contracts.map((c) => ({ source: `contract ${c.path}`, content: c.text })),
    ...milestoneDocuments(i.milestones),
    targetDocument(i.target),
  ])}

<contracts_index>${JSON.stringify(i.index.contracts)}</contracts_index>${milestonesText(i.milestones)}${systemNotesText(i.systemNotes)}

<direction_text>
${i.direction}
</direction_text>



<obligations>
${obligationsText(i.obligations, { serves: false })}
</obligations>

<standing_obligations>
${standingObligationsText(i.standingObligations)}
</standing_obligations>

${boundedDiffText('diff', i.diff.bounded, i.diff.claims)}

<lane_ledger>
${laneLedgerText(i.laneLedger)}
</lane_ledger>

<evidence_dirs>
${bullets(i.evidence, '(none)')}
</evidence_dirs>

<unit_systems>${bullets(i.systems, '(none)')}</unit_systems>
<builder_touches>${bullets(i.touches, '(none)')}</builder_touches>
<reach>${bullets(i.reach, '(none)')}</reach>
<system_traits>${bullets(i.traits, '(none)')}</system_traits>
<reach_traits>${bullets(i.reachTraits, '(none)')}</reach_traits>
<intent>${i.intent}</intent>
<non_goals>${bullets(i.nonGoals, '(none)')}</non_goals>${undeclaredContractsText(i)}${gateChecksText(i.checks)}${priorRound(i)}${review(i)}${escalationText(i.escalation, 'gate')}${largeDiff(i)}

<standing_items>${JSON.stringify(i.standing)}</standing_items>
${methodModules('verifier', i.method)}
Gate unit ${i.spec.unit} at head ${i.diff.bounded.to}, spec revision ${i.spec.rev}. Grade each acceptance clause, then return your decision.`;
