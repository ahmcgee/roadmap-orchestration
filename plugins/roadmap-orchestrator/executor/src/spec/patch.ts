// SpecPatch application and the `spec.patch` file op. Plan-check redirects are the only M1 source of
// patches (§2.7), besides the executor appending the implementer's decisions. `applySpecPatch` is pure; the
// op records `{path, oldSha256, expectRev, patch}` and the expected `{newSha256, newRev}` before it writes,
// so recovery decides by the kept spec bytes alone.
import { existsSync, readFileSync } from 'node:fs';
import { crashPoint } from '../core/crash.ts';
import type { IntentOf, OpOutcome } from '../core/events.ts';
import { type ClauseId, type LaneId, type Sha256Hex, specRev } from '../core/ids.ts';
import type { IntentBody, Reconciler } from '../core/interfaces.ts';
import type { SpecM1, SpecPatch, SpecPatchOp, SpecSection } from '../core/records.ts';
import type { AbsPath } from '../core/values.ts';
import { reconcileSpecPatch } from '../recover/spec.ts';
import { SPEC_INPUT, keepInput, keptInput } from '../input/inforce.ts';
import { bytesSha256, fileSha256, parseSpec, specBytes, writeSpec } from './spec.ts';

export class SpecPatchStaleError extends Error {
  readonly expectRev: number;
  readonly actualRev: number;
  constructor(expectRev: number, actualRev: number) {
    super(`spec patch expects rev ${expectRev}, but the spec is at rev ${actualRev}`);
    this.name = 'SpecPatchStaleError';
    this.expectRev = expectRev;
    this.actualRev = actualRev;
  }
}

/**
 * Why one op of a patch was refused. Ids are never reused (`id-reused`); an op may only touch an item
 * that exists (`unknown-id`) in the section it names (`wrong-section`); only active items can be replaced
 * or deferred (`not-active`), and a struck item stays struck (`already-struck`).
 */
export type SpecPatchRefusal = 'id-reused' | 'unknown-id' | 'wrong-section' | 'not-active' | 'already-struck';

export class SpecPatchOpError extends Error {
  readonly index: number;
  readonly reason: SpecPatchRefusal;
  readonly id: string;
  constructor(index: number, reason: SpecPatchRefusal, id: string) {
    super(`spec patch op ${index} refused (${reason}) for item ${id}`);
    this.name = 'SpecPatchOpError';
    this.index = index;
    this.reason = reason;
    this.id = id;
  }
}

type Item = SpecM1[SpecSection][number];
type Sections = Record<SpecSection, Item[]>;
type Located = Readonly<{ section: SpecSection; index: number; item: Item }>;

function locate(sections: Sections, id: LaneId | ClauseId): Located | null {
  for (const section of Object.keys(sections) as SpecSection[]) {
    const index = sections[section].findIndex((i) => i.id === id);
    if (index !== -1) return { section, index, item: sections[section][index]! };
  }
  return null;
}

type ItemOp = Exclude<SpecPatchOp, Readonly<{ op: 'cite' }>>;

function applyOp(sections: Sections, op: ItemOp, index: number): void {
  const id = op.op === 'add' || op.op === 'replace' ? op.item.id : op.id;
  const at = locate(sections, id);
  const refuse = (reason: SpecPatchRefusal): never => {
    throw new SpecPatchOpError(index, reason, id);
  };
  switch (op.op) {
    case 'add':
      if (at !== null) refuse('id-reused');
      sections[op.section].push({ ...op.item, state: 'active' });
      return;
    case 'replace':
      if (at === null) return refuse('unknown-id');
      if (at.section !== op.section) refuse('wrong-section');
      if (at.item.state !== 'active') refuse('not-active');
      sections[op.section][at.index] = { ...op.item, state: 'active' };
      return;
    case 'strike':
      if (at === null) return refuse('unknown-id');
      if (at.item.state === 'struck') refuse('already-struck');
      sections[at.section][at.index] = { ...at.item, state: 'struck' };
      return;
    case 'defer':
      if (at === null) return refuse('unknown-id');
      if (at.item.state !== 'active') refuse('not-active');
      sections[at.section][at.index] = { ...at.item, state: 'deferred' };
      return;
  }
}

/** The union of two id lists, sorted: cites only grow, and a repeated cite is already there. */
const union = <T extends string>(a: readonly T[], b: readonly T[]): readonly T[] => [...new Set([...a, ...b])].sort();

/**
 * Applies every op in order and returns the spec at `expectRev + 1`, or throws without partial effect.
 * Strike and defer change an item's state and never remove it; `cite` adds to the cites, and nothing
 * removes one. Scope and resources have no op: the `SpecPatchOp` type and its validator do not admit
 * them, so a patch naming them never reaches here. Whether a cite names a plan contract and a ledger
 * ruling is the caller's check (the plan and ledger are not the spec's).
 */
