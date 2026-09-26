// The startup rejection table as data. Every rejection refuses `start` before any pipeline intent and is
// explained in `status`, so each member carries what its row needs to explain itself, and never a model
// id (a routing refusal names the seat and the layer instead). Step 13 implements one StartupCheck per
// kind; no fs or git here. A refused start persists its rejections as `status.rejection.json` in the run
// dir (`RejectionFile`, step 13b), which `status` reads back through `rejectionFile`.
import {
  type ArcId, type InvocationId, type LaneId, type ResourceName, type Sha, type UnitId, arcId, invocationIdOf, laneId, resourceName, sha, unitId,
} from '../core/ids.ts';
import { type ResidueKey, residueKey } from '../core/records.ts';
import { type Read, SchemaError, arrayOf, literal, nat, nullable, object, oneOf, positive, str, tagged, version } from '../core/validate.ts';
import { type AbsPath, type IsoTime, type PlanPath, absPath, isoTime, planPath } from '../core/values.ts';
import type { SchemaVersion } from '../core/version.ts';
import type { PlanM1 } from '../input/plan.ts';
import {
  type Backend, type ModelClass, type ProfileName, type RoutingLayerName, type SeatRef, backend, modelClass, profileName, seatFields,
} from '../routing/types.ts';

/** EX_CONFIG: start refused; fixing the input or disposing the blocker is the user's move. */
export const EXIT_REFUSED = 78;
/** EX_TEMPFAIL: another live process holds the host; retry later. */
export const EXIT_HOST_BUSY = 75;

export type StartupRejection =
  // Row: in-tree .roadmap/ holding anything beyond the 1.0 set (a 0.x layout).
  | Readonly<{ kind: 'legacy-roadmap-dir'; path: AbsPath; unexpected: readonly string[] }>
  // Row: worktreeRoot on tmpfs, or not writable.
  | Readonly<{ kind: 'worktree-root-unusable'; path: AbsPath; problem: 'tmpfs' | 'not-writable'; detail: string }>
  // Row: spec-lane-unrunnable. `unit: null` is a plan suite lane.
  | Readonly<{
    kind: 'spec-lane-unrunnable';
    unit: UnitId | null;
    lane: LaneId;
    problem: CommandProblem | Readonly<{ type: 'estate-lane-for-implementer' }>;
  }>
  // Row: spec-lane-unrunnable, resource variant (lead ruling, 13b): a declared resource's probe or teardown
  // command cannot run. Told apart from the lane form by `resource` in place of `lane`.
  | Readonly<{ kind: 'spec-lane-unrunnable'; resource: ResourceName; command: 'probe' | 'teardown'; problem: CommandProblem }>
  // Row: a seat resolving to an unsupported triple (including every Codex judgment triple). Names the seat,
  // the layer that chose its class and the class, never the model.
  | (Readonly<{ kind: 'unsupported-routing'; layer: RoutingLayerName; class: ModelClass; unit: UnitId | null; why: 'codex-judgment' | 'no-prompt' }> & SeatRef)
  // Row: undispositioned host residue.
  | Readonly<{ kind: 'undispositioned-residue'; residues: readonly ResidueKey[] }>
  // Row: live host owner (or a live recovery-lock holder). Exit 75.
  | Readonly<{ kind: 'host-busy'; holder: 'owner' | 'recovery'; arc: ArcId; generation: number; pid: number }>
  // Row: unreconciled previous-arc invocations (R18); a durable needs-user is raised.
  | Readonly<{ kind: 'previous-arc-unreconciled'; arc: ArcId; invocations: readonly InvocationId[] }>
  // Row: backend smoke missing or failed for the resolved profile.
  | Readonly<{ kind: 'backend-smoke'; profile: ProfileName; backend: Backend; problem: 'missing' | 'failed'; detail: string }>
  // Row: plan schema invalid, unknown spec path, baseline not an ancestor, resource request unknown.
  | Readonly<{
    kind: 'plan-invalid';
    problem:
      | Readonly<{ type: 'schema'; field: string; detail: string }>
      | Readonly<{ type: 'unknown-spec-path'; unit: UnitId; path: PlanPath }>
      | Readonly<{ type: 'baseline-not-ancestor'; baseline: Sha; tip: Sha }>
      | Readonly<{ type: 'unknown-resource'; unit: UnitId | null; lane: LaneId | null; resource: ResourceName }>;
  }>
  // Host rows from the plan's "Host lock and ownership" and "Tail rule" sections, also refused at start.
  | Readonly<{ kind: 'recovery-holder-dead'; pid: number }>
  | Readonly<{ kind: 'owner-mismatch'; detail: string }>
  | Readonly<{ kind: 'log-corrupt'; file: AbsPath; offset: number; detail: string }>
  | Readonly<{ kind: 'containment-mode-changed'; recorded: 'session' | 'cgroup'; detected: 'session' | 'cgroup' }>;

