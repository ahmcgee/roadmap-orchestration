// The startup rejection table as data. Every rejection refuses `start` before any pipeline intent and is
// explained in `status`, so each member carries what its row needs to explain itself, and never a model
// id (a routing refusal names the seat and the layer instead). Step 13 implements one StartupCheck per
// kind; no fs or git here.
import type { ArcId, InvocationId, LaneId, ResourceName, Sha, UnitId } from '../core/ids.ts';
import type { ResidueKey } from '../core/records.ts';
import type { AbsPath, PlanPath } from '../core/values.ts';
import type { PlanM1 } from '../input/plan.ts';
import type { Backend, ProfileName, RiskTier, Role, RoutingLayerName } from '../routing/types.ts';

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
    problem:
      | Readonly<{ type: 'argv0-unresolvable'; argv0: string }>
      | Readonly<{ type: 'env-missing'; name: string }>
      | Readonly<{ type: 'estate-lane-for-implementer' }>;
  }>
  // Row: a role resolving to an unsupported triple (including every Codex judgment triple).
  | Readonly<{ kind: 'unsupported-routing'; role: Role; tier: RiskTier; layer: RoutingLayerName; unit: UnitId | null; why: 'codex-judgment' | 'no-prompt' }>
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
