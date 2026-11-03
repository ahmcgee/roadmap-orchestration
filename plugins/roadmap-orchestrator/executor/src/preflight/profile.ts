// A profile is revisioned routing state once a plan is in force.
import type { ProfileName } from '../routing/types.ts';
import type { StartupRejection } from './startup.ts';

export function profileConflict(requested: ProfileName | null, recorded: ProfileName | null): Extract<StartupRejection, { kind: 'profile-conflict' }> | null {
  return requested === null || recorded === null || requested === recorded ? null : {
    kind: 'profile-conflict', requested, recorded,
    detail: `The arc's recorded profile is ${recorded}; --profile ${requested} conflicts. Change the profile with a routing apply.`,
  };
}
