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
Fresh holistic starts require corpus (`holistic-needs-corpus`); the architecture-doc holistic arm remains a parsed shape.
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

DesignRecord and its validators live in `src/core/design.ts`: unit kind, typed changes/interfaces, failure modes/proofs,
clause-lane coverage, breaks, experiments, newSystem and verification. Root-authored design must pass reachability,
reference coverage, clause/witness and verification checks. It is authored by the root.
Pins in `src/core/pins.ts` bind linked requirement revisions and contract blobs. `stale-set`, `stale-answered` and
`stale-reopened` retain revision-link diagnostics and boundary reopening.

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
units. Selected milestone lanes must be suite batch lanes explicitly shared-resource or cross-system.

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

KnownDefects `{id,match,fixUnit}` match lane or output substring; held units wait uncharged until the fix lineage merges.
Derived entries `{sources,outputs,regenerate?:ToolCommand}` only add deterministic regeneration at lanes; no exclusions.

### Milestones and bring-up

Milestone `{id,text,units,design:{unit}|{supplied:true},lanes?,references,bringUp,journeys,resources}`. Units/references/
journeys are nonempty where required; selected lanes default []. A design unit is planned and outside its members.
Journeys have `{id,text,via:browser|shell,entry,budget:{steps,seconds}|null}`. BringUp has setup argv[], serve entries
`{name,argv,ready:{http}|{log}}`, env map, seed argv[]. `{port:<serve-name>}` substitutes allocated ports consistently.
References are design directories and have a 512 KiB text budget. Missing tools/MCP handshake refuse browser readiness.
A planned descendant outside the milestone waits for milestone-passed; code follows lineage heads. Non-planned
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

Phase-0 advisories add `{kind:"vacuous-future-witness",obligation,files}` for existing future witness files and `{kind:"spanning-proof",obligation,lane,units}` for multi-unit delivery without a spanning candidate/batch lane. They never refuse. Actual baseline vacuity remains execution-derived.

## Commands, receipts and needs-user

CLI parsing is pure and closes over Command kinds; run locator is host or paired repo/arc. Complete forms are in the
skill reference and parsed by skill-lint. The persisted CommandBody union appears below; host acts such as export and
brief are not queued command bodies. Brief/note evidence is hashed before submit, so later changed bytes refuse.

Command files are write-once incoming records with accepted/queued/applied/rejected receipts. Accepted/queued does not
mean applied. Apply receipt may expose remaining plan-defect advisories while refusing new defects. Steer drains a live
unit before applying; note informs the next build without cancelling it. Resume backend is explicit availability recovery. Dismiss requires a named active finding and non-whitespace counterEvidence. `finding-dismissed {id,command,counterEvidence,by:{role:"root",routingRev}}` folds as ruled/dismissed, including P1. Same-command replay is idempotent; a new command against an unknown/closed finding refuses. It suppresses unchanged-evidence re-raising through the existing admission predicate. Campaign dismisses/counterEvidence fields only raise a root request. If the finding settled while the audit ran, the request is informational and cannot re-block completion.

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

Strict role output readers reject unknown fields. BuildOutput is summary/blockers/experiments/grounding/tooBig/notes/final
(exact type below). Grounding contains specWrong nullable text and touches strings; tooBig is **top-level**. Structured
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
| Inputs | plan-applied, apply-queued, finding-dismissed, noted, steered, merged-in, revision-link stale-set/answers/reopening |
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
coverage remain. Close-out debt/releases remain; only the root edits obligation authority. Root dismissals use the dedicated dismiss command and finding-dismissed fact; audit requests never apply them. Repair publication and code-owned reproduction/close-out paths also change finding state.

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

Status is read-only without a lock. Summary fields: arc, state, planRev, supervision, progress `{total,merged,states,held,remaining}`,
spend `{costUsd,expectedUsd,differenceUsd,estimatedCalls,unavailableCalls}`, milestones, caught, verdicts, captures,
needsUser, waste, demo, completion. Caught is laneReds + gateRevisions + uniqueFindings, with byLens counts of unique keys;
not a cross-seat unique-defect metric. Milestone costs include members/re-entries/polish and walk/compare jobs, not all
arc costs. Captures lists suite capture spawns only. Waste findings use observed duration/evidence and durable cause keys.

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
  | Readonly<{ type: 'dismiss'; finding: FindingId; counterEvidence: string }>
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

`resource.transition` moves an all-or-none set under a holder:

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
recipe/provenance. Startup refuses **all foreign undispositioned residues**, even for resources this arc does not use;
clean or isolate them. A readable journal proving this arc owns a residue permits start so recovery/probes can reclaim
it. Its dirty instance remains unavailable. Cleaned/isolated/transferred dispositions are durable, not manual deletion.

## Scheduling

Admission rechecks pause, pending mutation drain, run-only, backend parks, breakers, base-red, blocking items, findings,
known defects, pressure, compare and deflake holds before prepare/reproduce/pre-build/build/lanes/gate/candidate.
Quiesce/evidence/salvage/teardown and ff/snapshot are mandatory chains despite pause/drain.

The arbiter serves docs/batch/job waiters first in arrival order, then units: high priority; promoted waiters by age;
otherwise repair=deflake, polish, planned; wait-start sequence then plan index break ties. A unit promotes after **three
other unit publications** in its waiting interval. Backfill may pass a blocked higher rank only with a disjoint request
(CPU and any shared pool count as overlap). Environment/pressure-blocked requests are set aside.
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
pressure unavailable, never invented. Scheduler ticks are retained for 30 minutes in memory.

At pressure >= 0.5 (saturated) the arbiter holds new builds/lanes while CPU is already reserved. Judgments bypass this brake,
and one workload always progresses. A deadline/stall under saturation is uncharged starved work; an ordinary red gets
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
 argv:string[]; cwd:AbsPath; env:Record<string,string>; stdinPath:AbsPath|null;
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
`{type,purpose,role,routingRev,schemaPath,outputPath,session}`. TimeoutMin is lane-only. Claude sessions have backend,
mode fresh/resume and id; fresh Codex lacks id until the result. Runner adds ROADMAP_OP/INV/ROLE to the declared env.
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

### dev.42 publication adoption and item settlement

RevisionPayload.publication is null or `{renders:{path,sha256}[]}`. New payloads omit contractOps. The temporary dev.41 reader accepts and discards a legacy `contractOps: []` with a ROADMAP_UPGRADE warning; nonempty arrays and other values fail loudly. Kept bytes and hashes are unchanged. Schema remains 2.

Arc-subject needs-user items require a named `ack <id>` (optionless accepted). Unit/host subject actions still close their items. Finding requests retain settlement by named findings or a root revision supplying all repairs. Pack-review supersession remains. A later baseline with no problems emits `baseline-held{job:baseline-n,items:NeedsUserId[]}` (sorted, unique, nonempty) to settle exactly the open obligation-baseline items; replay folds this separately from acknowledgement. Apply/resume alone never closes unrelated arc items.