/** Why a declared command (a lane, a probe, a teardown) cannot run on this host. */
export type CommandProblem = Readonly<{ type: 'argv0-unresolvable'; argv0: string }> | Readonly<{ type: 'env-missing'; name: string }>;

export type StartupRejectionKind = StartupRejection['kind'];

/** 75 only while another live process holds the host; every other row is a refusal, 78. */
export function exitCodeFor(rejection: StartupRejection): typeof EXIT_REFUSED | typeof EXIT_HOST_BUSY {
  switch (rejection.kind) {
    case 'host-busy':
      return EXIT_HOST_BUSY;
    case 'legacy-roadmap-dir':
    case 'worktree-root-unusable':
    case 'spec-lane-unrunnable':
    case 'unsupported-routing':
    case 'undispositioned-residue':
    case 'previous-arc-unreconciled':
    case 'backend-smoke':
    case 'plan-invalid':
    case 'recovery-holder-dead':
    case 'owner-mismatch':
    case 'log-corrupt':
    case 'containment-mode-changed':
      return EXIT_REFUSED;
  }
}

/** What every check may read; step 13 builds it. Checks that need more (smoke results, host files) read them themselves. */
export type StartupContext = Readonly<{
  repo: AbsPath;
  planFile: AbsPath;
  plan: PlanM1;
  profile: ProfileName;
  runDir: AbsPath;
  hostDir: AbsPath;
}>;

/** One row of the table. Returns every rejection the row finds; empty means the row passes. */
export interface StartupCheck<K extends StartupRejectionKind> {
  readonly kind: K;
  check(context: StartupContext): Promise<readonly Extract<StartupRejection, { kind: K }>[]>;
}

// ---------------------------------------------------------------------------------------------------
// The persisted form: `<runDir>/status.rejection.json`, written by a refused start, read by `status`.

export type RejectionFile = Readonly<{ v: SchemaVersion; at: IsoTime; rejections: readonly StartupRejection[] }>;

const commandProblem: Read<CommandProblem> = tagged('type', {
  'argv0-unresolvable': object((f): CommandProblem => ({ type: f.get('type', literal('argv0-unresolvable')), argv0: f.get('argv0', str) })),
  'env-missing': object((f): CommandProblem => ({ type: f.get('type', literal('env-missing')), name: f.get('name', str) })),
});

type LaneProblem = Extract<StartupRejection, { lane: LaneId }>['problem'];
const laneProblem: Read<LaneProblem> = (value, path) => {
  const probe = object((f) => f.get('type', str))(value, path);
  if (probe === 'estate-lane-for-implementer') return object((f): LaneProblem => ({ type: f.get('type', literal('estate-lane-for-implementer')) }))(value, path);
  return commandProblem(value, path);
};

type Row<K extends StartupRejectionKind> = Extract<StartupRejection, { kind: K }>;
const abs: Read<AbsPath> = (v, p) => absPath(v, p);
const containment = oneOf(['session', 'cgroup'] as const);

const specLaneUnrunnable: Read<Row<'spec-lane-unrunnable'>> = (value, path) => {
  if (typeof value === 'object' && value !== null && Object.hasOwn(value, 'resource')) {
    return object((f): Row<'spec-lane-unrunnable'> => ({
      kind: f.get('kind', literal('spec-lane-unrunnable')), resource: f.get('resource', resourceName),
      command: f.get('command', oneOf(['probe', 'teardown'] as const)), problem: f.get('problem', commandProblem),
    }))(value, path);
  }
  return object((f): Row<'spec-lane-unrunnable'> => ({
    kind: f.get('kind', literal('spec-lane-unrunnable')), unit: f.get('unit', nullable(unitId)), lane: f.get('lane', laneId), problem: f.get('problem', laneProblem),
  }))(value, path);
};

