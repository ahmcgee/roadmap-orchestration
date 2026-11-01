# Executor schemas and contracts — schema 2

Current contracts for **1.0.0-dev.33**. This is a reference to the implemented readers, not an append-only release
history. Paths below are relative to this executor directory. [DESIGN-1.0.md](../../../DESIGN-1.0.md) explains behavior;
[reference.md](../skills/orchestrate/reference.md) lists every parser-checked CLI form.

## Conventions and record evolution

`SCHEMA_VERSION = 2` in `src/core/version.ts`. Versioned runtime records require `v:2`; startup inspects pre-existing
run state and refuses schema 1 **before** host claim or recovery. Dev.32 runs must finish with their original executor.
This is the explicit one-off exception to upgrade-in-place. There is no schema-1 journal adoption/defaulting layer.
The serial previous-release regression names `1.0.0-dev.32` and asserts that refusal.

Input schema strings remain `roadmap/plan-m1`, `roadmap/spec-m1`, `roadmap/vision-m3`, `roadmap/obligations-m3`,
`roadmap/phase0-m4`, `roadmap/corpus-guide-m4`, `roadmap/corpus-pin-m4`, `roadmap/debt-m4` and `roadmap/brief-m4`.
Their suffixes identify formats, not runtime compatibility. Optional fields/defaults below are current authoring
semantics, not a promise to read a previous release's runtime.

Readers in `src/core/validate.ts` reject unknown fields. `?` denotes optional, not nullable. Nullable fields must be
present with null where their reader requires them. Integers/counts, enum membership, path brands and cross-field rules
are checked explicitly. Id lists use the ordering their reader specifies (numeric id order where required); do not
infer lexicographic C-10 before C-2. `Sha` is a 40-hex git id, `Sha256Hex` a 64-hex content hash. RepoPath/RepoPattern
stay under the repo; PlanPath resolves beside plan.json; AbsPath is absolute. Commands execute argv without a shell.

### Reader map

| Contract | Source |
|---|---|
| Id constructors, invocation/op/job grammar | `src/core/ids.ts` |
| Paths, patterns, timestamps, branch/ref names | `src/core/values.ts` |
| Plan, units, milestones, environments | `src/input/plan.ts` |
| Specs, lanes, dispatch, runner/host/command records | `src/core/records.ts` |
| Systems and traits | `src/input/systems.ts` |
| Lane authoring placement | `src/input/ci.ts` |
| Frozen change classification, CAS | `src/input/classify.ts`, `src/input/cas.ts` |
| Vision, obligations, finding/audit/pack types | `src/holistic/types.ts` |
| Corpus guide/pin/registry | `src/corpus/types.ts` |
| Phase 0, chain, brief/answers | `src/phase0/types.ts` |
| Debt ledger and dispositions | `src/debt/types.ts` |
| Role inputs and strict outputs | `src/prompts/inputs.ts`, `src/prompts/schemas.ts` |
| Routing and effective profile/fallback | `src/routing/{types,layers,profiles,eligibility}.ts` |
| Journal intents/done/abort/facts | `src/core/events.ts` |
| Finding ledger/disputes, design, pins | `src/core/{review,design,pins,stale}.ts` |
| Status, summary and TUI projections | `src/status.ts`, `src/status/summary.ts`, `src/tui/` |

## Input contract

The root keeps inputs outside the product worktree. Start keeps bytes by hash. Subsequent authoring-directory edits
are inert; only exported CAS apply can change the revision in force. Restart reads kept inputs, not edited originals.

### Plan

Required top-level fields:

```ts
{
  schema: 'roadmap/plan-m1'; arc: ArcId; integrationBranch: BranchName;
  baseline: Sha; worktreeRoot: AbsPath; contracts: RepoPath[];
  rulings: PlanPath; direction: string;
  suite: {lanes: LaneDef[]}; resources: ResourceDecl[]; units: PlanUnit[];
  // exactly one target arm, described below
}
```

Optional: routing, capacity `{cpu?}`, expectations `{arcUsd?,perMilestoneUsd?}` (finite non-negative USD, never caps),
limits, chain `{previousArc,previousHead}`, previousHead, knownDefects, derived, milestones, environments. Top-level
previousHead is the foreign-predecessor form and cannot coexist with chain. Baseline/head/path ancestry checks run in
Phase 0/start, not just parsePlan. `demo` is reserved as an arc id. Units, spec paths, resources and edge ids are unique;
after/reenters name earlier units in plan order.

Target arms:

- `architectureDoc:RepoPath`, optional architectureDigest, optional holistic `{vision:PlanPath,advances,obligations?}`.
- `corpus:PlanPath`, `phase0:PlanPath`, `holistic:{advances,obligations?}`. No architecture digest or holistic vision
  path in this arm; vision is product `.roadmap/vision.json`. Corpus arcs are holistic.

Advances are active vision clauses and include a world clause. Optional obligations means no obligations when absent.
Milestones and batch lanes require holistic. The parsed target discriminant is derived from fields; do not write it.

