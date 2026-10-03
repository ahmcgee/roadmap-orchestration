// The read-only materialisation of a pinned corpus for judges (M4a "Corpus, pin and census" 5): every pinned file
// written from kept bytes under `<runDir>/corpus/<first 8 hex of the pin's sha256>/`, or, for the gate's and the
// build's view without the vision document (M3 R17), under `.../<sha8>.no-vision/`. Content-addressed: an existing
// directory is the same view and is reused. Built in a temp sibling and renamed into place, so a crash leaves no
// partial view. Files are 0444; directories stay writable so the run dir's removal (gc) needs no chmod. Each file's
// bytes must hash to the pin's (fail loud).
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Sha256Hex } from '../core/ids.ts';
import { durableMkdir, durableRename } from '../core/fsx.ts';
import { sha256Hex } from '../core/json.ts';
import { type AbsPath, absPath } from '../core/values.ts';
import type { CorpusFile, CorpusPin } from './types.ts';

export type CorpusView = 'full' | 'without-vision';

export function materialisedDir(runDir: AbsPath, pinSha: Sha256Hex, view: CorpusView): AbsPath {
  return absPath(join(runDir, 'corpus', `${pinSha.slice(0, 8)}${view === 'full' ? '' : '.no-vision'}`));
}

/** The view's directory, written from `bytesOf` (the kept bytes of a pinned file) unless it exists. */
export function materialiseCorpus(runDir: AbsPath, pin: CorpusPin, pinSha: Sha256Hex, view: CorpusView, bytesOf: (file: CorpusFile) => Buffer): AbsPath {
  const dir = materialisedDir(runDir, pinSha, view);
  if (existsSync(dir)) return dir;
  const files = pin.files.filter((f) => view === 'full' || f.path !== pin.vision.path);
  durableMkdir(dirname(dir));
  const temp = `${dir}.${process.pid}.tmp`;
  rmSync(temp, { recursive: true, force: true });
  for (const f of files) {
    const bytes = bytesOf(f);
    if (sha256Hex(bytes) !== f.sha256) throw new Error(`materialiseCorpus: kept bytes of ${f.path} hash to ${sha256Hex(bytes)}, the pin says ${f.sha256}`);
    mkdirSync(dirname(join(temp, f.path)), { recursive: true });
    writeFileSync(join(temp, f.path), bytes, { mode: 0o444 });
  }
  mkdirSync(temp, { recursive: true });
  durableRename(temp, dir);
  return dir;
}
