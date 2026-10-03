// The pack review (M4a, OR-Q16; DESIGN §3 Phase 0). Step 0a lands only the required-review key; C3 completes this
// module (scheduling before the first admission, the kept inputs, the hold and supersession).
import { type Sha256Hex, sha256 } from '../core/ids.ts';
import { canonicalJson, sha256Hex } from '../core/json.ts';
import type { PackReviewInputs } from './types.ts';

/**
 * The required-review key (H9, R28): sha256 of the canonical inputs without `job`, which is the review's identity, not
 * an input (with it no completed review could match the next key). Pure; the only place the key is computed.
 */
export function packReviewKey(inputs: PackReviewInputs): Sha256Hex {
  const { job: _job, ...bound } = inputs;
  return sha256(sha256Hex(canonicalJson(bound)));
}
