// A fake forge for tests (M4a step 0b): the stateful fake `gh` (test/fakes/fake-gh.ts) over a JSON store this helper
// seeds and edits between calls. `forge.binDir` goes first on PATH; `forge.read()` is the whole forge; `forge.calls()` is
// every call with the hostname, owner and name it carried.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RepoIdentity } from '../../src/forge/types.ts';
import { type GhCallRecord, type GhPull, type GhStore, STORE_FILE, readGhCalls, readStore, writeStore } from '../fakes/gh-store.ts';
import { writeGhShim } from '../fakes/shim.ts';
import { tmpDir } from './repo.ts';

export const DEFAULT_REPO: RepoIdentity = { host: 'forge.test', owner: 'tidewater', name: 'harbour' };

export type ForgeInit = Readonly<{ repo?: RepoIdentity; originPath?: string }>;

export type Forge = Readonly<{
  dir: string;
  storePath: string;
  binDir: string;
  /** `PATH` with the fake gh first. */
  path: string;
  read(): GhStore;
  calls(): readonly GhCallRecord[];
  /** Rewrite the store. */
  update(edit: (s: GhStore) => GhStore): void;
  /** A PR as `gh pr list` returns it, state OPEN; returns its number. */
  addPull(pull: Readonly<{ head: string; base: string; title?: string; body?: string }>): number;
  /** The PR is merged (mergeCommit `oid`) or closed. */
  setPullState(number: number, state: 'MERGED' | 'CLOSED', oid?: string): void;
}>;

export function makeForge(init: ForgeInit = {}): Forge {
  const dir = tmpDir('forge');
  const storePath = join(dir, STORE_FILE);
  const binDir = join(dir, 'bin');
  mkdirSync(dir, { recursive: true });
  const empty: GhStore = {
    repo: init.repo ?? DEFAULT_REPO, originPath: init.originPath ?? null, nextNumber: 1, pulls: [], mutations: [],
  };
  writeFileSync(storePath, `${JSON.stringify(empty)}\n`);
  writeGhShim(binDir, storePath);
  const update = (edit: (s: GhStore) => GhStore): void => writeStore(storePath, edit(readStore(storePath)));
  return {
    dir, storePath, binDir, path: `${binDir}:${process.env['PATH'] ?? ''}`,
    read: () => readStore(storePath),
    calls: () => readGhCalls(storePath),
    update,
    addPull(pull) {
      let number = 0;
      update((s) => {
        number = s.nextNumber;
        const p: GhPull = {
          number, title: pull.title ?? pull.head, body: pull.body ?? '', state: 'OPEN', url: `https://${s.repo.host}/${s.repo.owner}/${s.repo.name}/pull/${number}`,
          baseRefName: pull.base, headRefName: pull.head, mergeCommit: null, isDraft: false,
        };
        return { ...s, nextNumber: number + 1, pulls: [...s.pulls, p] };
      });
      return number;
    },
    setPullState(number, state, oid) {
      update((s) => {
        if (!s.pulls.some((p) => p.number === number)) throw new Error(`forge: no PR ${number}`);
        return {
          ...s,
          pulls: s.pulls.map((p) => (p.number === number ? { ...p, state, mergeCommit: state === 'MERGED' && oid !== undefined ? { oid } : null } : p)),
        };
      });
    },
  };
}