```ts
PlanUnit = {
  id: UnitId; spec: PlanPath; risk: 'low'|'med'|'high'; systems: SystemName[];
  resources: ResourceName[]; after?: UnitId[]; contingent?: {id:EdgeId,condition:string}[];
  origin?: 'planned'|'repair'|'polish'|'deflake'; cpu?: number;
  review?: 'always'|'never'; spike?: {question:string};
  reenters?: {unit:UnitId,enterAt?:'pre-build'|'build'|'verify',reset?:{reason:string},fixes?:FailureRef};
  cut?: {reason:string}; routing?: RoutingLayer; limits?: UnitLimits;
  priority?: 'normal'|'high'; polish?: {milestone:MilestoneId,proposal:PolishId};
  deflake?: {keys:FlakyKey[]};
}
```

Systems are required, nonempty, unique and known. Optional after/contingent normalize to empty lists; priority to normal,
origin to planned. Polish/deflake metadata is present exactly for that origin. A spike requires a nonempty question and
resources; it retires the gated report without candidate publication. Later spike resource/environment introduction is
refused and escalated to an owner request. Reserved new unit ids include batch-n, jobs and mutants.

Root splits conserve parent text, systems, obligations, dependencies and milestone ownership; deflake cannot split.
Re-entry must identify a recorded failure where required and does not silently clear lineage counters. Cuts and reset
carry reasons. All structural/runtime restrictions are applied again by the classifier, not only the parser.

### Specs and design

```ts
{
  schema:'roadmap/spec-m1'; unit:UnitId; rev:number;
  intent:string; nonGoals:string[];
  lanes: (LaneDef & {state:ItemState})[];
  acceptance: {id:ClauseId,clause:string,failLoudIfUndelivered:boolean,state:ItemState}[];
  resources:ResourceName[];
  decisions:{id:ClauseId,text:string,state:ItemState}[];
  facts:{id:ClauseId,text:string,state:ItemState}[];
  cites:{contracts:RepoPath[],rulings:RulingId[]};
  obligations?:ObligationId[]; repairs?:(FindingId|ObligationId)[];
  witnesses?:{id:WitnessItemId,lane:LaneId,testId:string,clause:ClauseId,skeleton:string,
              obligation?:ObligationId,state:ItemState}[];
  removes?:string[]; forces?:LaneId[]; design?:DesignRecord; pins?:SpecPin[];
}
ItemState = 'active'|'struck'|'deferred';
```

Rev starts at 1. Intent is required text; nonGoals and acceptance are nonempty. Item ids are unique across all item
sections, never reused when struck/deferred. Optional nonempty lists cannot be supplied empty unless their reader
explicitly permits it. A repair origin requires repairs. Obligation declarations cover system impact selected by mapping.
Removes is retained as literal one-line names; it does not grant or impose a file write fence. Forces selects suite
checks at the unit lanes point, subject to integration/expense placement rules.

Cites keeps the legacy field names above. Only contracts are supplied to seats; C-n text is root-facing. Plain ledger
format is `C-n — <text>` or `C-n — withdrawn by C-m`, with C-m present and each id once. Empty lines/headings are ignored.
No sidecar directory or consistency stamp is part of RevisionInputs.

DesignRecord and its validators live in `src/core/design.ts`: unit kind, typed changes/interfaces, failure modes/proofs,
clause-lane coverage, breaks, experiments, newSystem and verification. Root-authored design must pass reachability,
reference coverage, clause/witness and verification checks. It is not produced by a separate design-review seat.
Pins in `src/core/pins.ts` bind linked requirement revisions and contract blobs. `stale-set`, `stale-answered` and
`stale-reopened` retain revision-link diagnostics and boundary reopening; no automatically minted propagation unit exists.

### Lanes

Required LaneDef fields: id, nonempty argv, cwd, env `{set:Record<string,string>,pass:string[]}`, expectedExit,
cadence, resources, evidenceGlobs. EvidenceExcludes defaults to []. Pass/set names cannot overlap. Optional fields:
inputs (nonempty unique patterns), cost cheap|expensive, placement local|shared-resource|cross-system, cpu, timeoutMin,
systems, testArgv, stochastic, environment, readsComments, kind/capture.

| Lane context | Accepted cadence | Additional rules |
|---|---|---|
| Spec | build, unit, candidate | Integration placements require spike; candidate executes on current candidate tip |
| Suite | build, unit, candidate, batch | Batch requires holistic; local batch placement refuses |
| Arc witness | build, candidate | Adds reporter/testPaths/witnessClass; no testArgv/stochastic/environment |

Contextual authoring (`ciReasons`) refuses cost expensive or explicit whole-tree inputs (`*`, `**`, `**/*`) at build/unit.
Shared-resource/cross-system spec placement refuses outside spike. Forced expensive/integration suites refuse for normal
units. Selected milestone lanes must be suite batch lanes explicitly shared-resource or cross-system. There is no
milestone cadence literal, attempts/reviewAfterReds Bounds field or lane estMin.