const planProblem: Read<Row<'plan-invalid'>['problem']> = tagged('type', {
  schema: object((f): Row<'plan-invalid'>['problem'] => ({ type: f.get('type', literal('schema')), field: f.get('field', str), detail: f.get('detail', str) })),
  'unknown-spec-path': object((f): Row<'plan-invalid'>['problem'] => ({ type: f.get('type', literal('unknown-spec-path')), unit: f.get('unit', unitId), path: f.get('path', (v, p): PlanPath => planPath(v, p)) })),
  'baseline-not-ancestor': object((f): Row<'plan-invalid'>['problem'] => ({ type: f.get('type', literal('baseline-not-ancestor')), baseline: f.get('baseline', sha), tip: f.get('tip', sha) })),
  'unknown-resource': object((f): Row<'plan-invalid'>['problem'] => ({
    type: f.get('type', literal('unknown-resource')), unit: f.get('unit', nullable(unitId)), lane: f.get('lane', nullable(laneId)), resource: f.get('resource', resourceName),
  })),
});

export const startupRejection: Read<StartupRejection> = tagged<StartupRejectionKind, StartupRejection>('kind', {
  'legacy-roadmap-dir': object((f): StartupRejection => ({ kind: f.get('kind', literal('legacy-roadmap-dir')), path: f.get('path', abs), unexpected: f.get('unexpected', arrayOf(str)) })),
  'worktree-root-unusable': object((f): StartupRejection => ({
    kind: f.get('kind', literal('worktree-root-unusable')), path: f.get('path', abs), problem: f.get('problem', oneOf(['tmpfs', 'not-writable'] as const)), detail: f.get('detail', str),
  })),
  'spec-lane-unrunnable': specLaneUnrunnable,
  'unsupported-routing': object((f): StartupRejection => ({
    kind: f.get('kind', literal('unsupported-routing')), ...seatFields(f),
    layer: f.get('layer', oneOf(['builtin', 'repo-config', 'plan', 'unit'] as const)), class: f.get('class', modelClass), unit: f.get('unit', nullable(unitId)), why: f.get('why', oneOf(['codex-judgment', 'no-prompt'] as const)),
  })),
  'undispositioned-residue': object((f): StartupRejection => ({ kind: f.get('kind', literal('undispositioned-residue')), residues: f.get('residues', arrayOf(residueKey)) })),
  'host-busy': object((f): StartupRejection => ({
    kind: f.get('kind', literal('host-busy')), holder: f.get('holder', oneOf(['owner', 'recovery'] as const)), arc: f.get('arc', arcId),
    generation: f.get('generation', positive), pid: f.get('pid', positive),
  })),
  'previous-arc-unreconciled': object((f): StartupRejection => ({
    kind: f.get('kind', literal('previous-arc-unreconciled')), arc: f.get('arc', arcId), invocations: f.get('invocations', arrayOf(invocationIdOf)),
  })),
  'backend-smoke': object((f): StartupRejection => ({
    kind: f.get('kind', literal('backend-smoke')), profile: f.get('profile', profileName), backend: f.get('backend', backend),
    problem: f.get('problem', oneOf(['missing', 'failed'] as const)), detail: f.get('detail', str),
  })),
  'plan-invalid': object((f): StartupRejection => ({ kind: f.get('kind', literal('plan-invalid')), problem: f.get('problem', planProblem) })),
  'recovery-holder-dead': object((f): StartupRejection => ({ kind: f.get('kind', literal('recovery-holder-dead')), pid: f.get('pid', positive) })),
  'owner-mismatch': object((f): StartupRejection => ({ kind: f.get('kind', literal('owner-mismatch')), detail: f.get('detail', str) })),
  'log-corrupt': object((f): StartupRejection => ({ kind: f.get('kind', literal('log-corrupt')), file: f.get('file', abs), offset: f.get('offset', nat), detail: f.get('detail', str) })),
  'containment-mode-changed': object((f): StartupRejection => ({
    kind: f.get('kind', literal('containment-mode-changed')), recorded: f.get('recorded', containment), detected: f.get('detected', containment),
  })),
});

export const rejectionFile: Read<RejectionFile> = object((f) => {
  const out: RejectionFile = { v: f.get('v', version), at: f.get('at', (v, p): IsoTime => isoTime(v, p)), rejections: f.get('rejections', arrayOf(startupRejection)) };
  if (out.rejections.length === 0) throw new SchemaError(`${f.path}.rejections`, 'at least one rejection', out.rejections);
  return out;
});
