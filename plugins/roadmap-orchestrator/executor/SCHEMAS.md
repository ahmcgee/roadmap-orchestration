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
| Status, summary, TUI and web observations | `src/status.ts`, `src/status/summary.ts`, `src/observation/`, `src/console/`, `src/tui/` |

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
Fresh holistic starts require corpus (`holistic-needs-corpus`); the architecture-doc holistic arm remains a parsed shape.
Milestones and batch lanes require holistic. The parsed target discriminant is derived from fields; do not write it.

```ts
PlanUnit = {
  id: UnitId; spec: PlanPath; risk: 'low'|'med'|'high'; systems: SystemName[];
  resources: ResourceName[]; after?: UnitId[]; contingent?: {id:EdgeId,condition:string}[];
  origin?: 'planned'|'repair'|'polish'|'deflake'; cpu?: number;
  review?: 'always'|'never'; spike?: {question:string};
  reenters?: {unit:UnitId,enterAt?:'pre-build'|'build'|'verify',reset?:{reason:string},fixes?:FailureRef};
  cut?: {reason:string}; carries?: {unit:UnitId,tip:Sha}; routing?: RoutingLayer; limits?: UnitLimits;
  priority?: 'normal'|'high'; polish?: {milestone:MilestoneId,proposal:PolishId};
  deflake?: {keys:FlakyKey[]};
}
```

Systems are required, nonempty, unique and known. Optional after/contingent normalize to empty lists; priority to normal,
origin to planned. Polish/deflake metadata is present exactly for that origin. A spike requires a nonempty question and
resources; it retires the gated report without candidate publication. Later spike resource/environment introduction is
refused and escalated to an owner request. Reserved new unit ids include batch-n, jobs and mutants.

Root splits conserve parent text, systems, obligations, dependencies and milestone ownership; deflake cannot split.
Re-entry must identify a recorded failure where required and keeps lineage counters. `reenters.reset: {reason}` clears
only chargeable failures; lifetime attempts and other counters remain. Cuts and reset carry reasons. All structural/runtime restrictions are applied again by the classifier, not only the parser.
`carries` (dev.59, C4, additive: absent means none, no read-time default needed) records that a fresh unit continues a
cut unit's work from `tip`, a commit of that unit's branch. It is set when the unit is added, never after; never on a
re-entry or naming itself; the classifier requires the named unit cut (before or by the same apply), with a branch whose
history holds `tip`. Status shows `units[].carries` on the carrier and `carriedBy` on the cut unit. A carrier stands for
the unit it carries in milestone membership and the milestone node (`src/walk/node.ts` follows it as a lineage).

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

DesignRecord and its validators live in `src/core/design.ts`: unit kind, typed changes/interfaces, failure modes/proofs,
clause-lane coverage, breaks, experiments, newSystem and verification. Root-authored design must pass reachability,
reference coverage, clause/witness and verification checks. It is authored by the root.
Pins in `src/core/pins.ts` bind linked requirement revisions and contract blobs. `stale-set`, `stale-answered` and
`stale-reopened` retain revision-link diagnostics and boundary reopening.

### Lanes

Every lane launch (unit, candidate, capture, rerun and job journey) receives executor-owned `ROADMAP_CPU`, the decimal count of actually granted `@cpu` tokens, including zero. It is persisted in launch.env. Authoring and preflight refuse env.set/env.pass collisions; persisted legacy lane readers remain compatible. Startup adopts kept collisions, and the scheduler raises a blocking arc plan-defect before any stage starts; correcting the declaration through apply --resolves releases it. Retired units are excluded from this diagnosis.

Required LaneDef fields: id, nonempty argv, cwd, env `{set:Record<string,string>,pass:string[]}`, expectedExit,
cadence, resources, evidenceGlobs. EvidenceExcludes defaults to []. Pass/set names cannot overlap. Optional fields:
inputs (nonempty unique patterns), cost cheap|expensive, placement local|shared-resource|cross-system, cpu, timeoutMin,
systems, testArgv, stochastic, noRerunPatterns, environment, readsComments, kind/capture.

| Lane context | Accepted cadence | Additional rules |
|---|---|---|
| Spec | build, unit, candidate | Integration placements require spike; candidate executes on current candidate tip |
| Suite | build, unit, candidate, batch | Batch requires holistic; local batch placement refuses |
| Arc witness | build, candidate | Adds reporter/testPaths/witnessClass; no testArgv/stochastic/environment |

Contextual authoring (`ciReasons`) refuses cost expensive or explicit whole-tree inputs (`*`, `**`, `**/*`) at build/unit.
Shared-resource/cross-system spec placement refuses outside spike. Forced expensive/integration suites refuse for normal
units. Selected milestone lanes must be suite batch lanes explicitly shared-resource or cross-system.

Systems select impacted checks conservatively; unmapped paths select. Reuse input is explicit inputs-filtered ls-tree,
else unit systems for implicit spec lanes or lane systems. Command/environment/lane identity, clean series certificate and
completed evidence metadata still bind reuse. `testArgv` has exactly one `{files}` element for changed leaf-test files.
dev.59: a test-only run needs every changed leaf test inside the lane's cwd; one outside it (a dependency's) runs the
lane's argv. A red test-only run is classed `{kind:'targeted'}` (after a host signature, before every other class): its
rerun is the lane's argv and that run's verdict is the lane's, so a runner finding no test files among `{files}` charges nothing.
Stochastic `{runs,minPasses}` requires runs >= 2 and minPasses <= runs and bypasses ordinary flake classification.
TimeoutMin is positive; absent uses the six-hour runner backstop rather than a red timeout verdict. ReadsComments true
remains parseable but enables no special pass carryover.

Capture shape:

```ts
{kind:'capture', capture:{up:string[],script:string[],states:string[],port:ResourceName,portBase?:number}}
```

Capture and `kind:'capture'` appear together. dev.59: `kind:'static'` (additive; no capture) marks a static check, a
linter or typechecker that reads the source and runs none of it. A candidate red with the tip alone green whose every red
lane is static, its checkout clean, records candidate outcome `static-red` (detail as `candidate/red`): one uncharged fix
round, class `static-red` (fold counter `staticReds`, 0 in older logs: none spent), taking no candidateReds round and no
chargeable failure; a second `static-red` takes the `red` row (class `candidate-red`, charged, then the park). The kind is
declared, never inferred from a lane's name. States are safe filename stems. Port is in lane resources and names a declared pool;
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
Central protectedPaths protects `.roadmap/` except `.roadmap/contracts/`, plus pinned same-repo corpus files across salvage/transient/recovery. Owner-managed contract docs are ordinary product source edited in unit diffs; systemsMap.contracts maps their paths to consuming systems for re-gating. Contracts are never executor-rendered.

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
`review:never` disables review/diagnosis calls and their M4 fallback marker, but not the hard cap. Steering leaves cap counts intact.

The M4 diagnosis runs inside the step of the first build that finds it due (a decided round, or a steer round), under a
pre-build attempt of its own. That attempt closes with pre-build outcome `diagnosed` (1.0.0-dev.70), class `hold` with no
cause: it decides nothing, so the unit's decision, interruption, entry and status stay as they were and the build that
opened it runs next. A pause during it closes it `interrupted` and the build runs after the resume. A crash that leaves it
open is recorded at startup: a recorded call is read once (`review-completed`) and the attempt closes `diagnosed`; a lost
call closes it with the recovery hold. Journals written up to dev.69 closed it `approve`, which the fold refused under a
steer entry; those `approve` facts keep their reading, and an attempt such a crash left open is adopted as above.
`executor-fault` is the one deciding outcome the fold admits at a stage other than a unit's entry stage (a fault during
that diagnosis): the entry ends with the park. At startup a unit whose recorded attempt cannot be read parks
`executor-fault` and the arc starts; a fault that holds shared state still crashes.

KnownDefects `{id,match,fixUnit}` match lane or output substring; held units wait uncharged until the fix lineage merges.
Derived entries `{sources,outputs,regenerate?:ToolCommand}` only add deterministic regeneration at lanes; no exclusions.

### Milestones and bring-up

The optional milestone `name` is a nonblank single-line display name, at most 32 characters, with no surrounding whitespace. Absent reads as no name, without a warning or schema-version change; never derive it from `text`. Console snapshots carry it unchanged.