Systems select impacted checks conservatively; unmapped paths select. Reuse input is explicit inputs-filtered ls-tree,
else unit systems for implicit spec lanes or lane systems. Command/environment/lane identity, clean series certificate and
completed evidence metadata still bind reuse. `testArgv` has exactly one `{files}` element for changed leaf-test files.
Stochastic `{runs,minPasses}` requires runs >= 2 and minPasses <= runs and bypasses ordinary flake classification.
TimeoutMin is positive; absent uses the six-hour runner backstop rather than a red timeout verdict. ReadsComments true
remains parseable but enables no special pass carryover.

Capture shape:

```ts
{kind:'capture', capture:{up:string[],script:string[],states:string[],port:ResourceName,portBase?:number}}
```

Capture and kind appear together. States are safe filename stems. Port is in lane resources and names a declared pool;
script names a repo capture script path. The executor binds a leased slot/port, contains stack+script and requires every
PNG. Only related milestone design/member gates get the evidence. Summary currently projects suite capture spawns.

Evidence globs declare disposable outputs, not source/test files. Authoring checks reject overlap with tracked files of
unit systems and protected paths. Ignored-output evidence has default secret exclusions; explicitly declared output is
kept. A completed lane result carries census/host evidence; final host.json is the durable completion marker. Partial
capture after a crash is not reusable completed history.

Repeated reds compare diffBase and record lane-base-compared with original evidence; pass there charges regression,
fail uses base-red. Original base/unit result directories survive cache hits and recovery. Fix-round comparison preserves
lane id, set, base/head, results and evidence; candidate comparisons preserve green tip-alone evidence too.

### Systems and non-normative memory

Product config systemsMap:

```ts
{
 systems:Record<SystemName,{paths:RepoPattern[],tests?:RepoPattern[],dependsOn?:SystemName[],
                            traits?:('persistent'|'redacts')[]}>;
 shared?:{paths:RepoPattern[],dependents:SystemName[]}[];
 contracts?:Record<RepoPath,SystemName[]>; docs?:RepoPattern[];
}
```

Systems cannot be empty; docs is reserved for the docs class. Shared/contract/dependency names must resolve. Each revision
records the map read from config. Gate reach is actual paths beyond direct declared-system membership, plus reachTraits
from actual diff/builder touches. It is neutral input, not an out-of-system write refusal. Phase 0 overlap is advisory.
Central protectedPaths protects `.roadmap/` and pinned same-repo corpus files across salvage/transient/recovery.

Config `systemNotesDir?:RepoPath` defaults to docs/systems. Build/gate inputs `systemNotes` are sorted existing
`<system>.md` paths at the checkout commit, not note contents or new normative requirements. Notes edits use ordinary unit
diffs. Commit memory uses captured report summary and decisions.json bytes; salvage/candidate and repair-batch messages
are deterministic from verified evidence even when builders already committed all changes.

### Resources, environments and bounds

ToolCommand `{argv,cwd:RepoPath,env:LaneEnv}` runs without a shell. ResourceDecl `{name,probe,teardown,pool?:{size}}`;
probe exits 0 free, 10 own label, 11 foreign/unlabelled, others fault. Pool instances are name#n, exposed as
RESOURCE_INSTANCE_<NAME>. Reservations include CPU atomically; residues are per resource instance and unit/job owner.

On disk environments is a name-keyed map of `{probe,up?,down?,idleMinutes?,resources?}`. Up/down/idleMinutes come together;
with them code owns lazy lifecycle, otherwise it only probes/reserves. Environment names share the resource namespace
and cannot collide. Resources lists declared resources powered by the environment; absent means none.

Limits override defaults at plan then unit, never below spent counters. Current defaults:

| Bound | Default |
|---|---:|
| chargeable | 3 |
| certifications (charge every Nth certification red) | 4 |
| reviseRounds | 2 |
| candidateReds | 1 |
| retries | 1 |
| judgmentDeadlineMin | 45 |
| freshBuildMin | 180 |
| editAllowanceMin | 60 |
| smokeRounds | 1 |
| smokeRuns | 2 |

Arc limits additionally allow walkRounds (default 3) and verification `{laneMinutes?,lanes?}` for deflake budgets (default
30 lane-minutes; batch default two runs). Separate fixed attempt thresholds are 8 builds/20 judged attempts for M4 and
16/40 at a boundary for a hard cap. Attempt counts include build/lanes/gate, interrupted and uncharged work, with lineage.
`review:never` disables review calls but not the hard cap. Steering leaves cap counts intact.

KnownDefects `{id,match,fixUnit}` match lane or output substring; held units wait uncharged until the fix lineage merges.
Derived entries `{sources,outputs,regenerate?:ToolCommand}` only add deterministic regeneration at lanes; no exclusions.

### Milestones and bring-up

Milestone `{id,text,units,design:{unit}|{supplied:true},lanes?,references,bringUp,journeys,resources}`. Units/references/
journeys are nonempty where required; selected lanes default []. A design unit is planned and outside its members.
Journeys have `{id,text,via:browser|shell,entry,budget:{steps,seconds}|null}`. BringUp has setup argv[], serve entries
`{name,argv,ready:{http}|{log}}`, env map, seed argv[]. `{port:<serve-name>}` substitutes allocated ports consistently.
References are design directories and have a 512 KiB text budget. Missing tools/MCP handshake refuse browser readiness.
Milestone dependents wait for experience settlement; breaks hold, deviations can be repaired alongside work. Walk and
before/after comparison share the experienceVerdict role. Demo records/controls are in `src/demo/records.ts`.

