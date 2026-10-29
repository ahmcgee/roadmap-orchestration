// The recorded basis of a CPU reservation, independent of plans and lane identity.
import { type Sha256Hex, sha256 } from './ids.ts';
import { type Read, literal, nat, object, positive, tagged } from './validate.ts';

export type CpuBasis =
  | Readonly<{ kind: 'explicit'; value: number }>
  | Readonly<{ kind: 'default'; key: Sha256Hex; value: number; samples: number }>
  | Readonly<{ kind: 'calibrated'; key: Sha256Hex; value: number; samples: number }>;

const measuredBasis = (kind: 'default' | 'calibrated'): Read<CpuBasis> => object((f) => ({
  kind: f.get('kind', literal(kind)), key: f.get('key', sha256), value: f.get('value', positive), samples: f.get('samples', nat),
}));
export const cpuBasis: Read<CpuBasis> = tagged('kind', {
  explicit: object((f) => ({ kind: f.get('kind', literal('explicit')), value: f.get('value', positive) })),
  default: measuredBasis('default'), calibrated: measuredBasis('calibrated'),
});