export function applySpecPatch(spec: SpecM1, patch: SpecPatch): SpecM1 {
  if (patch.expectRev !== spec.rev) throw new SpecPatchStaleError(patch.expectRev, spec.rev);
  const sections: Sections = {
    lanes: [...spec.lanes],
    acceptance: [...spec.acceptance],
    decisions: [...spec.decisions],
    facts: [...spec.facts],
  };
  let cites = spec.cites;
  patch.ops.forEach((op, i) => {
    if (op.op === 'cite') cites = { contracts: union(cites.contracts, op.contracts), rulings: union(cites.rulings, op.rulings) };
    else applyOp(sections, op, i);
  });
  // Each add and replace put an item of its own section's type into that section.
  return {
    ...spec,
    rev: specRev(spec.rev + 1),
    lanes: sections.lanes as SpecM1['lanes'],
    acceptance: sections.acceptance as SpecM1['acceptance'],
    decisions: sections.decisions as SpecM1['decisions'],
    facts: sections.facts as SpecM1['facts'],
    cites,
  };
}

/** `path`: the unit's spec file; `oldSha256`: the spec in force the patch applies to (its kept bytes). */
export type SpecPatchRequest = Readonly<{ path: AbsPath; oldSha256: Sha256Hex; patch: SpecPatch }>;

export class SpecPatchPostconditionError extends Error {
  constructor(path: AbsPath, detail: string) {
    super(`spec.patch on ${path}: ${detail}`);
    this.name = 'SpecPatchPostconditionError';
  }
}

/** The bytes of the spec a patch applies to: kept in the run dir, or the live file while it still hashes to them. */
function oldBytes(runDir: AbsPath, path: AbsPath, oldSha256: Sha256Hex): Buffer | null {
  const kept = keptInput(runDir, oldSha256, SPEC_INPUT);
  if (kept !== null) return kept;
  return existsSync(path) && fileSha256(path) === oldSha256 ? readFileSync(path) : null;
}

/** The patched spec, from the old spec's bytes; throws when they are gone. */
function patchedSpec(runDir: AbsPath, path: AbsPath, oldSha256: Sha256Hex, patch: SpecPatch): SpecM1 {
  const bytes = oldBytes(runDir, path, oldSha256);
  if (bytes === null) throw new SpecPatchPostconditionError(path, `the old spec ${oldSha256} is neither kept in the run dir nor the file's content`);
  return applySpecPatch(parseSpec(bytes, path), patch);
}

/**
 * The `spec.patch` op of a run dir, shaped like `GitOp` (which is typed to git kinds only). The spec in force
 * is kept content-addressed (`inputs/<sha256>.spec.json`), so the patch reads the old spec from there and
 * keeps the new one there: that is the op's effect and its postcondition. The unit's spec file is rewritten
 * too while it still holds the old spec, so the architect edits the patched revision; a file the architect
 * has changed since (an edit not applied yet) is left alone. `prepare` computes every recorded value; `act`
 * recomputes the same bytes from the intent (so a redo needs nothing but the intent) and writes them durably;
 * `verify` re-hashes the kept bytes.
 */
export function specPatchOp(runDir: AbsPath): Readonly<{
  kind: 'spec.patch';
  prepare(request: SpecPatchRequest): Promise<IntentBody<'spec.patch'>>;
  act(intent: IntentOf<'spec.patch'>): Promise<void>;
  verify(intent: IntentOf<'spec.patch'>): Promise<OpOutcome['spec.patch']>;
  reconcile: Reconciler<'spec.patch'>;
}> {
  return {
    kind: 'spec.patch',

    async prepare({ path, oldSha256, patch }) {
      const next = patchedSpec(runDir, path, oldSha256, patch);
      return {
        expect: { path, oldSha256, expectRev: patch.expectRev, patch },
        post: { newSha256: bytesSha256(specBytes(next)), newRev: next.rev },
      };
    },

    async act(intent) {
      const { path, oldSha256, patch } = intent.expect;
      const next = patchedSpec(runDir, path, oldSha256, patch);
      const bytes = specBytes(next);
      const actual = bytesSha256(bytes);
      if (actual !== intent.post.newSha256) {
        throw new SpecPatchPostconditionError(path, `patched bytes hash to ${actual}, the intent expects ${intent.post.newSha256}`);
      }
      crashPoint('spec.patch.before-write');
      if (existsSync(path) && fileSha256(path) === oldSha256) writeSpec(path, next);
      keepInput(runDir, bytes, SPEC_INPUT);
      crashPoint('spec.patch.after-write');
    },

    async verify(intent) {
      if (keptInput(runDir, intent.post.newSha256, SPEC_INPUT) === null) {
        throw new SpecPatchPostconditionError(intent.expect.path, `the patched spec ${intent.post.newSha256} was not kept, as expected`);
      }
      return { kind: 'patched' };
    },

    reconcile: reconcileSpecPatch(runDir),
  };
}