Milestone `{id,name?,text,units,design:{unit}|{supplied:true},lanes?,references,bringUp,journeys,resources}`. Units/references/
journeys are nonempty where required; selected lanes default []. A design unit is planned and outside its members.
Journeys have `{id,text,via:browser|shell,entry,budget:{steps,seconds}|null}`. BringUp has setup argv[], serve entries
`{name,argv,ready:{http}|{log}}`, env map, seed argv[]. `{port:<serve-name>}` substitutes allocated ports consistently.
References are design directories and have a 512 KiB text budget. Missing tools/MCP handshake refuse browser readiness.
A planned descendant outside the milestone waits for milestone-passed; code follows lineage heads.
Membership (dev.59, `milestoneMembers` in `src/input/plan.ts`): the listed units, every unit re-entering one of them
and every unit carrying a cut one forward, transitively, in plan order. Superseded and cut members are withdrawn: a
milestone is reached when it has a live member and every live member merged (an all-withdrawn milestone is never
reached). A revision that leaves a milestone with members but no live one is refused (classifier, every proposer; the
plan alone decides: cut, or re-entered); one already so in force, from an earlier release, is raised at scheduler start
as a blocking arc `plan-defect` item naming the milestone and its withdrawn members (temporary adoption scaffolding,
`allWithdrawnMilestones`). Members also receive the milestone's prompt inputs, and the walk reads every merged member's spec. Status
`milestones[]` adds `members`, `withdrawn`, `live` and `merged`; summary milestones add `live` and `merged`; the
console's graph, milestone detail (`total` live, `merged`) and filters read status's members. Non-planned
lineages are exempt so repairs/polish can proceed. A reported walk with no active walkthrough P1 passes the node;
polish may still be settling. Breaks hold, deviations can be repaired alongside work. Walk and
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
them optional. dev.59: so does every revision for the lanes and binding witnesses it adds (Phase-0 mode `REVISION`; a
revision is refused only for the defects it adds), and an argv's test paths include the words of a shell's `-c` script
(`sh|bash|dash|zsh`), so a witness file left out of a file list there is `witness-not-in-lane{missing:'argv'}`. dev.59 pass 6
(nu-119813): an argv word naming a test file (`*.test.*`, `*.spec.*`, `test_*.py`, `*_test.{go,py,rb,ex,exs}`, the bounded
diff's rule), resolved against the lane's `cwd`, is a test path anywhere in the argv (past any number of `--` wrapper
layers) and with or without `testPaths`; a word naming another file (an extension, no glob: a wrapper script) is none. So once
the argv lists test files, the witness file must be listed (or under a listed directory or glob); with no test path in the
argv, `testPaths` alone decides. dev.59 pass 7 (nu-119813, C-351): a spec witness item declares no files; its file is
its `testId`'s first segment before ` > `, when that segment is a test file name (by the
same rule; otherwise nothing is derived and the item is not checked). dev.64: the segment is read both from the repo root and
from the lane's `cwd`, since the lane's reporter decides which it writes and the lanes stage matches the id exactly; the item
is in its lane when either reading is. The same check refuses it as
`spec-witness-not-in-lane{unit,item,lane,file,missing:'test-paths'|'argv'}` at a fresh start and at every revision (`REVISION`),
and parks it uncharged at the lanes witness diagnosis (`plan-defect`). A revision adopts such a defect in force while the
item and its lane are unchanged, and is refused for it when it adds or changes either; a restart adopts it. A witness the
argv cannot show (a package script's file list, a spec witness item whose testId names no file) is the builder's to report
as `grounding.specWrong`: a build `spec-wrong` park, uncharged, for the root. Census is required for corpus target validation and names every active rule exactly once; split-family
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

dev.59: a suite-lane edit is refused only while a candidate is under way. While a lanes attempt runs, the apply is `busy`
behind that attempt's boundary (`apply-queued`, a `queued` receipt), like a spec edit of a running unit. A lanes red's fix
round reads its fast-suite series by the plan revision in force at that red (`JournalView.planAppliedAt(seq)`, derived from
the `plan-applied` facts; no record change), and requires the suite checks in force: an edited lane runs as it now stands,
a removed one is not required.

Phase-0 advisories add `{kind:"vacuous-future-witness",obligation,files}` for existing future witness files and `{kind:"spanning-proof",obligation,lane,units}` for multi-unit delivery without a spanning candidate/batch lane. They never refuse. Actual baseline vacuity remains execution-derived.

## Commands, receipts and needs-user

`apply --resolves nu-ID[,nu-ID...]` names unique nonempty journal item ids. Malformed, duplicate, host-* and sup-*
ids refuse. Optional `CommandBody.apply.resolves` and applied `Receipt.resolved` are additive; readers preserve absence and consumers default it to an
empty list. Validation never writes defaults or emits upgrade warnings. Disk reads of absent legacy apply fields
warn once per process; non-apply receipts have no resolution field by design. Original content-addressed bytes are preserved.
One eligibility predicate runs at submission, dry-run, fenced precommit (after queueing and smokes), and successful
finish. Items must be canonical open journal items, including ack-file and supersession checks. A changed apply may
explicitly answer arc subjects (the architect's assertion); unit subjects require that unit's change or re-entry;
finding subjects require all named findings settled or answered by the prospective repair predicate. Host/file-only
subjects and no-op applies refuse. Rejected/stale applies close nothing.
After planAppliedBy(command) exists, explicit and automatic closures reuse acknowledge, writing choice:null to the
existing ack file/fact. Recovery resumes after commit, each ack file/fact and receipt without a second closure fact.
Another command's acknowledgement wins without overwrite. Receipt.command identifies the apply and resolved lists
only journal ids actually closed by it, rebuilt from acknowledgement facts on replay.

CLI parsing is pure and closes over Command kinds; run locator is host or paired repo/arc. Complete forms are in the
skill reference and parsed by skill-lint. The persisted CommandBody union appears below; host acts such as export and
brief are not queued command bodies. Brief/note evidence is hashed before submit, so later changed bytes refuse.

Command files are write-once incoming records with accepted/queued/applied/rejected receipts. Accepted/queued does not
mean applied. Apply receipt may expose remaining plan-defect advisories while refusing new defects. Steer drains a live
unit before applying; note informs the next build without cancelling it. Resume backend is explicit availability recovery.
Rerun (dev.59, scope {u}, never killing a live build: its pending drain holds the unit's next admission) names a lane
failure `<unit>/lanes#<n>/<lane>`: lanes#n is the unit's latest decision and latest stage attempt (`counters.attempts = n`:
nothing started since, else refused toward steer), its outcome one of `RERUNNABLE` (red, regression, flaky, not-certified,
witnesses-missing, or a rerun's own rerun-red), the lane ran red there at commit `at`, the unit branch is still at `at`, and
no earlier rerun named that lane at `at`. Its effect and postcondition is `lanes-rerun {unit,command,attempt,lane,at,cause,
evidence,by:{role:"root",routingRev}}`; the generic command crash points cover it plus `rerun.after-fact`. The fold checks
the log's side of them (the attempt, the outcome, one per lane and head) and sets `UnitState.entry {kind:"rerun",seq,command}` (ENTRY_STAGE lanes) and `UnitState.rerun
{seq,command,waived}`, `waived` the decided outcome the first rerun of a series waived. The lanes stage under `rerun` removes
the stable verification checkout first (a fresh checkout), runs no lane test-only, and records any `RERUN_REDS` series as
lanes `rerun-red`: an uncharged operator env park (reason `rerun-red`), outside the certification allowance. `rerun` is kept
through holds, retries and retryable/env parks (their restore sets the rerun entry again) and through its own rerun-red park,
whose `resume` restores `waived` and ends it; `resume` refuses when `waived` halted (the chargeable bound, a steer park),
pointing at re-entry. Any other lanes outcome, a steer, merge-in, reopen or stale reopen clears it. The rerun's lanes attempt
counts toward the judged-stage total; no build runs. Status decisions list it as kind `rerun`. New union members only:
older logs carry none, so nothing defaults and `SCHEMA_VERSION` is unchanged. Dismiss requires a named active finding and non-whitespace counterEvidence. `finding-dismissed {id,command,counterEvidence,by:{role:"root",routingRev}}` folds as ruled/dismissed, including P1. Same-command replay is idempotent; a new command against an unknown/closed finding refuses. It suppresses unchanged-evidence re-raising through the existing admission predicate. Campaign dismisses/counterEvidence fields only raise a root request. If the finding settled while the audit ran, the request is informational and cannot re-block completion.

NeedsUserRecord `{v:2,id,arc,raisedAt,blocking,subject,reason,summary,recommendation,options,evidence}` has subject
unit `{type:'unit',unit}`, arc, host or `{type:'findings',findings:FindingId[]}` (nonempty). A dismissal closes matching finding subjects only when every named finding is resolved or ruled. Options are `{id,label}`; evidence is absolute paths. Ack record is
`{v:2,id,command,choice:string|null,at}`. Optionless pack-review items accept ack with null choice; other optionless items reject ack. Successful subject actions close them. Offered choice
must exist. Revision-notice and waste-finding are non-blocking. Subject closure preserves publication/recovery ordering
instead of requiring a second bookkeeping command. A root apply that supplies repairs for every finding named by a finding-subject request closes that request without dismissing the findings; repair publication still settles them. Successful root actions can also close already-settled finding requests. The full current reason enum is emitted in the appendix.

Pack-review admission scope is derived, with no new record or status fields. Admission waits for a running/due review
to end. An open ended review holds unit targets and their transitive effective `after` dependents; non-unit blocking
targets or abandonment hold arc-wide. One arc-subject item remains; its summary names targets and dependents count
or arc-wide scope. Unit status uses `blocked` with `waitingFor.admission: [{type:"blocking-item",id,reason:"pack-review"}]`,
including dependents with unmet dependencies. Arc `holds` includes `pack-review` for running/due reviews or arc-wide
ended scope only. `packReview.state` remains `held` while scoped findings are open after unrelated admission. Ack or a
superseding review releases the item (K14).

## Roles, routing and strict results

Only recorded roles: build, verifier, packReview, experienceVerdict, campaignAudit. Build seats low/med/high; verifier adds
escalation; arc roles have arc. Verifier modes pre-build/gate/diagnosis; experience modes walk/compare. Routing layers name
classes per seat (builtin → repo-config → plan → unit). Classes efficient/frontier/summit may build; economy is judgment-only.
Profiles default/claude-only differ in build bindings and eligibility, not the five-role vocabulary.

Config routing `{profile?,seats?,classes?}` binds model triples only in classes. Default eligible low/med builds can use
Codex; M2/design/high risk and diagnosis fallback use Claude. M1/capture-only remain eligible. Claude judgments and
frontier advisor remain. Effective fallback/profile changes have routing revisions so history resolves actual seats.
Config also accepts chain, walkthrough.mcp, systemsMap and systemNotesDir; unknown keys refuse.

Strict role output readers reject unknown fields. BuildOutput is summary/blockers/experiments/grounding/tooBig/notes/messages/final
(exact type below). `messages` (dev.59) lists every cross-session message the build received, `{from,at,text}` (text verbatim or
its first 500 characters); the wire schema requires it, and the reader takes a report written before dev.59 (its launch's
schema had no such field) as none, with one `ROADMAP_UPGRADE` warning per process (temporary scaffolding). Grounding contains specWrong nullable text and touches strings; tooBig is **top-level**. Structured
decisions come from decisions.json captured by evidence, not a BuildOutput decisions key. Final false is an intermediate
wait protocol; the terminal build output must be final true.

Verifier uses GateOutput: decision approve/revise/escalate; standing dispositions addressed|rebutted with nonempty evidence;
findings; reasons; premises; clusters|null; rulings for disputes; directives only nonempty for revise; optional ordering
blockers only for escalate. Finding severity blocking|note|pre-existing|ride-along; evidence and experiments must provide
an experiment or path:line. Defect is nullable classification, not mandatory for blocking. Approve cannot contain blocking
findings. New evidence is required to re-raise settled findings. Gate disputes still use `rulings` in this schema; this is
separate from the C-n root ledger. Clusters cover each changed path exactly once on a large diff.

M2 checks absent witness/ids/lane, later cadence or environment-backed proof for active delivered obligations; external
class alone is not its trigger. M1/M2/M3 reviews annotate standing items; M4 diagnosis stores a note. Markers and completed reviews are journal facts.
PackReview result carries target-specific findings/dispositions and report; whole-campaign outputs carry findings and
root requests, never executable plan changes. ExperienceVerdict holds a tagged walk or compare output. See the source
readers for their complete nested schema; those fields are validated against real ids and evidence rather than prose.

## Event log and effect contracts

Throughput additions retain schema 2: reserve transitions may carry `expect.waited` and candidate reserves may
carry `expect.slotHolder`. `stage-admitted {unit,stage,waited}` records admission measurement without advancing an
attempt; `candidate-entry-planned {unit,attempt,tip,request}` records candidate selection and tip-driven refresh.
The Scheduling and Residues sections define their validation and ownership contracts. No wait-episode facts or ids exist.

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
| Control | paused, stop-requested, stop-completed, resumed, backend-park, probe, reopened/unparked, edge-resolved, run-only |
| Inputs | plan-applied, apply-queued, finding-dismissed, noted, steered, merged-in, lanes-rerun, revision-link stale-set/answers/reopening |
| CI | external-witness/reopened, spike-completed, attempt-marker/capped, lane-base-compared, lane-reused, series-certified, smoke-ran |
| Review | review-triggered/completed; gate round/findings-ledger/dispute facts |
| Target | witnessed, obligation-latched, finding-opened/transition, audit-started/ended/requested, divergence |
| Pack/debt | pack-review-started/ended, debt-banked |
| Lifecycle | integration-push, admissions-closed, docs-published/covered, arc-completed, executor-started, containment-mode, tail-discarded, needs-user-acked |
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
coverage remain. Close-out debt/releases remain; only the root edits obligation authority. Root dismissals use the dedicated dismiss command and finding-dismissed fact; audit requests never apply them. Repair publication and code-owned reproduction/close-out paths also change finding state.

## Runner, host, publication and recovery records

InvocationBinding pins version/arc/invocation. LaunchFile pins process, input/output paths, deadline, containment, terminal
protocol, environment and subject (backend role/seat or lane/probe/etc). Backend call roles are the current five; modes
belong in role inputs. The runner owns the child/workload membership, writes files, waits for quiescence then runs a pure
adapter. ExitFile binds child termination/cause/endedAt/quiescedAt and optional CPU observation. BackendResult separates
outcome from known/unavailable usage; CommandResult uses pass/fail/stall/timeout/process-fault/cancelled. A result is usable
only under its own invocation binding.

Host owner/lock records bind nonce/generation/pid/start/boot, with handshake before effects. Readiness/supervisor state,
heartbeat (10 seconds; stale 5 minutes; written by a timer and, at most every 10 seconds, at each git call's return and
each scheduler iteration, so a long synchronous stretch that keeps completing work does not go stale:
src/host/heartbeat.ts), intentional executor exit and external exit evidence are typed in records.ts.
Recovery takes an exclusive recovery lock before owner takeover. Ambiguous identity refuses. Residue records are keyed
by arc/invocation/resource-instance and exactly one unit/job owner; disposition is cleaned/isolated/transferred with
provenance. CPU tokens do not get residues. Resource release requires actual teardown/quiescence, not just a done flag.

Snapshots publish only allowlisted records plus a SHA-256 manifest to refs/roadmap/<arc>. Raw evidence stays in runtime.
Recovery verifies closure and required kept bytes, replays pending revisions/publications and reconstructs deterministic
commits. Ref movement must match its expected old/new identities. Document publication owns the same slot and may preempt
candidates uncharged. Completion binds planRev/head/highWater and can reopen under a valid later revision; sealed history
remains immutable. GC preserves needed verified snapshots while compacting eligible old runtime/evidence.

## Status and brief projections

Full status and summary share `waiting` through StatusCore:
`{unmeasuredReservations,byUnitStage:[{unit,stage,totalMs,byReasonMs}],byJobStage:[{job,stage:JobKind,totalMs,byReasonMs}]}`.
It sums completed reserve and stage-admitted measurements. Simultaneous reason totals are non-additive; absent
legacy measurements remain unmeasured. Current blockers stay in sched.json; no active tail or recovery downtime is
extrapolated. Summary retains the lightweight shared projection.

Status is read-only without a lock. `captureStatus` carries one clock, source stamps and measured fold telemetry; full and summary share its core derivation. The TUI and console use the shared observer; console-backed CLI output remains canonicalJson(value)+"\n", without URL/freshness fields. Summary fields: arc, state, planRev, supervision, progress `{total,merged,states,held,remaining}`,
spend `{costUsd,expectedUsd,differenceUsd,estimatedCalls,unavailableCalls}`, milestones, caught, verdicts, captures,
needsUser, waste, demo, completion. Caught is laneReds + gateRevisions + uniqueFindings, with byLens counts of unique keys;
not a cross-seat unique-defect metric. Milestone costs include members/re-entries/polish and walk/compare jobs, not all
arc costs. Captures lists suite capture spawns only. Waste findings use observed duration/evidence and durable cause keys.

Full status `units[].running.session` (dev.59, derived) is the cross-session name of the Claude build running in the
unit's attempt now, read from its launch.json `terminal.name`: the exact `SendMessage` address. It is null between builds,
for a Codex build and for a build launched before dev.59, so it disappears when the build ends.

Full status `units[].lineageAttempts` (dev.59, derived) is `{builds,judged,buildCap:16,judgedCap:40}`: the unit's lineage
(itself and each unit it re-enters) against the total-attempt caps, which `reenters.reset` never clears. An accepted apply
(and `apply --dry-run`'s `warnings`) states the same per `unit-reentered` change, one receipt line beginning `lineage:`.

Full status and summary both expose `supervision: {state:'live'|'stale'|'none',pid?,lastPollAt?,executorVersion?}`.
`none` has no other fields; `live` and `stale` include all three. Liveness is the lease's PID/start identity on the
recorded boot, not the age of lastPollAt. The TUI keeps supervision on one status line, red when it is not live,
the run is neither complete nor refused, and at least one open blocking needs-user item exists.

`watch --actionable` streams transition and heartbeat JSON lines. Every such line carries `seq` (the poll's log
high-water) and `openBlocking: [{id:NeedsUserId,reason:NeedsUserReason}]`, ascending by id, empty when none. The digest
and status needsUser share `src/needsuser.ts`'s canonical open-item list: journal and file-only items, not acknowledged
(by journal or ack file), not superseded; only blocking items enter the digest. Each poll derives the digest before
emitting any transition, and the heartbeat repeats it even with no transitions. Raw watch keeps its existing fields
and takes no lease. A live holder refuses a second actionable watch with one `{event:'watch-busy',...WatchLease}`
JSON line and exit 73. `--replace` requires `--actionable`; `--stop` excludes stream options and prints one
`{event:'watch-stopped',state:'stopped'|'stale'|'none',pid?}` line, exit 0. Invalid options exit 64; unexpected I/O,
validation or termination failures throw (CLI exit 1).

BriefPayload `{schema:'roadmap/brief-m4',coverage,items,chain,answers,arcs}` is canonical and has no clock. BriefId is the
first 16 hex of its SHA-256. Coverage entries are `{arc,snapshotCommit,highWater}`; Markdown derives only from the payload.
Arc entries include slice, divergences, decisions, curation/corpusDivergences, debt, questions, pack notes, census, timings,
PR and demo. AckMarker `{briefId,at,chainHead,coverage,items}` is write-once pending then committed by rename under
common-dir roadmap/acks. Brief ack advances coverage/chain count and does not resolve optionless runtime items.

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
  grounding: Grounding; tooBig: TooBig | null; notes: readonly string[];
  messages: readonly ReceivedMessage[];
  final: true;
}>;
export type ReceivedMessage = Readonly<{ from: string; at: string; text: string }>;
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
  | Readonly<{ type: 'stop'; mode?: 'immediate' | 'drain'; deadline?: IsoTime | null }>
  | Readonly<{ type: 'ack'; needsUser: NeedsUserId; choice: string | null }>
  | Readonly<{ type: 'resume'; target: ResumeTarget }>
  | Readonly<{ type: 'sweep'; resource: ResourceName | null }>
  | Readonly<{ type: 'apply'; planFile: AbsPath; rev: PlanRev; reason: string; base: RevisionManifest; manifest: RevisionManifest; resolves?: readonly NeedsUserId[] }>
  | Readonly<{ type: 'resolve-edge'; edge: EdgeId; evidence: string }>
  | Readonly<{ type: 'run-only'; units: readonly UnitId[] | null }>
  | Readonly<{ type: 'reverse'; divergence: DivergenceId }>
  | Readonly<{ type: 'steer'; unit: UnitId; brief: Readonly<{ path: AbsPath; sha256: Sha256Hex }>; budgetMin: number; class: BuildClass | null; resume: boolean }>
  | Readonly<{ type: 'witness'; obligation: ObligationId; expectedHead: Sha; result: 'pass' | 'fail'; evidence: string; evidenceFile: HashedFile | null }>
  | Readonly<{ type: 'dismiss'; finding: FindingId; counterEvidence: string }>
  | Readonly<{ type: 'note'; unit: UnitId; brief: HashedFile }>
  | Readonly<{ type: 'merge-in'; unit: UnitId }>
  | Readonly<{ type: 'rerun'; unit: UnitId; attempt: number; lane: LaneId; cause: 'estate' | 'infra'; evidence: string }>
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
  'rerun-red',
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
  'push-failed', 'push-diverged',
] as const;
```

## Ids

Constructors in `src/core/ids.ts` reject invalid forms before branding.

| Id | Grammar / allocation |
|---|---|
| Arc, unit, resource, edge, system, serve | `[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?` (1–64 characters) |
| Lane, clause | `[A-Za-z][A-Za-z0-9_.-]{0,63}` |
| Op / invocation | `<arc>/<positive sequence>` / `<op>#<positive ordinal>` |
| Pool instance / CPU token | `<pool>#<positive n>` / `@cpu#<positive n>` |
| Command | `cmd-<16 lowercase hex>` |
| Session | Lowercase UUID |
| Build session name (dev.59) | `<arc>-<unit>-<seq>-<ordinal>` (`buildSessionName`, the one derivation); `[A-Za-z0-9_-]{1,200}` |
| SHA / content hash | 40 / 64 lowercase hex |
| Routing, seat, lane, environment rev; brief id | 16 lowercase hex |
| Needs-user | `nu-<n>`, `sup-<n>-<n>`, or `host-<slug>` |
| Numbered ids | V (vision), Q (vision question), I (obligation), F (finding), D (divergence), T (rule), B (debt), P (Phase-0 question), K (known defect), W (spec witness), MS (milestone), J (journey), X (polish), FM (failure mode), R (gate finding), each `PREFIX-<positive n>` |
| Root ledger | `C-<digits>` |
| Jobs emitted by current producers | `audit|docs|batch|baseline|review|walk|compare` followed by `-<positive n>` |

Positive components have at most 15 digits. Numbered ids sort by prefix then numeric suffix; ordinary keys use string
order. T/B/P persist across arcs; W is spec-scoped; MS/K are plan-scoped; F/X/R are allocated in arc log order. Withdrawn
or settled ids remain history, never reusable authoring slots.

## Startup rejection table

`src/preflight/startup.ts` owns the discriminated rows. All refuse with **78**, except live `host-busy` and
`previous-schema-host-busy` (**75**).
Exit 78 writes `<runDir>/status.rejection.json:{v,at,rejections}` and `exit.reason.json`; no work is admitted.
Schema compatibility is checked before host claim/recovery. Checks stop at the first refusing group, retaining every
row in that group (`src/preflight/checks.ts`).

| Kind | Refusal / payload |
|---|---|
| legacy-roadmap-dir | Unexpected entries in a 0.x layout: path, unexpected[]; never convert it |
| schema-version | Runtime version mismatch: path, recorded, expected, detail |
| worktree-root-unusable | path, problem tmpfs or not-writable, detail |
| spec-lane-unrunnable | unit/null + lane + problem, or resource + probe/teardown/up/down + problem; unresolved argv0, missing env, invalid lane/environment use |
| unsupported-routing | role/tier, layer, class, unit/null, why codex-judgment or no-prompt |
| undispositioned-residue | residues[] not cleaned/isolated; own-arc residues proved by a readable journal are recoverable |
| host-busy | holder owner/recovery, arc, generation, pid |
| previous-schema-host-busy | Schema-1 holder: path, pid, detail (stop with its own executor) |
| previous-arc-unreconciled | arc, invocations[]; durable host item |
| recovery-holder-dead / owner-mismatch | pid / identity detail; no guessed takeover |
| log-corrupt / containment-mode-changed | file/offset/detail / recorded and detected containment modes |
| profile-conflict | requested profile, recorded profile, detail directing a routing apply; refuses restart before host claim |
| backend-smoke | profile, backend, missing/failed, detail |
| plan-invalid | Schema/path/branch/baseline/resource/cite/capacity problem |
| plan-change-refused | reasons[] from the revision classifier |
| vision-unconfirmed / corpus-invalid / phase0-invalid | Confirmation identity / corpus problems[] / Phase-0 problems[] |
| chain-invalid / arc-superseded | Chain problem / successor arc |
| tree-uncommitted | Required product paths differing from HEAD |
| holistic-needs-corpus / milestones-need-holistic | Invalid target/layer combination |
| plan-defect | defects[] no builder can repair by implementing its spec |
| walk-tools-missing | milestone + program, MCP configuration or handshake problem |

## Host files

`/var/tmp/roadmap/` (parameterized in tests) contains `host.lock`, `host.owner.json`, `host.generation`,
`host.recovery.lock`, `handshake.<generation>`, `residues.jsonl` and its compaction archives,
`supervisor.state.json`, `supervisor.ready.<generation>` / `supervisor.failed.<generation>`,
`executor.<generation>.out`, `.err`, `.exit.json`, supervisor stdout/stderr logs, `exit.reason.json` and `demo.json`.
Generation/owner identity guards stale files. Supervisor crash history survives restarts; three crashes/hour stop it.
The independent console lease/logs are under `<realpath-git-common-dir>/roadmap-console/`, never this host directory or an arc directory; see “Roadmap web console” below.

Temporary dev.32/schema-1 handling runs before the host claim: a live previous-schema lock/recovery holder (or
owner executor) refuses startup with exit 75 and must be stopped with its own `roadmap stop`. With no live holder,
schema-1 host records are renamed to `<name>.schema1` (numeric suffix on collision), with a notice per file.
Schema-1 residue indexes and archives instead refuse with `schema-version` (exit 78), preserving disposition
authority: use dev.32 to disposition residues and verify none remain before manually moving that history aside.
Other unexpected versions still throw. Delete this scaffolding once no host carries dev.32 state.

The arc run directory holds `events.jsonl`, immutable `inputs/`, `inv/`, needs-user/command records, `heartbeat.json`,
`status.rejection.json` on refusal, `demo.desired.json`, `watch.lease.json` and derived `sched.json`.
`sched.json` exposes task states and arbiter queues; status trusts it only while its recorded executor owns the run.
It is not journal authority. `src/host/hostdir.ts`, `src/supervisor.ts` and `src/schedule/scheduler.ts` own the layout.

### Actionable watch lease (`watch.lease.json`, `src/core/records.ts`)

`WatchLease = {v:2,pid:positive,start:nat,bootId:BootId,executorVersion:string,arc:ArcId,
startedAt:IsoTime,lastPollAt:IsoTime,lastSeq:nat}`. `pid,start` reuse ProcIdentity; bootId and host liveness reject
PID reuse, zombies and previous boots. executorVersion is the executor package version. Initial lastSeq is 0;
after each poll only lastPollAt and lastSeq change. Publication and renewal use atomic durable JSON replacement.
The schema version stays 2; no lease in an older run defaults to supervision none.

Claim and stop serialize on a short-lived Linux abstract Unix socket keyed by the canonical run-directory path,
using Node built-ins. The kernel releases it on death, including SIGKILL; there is no persistent mutex record or
runtime dependency. Live leases refuse without --replace, regardless of executorVersion. Dead holders are silently
replaced. Replacement and stop signal only the recorded identity on the recorded boot, wait 10 seconds after
SIGTERM, then SIGKILL and wait 2 seconds; a survivor is an error. Mutex contention is bounded at 17 seconds.
Clean abort/SIGINT/SIGTERM removes only a matching pid/start lease; SIGKILL can leave a stale lease for takeover.
Stop removes a stale lease too and succeeds when absent. Poll renewal fails loudly if a live watch lost its lease.

## Residues and reservation states

`resource.transition` moves an all-or-none set under a holder. A candidate-stage reserve containing integration-slot
may additionally name `expect.slotHolder: publication{unit,attempt}` matching its stage holder. All units become
pending in one intent and settle in one done: the slot belongs to slotHolder; every other resource belongs to the
candidate stage. Later transitions are ordinary per-owner transitions; recovery settles both partitions. Absent
slotHolder keeps legacy single-holder behavior. It is illegal on any other edge/stage, without the slot, or with
mismatched unit/attempt.

`candidate-entry-planned {unit,attempt,tip,request}` records the initial candidate entry and each changed tip/request.
Selection uses the merged tree: first scheduled candidate spec lane, else first selected suite lane. Refresh is
synchronous before allocation/precedence inspection. A tip change after grant releases entry and slot before retry.
The first owning series consumes the reservation, releasing it unused on reuse or preparation/refusal/cancellation.
The publication alone retains its slot through green ff/snapshot; workload CPU never carries across those stages.

The ordinary transitions are:

| From | Edge | To |
|---|---|---|
| free | reserve | reserved |
| reserved | run | running |
| reserved / running | clean | cleaning |
| cleaning | release | free |
| cleaning | fail (one residue per failed instance) | cleanup-failed |
| cleanup-failed | reclaim (sweep/retry) | cleaning |

Absent table entries are free. Pending transitions prevent another reservation. Lock order is named resources/pools by
name (instances numerically), CPU tokens numerically, integration-slot last. Requests exceeding capacity refuse at
load/apply. A build retains its reservation through cleanup; a publication holder keeps the slot through ff/snapshot.
Release requires confirmed quiescence and teardown. CPU tokens have no teardown or residue.

Residue identity binds arc/invocation/resource instance and exactly one unit or job owner, plus recorded cleanup
recipe/provenance. The recipe is `TeardownRecipe {argv,cwd,env,envPass?}`: `env` holds literal values (env.set, owner
label, instance binding), `envPass` the sorted names of the declared `pass` variables, whose values are read from the
executor's environment when the teardown runs and are never recorded (absent when none; a recipe recorded before it carries
passed values in `env` and runs as recorded). Startup refuses **all foreign undispositioned residues**, even for resources this arc does not use;
clean or isolate them. A readable journal proving this arc owns a residue permits start so recovery/probes can reclaim
it. Its dirty instance remains unavailable. Cleaned/isolated/transferred dispositions are durable, not manual deletion.

## Scheduling

The arbiter accumulates waiting milliseconds in memory at each re-evaluation, counting each interval once in
`totalMs` and once for each simultaneous blocker in `byReasonMs` (non-additive). A grant writes optional
`resource.transition.expect.waited: {totalMs,byReasonMs}` on its reserve intent. Immediate grants, including sweep reserves, record zero.
Closed keys are `cpu-pressure`, `memory-pressure`, `cpu-tokens`, `named-resource:<declared name or pool>`,
`publication-slot`, `queue-precedence`, and `admission-hold:<kind>`. Admission kinds are the constraint variants
plus dependency, contingent-edge, milestone, baseline, pack-review and repair-batch. Resource inspection collects
all blockers even when pressure or a dirty instance prevents allocation.

Scheduler admission accumulation runs from first refusal to admission, including undispatched units. A measurement-only
`stage-admitted {unit,stage,waited}` fact records it when the stage is admitted; it never advances attempts.
`status.waiting` and summary's identical shared-core field sum completed measurements by unit/stage and job/stage;
`unmeasuredReservations` counts legacy grants without a measurement. Missing measurements are never zero historical
waiting; readers log one ROADMAP_UPGRADE warning per process. Current blockers stay in sched.json's queue/jobQueue
`reasons` and `admissions` rows. A crash loses only in-flight measurements; downtime is excluded. No wait episodes,
wait ids, recovery closure facts or active-tail extrapolation exist.

Admission rechecks pause, pending mutation drain, run-only, backend parks, breakers, base-red, blocking items, findings,
known defects, pressure, compare and deflake holds before prepare/reproduce/pre-build/build/lanes/gate/candidate.
Dependency, contingent-edge and milestone constraints gate initial task dispatch only; tasks already in flight retain
the original stage-admission rules. Waiting reasons are measured only from the constraints each path enforces.
Quiesce/evidence/salvage/teardown and ff/snapshot are mandatory chains despite pause/drain.

The arbiter serves docs/batch/job waiters first in arrival order, then units: high priority; promoted waiters by age;
otherwise repair=deflake, polish, planned; wait-start sequence then plan index break ties. A unit promotes after **three
other unit publications** in its waiting interval. Backfill may pass a blocked higher rank only with a disjoint request
(CPU and any shared pool count as overlap). Environment/pressure-blocked requests are set aside.
Slot-blocked combined entrants contribute only publication-slot precedence, including through other queued requests. The durable publication owner maps unit/attempt to candidate, docs to its job, and batch to the originating reserve parent job. Only its workload requests bypass CPU pressure. Memory pressure still brakes them while another workload holds or has reserved CPU tokens; a lone workload progresses under either pressure cause. Tokens, dirty instances and independent precedence still apply. Blocked docs callbacks run despite other simultaneous blockers.
Task-fault recovery closes a compound reserve atomically but settles only holders selected by its scope; full recovery settles both owners.
Docs publications outrank unit publications and may request candidate preemption before green. Red/preempted or
finding-blocked candidates abandon and release their reservations; green publication finishes ff/snapshot under its holder.

## Parks

Parks are durable stage outcomes, not red-lane synonyms. Retryable parks record nonempty sorted probe targets;
operator parks require a subject action. Operator env resumes the same stage; operator design needs an appropriate
revision/re-entry. Ordering parks record unit blockers and unpark automatically with `unparked` after all blockers merge.
A held stage does not advance or consume a charge; backend/recovery holds retain their cause (`hold{backend}`,
`hold{recovery}`) separately from operator pause. ParkRecord is `{class:"retryable",targets}` or
`{class:"operator",kind:"env"|"design",ordering?}`; ordering belongs only to design parks. HoldCause is backend
`{backend,parkSeq}`, recovery, or host-pressure `{inv}`, each tagged by type.

| Retryable outcome | Probe targets |
|---|---|
| build process-fault/lost; gate process-fault | backend |
| reproduce/lanes/candidate blocked | host |
| build/salvage/teardown/reproduce/lanes/candidate cleanup-failed | Each failed resource instance |
| salvage commit-failed | host plus failed cleanup instances |
| reproduce/lanes/candidate env-unavailable | Named environment |

Lanes `rerun-red` (dev.59) is an operator env park: `resume` restores the decision the rerun waived (above, Commands).

dev.59 gate split proposal (no schema change): a gate answer holds an active acceptance clause unmet when a blocking
`requirement-unmet` finding names its id as a whole token (`src/pipeline/gate.ts` `unmetClauses`). A clause every gate
answer of a lineage holds unmet, from the second answer on,
raises one non-blocking unit `split-proposal` per lineage, parented by that gate attempt and raised before its outcome
(a crash between them re-reads the answer and finds the item). The unit goes on.

dev.59 park items (no record change): a `chargeable-bound` park's recommendation names a re-entry with `reenters.reset`,
never a spec revision (a re-opened unit keeps its count and parks at its next charged failure), and a candidate `base-red`
park, an operator env park, names its two ways out: estate or base fixed, `ack` then `resume` (the candidate re-runs as a
new attempt, uncharged); the unit's own red, `steer --resume` then `ack`. Its summary states the executor's finding,
"The tip also fails without this unit", not a verdict on the cause. Both state the lineage's builds and judged stages
against the total-attempt caps (`src/pipeline/attempts.ts` `lineageAttemptsText`).

`src/park/table.ts` supplies targets; `src/pipeline/transitions.ts` owns class/charge/re-entry decisions. Recovering then
parking on the same target within six hours becomes operator env (`env-blocked`), preventing endless flapping retries.

### Backend parks

Usage-limit dominates retryable outage/capacity parks, holds future calls arc-wide and is never probed. Running calls
finish. Only explicit `resume --backend` clears a usage limit; changing profiles is not availability recovery.
Retryable backend parks share the backend probe. Backend-only parks do not receive unit/residue escalation.

### Park schedule

One coalesced job per backend/host/resource/environment target covers the outstanding park/residue sequence numbers.
First probe is immediate; new uncovered parks are immediate too. Failure backoff persists as `nextProbeAt`:
**1, 2, 4, 8, 16, 30, 30… minutes**. Passing every target re-enters the parked stage. At six hours, a unit park or an
unclaimed residue raises one non-blocking `park-escalated`; probes continue. Two distinct units parking on one target
within one hour trip an admission breaker and raise `env-blocked` (`src/park/schedule.ts`, `schedule/types.ts`).

## Rev 3: host pressure

`src/host/pressure.ts` samples `/proc/schedstat` CPU totals: delta wait / (delta run + delta wait), over a minute.
Memory PSI full avg10 contributes; available RAM below 5% supplies a saturated backstop. Missing schedstat makes CPU
pressure unavailable, never invented. Latest memory readings remain independently available without schedstat or a full CPU window; `hostCpuPressure` and `PressureTicks.memory()` keep the causes separate, with `hostPressure` the combined wrapper. Scheduler ticks are retained for 30 minutes in memory.

At CPU or memory pressure >= 0.5 the arbiter holds new workloads only while workload CPU tokens are already held or pending. Positive CPU with cpuBasis, or a build/lanes/candidate stage, is workload CPU; uncalibrated judgments never arm the brake. This derived classification follows its originating reserve through running and cleaning until release, including replay of old records. The first workload always progresses under either CPU or memory pressure, even when an external workload saturates the shared host. Memory readings remain independent of the CPU window; judgments retain their exemption. A deadline/stall under saturation is uncharged starved work; an ordinary red gets
one pressure rerun. Holds wait for a clear minute or 30 minutes, with at most three pressure holds per unit; after that bound
ordinary charging applies. This does not assert every job/witness path has pressure-aware charging.

### Calibrated CPU reservations

`CPU_COST`: judgment 1, build 4, lane build 2, lane unit/candidate/batch 4. Explicit cpu overrides calibration.
Otherwise execution-key history needs three samples; use ceil(nearest-rank p90 of the last ten completed runs of at
least 30 s), floored at 1 and capped at the default. Demand is (runMs + waitMs) / wallMs. Build keys bind class/routing;
lane keys bind argv/cwd/env/expectedExit, not lane id or reuse identity. Partial-file retries do not teach full-lane cost.
The journal plus runner CPU records rebuild observations after restart (`src/resources/calibrate.ts`).

## Fault isolation

`src/schedule/fault.ts` classifies from held/open journal state at the throw. A publication slot or open shared-state
op makes a fault fatal; so does a throw outside a supported task wrapper or a failed settlement. Unit-confined faults
run `settleFaulted`: kill/quiesce invocations, reconcile own ops, abort a repeated faulty act, clean reservations, then
record uncharged operator-env `executor-fault` with stack. Resume re-enters the stage; restart replays the park.
Only audit/walk/baseline jobs have job containment; their non-blocking item holds that track until arc resume closes it.
Shared-state faults go through supervisor recovery, bounded at three crashes/hour.

## Finding record

`finding-opened` fields: id F-n, key, lens, severity P1|P2|P3, obligation|null, visionClauses[], claim,
evidence[] `{path,blob:Sha|null}`, mutant `{patchSha256,lane}`|null, source (job/stage/demo), gateHadPassed,
optional milestone/cause/lane. Key hashes canonical `{lens,obligation,cause}`. Lens categories are invariants, drift,
vacuity, vision, witness, pre-build and walkthrough (the closed list is `FINDING_LENSES` in holistic/types.ts).
Walkthrough findings bind a milestone; batch reds may name a lane. FindingState keeps all opening fields except kind
and adds `{state,owner:UnitId|null,openedSeq,last:FindingTo|null}`; last is null until the first move.

| State | Allowed next state |
|---|---|
| open | owned, ruled |
| owned | fixed-on-branch, open, ruled |
| fixed-on-branch | resolved, owned, open, ruled |
| resolved / ruled | Terminal |

Ownership follows declared repairs; gate approval fixes on branch; publication resolves. Ruled carries
`disposition:dismissed|deferred|accepted|released` and root/ledger/code provenance. `finding-dismissed` records the root
command/counterEvidence/role/routingRev and folds to ruled/dismissed. Settled-finding admission checks suppress unchanged
evidence; a changed cited blob can lift dismissal. Only root input edits disposition obligations.

## Experience and evidence fact payloads

The following are payloads inside the versioned journal envelope; required fields are listed without `kind`.

| Fact | Payload |
|---|---|
| walk-started | job, milestone, round, sha, ports `{serveName:port}` |
| walk-ended | job, outcome, findings[], proposals[], dropped[], interrupted?:true |
| polish-proposed | id X-n, job, milestone, journey, evidence[], text, unit `{id,systems,spec}` |
| polish-refused | proposal, reasons[] |
| compare-started | job, unit, before, after, ports `{before,after}` |
| compare-abandoned | job, detail, interrupted?:true |
| tweak-judged | unit, decision keep/drop, reason judged/reference-untouched/bring-up-failed/abandoned |
| milestone-passed | milestone, job |
| demo-promoted | milestone, sha |
| demo-failed | milestone, sha, log absolute path |
| demo-acted | command, act (DemoAct: up/down/hold/release) |
| flake-observed | owner unit/job, lane, set spec/suite/arc, on?:unit/tip, event `{tree,env,failing[],red,green}`, forgiven |
| smoke-ran | unit, attempt, key, verdict `{killed,survived,inconclusive}` lists of `{lane,testId}` |
| docs-published | pub, source close-out, commit |
| docs-covered | pub, from, to (the publication's self-covered audit edge) |

FlakyLedgerEntry is `{key,events,deflakes}`; key is test `{lane,testId}` or whole lane, events are ordered nonempty
FlakyEvent records, deflakes are ordered unit ids. Stochastic lanes never produce flakes.
A mutant spawn binds `{purpose:'mutant',of:{type:'finding',finding}|{type:'smoke',unit,attempt},lane,laneRev,tree}`;
its `mutant.apply` intent binds worktree, at, of and patchSha256. The patch is kept by hash and executed, not judged from
text. Smoke survivors/inconclusive checks remain explicit. `src/core/events.ts` and `src/core/flaky.ts` own these fields.

### The demo

Run `demo.desired.json:{v,arc,repo,worktreeRoot,up,upSeq,target}` is derived by the executor. Target is null or
`{milestone,sha,bringUp}`. Host `demo.json:{v,ports,serving,trial,failures}` is written only by the supervisor keeper.
Instances bind arc/repo/worktreeRoot/slot/milestone/sha/bringUp/boot/processes; serving adds up/down state. Failures bind
arc/milestone/sha/log/upSeq/boot/at. Promotion tries the new instance beside the old one; failed bring-up retains the old
service. Hold blocks promotion/restart until release (`src/demo/records.ts`).

## Role input and output contracts

`judgment-inputs` captures unit, stage, attempt, tip, head|null, specRev/specSha256, planRev/routingRev before spawn.
Gate adds approval fingerprint, `diffShown:{inlined,notInlined}`, `largeDiff:{overflow}|null`, review/standingReview and
designEstimate|null. Recovery consumes those identities, never a newer tip or plan.

Verifier inputs are `{mode:'gate',brief:GateInputs}` or `{mode:'pre-build'|'diagnosis',brief:ReviewBrief}`. GateInputs
includes systemNotes, touches, standing, method, spec/intent/nonGoals, cited contracts/index/target/direction, selected
and standing obligations, bounded diff/claims, laneLedger/evidence, systems/reach/traits/reachTraits, priorRound,
checks/escalation/largeDiff/milestones, undeclaredContracts and proportional review. ReviewBrief is `{target,vision,spec,intent,nonGoals,contracts,systems,method,history,standing}`; history supplies
diagnosis failures where applicable. No model identity is a role input.

| Role | Strict output |
|---|---|
| verifier gate | GateOutput decision, findings/directives/reasons/premises and gate review/coverage fields |
| verifier pre-build/diagnosis | The same GateOutput schema; code converts findings into standing items and keeps a diagnosis/failure note |
| campaignAudit | LensOutput findings/reasons/premises plus requests[] `{op:'request',summary,evidence,dismisses:F-n|null,counterEvidence:string|null}`; dismissal requests require counter-evidence and root action |
| experienceVerdict | `{final:true,mode:'walkthrough',verdict:{final,journeys,findings,polish,premises,reasons}}` or `{final:true,mode:'polish',verdict:{final,decision:keep|drop,evidence,reasons,premises}}` |
| packReview | `{findings,dispositions,reasons,premises}`; findings bind severity/target/claim/evidence `{path,line}`; delta review dispositions name prior job/index |

Every backend output schema has a plain object root: `type: object`, `properties`, every property in `required`,
and `additionalProperties: false`. No root `anyOf`, `oneOf`, `allOf`, `not`, `if`, `then` or `else` is allowed;
nested `anyOf` describes nullable fields and variants such as the experience `verdict`.
Property descriptions state cross-field rules; parsers enforce them and return discriminated TypeScript unions.
Verifier directives are nonempty for revise and empty for approve/escalate; only escalate can carry ordering,
and approve forbids blocking findings. Experience mode must match the verdict shape.
`reraises` and dispute ruling finding ids name R-n ledger entries, never pre-build standing item ids.

Every judgment role gets at most one repair turn in its own session/schema/cwd when the answer fails validation;
a second invalid answer follows the role's failure path. See `src/prompts/{inputs,schemas}.ts` and pipeline/dispatch.ts.

## Runner files

`InvocationBinding = {v:2,arc,op,inv}`; inv must belong to op and op to arc. Files for one invocation live at
`<runDir>/inv/<seq>-<ordinal>/`. The runner owns `runner.json`, stdout/stderr, exit/result; input/schema and launch are
kept before spawning. Adapters read only quiescent files and write deterministic bound results.

```ts
LaunchFile = InvocationBinding & {
 argv:string[]; cwd:AbsPath; env:Record<string,string>; envPass?:string[]; stdinPath:AbsPath|null;
 deadlineAt:IsoTime; stallMs:number|null; graceMs:number; containment:'session'|'cgroup';
 test:{crash:AbsPath}|null; terminal:LaunchTerminal;
};
ExitFile = InvocationBinding & {
 child:{type:'exited',code:number}|{type:'signalled',signal:string}|{type:'spawn-failed',error:string};
 cause:'exited'|'deadline'|'timeout'|'stall'|'cancel'|'recovery-kill'|'reported';
 endedAt:IsoTime; quiescedAt:IsoTime; cpu?:{wallMs:number,runMs:number,waitMs:number}|null;
};
```

LaunchTerminal is command `{type,purpose,expectedExit,timeoutMin?}` or backend
`{type,purpose,role,routingRev,schemaPath,outputPath,session,name?}`. `name` (dev.59) is a Claude build's
`BuildSessionName`, the `--name` it launched with (a startup or probe smoke's build is named by its check); it is refused on a
Codex build and absent on a build launched before dev.59. Every Claude build also launches with
`crossSessionInbound: "accept"` in its `--settings` and never `--bare`. TimeoutMin is lane-only. Claude sessions have backend,
mode fresh/resume and id; fresh Codex lacks id until the result. Runner adds ROADMAP_OP/INV/ROLE to the declared env.
`env` holds literal values only. `envPass` names the variables a launch takes from the executor's environment (a lane's or
declared command's `env.pass`): sorted, non-empty, never ROADMAP_*, disjoint from `env`, absent when none. Their values never
reach a file: the executor sets them in the runner's process environment and the runner copies them into the workload's, so
launch.json and its `launchSha256` carry names only. A launch.json written before `envPass` (1.0.0-dev.61 and earlier)
carries passed values inside `env`; it reads and hashes as written and is never rewritten. Backend and bring-up launches
pass nothing: their host PATH, HOME and CLI config-dir values stay literal in `env`.
Only launch argv can carry model ids among executor-written runtime files. Exit is published after containment empties,
before adaptation; `reported` follows a validated final report's bounded descendant grace. Binding mismatch refuses.

## Backend call kinds and read surface

`src/backends/argv.ts` defines claude-build, claude-judgment, claude-acting-judge and codex-build. Builders edit their
checkout. Read-only Claude judgments disable project settings/slash commands and use explicit tools/system text.
Acting judges have shell/browser/project tooling in their disposable checkout with write-deny rules over existing
paths outside allowed writable roots. This is not protection against deliberately escaped processes or paths created
later. `--add-dir` explicitly names repo, run dir and role-specific evidence directories. `reads.json` records Read/Grep/
Glob calls (including subagents) and denied reads for review validation.

Claude JSONL is retained. A usage-limit error in **any** result dominates later success; classify from CLI error
results, never product command stdout. Missing final results retain streamed token lower bounds with unavailable
cost/reason; resumed builder accounting avoids double counting cumulative usage. Codex retains partial tokens and final
`-o` output. A failed k-of-n series retains each attempted run and partial metering; aggregate failure is not zero usage.

## witness-check

`roadmap witness-check --lane-file <file>` is a host act in the builder's git worktree. The write-once WitnessLaneFile
binds lane/reporter/argv/cwd/env/required ids. Run exact argv with declared env plus reporter, collect a fresh output per
execution, and compare exact required test ids. Lane exit alone is not the verdict. Exit **0** means all required ids
passed; **78** reports `{missing,failed,malformed}` when a required witness is missing/failing (including skipped ids).
Lane stdout/stderr go to command stderr; temporary reporter evidence is removed afterwards. See commands/witnesscheck.ts.

## Environment lifecycle

Managed environments move **down → starting → up → stopping → down** through journaled environment spawns.
Failed/lost transitions leave unsettled state, requiring down before another up. Reservation serializes each environment
and includes powered resources. First use brings it up then probes; a failed up/probe tears it down and yields retryable
`env-unavailable`, never a red lane. Failed down raises non-blocking `env-blocked` because it may still be running.

Idle expiry requires no users or waiters. Pause-all/stop idles immediately; a unit pause uses idleMinutes. Recovery
settles interrupted up/down spawns, downs unsettled environments and restarts an already-up environment's idle clock
from executor start. Up/down timeout is 30 minutes, probe two minutes. Plain probe-only environments have no power state.

## Lane dir and build handover

A lane's explicit timeoutMin yields timeout red; without it the six-hour runner backstop applies. Previous red lanes run
first; repeated identical red evidence is not blindly rerun. A suite lane identical to a spec/arc lane shares execution
where identity matches. Same-commit red→green is a flake: unit-tree flakes return uncharged evidence for repair, while
eligible integration-tip flakes can be forgiven and mint at most two deflake units before a recurring-flake item.
Both original evidence paths remain visible. `near-duplicate-lanes` is a Phase-0 advisory, never permission to omit checks.
Status blockingUnits uses effective lineage heads of future deliveredBy units or active must-hold repair owners
(`holistic/blocking.ts`). Required witnesses block publication/completion; campaign audit readiness follows milestone,
root-request and final triggers (`holistic/cadence.ts`).

Fresh build sessions with prior lineage receive code-built handover: lineage, failure diagnosis, latest gate, unsettled
findings, unmet clauses, missing/failed witnesses, inherited decisions, latest report and extant failing evidence.
Each history list retains the ten most recent items; unmet clauses are spec-bounded (`pipeline/handover.ts`).

## Container command and TUI

`executor/bin/install-roadmap` installs/refreshes a managed launcher pointing to the plugin and current Node executable;
`--bin-dir` chooses a writable PATH directory. It refuses unrelated existing commands. Refresh on plugin/container
updates. The TUI reads retained runtime and captured document identities without making runtime writes or controlling
admission. Closing it leaves the executor running; status/usage observation is bounded and read-only.

### Roadmap web console

`.roadmap/config.json` accepts `webConsole:{host?,port?}`. Missing fields default to `0.0.0.0:4747`
without rewriting the file. Host must be an IPv4/IPv6 literal; port is an integer 0–65535; zero requests any free port and the lease records the actual positive bound port; unknown keys
are refused. This is the devcontainer default: the wildcard interface makes the console reachable from
the host through the container network. No auth is provided. On exposed hosts, choose loopback (`127.0.0.1`
or `::1`); plans, state, spend, questions and selected logs/results can contain sensitive text. Port 4318 is
reserved for OTLP/HTTP, not the console. On automatic startup, console operational failures (bind errors,
startup/mutex timeouts, live settings conflicts and failed termination) print one loud warning naming the
cause and `.roadmap/config.json` webConsole.port or `roadmap console stop`; arc execution proceeds.
Direct `console start` refuses these failures. Corruption and programming errors still propagate. Invalid configuration refuses startup. Nonzero ports never fall back. A zero setting reuses a live console on the same host. Other binding changes require console stop/start;
conflicting worktree settings name the startup config source.

`console start|stop|status --repo` prints the same console status/URL line to stderr only. `status` also
prints it on stderr, preserving legacy JSON stdout. Wildcard binds use loopback in local connection URLs;
LAN sharing substitutes the reachable machine hostname/IP. Startup ensures the detached service before
supervisor launch, and direct supervisor entry ensures it before host claim. No supervisor tick ensures it:
explicit console stop persists until another start; normal stop/drain/park/completion/death leaves it running.

`<common>/roadmap-console/lease.json` is outside arc GC, shared across worktrees and keyed by realpath
Git common directory. Its closed schema is `{pid,start,bootId,nonce,executorVersion,repo,common,hostDir,
configSource,host,port,bindUrl,url,ready,startedAt}`. Identity is bootId/PID/start, not PID
alone. Older leases may retain `lastObservation`; it is ignored, and checks never rewrite the lease.
Nonce identifies the instance. An abstract-socket mutex serializes concurrent starters, stop and
replacement. Readiness is published only after bind. Dead identities are reclaimed even if their recorded common directory
differs; a live foreign-common identity is refused with the lease path, pid, and stop guidance; a version replacement
identity-checks SIGTERM then bounded SIGKILL, awaits death and rebuilds caches. Stopping never signals the
executor or actionable watch. Only console lease/log metadata is written; schema remains 2, including
adoption of dev.54 state.

Gathering and serving run on separate threads. Each maintained arc has a collector worker: the selected arc (this
repo's claimed arc, otherwise the latest retained) always, and up to two more that were subscribed or read in the last
minute, least recently used out first; a released arc's collector is terminated and the arc returns with a new epoch. The
browser shows only the selected arc (another arc's link reads "This console shows the current arc only"). A collector
steps every second (100 ms after a filesystem notice or a strict read's request, never closer to a capture than 150 ms or
half that capture's time); it watches the run directory flat, the refs and answers trees, and the directory of each
invocation whose history a stream follows. A step samples what changed: the journal's stamp; the run's start, rejection and schedule
records, the host claim, owner and demo files, `HEAD`, `packed-refs`, `config`, the refs and answers trees, incoming
commands, receipts and needs-user records with their membership, the kept inputs' names, and each open invocation's
runner records (identity/size/mtime/ctime, never following symlinks); the heartbeat and watch lease as a volatile overlay;
open invocations' output streams. Nothing it stats grows with settled invocations or evidence. A moved journal or stable
record captures and publishes the change; moved output re-reads the open rows at most every five seconds; otherwise the
step publishes a check. Only ObserverJournal.read verifies journal prefixes, retaining incomplete tails without repair;
inode/truncation/anchor resets change epoch. A capture folds only appended events, reads open invocations' rows and newly
settled ones, and answers immutable git commands (full object ids only), write-once records and parsed kept inputs from
memory (src/observation/memo.ts); a ref lookup is asked once per capture, and a lookup of a full ref name in the arc's
repository once per sample of its refs. Derivation cells keep five derived values with the key each was derived under
and derive them again only when a capture's key differs: `refs` (those ref lookups; key: the sample's stamps of the refs
tree, `packed-refs`, `HEAD` and `config`; none for a reftable repository), `receipts` (the terminal receipts; key: the
sample's stamps of the receipts and incoming trees), `routing` (the routing tables of every plan revision; key: the seq of
the last `plan-applied`), `truths` and `history` (each obligation's verdict and evidence on the integration head, and its
last observation before it; key: the head commit, the seq of the last `witnessed`, `external-witness`,
`obligation-latched` or `plan-applied`, and the systems map's content hash). Journal facts are keyed by
`JournalView.lastSeqOf(kinds)`, the seq of the last event of those kinds. What an obligation waits on (its units, their
reasons) reads unit states and is derived on every capture. A shadow derivation checks the cells: status and summary
derived again at the same journal position and clock with every cell computing, compared with what was published. The
console runs it once the collector has been idle 60 s, at most once every 10 minutes and once per published capture; the
test harness before every capture is published (`ArcCollector` option `shadow`). It counts only when a sample taken after
it equals the published one. A difference is a `failed` with code `corruption`, `console derivation diverged at <path>`
(the first differing path), logged; it stands, and the arc's collector publishes nothing more until the console restarts.
What it remembers is bounded by bytes, not by
the arc: git answers 64 MiB and records 128 MiB (a witness record as its parsed observation, never its text), least
recently used first, neither keeping one entry over an eighth of its bound, and no record the capture under way used is
dropped for another (a capture reading more than the bound keeps a stable set and reads only the rest again); parsed
inputs only while captures ask for them, dropped when a record the memo had read is found rewritten; tree listings 200,000
entries, read by the last-observation walk tree by tree in chunks that fit, and only for trees whose lane inputs are not
yet known; and a snapshot ref only as its digest (commit, chain link, completed head), verified once per commit and kept
while captures ask for it. A capture is published as of the sample taken
before it read anything: every record it read is complete and at least that new, and whatever changed meanwhile is the
next step's capture. A capture that races a writer (`ENOENT`) publishes nothing, keeps its cursor and rows, and is retried
at the next step; five in a row are logged once. Any other failure is published, answers that arc's reads, and stands
until a capture succeeds.

Write-once records are trusted once read. An integrity sweep re-stamps them (settled invocations' runner records, red and
witness records, kept inputs) against their stamps when read, at most 20 ms per step, and walks the run for symlinks that
escape it, at most 20 ms per step: a rewritten or removed record is read again (a tampered one fails the capture, a pruned
result shows pruned) within one pass, about 47 s on an arc of 40,000 records. That is the detection bound for a record
nobody opens; routes that open a record (result, log, history, content) verify it on that read.

The serve worker holds each maintained arc's latest observation and parses the verified journal prefix itself. Every API
read is answered from memory: shell, graph, status and summary are kept per capture, and the metadata's view versions are
computed once when a capture or rows refresh is published and kept with it (`data.capture.viewVersions`; their inputs are
accumulators extended with the appended events and changed rows); tab views build on their first request per capture and
are rebuilt for each new capture the last five minutes asked for once it has stood half a second; a unit's, a milestone's
and an Activity event's detail build once per published data object, in the same 32-view cache. The Activity index is
kept per arc and journal epoch and extended to each capture (the appended events, and the entries whose inputs changed:
invocation rows, stage steps, finding claims, request digests, unit titles, backend holds and the terminal fact, root
decisions), in 20 ms slices between other reads; a new epoch or a journal that does not grow the folded one builds it from
nothing, by the same fold. The index is not a cache: it is kept, whatever its size, for as long as the serve worker maintains
its arc, and is bounded by the serve worker's heap guard, which scales with the journals it parses. An Activity anchor and its
cursors are frozen at their position: pages read from them stay as they were, and `activity/changes` counts on the newest index
for as long as the epoch lasts and the anchors' bounds (24 MiB, 32 anchors, 15 minutes idle; the least recently used goes
first) keep the anchor. A gone anchor answers `reset`: its tab offers "Updates available." with "Show latest". A check is not an observation: it moves `checkedAt` and the heartbeat,
supervision and clock that the status route alone applies (live elapsed and token-wait times advanced from the capture's
clock to the check's), and no revision, so revision notices follow captures and rows refreshes only. API discovery is answered by the HTTP thread from the serve worker's reported
selection, once the selected arc is observed. The HTTP thread logs, once each, when an arc falls behind (its journal is
past what was published, or nothing was checked for three seconds, for five seconds): `console is behind arc <arc> by
<d>s: published through seq <n> (byte <b> of <size>); collector in <phase> for <t>s; last capture <ms> ms (<events> events,
<reads> record reads, <git> git)`, and when it catches up: `console caught up with arc <arc> after <t>s behind (<d>s at
most)`. `<t>` is how long the episode lasted; `<d>` is its depth, how long the oldest unpublished event had waited: the
age of the first of the last 120 once-a-second checks of the journal's size to find it past what was published; a cold
read says how far it got every ten seconds (`console is reading arc <arc>: <phase> <percent>%`). Workers run with heap
limits that are runaway guards a healthy arc never reaches, not budgets: three times a measured need plus 512 MB (a
collector needs 384 MB plus three times its journal; the serve worker 256 MB plus three times the maintained journals, and
is sized 64 MB over for their growth; a maintained set past its limit restarts it). A collector, which
nothing waits on, collects its captures' garbage itself once its used heap is 192 MB over what its last collection left
(the console process runs with `--expose-gc`): left to V8 under a guard-sized limit it runs to three times what it holds.
The serve worker does the same after answering, at 128 MB over, when no read is parked.
Each worker reports its heap (used,
limit, external) with what it holds at its first observation, every ten minutes, and once each time its used heap passes
80% of its limit; the HTTP thread logs one line per report (`console collector for arc <arc>: heap <used> of <limit> MB
(external <n> MB); events …, rows …, open …; records … (<n> MB, <n> evicted, <n> not kept), git … (<n> MB), stamps …, parsed …; …;
process RSS <n> MB`, the same shape for `console serve worker:`, ` NEAR ITS LIMIT` on the 80% report). One that exits is
logged with its reason (out of memory: its limit, its last report or `no report yet`, and a collector's phase) and
restarted after 5, 30, then 60 s, and its arc's reads answer unavailable with that reason meanwhile. A worker out of
memory three times in a row (a collector before it publishes a capture, the serve worker before its first observation) is
not restarted: the log says so, and every read of that arc (every read, for the serve worker) answers unavailable saying
the console stopped after running out of memory at that limit, until the console is restarted.

An atomic envelope is `{protocol,instance,repoId,arc,epoch,highWater,revision,observedAt,checkedAt,data}`.
Protocol is the exact executor package version. HighWater is the verified event prefix; revision also changes
with side files/liveness and with a rows refresh, never with a check alone. This is a verified journal prefix plus sampled external state, not a
filesystem transaction; `checkedAt` moves only when a step found nothing newer than the published observation, or
published one. Requests accept `minHighWater`, `epoch`, `revision`; CLI adds `fenceIdentity` (device:inode) and
`fenceSize` captured cheaply from the journal. A browser read is answered from the published observation; one whose
watermark is ahead waits for an observation reaching it, and is unavailable once a check made after it arrived found
nothing newer. A strict read (status, the CLI) is answered only by a check made after it arrived that covers its fence
(the cursor inspected through it, excluding incomplete trailing lines), within two seconds; one arriving before its arc's
first observation waits for that observation and gets its two seconds from then, otherwise it answers unavailable
(`console has not verified the arc since this request arrived`). A request whose caller left is dropped unanswered.
Reset/conflict (409), unavailable (503) and corruption (500) are explicit; old epochs, lower watermarks and unchecked
observations are not silently returned. Absent/dead/unreachable servers, unavailable catch-up and console
protocol/version mismatch fall back locally with a stderr diagnostic. Identity mismatch, malformed payload and corrupt
evidence do not fall back; explicit evidence routes retain not-found for absent/pruned evidence.
`host.log.foldMs` and compactionDue retain measured fold semantics; elapsed time is not zeroed for parity.

All API paths start `/api/<executorVersion>`. GET and HEAD only (other methods 405), no-store, no CORS.
`:arc` is the arc id; `:id` of an invocation is its `seq-ordinal` key. Every typed view and detail returns
the envelope with `data` validated by `src/console/view-shapes.ts` (malformed data is a `protocol` error):

| Path after version | Response data |
|---|---|
| `/arcs` | Console protocol, UI schema and the selected arc |
| `/arcs/:arc/status?summary=0\|1` | Envelope containing the unchanged canonical CLI status object, or its summary |
| `/arcs/:arc/shell`, `/graph`, `/metadata` | Arc shell (header; `availableRange` is the arc's recorded start and end, null while it runs), the unit/milestone graph, and the metadata notice (`viewVersions`, and `lastEventAt`, the last event's time); only `epoch`, `revision`, `minHighWater` accepted |
| `/arcs/:arc/activity` | Activity page: `window=arc\|24h\|7d` or `from`/`to` (RFC3339), `zone`, keyset `afterSeq`/`beforeSeq`/`cursor`, `order=asc\|desc`, `limit`, `housekeeping`, `q`, filters unit, milestone, stage, kind, role, backend, model, outcome; `facets` |
| `/arcs/:arc/activity/changes` | Count of newer matching entries since an anchor |
| `/arcs/:arc/activity/:id` | One activity entry's detail; `section=content` pages its full text |
| `/arcs/:arc/timeline`, `/timeline/intervals`, `/timeline/holds` | Tracks, a track's intervals and backend holds: window, unit, milestone, state, stage, execution, `q`, `sort`, `subject`, `cursor`, `limit` (intervals up to 200); tracks carry `facets` |
| `/arcs/:arc/holistic?section=audits\|findings\|decisions` | Holistic audits, findings and decisions, paged |
| `/arcs/:arc/holistic/fields/:key?after=N` | One long holistic text field, sliced |
| `/arcs/:arc/effort` | Effort page: `group=unit\|role\|system-set`, `metric=work\|spend\|waiting`, `sort`, `direction`, window, filters; `facets` |
| `/arcs/:arc/resources?section=schedule\|cpu\|waiting\|now` | Resources page: bookings, CPU reservation against measured run time, measured waits, current holders/queues; filters resource, unit, stage, state, reason, utilization; `facets` |
| `/arcs/:arc/resources/reasons` | Waiting reasons with totals, paged |
| `/arcs/:arc/resources/details/:key` | Selected booking-, resource-, cpu-, waiting- or measurement- detail (`evidence=ownership\|calls\|measurements`); `effort-<group id>` (for example `effort-job:audit-1`) is an Effort scope read under the page's grouping and window |
| `/arcs/:arc/attention` | Attention subjects: `subjectType`, `reason`, `q`, `sort=oldest\|newest`, `cursor`, `limit` |
| `/arcs/:arc/requests/:id` | One recorded request; `section=content` pages its text |
| `/arcs/:arc/units/:id`, `/milestones/:id`, `/invocations/:id` | Selected detail. Unit sections summary, depends, usedBy, journey, invocations, acceptance, waiting, checks, requests, intent; milestone members, intent; invocation related; every one content. Collections page with `section`, `cursor`, `limit=25\|50\|100` |
| `/arcs/:arc/invocations/:id/result` | Validated recorded result/evidence, or explicit absence/pruning |
| `/arcs/:arc/invocations/:id/log?source=stdout\|stderr\|runner.log&after=N` | At most 64 KiB of source bytes, next cursor, identity, text and lossless base64 bytes |
| `/arcs/:arc/invocations/:id/history?before=BYTE:BLOCK&identity=…` | Latest 50 structured events, or preceding page; retained transcript identity and complete-line byte cursor |
| `/arcs/:arc/invocations/:id/history-field?ref=BYTE:BLOCK&field=text\|input\|output\|title&after=N&identity=…` | At most 4,096 characters from one decoded field; explicit next cursor and total length |
| `/arcs/:arc/invocations/:id/prompt?after=N` | Retained, hash-verified seat input through the canonical LogReader, at most 4 KiB of source bytes |
| `/arcs/:arc/events?invocation=ID` | Revision/heartbeat/reset/pulse/error stream; optional history subscription sends small `history` invalidations and `history-error` |

`/arcs/:arc/snapshot` is not found. Windowed views default to `window=24h` (Activity to the whole arc) and
refuse `window` with `from`/`to`. Unknown query parameters, values outside closed choices and filter values
outside the view's `facets` are refused with `invalid` ("unknown … filter"). `facets` lists the recorded values
each text filter accepts: Activity unit, milestone, stage, role, backend, model, outcome; Timeline unit,
milestone, stage; Effort unit, milestone, system; Resources resource, unit, stage, reason. Responses are
byte-bounded (for example 128/256 KiB view pages by limit, 32 KiB details); paged cursors are bound to arc,
epoch and query, and a foreign cursor is `invalid`. Graph units and unit summaries carry `stageFinished`: the
current stage's last attempt has ended. A unit's total time is null when no start is recorded or the recorded
end equals the start.

Typed views, `/arcs` with `Prefer: respond-async`, and unit/invocation details with that header use browser
preparation: a read not ready within 250 ms answers 202 with `{state:'preparing',pending,retryAfterMs}` and
`retry-after: 1`; polling with `pending=<token>` holds up to a second for the result; `cancel=1` cancels.
A settled read is delivered as the serve worker admitted it, whatever its age: browser reads are never refused or
re-run for age, so a 202 means only that the read is still running. Only the strict CLI read keeps a freshness
condition. An Activity read is answered from the newest capture of the arc whose Activity index is built (same epoch,
admitted by the read's watermark) while the current capture's index is built; only a read no built index can answer
waits for the build.
Reads live at most 30 s, with at most 32 preparing reads and 128 readers (beyond either: unavailable).
`pending`/`cancel` on other routes are `invalid`. Status and API discovery keep the two-second admission.

Invocation route IDs are the existing `seq-ordinal` directory keys: canonical invocation IDs contain `/`
and `#`, while routes deliberately reject encoded separators. Keys resolve only to journal-recorded
invocations of the named arc. Log requests can echo `identity` to detect replacement; after beyond the
current end returns reset. SSE reconnects with Last-Event-ID; missed revisions reset rather than replaying
unbounded history. Every SSE frame is at most 4 KiB: revision notices carry only
arc/epoch/revision/checkedAt/highWater, the view versions and `lastEventAt` (the last event's time, which moves with
every event and so is in no view's version; the header's "Last activity" and the default 24-hour windows read it), and history notices carry invocation/identity/cursor/state/end/reset
and changed count. Views, event pages and expanded content are fetched through ordinary GETs. A full
socket waits for drain for up to two seconds; pending notices coalesce by event kind, and a persistently
blocked connection closes. Reconnection revalidates the current prefix. Heartbeats carry checkedAt. Once a
second, after each lag check of an arc that has published, every stream of that arc gets
`event: pulse` with `{arc, asOfAgeMs, behind}` and no `id:` (it never moves Last-Event-ID): `asOfAgeMs` is the
server's `now - checkedAt` of the latest published observation, a whole non-negative number of milliseconds, and
`behind` is the lag monitor's verdict (journal past the published offset, or nothing published or checked for three
seconds). It is sent from the main thread, which runs no capture or view build, so it arrives while a capture is slow.
The browser measures how old its data is from the pulse (received time minus `asOfAgeMs`, its own clock only; before
a connection's first pulse, the notice's checkedAt). The pill is the connection only: Connecting, Connected,
Reconnecting (amber; the stream closed, or silent for five seconds), Offline. Behind is not an error: past five seconds
old (cleared under two) a neutral line bottom-left reads “Catching up. Showing the arc as of 8s ago.”; while
reconnecting with data shown it reads “Reconnecting. Showing the arc as of 40s ago.” in amber. Meanwhile every elapsed
time and “N ago” is measured to that as-of instant. The browser polls `/metadata` only when the stream is silent for
five seconds and reopens a stream silent for ten. Each view read carries the epoch and the high-water mark of what that
view already shows (none before it shows anything), so a read never waits for a capture: a view may be a capture behind
the notices, is shown, and loads again when its version differs. A view loaded automatically (its version moved; the
Resources "now" strip and Activity's new-events count alike) is loaded again no sooner than max(1 s, twice its last load's
time) after that load ended, with one trailing load for the versions that arrive meanwhile; a person's reload is not paced.
A failed refresh keeps the view's data and retries
after 1, 2, 4, 8, then every 15 s while the view is open; it alerts only when the view has nothing to show or after
three failures in a row. A browser on another package protocol requires reload.

Static paths come only from an explicit content-hashed manifest. HTML revalidates; immutable assets include
prebuilt React, shadcn/ui components, Tailwind styles, Cytoscape/dagre and Latin Barlow/JetBrains fonts.
Sources live in `web-src/`; `npm run build:console` writes committed `web/` assets and a sorted manifest.
`web/THIRD-PARTY-NOTICES.txt` records every bundled package version and licence text. A byte-for-byte drift
test guards the output. No runtime dependency, build, install or download is required. Roadmap product names/accessibility labels
exclude supplied branding and marks. Evidence is text only. Traversal, encoded separators and symlink escapes
are refused; evidence reads verify containment of the opened descriptor. CSP is same-origin with nosniff;
there are no commands, credential reads, shell actions or arbitrary filesystem browsing.

Browser routes are `#/arcs/:arc/:tab` with tabs graph, timeline, activity, effort, resources and attention,
plus an optional drawer segment `/units|milestones|invocations|events|requests|scopes|resources/:id`; any other
hash is invalid. Activity opens on the latest events regardless of age; Timeline, Effort and Resources open on
the 24 hours ending at the last recorded event. Filters are offered only as choices of the view's `facets`; an
unknown value from a link is left out of the read, saying so under the filter bar. One display vocabulary
(`src/console/vocabulary.ts`) names states, stages, roles, agents (role, then model), outcomes, hold classes,
closures and decision kinds. Missing values read "Not recorded", known absence in a window "None in this window",
and values that cannot apply "Not applicable". An interval still open past a window's right edge keeps its true
start, gets an arrow cap at the edge, and its row says since when it has run or been held.

The graph uses Cytoscape with dagre milestone bands and a legend. Dependency edges are solid; milestone waits
are dashed. Unit signals (`src/console/signals.ts`):
merged is passed; preparing/running active; held/blocked/parked/awaiting-admission held; waiting/ready
pending; cut/superseded withdrawn (dashed border), never passed. Waiting/ready units whose current stage has
finished are marked distinctly, and the unit drawer reads "Finished: <stage>". Search, focus and selection keep
every unit navigable; route-driven drawers overlay the canvas, and the drawer's route is the graph selection. Effort scope drawers read under the page's
resolved window. Attention shows subjects, recommendations, options and evidence without response controls.

Activity rows for invocations open the invocation drawer; the seat brief renders as its own collapsed block.
`decodeTranscript` in `src/tui/transcript.ts` is the single presentation decoder; `normalize` renders its structured events
through the legacy text projection, guarded by unchanged TUI tests and phase-4 text goldens. This does
not change backend execution/result parsers. Claude stream-json is first-class; Codex JSONL command,
reasoning, message, result and error events use the same event layer. Known events are readable prose;
unknown events retain their original escaped JSON text. Recorded parent tool IDs label subagent work.
Tools pair by `(parent, tool_use id)` with call input and result output. A separate bounded index retains
up to 256 pending calls while subagent traffic moves beyond the displayed window;
a result whose call precedes the available window and pending-call index is explicitly labelled as such. Model, usage,
timestamps and duration appear only when recorded. Tokens attached to a multi-block message appear
once; no per-tool cost or elapsed time is inferred.

Each history subscription tails complete newline-terminated records from a byte cursor. Partial UTF-8
and JSON tails remain pending by byte range, without unbounded carry buffers. Inode replacement,
shrinkage, same-size rewrite, prefix/previous-tail changes reset the identity; a new reader lifetime
also gets a fresh identity. History reconnect always starts with a reset page rather than replaying
missed transcript events under a journal revision ID. Upserts carry stable byte/block event IDs;
paired tool outputs update their existing event. Terminal invocation state arrives on the same stream
and removes the running caret without reloading. Scrolling up freezes the displayed events and counts
updates; Follow live tail reloads the latest page. The browser retains at most 200 events, offers Show
earlier and explicit field expansion, opens failed outputs, and otherwise collapses tool output.

History limits: 16 subscribed/cached invocation readers, 200 retained event previews per reader,
50 events per page, 1 MiB forward scan per poll or normal backward page window (up to 8 MiB to recover a long record), and 1,000 characters per
preview field. Expansion returns at most 4,096 characters. Individual JSON records decode up to
8 MiB; a larger record becomes an explicit oversize notice linking the existing lossless 64 KiB raw
byte pages, never a silently clipped record. A backward byte window may be shorter than 50 events;
its cursor allows continuing earlier. Prompt and transcript absence/pruning are explicit. Evidence
paths are selected from validated invocation records and opened with the same descriptor containment
checks as the existing log endpoint. No agent or executor writes are exposed.

### dev.42 publication adoption and item settlement

RevisionPayload.publication is null or `{renders:{path,sha256}[]}`. New payloads omit contractOps. The temporary dev.41 reader accepts and discards a legacy `contractOps: []` with a ROADMAP_UPGRADE warning; nonempty arrays and other values fail loudly. Kept bytes and hashes are unchanged. Schema remains 2.

Arc-subject needs-user items require a named `ack <id>` (optionless accepted). Unit/host subject actions still close their items. Finding requests retain settlement by named findings or a root revision supplying all repairs. Pack-review supersession remains. A later baseline with no problems emits `baseline-held{job:baseline-n,items:NeedsUserId[]}` (sorted, unique, nonempty) to settle exactly the open obligation-baseline items; replay folds this separately from acknowledgement. Apply/resume alone never closes unrelated arc items.


### dev.44 automatic integration pushes

Every durable `integration.ff` done record with outcome `published` queues publication to `origin`, including unit,
repair-batch, docs-revision and close-out subjects. After recovery completes staged needs-user raises, the executor
subscribes to new publications and queues the current integration ref, covering recovered fast-forwards. A worker inherits the user's environment and calls the
same `forge/push.ts::pushBranch` as `roadmap pr`, outside the scheduler's stage and sealed local-git boundary (R22).
Pushes are serial, each bounded by one `PUSH_TIMEOUT_MS` (300000 ms) deadline across its git operations. Normal exit
joins queued workers before closing the single journal writer. A crash before enqueue, during git, or after remote
acceptance is recovered by publishing the current head at startup or the next ff. Remote already at head is a no-op.

New additive schema-2 fact (previous-release logs default to no push facts):

```ts
{kind:'integration-push', branch:BranchName, head:Sha,
 result:'pushed'|'up-to-date'|'failed'|'diverged'|'no-origin',
 error:string|null, settles:NeedsUserId[]}
```

`error` is nonempty only for `failed` / `diverged`, and names the git failure; the fact names the attempted head.
Only `pushed` / `up-to-date` may carry `settles`: exactly the open push notices this success settles. Replay's
`supersededItems` consumes those explicit ids; no acknowledgement or unrelated arc action is invented. A failed fact
precedes its needs-user raise; startup reconstructs a missing notice if a crash separated them. Episodes are tracked
from the first failure of each reason since the last successful result, including after an explicit ack, so repeating
failures do not repeatedly raise the same notice. A new failure after success starts a new episode.

`push-failed` (network, authentication or timeout) and `push-diverged` (remote tip not an ancestor) are fixed
non-blocking reasons with arc subject and no options. The notice includes the error and head. The next ff or startup
retries; a diverged remote receives no push attempts while ancestry probes continue on these triggers. A named ack
can close the item but never bypasses the shared ancestry rule. The remote update uses an explicit force-with-lease
on its observed tip *only after* verifying fast-forward ancestry; a race refuses, foreign history is never overwritten,
and `main` is always refused. Absence of `origin` performs no network operation and records `no-origin` only once per
arc across restarts, with no needs-user notice. `roadmap pr` retains its own canonical push, now usually up-to-date.

### dev.45 candidate-red detail

`candidate/red` and (dev.59) `candidate/static-red` stage outcomes carry `detail {kind: "candidate-red", path, causes, summary, evidence, directives, baseComparison}`.
`path` is `suite red vs tip green`, `held-claims brake`, `mutant survivor`, or `repair batch`. The summary/directives name
red obligations and declared repairs, unexplained/background lane failures, dirty/moved checkouts, mutant findings,
and RUN/REUSED grading invocations with record/evidence paths. Fix rounds and bounded parks read this same diagnosis.
`baseComparison` is a lane/base/result/evidence array or null. Older reds default at read time to `path: "legacy"`, empty causes,
an explicit unavailable-cause summary, empty evidence/directives and null comparison, with `ROADMAP_UPGRADE`; kept bytes stay unchanged.

Journey reuse additionally requires every current witness test id on the lane to be present in the certified record. Missing IDs force execution; covered records remain reusable across obligation evidence refreshes. Files and normative revision retain their existing input/proof checks; a revision alone does not invalidate a record covering the current IDs.

Builder decisions use existing spec.patch and kept-spec history to establish the last text author. Builders may replace their own current text. Root/other-authored text survives repeats; differing proposals become stable `departure.<hash>` decisions through the existing departure channel. No provenance field or runtime migration is added.

### dev.45 walkthrough MCP availability

`walkthrough-mcp` facts retain `inv`, `server`, configured `command` argv and `connection`: either
`{type: "unavailable", status, error: string|null, signature: sha256, notice: needsUserId}` or
`{type: "connected", settles: needsUserId[]}`. Each invocation/server is recorded once, from Claude stream-json init.
Unavailable statuses (including a server missing from an explicit census) raise a non-blocking arc notice with reason
`walkthrough-mcp`, deduplicated arc-wide by server and hash of status/error. The notice names command, status and stdout
evidence and recommends fixing walkthrough.mcp for the worktree. Builds continue. A later connected configured Claude
build or acting walk explicitly settles that server's open notice IDs; unrelated applies/resumes do not. Named ack remains
available. No declared MCP config or no init census produces no availability fact or notice. Monitoring and spawn recovery
share the same idempotent inspection. Old logs need no new fields; the new fact collection starts empty.


### Lane reruns and stable verification checkouts

`LaneDef.noRerunPatterns?: string[]` is additive and optional: absent means no deterministic output patterns.
When supplied it is nonempty and each literal substring is nonempty. A substring in the failed command's stdout/stderr
tail suppresses its diagnostic rerun. Host signatures take precedence; timeout verdicts do not use this opt-out.
Stochastic lanes keep their runs/minPasses rule. The persisted red class adds
`{kind:'no-rerun', reason:'base-red'|'deterministic'}` and (dev.59) `{kind:'targeted'}`, a test-only run's red; older red
classes remain readable without changes.
A failing `lane-base-compared` for the same unit/lane/diffBase also suppresses diagnostics, retaining original evidence.
Specific failure signatures skip make `***`, npm lifecycle, exit-status and FAIL wrapper lines and generic summaries;
masking still replaces checkout paths, timestamps, hashes and digits. Spec base-red raises a blocking arc `base-red`
notice with an exported plan.json knownDefects apply fragment (root chooses fixUnit), goes to gate uncharged, and never
starts a fix round for that lane. Candidate behavior remains the final tip-alone merge brake. Known-defect output
matches accept their existing raw substrings or masked output lines; masked tokens are literal, not regexes.

`worktree.create.expect` adds optional `reset:true`, accepted only for detached checkouts. Absent retains the old
create-only contract. A reset-capable request at an absent path records an ordinary fresh add, retaining the old
partial-add recovery protocol. Each series journals a fresh create/reset intent, acts with `git checkout --detach --force <sha>`
and `git clean -fd`, and verifies the same detached-HEAD/clean-status/admin-link postcondition before done. Ignored
caches survive; unchanged files keep mtimes. Recovery can reconcile a completed reset or redo a partial reset only
in a registered detached checkout belonging to the repo. A queued series parks rather than resetting a path with
an earlier open create/remove/snapshot intent, including a permission park that released integration-slot. Existing crash points `worktree.create.act-start` and
`worktree.add.inside` cover reset before checkout and between checkout and clean, respectively; no new labels.

Unit verification uses `<unit>.verify`, kept until merge/retirement. Candidate suites use the arc's `.candidate.verify`,
serialized by integration-slot and kept between unit publications. The unit driver serializes stages and checks for
live workloads before moving stages, so its gate finishes before another series can reset its verification tree.
Series readers reject a checkout superseded by a later reset. Legacy `<unit>.verify-<attempt>` records are read via
an additive path fallback (one ROADMAP_UPGRADE warning per process) and still removed by the original evidence-backed removal path. Multiple creates for one
stable path project only the latest standing create for retirement. Interrupted series without completed snapshots
preserve dirty/evidence outputs before reset, as the previous removal path did.

Checkout create/reset/remove EACCES/EPERM (including git's permission-denied diagnostics) raises a blocking
unit-subject `residue` notice; other units remain admissible. Prepare, reproduce, pre-build, build, lanes and gate,
and candidate record uncharged `checkout-residue` outcomes, release reservations and leave checkout intents open.
These are operator environment parks: ownership repair requires the user, and a general host probe cannot prove it.
Retirement has no outcome stage and holds only its unit with the same notice. Restore ownership/write/search
permission (`sudo chown -R ...`) or remove the path, then `roadmap resume <unit>` retries in-process, without restarting.
Resume and every unit step reconcile only that unit's open create/remove intents through startup's canonical recovery
path: an already absent checkout closes `reconciled`; redo acts and verifies before closing `redone`; permission errors
leave the intent open and the unit parked. A partial git removal can unregister the checkout before failing: redo may
remove its leftover directory only with the journal's standing create, verified evidence from that checkout or its stage,
no replacement `.git` entry or symlink, and no competing open intent on the path. Unknown unregistered content parks.
Failed base-comparison promises are evicted so another unit or a resumed attempt can compare again.

### Stop controls and spec reopen eligibility

`stop` command bodies and `stop-requested{command}` facts add `mode: immediate|drain` and
`deadline: IsoTime|null` (absolute UTC). Missing mode/deadline read as immediate/null with a once-per-process
`ROADMAP_UPGRADE` warning; the schema version stays unchanged. An immediate stop has no deadline. The CLI
accepts `stop --drain [--within <positive minutes>]`, including fractional minutes, and stamps the deadline
at submission. Repeated drain requests do not extend it; a plain stop during drain replaces the control
with immediate mode. `control().stop` remains the command id; `stopOptions` exposes mode/deadline.

Drain closes task and stage admission and starts no probes, audits or other new jobs. Running stages and
jobs finish normally, including build→teardown and ff→snapshot chains. At a boundary tasks end without
an interrupted outcome. All tasks/jobs settle, reservations recover and environments go down, then the
scheduler writes `stop-completed{command}` and returns the ordinary `{kind:stop,cause:command,needsUser:null}`.
A drain deadline or later plain stop uses the existing immediate abort/kill path; recovery enforces
that policy while adopting live runners too. An unfinished drain starts no backend smoke job and
survives `executor-started`, including escalation to immediate; a completed stop clears on the next start. Legacy immediate stops retain
their startup reset. Full status exposes `run.stop{mode,deadline}` and summary exposes `stop`; live run
state is draining, or stopping after escalation. This is separate from holistic close-admissions draining.

`reopened` accepts judgment parks (pre-build/gate) and build `spec-wrong` parks on an applied next spec
revision. Apply validation, resume validation and the fold use the same eligibility rule. Reopen starts
at pre-build with the new spec revision and retains branch, worktree, counters and implementer session.
Other build design parks still require re-entry.

The console-only presentation adapter preserves canonical status bytes. Graph is the landing view:
a segmented state strip, milestone stations and the complete dependency graph. The arc bar shows the state,
day, recorded spend and verification status; completion adds the recorded outcome. Unit and invocation
drawers overlay the current tab without blocking the graph. Other tabs currently use plain recorded lists
and tables pending their next design phase. Short presentation titles are separate from full intent.
Unit journeys use recorded specifications, stage-local attempt numbers and successive build rounds, with
validated review reports and finding titles. Retirement completion comes from its settled operations;
zero-duration and reasonless waits do not create waiting rows. Activity pages the journal in plain words,
hiding successful housekeeping by default while keeping failures visible. CPU evidence groups measurements
by unit and stage attempt: utilization is summed CPU time divided by reserved core-time, and reserved cores
are weighted by measured duration. Absent measurements stay unknown. Finished resource axes
end at the recorded completion/stop; a live view shows recent work and open queues, with ALL to widen.
Current admission wait starts are not reconstructed from queue order. Legacy unmeasured reservations are
explicit. Holistic audit outcomes/findings are shown; checkpoint job detail remains outside this console.
Claude init/rate-limit records become collapsed session metadata, while the canonical TUI text remains
unchanged. Transcript text is decoded, escaped and byte-paged in the browser, never a link to base64 JSON.