## Vision, obligations and witnesses

Vision shape:

```ts
{schema:'roadmap/vision-m3',rev:number,confirmation:{ref:string,at:IsoTime}|null,
 clauses:{id:VisionClauseId,kind:'world'|'purpose'|'serves'|'good'|'non-negotiable'|'tradeoff'|'experience',
          text:string,rank:number|null,state:'active'|'withdrawn'}[],
 questions:{id:QuestionId,text:string,bears:VisionClauseId[],assumption:string,state:'open'|'closed'}[]}
```

At least one active world clause. Rank is positive exactly for tradeoff. Open questions bear on active clauses; closed
questions retain history. Corpus confirmation is `corpus:<path-under-root>#sha256:<hash>` and verifies pinned bytes.
The architecture-doc arm also accepts `<file>#sha256:<hash>` without corpus playback verification.

```ts
Obligations = {
 schema:'roadmap/obligations-m3'; cutLine:string; lanes:ArcLaneDef[];
 obligations:ObligationDef[]; mapping:{systems:{system:SystemName,obligations:ObligationId[]}[]};
 census?:{rule:RuleId,state:{type:'obligation',id:ObligationId}|{type:'out-of-slice'|'untestable'|'prod-only'}}[];
}
ObligationDef = {
 id:ObligationId; rev:number; statement:string; serves:VisionClauseId[];
 // exactly one rule or docRef
 rule?:{id:RuleId,textSha256:Sha256Hex}; docRef?:{path:RepoPath,anchor:string,quotedText:string};
 witness:{lane:LaneId,testIds:string[],files?:RepoPath[]}|null;
 proofJudgment:{verdict:'proves'|'insufficient',obligationRev:number,
                witness:{testIds:string[],files?:RepoPath[]}}|null;
 deliveredBy:UnitId[]; activation:'future'|'must-hold'; parent?:ObligationId;
 contracts:RepoPath[];
 state:{type:'active'}|{type:'split',children:ObligationId[]}|
       {type:'waived'|'deferred'|'retired',reason:string,rev:number};
}
```

Fresh witness authoring requires files and arc lane testPaths through plan-defect checks, even where shape readers keep
them optional. Census is required for corpus target validation and names every active rule exactly once; split-family
census names the parent. Split parent witness/proof are null. New obligations start active at rev 1. Normative rev changes
exactly for statement/anchor/activation changes. Intentional weakening needs root apply reason; disposition records bind
reason/revision. Proof judgments must prove the current statement rev and ids/files. Lane/argv moves with identical proof
ids/files are re-witnesses, not obligation-dropped. Active vision citations, deliverers, impact declarations, split no-drop
text and frozen-contract checks remain enforced. Only the root authorizes dispositions.

ArcLaneDef = LaneDef + reporter node-test|go-test-json|jsonl, optional nonempty testPaths and witnessClass external.
Node-test reporter owns NODE_OPTIONS, so a lane cannot set/pass its own. Required witness tests must run exactly under
their ids; missing/skipped/failed do not hold a property. Witness records include environment, lane revision, tree/input,
invocation, hashed records and purpose. Future obligations latch after delivery and held proof; observations remain
code-derived rather than model assertions.

External-class lanes use root `witness` submission. Command binds expectedHead and either a hashed regular file or
HTTP(S) URL. Stale head, tampered bytes, inactive/non-external obligation refuse. Pass can latch; failure records reopening
of the latest delivering lineage and a kept note. URLs are recorded references, not proof that the executor fetched them.

## Corpus, Phase 0, debt and chain

Corpus guide: one fenced `json roadmap-corpus` block in `.roadmap/corpus.md`:

```json
{"schema":"roadmap/corpus-guide-m4","source":{"kind":"same-repo","root":"docs/corpus"},"include":["**/*.md"],"vision":"vision.md"}
```

Source alternatives are other-repo `{path:AbsPath,root}` or checkout `{remote,root}`. Pin is generated, not hand-authored:
`{schema,guideSha256,source(with commit),files:[{path,sha256}],rules:[{id,textSha256,text,file,section}],retired,highWater,vision}`.
Paths are under corpus root. Rules are one T-n claim per line in rules fences, never in the vision file. Equivalent
wording keeps ids; changed meaning takes new ids; retired ids cannot return. Pin/file/guide drift refuses. Published
invariants include `json roadmap-rules` registry `{highWater,active,retired}` with rule refs.

Phase0Record:

```ts
{schema:'roadmap/phase0-m4';
 curation:{tier:'structural'|'fact-currency',what:string,files:RepoPath[],rules:RuleId[]}[];
 corpusDivergences:{tier:'semantic',what:string,
   preimage:{pinSha256:Sha256Hex,files:{path:RepoPath,sha256:Sha256Hex}[]},cites:VisionClauseId[],rules:RuleId[]}[];
 questions:{id:PhaseQuestionId,rank:number,text:string,files:RepoPath[],bears:(RuleId|VisionClauseId)[],
   assumption:string,state:{type:'open'}|{type:'answered',answer:string,at:IsoTime}}[];
 debt:{id:DebtId,disposition:DebtDisposition}[];
 slice:{advances:VisionClauseId[],why:string};}
```

