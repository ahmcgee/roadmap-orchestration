import { METHOD as testing } from './testing.ts';
import { METHOD as persistence } from './persistence.ts';
import { METHOD as redaction } from './redaction.ts';
import { METHOD as clusterProof } from './cluster-proof.ts';
import { METHOD as ui } from './ui.ts';
import { METHOD as perf } from './perf.ts';
import type { SystemTrait } from '../../input/systems.ts';
export type MethodContext = Readonly<{ traits: readonly SystemTrait[]; markers: readonly string[]; unitKind: string; expensiveLanes: boolean; ui: boolean }>;
export function methodModules(role: 'build' | 'verifier' | 'experience' | 'audit', c: MethodContext): string {
  const modules: readonly (readonly [string, string, boolean])[] = [
    ['testing', testing, true], ['persistence', persistence, c.traits.includes('persistent')],
    ['redaction', redaction, c.traits.includes('redacts')], ['cluster-proof', clusterProof, c.markers.includes('M2')],
    ['ui', ui, role === 'experience' || c.unitKind === 'design' || c.ui], ['perf', perf, c.expensiveLanes],
  ];
  return modules.filter(([, , selected]) => selected).map(([name, body]) => `<method name="${name}">\n${body}\n</method>`).join('\n');
}
