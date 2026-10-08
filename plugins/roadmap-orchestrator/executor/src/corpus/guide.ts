// The corpus guide (`.roadmap/corpus.md`, R2): agent-facing prose (access, standards) plus exactly one fenced
// `json roadmap-corpus` block naming the source, the include patterns and the vision document. The pin binds the
// guide's bytes (`guideSha256`): any byte change, prose included, is drift.
//
// `corpus pin` reads the guide committed at the product repo's HEAD (K18 requires the working tree's to equal it at
// every start and apply).
import { type Sha256Hex, sha256 } from '../core/ids.ts';
import { sha256Hex } from '../core/json.ts';
import { SchemaError } from '../core/validate.ts';
import type { AbsPath } from '../core/values.ts';
import { gitRun } from '../git/git.ts';
import { CorpusFormatError, fencedBlocks } from './rules.ts';
import { CORPUS_GUIDE_FENCE, CORPUS_GUIDE_FILE, type CorpusGuide, parseCorpusGuide } from './types.ts';

export const CORPUS_GUIDE_PATH = `.roadmap/${CORPUS_GUIDE_FILE}`;

export type ReadGuide = Readonly<{ guide: CorpusGuide; bytes: Buffer; sha256: Sha256Hex }>;

/** The guide in `text`: exactly one `json roadmap-corpus` block whose JSON reads as a guide. */
export function parseGuideText(text: string): CorpusGuide {
  const blocks = fencedBlocks(text, CORPUS_GUIDE_PATH).filter((b) => b.info === CORPUS_GUIDE_FENCE);
  if (blocks.length !== 1) throw new CorpusFormatError(CORPUS_GUIDE_PATH, `${blocks.length} ${CORPUS_GUIDE_FENCE} blocks (exactly one)`);
  let value: unknown;
  try {
    value = JSON.parse(blocks[0]!.body.join('\n'));
  } catch (error) {
    throw new CorpusFormatError(`${CORPUS_GUIDE_PATH}:${blocks[0]!.line}`, `the ${CORPUS_GUIDE_FENCE} block is not JSON: ${(error as Error).message}`);
  }
  try {
    return parseCorpusGuide(value);
  } catch (error) {
    if (error instanceof SchemaError) throw new CorpusFormatError(`${CORPUS_GUIDE_PATH}:${blocks[0]!.line}`, error.message);
    throw error;
  }
}

export function readGuideBytes(bytes: Buffer): ReadGuide {
  return { guide: parseGuideText(bytes.toString('utf8')), bytes, sha256: sha256(sha256Hex(bytes)) };
}

/** The guide committed at `rev` of the product repo, or null when that commit has none (`guide-missing`). */
export function guideAt(repo: AbsPath, rev: string): ReadGuide | null {
  const r = gitRun(repo, ['cat-file', 'blob', `${rev}:${CORPUS_GUIDE_PATH}`], { okCodes: [0, 128] });
  return r.code === 0 ? readGuideBytes(Buffer.from(r.stdout, 'utf8')) : null;
}