Questions are ascending by id, ranks unique; new ids continue chain history. Recorded owner answers must match exactly.
Every open baseline debt item needs a disposition; twice-kept debt needs a question. Slice matches holistic advances.
Curation source files/preimages make semantic interpretation auditable. Spec-census cross-checks run on revisions too.

DebtDisposition is promote `{type:'promote',unit}`, keep `{type:'keep',reason}` or resolve `{type:'resolve',ruling:C-n}`.
DebtLedger `{schema:'roadmap/debt-m4',items}` is rendered in `json roadmap-debt`. Items retain id, originArc, bankReason
(gate-note|finding-deferred), what, unit|null, key, history and state open|promoted|resolved. Key dedupes normalized unit/
reason/text; gate or finding source prevents repeated banking. C-n is retained here as a plain ledger reference.

Chain plans use chain `{previousArc,previousHead}`; foreign predecessors use top-level previousHead instead. Baseline is
validated against the preceding head/allowed single-parent between-arc commit. Normal chain requires a completed verified
previous ref; foreign baseline does not fabricate one. Config chain.k and acknowledged starts determine next eligibility.
PR records distinguish open/merged/closed/unavailable, with stacked base and explicit supersede behavior.

OwnerAnswer `{schema:'roadmap/answer-m4a',question,k,answer,at,arc}` is append-only under common-dir roadmap/answers.
Latest k supersedes older answers; applying the answer to Phase 0 is separate from recording it.

## Plan in force and CAS

RevisionManifest = `{planSha256,specs:Record<UnitId,Sha256Hex>,rulings:{ledgerSha256},obligations:Sha256Hex|null,
vision:Sha256Hex|null,corpus?,corpusGuide?,phase0?}`. Corpus trio is present together or absent. Kept bytes use hashes and
fixed input extensions. RevisionSource has start, command, executor, walk, compare, split and deflake arms (exact declarations below).

Inputs export writes a new directory with current plan/specs/ledger/obligations/vision/pin/Phase0. Beside-plan names are
preserved; product files go under repo/. Guide is not exported. Export metadata is `{planRev,specRevs,base:RevisionManifest}`.
Apply requires that metadata and matching --rev. Changed file bytes must still match base in force; untouched files take
current bytes. All stale files are listed. Changed existing specs auto-bump current rev + 1. No field merge is attempted.

Apply still classifies safety/proof/risk/split/contract invariants and stores the reason. A payload-first revision is
activated under a fence with plan-applied last. Queued commands retain boundary provenance through restart. Executor CAS
races retry and produce non-blocking notices; root commands do not auto-raise executor revision notices.

## Commands, receipts and needs-user

CLI parsing is pure and closes over Command kinds; run locator is host or paired repo/arc. Complete forms are in the
skill reference and parsed by skill-lint. The persisted CommandBody union appears below; host acts such as export and
brief are not queued command bodies. Brief/note evidence is hashed before submit, so later changed bytes refuse.

Command files are write-once incoming records with accepted/queued/applied/rejected receipts. Accepted/queued does not
mean applied. Apply receipt may expose remaining plan-defect advisories while refusing new defects. Steer drains a live
unit before applying; note informs the next build without cancelling it. Resume backend is explicit availability recovery.

NeedsUserRecord `{v:2,id,arc,raisedAt,blocking,subject,reason,summary,recommendation,options,evidence}` has subject
unit `{type:'unit',unit}`, arc or host. Options are `{id,label}`; evidence is absolute paths. Ack record is
`{v:2,id,command,choice:string|null,at}`. Optionless items reject ack; successful subject actions close them. Offered choice
must exist. Revision-notice and waste-finding are non-blocking. Subject closure preserves publication/recovery ordering
instead of requiring a second bookkeeping command. The full current reason enum is emitted in the appendix.

## Roles, routing and strict results

Only recorded roles: build, verifier, packReview, experienceVerdict, campaignAudit. Build seats low/med/high; verifier adds
escalation; arc roles have arc. Verifier modes pre-build/gate/diagnosis; experience modes walk/compare. Routing layers name
classes per seat (builtin → repo-config → plan → unit). Classes efficient/frontier/summit may build; economy is judgment-only.
Profiles default/claude-only differ in build bindings and eligibility, not the five-role vocabulary.

Config routing `{profile?,seats?,classes?}` binds model triples only in classes. Default eligible low/med builds can use
Codex; M2/design/high risk and diagnosis fallback use Claude. M1/capture-only remain eligible. Claude judgments and
frontier advisor remain. Effective fallback/profile changes have routing revisions so history resolves actual seats.
Config also accepts chain, walkthrough.mcp, systemsMap and systemNotesDir; unknown keys refuse.

Strict role output readers reject retired fields. BuildOutput is summary/blockers/experiments/grounding/tooBig/notes/final
(exact type below). Grounding contains specWrong nullable text and touches strings; tooBig is **top-level**. Structured
decisions come from decisions.json captured by evidence, not a BuildOutput decisions key. Final false is an intermediate
wait protocol; the terminal build output must be final true.

