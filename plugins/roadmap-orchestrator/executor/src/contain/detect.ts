// The containment decision point. M1 builds ship session mode only: cgroup mode (step 3b) is experimental
// (CGROUP_EXPERIMENTAL) and becomes selectable only after its real-kernel test passes on another host. The
// executor records the detected mode as a `containment-mode` fact; a different mode on a later start refuses
// the arc.
import type { Containment } from '../core/interfaces.ts';
import type { ContainmentMode } from '../core/records.ts';
import { CGROUP_EXPERIMENTAL } from './cgroup.ts';
import { sessionContainment } from './session.ts';

export function detectContainmentMode(): ContainmentMode {
  return 'session';
}

export function containmentFor(mode: ContainmentMode): Containment {
  switch (mode) {
    case 'session':
      return sessionContainment;
    case 'cgroup': {
      // The rule lives in CGROUP_EXPERIMENTAL; the `satisfies` ties it to the compiler, so flipping the constant
      // fails to typecheck here until cgroup mode is actually wired in.
      CGROUP_EXPERIMENTAL satisfies true;
      throw new Error('cgroup containment is not selectable in M1 builds: it is experimental pending contain.cgroup-real');
    }
  }
}
