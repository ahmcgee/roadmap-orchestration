// Both profiles share seats; their builder class bindings differ.
import type { ClassTable } from './types.ts';
export const BUILTIN_SEATS: ClassTable = {
  build: { low: 'efficient', med: 'efficient', high: 'frontier' },
  verifier: { low: 'frontier', med: 'frontier', high: 'frontier', escalation: 'frontier' },
  packReview: { arc: 'frontier' },
  experienceVerdict: { arc: 'frontier' }, campaignAudit: { arc: 'summit' },
};