Verifier uses GateOutput: decision approve/revise/escalate; standing dispositions addressed|rebutted with nonempty evidence;
findings; reasons; premises; clusters|null; rulings for disputes; directives only nonempty for revise; optional ordering
blockers only for escalate. Finding severity blocking|note|pre-existing|ride-along; evidence and experiments must provide
an experiment or path:line. Defect is nullable classification, not mandatory for blocking. Approve cannot contain blocking
findings. New evidence is required to re-raise settled findings. Gate disputes still use `rulings` in this schema; this is
separate from the C-n root ledger. Clusters cover each changed path exactly once on a large diff.

M1/M2/M3 reviews annotate standing items; M4 diagnosis stores a note. Markers and completed reviews are journal facts.
PackReview result carries target-specific findings/dispositions and report; whole-campaign outputs carry findings and
root requests, never executable plan changes. ExperienceVerdict holds a tagged walk or compare output. See the source
readers for their complete nested schema; those fields are validated against real ids and evidence rather than prose.

## Event log and effect contracts

Events are hash-chained records. Envelope is `{v,seq,prev,at,arc}`; prev binds the preceding record hash (null at seq 1); body is intent,
done, abort or fact. Intents carry op id/kind, resource, parent and exact expect payload; done binds kind-specific outcome
and recoveredBy. Aborts give reason/evidence. Log replay enforces closure, identity and order; torn tails are recorded.
Never hand-author facts in an arc.

Op kinds: worktree.create/remove, resource.transition, proc.spawn/kill, evidence.snapshot, salvage.commit, mergein.prepare,
spec.patch, candidate.merge, integration.ff, snapshot.publish, needsuser.raise, command.apply, docs.commit, mutant.apply,
revision.commit. Exact OpExpect/OpOutcome maps in events.ts define each pre/postcondition; source-level signatures replace
historical schema appendices. Git effects include deterministic commit inputs/parents/expected refs. Ff publishes either
unit fingerprint or docs/batch subject and only the tested head. File effects use durable writes and content hashes.

Live fact families:

| Family | Facts and meaning |
|---|---|
| Work/usage | dispatch, judgment-inputs, approval, stage-outcome, meter, usage-unavailable; exact attempt/role/routing attribution |
| Control | paused, stop-requested, resumed, backend-park, probe, reopened/unparked, edge-resolved, run-only |
| Inputs | plan-applied, apply-queued, noted, steered, merged-in, revision-link stale-set/answers/reopening |
| CI | external-witness/reopened, spike-completed, attempt-marker/capped, lane-base-compared, lane-reused, series-certified, smoke-ran |
| Review | review-triggered/completed; gate round/findings-ledger/dispute facts |
| Target | witnessed, obligation-latched, finding-opened/transition, audit-started/ended/requested, divergence |
| Pack/debt | pack-review-started/ended, debt-banked |
| Lifecycle | admissions-closed, docs-published/covered, arc-completed, executor-started, containment-mode, tail-discarded, needs-user-acked |
| Experience/demo | walk/compare/polish/tweak and demo facts in WalkFact; tagged by durable job/milestone/round |
| Flakes | flake-observed and ledger/code-edge state |

`stage-outcome` is a union: unit stage/attempt/outcome/class/chargeable (+ detail/park/cause), or job stage
experience-verdict|campaign-audit with job/milestone/verdict/findings. Consumers must discriminate the arm; job outcomes
have no unit/attempt/outcome. Meter, proc.spawn and lane-reused remain stable feed names. TokenUsage preserves native
cost where present and sets costEstimated on price-table estimates; unavailable/partial usage retains the reason/tokens.
PromptSize records exact stdin bytes and canonical per-input bytes.

The pre-build stage remains as an annotation boundary. Live STAGES are prepare, reproduce, pre-build, build, quiesce,
evidence, salvage, teardown, lanes, gate, candidate, ff, snapshot, retire. Retry/counter behavior is defined by
pipeline/transitions.ts and park/table.ts. Attempt counting includes build/lanes/gate, not bookkeeping stages.

Finding/audit wire categories retain lens names as classifications. Scheduling has one campaign seat at milestone,
requested and final triggers; no selector flag or rolling cadence. Bounded diff budgets/refusals and durable partial
coverage remain. Close-out debt/releases remain; only the root edits obligation authority.

## Runner, host, publication and recovery records

InvocationBinding pins version/arc/invocation. LaunchFile pins process, input/output paths, deadline, containment, terminal
protocol, environment and subject (backend role/seat or lane/probe/etc). Backend call roles are the current five; modes
belong in role inputs. The runner owns the child/workload membership, writes files, waits for quiescence then runs a pure
adapter. ExitFile binds child termination/cause/endedAt/quiescedAt and optional CPU observation. BackendResult separates
outcome from known/unavailable usage; CommandResult uses pass/fail/stall/timeout/process-fault/cancelled. A result is usable
only under its own invocation binding.

Host owner/lock records bind nonce/generation/pid/start/boot, with handshake before effects. Readiness/supervisor state,
heartbeat (10 seconds; stale 5 minutes), intentional executor exit and external exit evidence are typed in records.ts.
Recovery takes an exclusive recovery lock before owner takeover. Ambiguous identity refuses. Residue records are keyed
by arc/invocation/resource-instance and exactly one unit/job owner; disposition is cleaned/isolated/transferred with
provenance. CPU tokens do not get residues. Resource release requires actual teardown/quiescence, not just a done flag.

Snapshots publish only allowlisted records plus a SHA-256 manifest to refs/roadmap/<arc>. Raw evidence stays in runtime.
Recovery verifies closure and required kept bytes, replays pending revisions/publications and reconstructs deterministic
commits. Ref movement must match its expected old/new identities. Document publication owns the same slot and may preempt
candidates uncharged. Completion binds planRev/head/highWater and can reopen under a valid later revision; sealed history
remains immutable. GC preserves needed verified snapshots while compacting eligible old runtime/evidence.

## Status and brief projections

Status is read-only without a lock. Summary fields: arc, state, planRev, progress `{total,merged,states,held,remaining}`,
spend `{costUsd,expectedUsd,differenceUsd,estimatedCalls,unavailableCalls}`, milestones, caught, verdicts, captures,
needsUser, waste, demo, completion. Caught is laneReds + gateRevisions + uniqueFindings, with byLens counts of unique keys;
not a cross-seat unique-defect metric. Milestone costs include members/re-entries/polish and walk/compare jobs, not all
arc costs. Captures lists suite capture spawns only. Waste findings use observed duration/evidence and durable cause keys.

BriefPayload `{schema:'roadmap/brief-m4',coverage,items,chain,answers,arcs}` is canonical and has no clock. BriefId is the
first 16 hex of its SHA-256. Coverage entries are `{arc,snapshotCommit,highWater}`; Markdown derives only from the payload.
Arc entries include slice, divergences, decisions, curation/corpusDivergences, debt, questions, pack notes, census, timings,
PR and demo. AckMarker `{briefId,at,chainHead,coverage,items}` is write-once pending then committed by rename under
common-dir roadmap/acks. Brief ack advances coverage/chain count and does not resolve optionless runtime items.

## Removed schema-1 surfaces

Schema-2 readers reject retired roles/stages/facts rather than preserving dead producers. Flow optimization/proofs/givens,
plan-check decisions, scaffold/PoC, checkpoint bundles/conversions/amendments, issue integration, scope growth/envelopes,
docs-only certification, convergence brakes, ruling sidecars and automatic propagation have no live contract. Internal
names such as lens classification, plain C-n fields and stale-link diagnostics survive only for the live uses above.

## Exact selected declarations

The following declarations are copied from current source without historical comments. They anchor the new fact and
command wire shapes; referenced branded/nested types are defined by the source index above.

### JobStageOutcomeFact (`src/core/events.ts`)

```ts
export type JobStageOutcomeFact = Readonly<{
  kind: 'stage-outcome'; stage: 'experience-verdict' | 'campaign-audit';
  job: JobId; milestone: MilestoneId | null;
  verdict: 'pass' | 'revise' | 'keep' | 'drop' | 'abandoned' | 'bring-up-failed';
  findings: Readonly<{ P1: number; P2: number; P3: number; total: number }>;
}>;
```

### CiFact (`src/core/events.ts`)

```ts
export type CiFact =
  | Readonly<{ kind: 'external-witness'; command: CommandId; obligation: ObligationId; obligationRev: number; laneRev: LaneRev; inputSha: Sha; head: Sha; result: 'pass' | 'fail'; evidence: string; evidenceSha256: Sha256Hex | null }>
  | Readonly<{ kind: 'external-reopened'; command: CommandId; unit: UnitId }>
  | Readonly<{ kind: 'spike-completed'; unit: UnitId }>
  | Readonly<{ kind: 'attempt-marker'; unit: UnitId; marker: 'M4'; builds: number; judged: number }>
  | Readonly<{ kind: 'attempt-capped'; unit: UnitId; builds: number; judged: number }>
  | Readonly<{ kind: 'lane-base-compared'; unit: UnitId; attempt: number; lane: LaneId; base: Sha; evidence: AbsPath; result: 'pass' | 'fail' }>;
```

### ReviewItem (`src/core/events.ts`)

```ts
export type ReviewItem = Readonly<{ id: string; text: string; evidence: readonly string[] }>;
```

### SurfaceFact (`src/core/events.ts`)

```ts
export type SurfaceFact =
  | Readonly<{ kind: 'review-triggered'; unit: UnitId; marker: 'M1' | 'M2' | 'M3' | 'M4' | 'always'; source: string; specRev: SpecRev }>
  | Readonly<{ kind: 'review-completed'; unit: UnitId; mode: 'pre-build' | 'diagnosis'; specRev: SpecRev; planRev: PlanRev; inv: InvocationId; items: readonly ReviewItem[]; note: Sha256Hex | null }>;
```

### RevisionSource (`src/core/events.ts`)

```ts
export type RevisionSource =
  | Readonly<{ type: 'start' }>
  | Readonly<{ type: 'command'; command: CommandId }>
  | Readonly<{ type: 'executor'; inv: InvocationId }>
  | Readonly<{ type: 'walk'; job: JobId }>
  | Readonly<{ type: 'compare'; unit: UnitId }>
  | Readonly<{ type: 'split'; unit: UnitId; inv: InvocationId }>
  | Readonly<{ type: 'deflake' }>
;
```

### Grounding (`src/prompts/schemas.ts`)

```ts
export type Grounding = Readonly<{ specWrong: string | null; touches: readonly string[] }>;
```

### TooBig (`src/prompts/schemas.ts`)

```ts
export type TooBig = Readonly<{ estimate: string; suggestedChildren: readonly string[] }>;
```

### BuildOutput (`src/prompts/schemas.ts`)

```ts
export type BuildOutput = Readonly<{
  summary: string; blockers: readonly string[]; experiments: readonly Experiment[];
  grounding: Grounding; tooBig: TooBig | null; notes: readonly string[]; final: true;
}>;
```

### DispatchRecord (`src/core/records.ts`)

```ts
export type DispatchRecord = Readonly<{
  unit: UnitId;
  specRev: SpecRev;
  specSha256: Sha256Hex;
  riskFloor: RiskTier;
  routingRev: RoutingRev;
  implementerSeatRev: SeatRev;
  at: IsoTime;
  transientRules: TransientRules;
  bounds?: BoundsRecord;
}>;
```

### RevisionInputs (`src/core/records.ts`)

```ts
export type RevisionInputs = Readonly<{
  rulings: Readonly<{ ledgerSha256: Sha256Hex;  }>;
  obligations: Sha256Hex | null;
  vision: Sha256Hex | null;
  corpus?: Sha256Hex;
  corpusGuide?: Sha256Hex;
  phase0?: Sha256Hex;
}>;
```

### CommandBody (`src/core/records.ts`)

```ts
export type CommandBody =
  | Readonly<{ type: 'pause'; target: PauseTarget }>
  | Readonly<{ type: 'stop' }>
  | Readonly<{ type: 'ack'; needsUser: NeedsUserId; choice: string | null }>
  | Readonly<{ type: 'resume'; target: ResumeTarget }>
  | Readonly<{ type: 'sweep'; resource: ResourceName | null }>
  | Readonly<{ type: 'apply'; planFile: AbsPath; rev: PlanRev; reason: string; base: RevisionManifest; manifest: RevisionManifest }>
  | Readonly<{ type: 'resolve-edge'; edge: EdgeId; evidence: string }>
  | Readonly<{ type: 'run-only'; units: readonly UnitId[] | null }>
  | Readonly<{ type: 'reverse'; divergence: DivergenceId }>
  | Readonly<{ type: 'steer'; unit: UnitId; brief: Readonly<{ path: AbsPath; sha256: Sha256Hex }>; budgetMin: number; class: BuildClass | null; resume: boolean }>
  | Readonly<{ type: 'witness'; obligation: ObligationId; expectedHead: Sha; result: 'pass' | 'fail'; evidence: string; evidenceFile: HashedFile | null }>
  | Readonly<{ type: 'note'; unit: UnitId; brief: HashedFile }>
  | Readonly<{ type: 'merge-in'; unit: UnitId }>
  | Readonly<{ type: 'audit' }>
  | Readonly<{ type: 'close-admissions' }>
  | Readonly<{ type: 'demo'; act: DemoAct }>;
```

### NeedsUserRecord (`src/core/records.ts`)

```ts
export type NeedsUserRecord = Readonly<{
  v: SchemaVersion;
  id: NeedsUserId;
  arc: ArcId;
  raisedAt: IsoTime;
  blocking: boolean;
  subject: NeedsUserSubject;
  reason: NeedsUserReason;
  summary: string;
  recommendation: string;
  options: readonly Readonly<{ id: string; label: string }>[];
  evidence: readonly AbsPath[];
}>;
```

### Needs-user reason enum (`src/core/records.ts`)

```ts
export const NEEDS_USER_REASONS = [
  'attempt-cap', 'spec-wrong', 'split-proposal',
  'chargeable-bound', 'escalation', 'refusal', 'process-fault', 'malformed', 'salvage-failed', 'empty-diff',
  'occupancy-unlabelled', 'lane-blocked', 'base-red', 'candidate-red', 'foreign-ref-move', 'recovery-required',
  'reconcile-park', 'residue', 'usage-limit', 'supervisor-crash-limit', 'log-corrupt', 'owner-mismatch',
  'recovery-holder-dead', 'previous-arc-unreconciled', 'build-lost', 'routing-changed',
  'park-escalated', 'env-blocked',
  'obligation-baseline', 'finding-p1-escalated', 'new-finding-draining', 'steered', 'not-reproduced', 'owner-request', 'respec-second',
  'pack-review',
  'read-denied',
  'witness-lane-missing',
  'plan-defect',
  'context-exceeded',
  'executor-fault',
  'env-unavailable',
  'deflake-parked', 'flake-recurring',
  'apply-dropped',
  'revision-notice', 'waste-finding',
] as const;
```
