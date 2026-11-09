// D1/D2/D3: cheap display vocabulary; no retained-evidence reads.
import type { WaitingFor } from '../status.ts';
export const stageWords = (stage:string):string => ({'pre-build':'Plan review',build:'Build',lanes:'Checks',gate:'Review',candidate:'Integration check',ff:'Merge',snapshot:'Publish snapshot',retire:'Complete',prepare:'Prepare re-entry',quiesce:'Stop workloads',evidence:'Collect evidence',salvage:'Save changes',teardown:'Release resources',reproduce:'Reproduce finding',verifier:'Review',baseline:'Baseline checks','campaign-audit':'Holistic audit','experience-verdict':'Experience review'}[stage] ?? (stage.startsWith('lane:')?(!stage.slice(5)||stage.slice(5)==='null'?'Checks':`Check: ${stage.slice(5)}`):stage.replaceAll('-',' ')));
export const stateWords = (state:string):string => ({running:'Running',preparing:'Preparing',ready:'Ready',waiting:'Waiting',held:'On hold',blocked:'Blocked',parked:'On hold',merged:'Merged',cut:'Withdrawn',superseded:'Replaced','awaiting-admission':'Waiting',complete:'Complete',holding:'Holding',done:'Done',draining:'Draining',stopping:'Stopping','no-owner':'Stopped',refused:'Refused'}[state] ?? state);
/** A recorded enum, as words: "owner-request" reads "Owner request". */
export const plainWords = (value:string):string => {const words=value.replace(/([a-z])([A-Z])/g,'$1 $2').replaceAll('-',' ').replaceAll('_',' ').toLowerCase();return words.charAt(0).toUpperCase()+words.slice(1);};
export const requestReasonWords = (reason:string):string => ({'attempt-cap':'Retry limit reached','chargeable-bound':'Failure limit reached','base-red':'Baseline checks failing','candidate-red':'Integration check failing','spec-wrong':'Spec needs changing','split-proposal':'Proposed unit split','process-fault':'Process fault','usage-limit':'Usage limit reached','owner-request':'Owner request','env-blocked':'Environment blocked'}[reason] ?? plainWords(reason));
export const activityKindWords = (kind:string):string => ({'stage-outcome':'Stage result','plan-applied':'Plan updated','arc-completed':'Arc completed','stop-completed':'Arc stopped','request-raised':'Question raised','request-acknowledged':'Question answered','audit-started':'Audit started','audit-ended':'Audit finished','finding-opened':'Finding opened','finding-transition':'Finding updated',decision:'Root decision','backend-park':'Backend unavailable','backend-closure':'Backend available again','invocation-started':'Run started','invocation-ended':'Run finished'}[kind] ?? plainWords(kind));
/** The one display word for each status signal, everywhere a status is shown. */
export const signalWords = {passed:'Passed',active:'Running',held:'On hold',failed:'Failed',pending:'Pending',withdrawn:'Withdrawn'} as const;
export const reasonWords = (reason:string):string => ({'cpu-tokens':'CPU capacity','cpu-pressure':'CPU pressure','memory-pressure':'Memory pressure','publication-slot':'Integration slot','admission-hold:base-red':'Baseline hold','admission-hold:dependency':'Dependency','admission-hold:milestone':'Milestone gate','admission-hold:paused':'Paused','admission-hold:host-pressure':'Host pressure'}[reason] ?? reason.replace(/^admission-hold:/,'').replace(/^named-resource:/,'Resource: ').replaceAll('-',' '));
export function waitWords(w:WaitingFor|null):string[] {
 if(!w)return[];
 const out=[...w.deps.map(d=>`Dependency on ${d}`),...w.milestones.map(m=>`Milestone ${m} has not passed`),...w.edges.map(d=>`Waiting for decision ${d}`)];
 for(const a of w.admission){switch(a.type){case 'dependency':out.push(`Dependency on ${a.unit}`);break;case 'milestone':out.push(`Milestone ${a.milestone} has not passed`);break;case 'base-red':out.push('Baseline hold: baseline checks are failing');break;case 'blocking-item':out.push(`Human decision needed: ${a.id}`);break;case 'host-pressure':out.push('Host CPU pressure');break;case 'known-defect':out.push(`Waiting for fix from ${a.fixUnit}`);break;case 'backend-parked':out.push(`${a.backend} is parked`);break;default:out.push(reasonWords(a.type));}}
 if(w.pressureBlocked)out.push('Host CPU or memory pressure');if(w.envBlocked)out.push('Resource environment is unavailable');
 if(w.resources){if(w.resources.publication)out.push('Queued for the integration slot');if(w.resources.cpu)out.push(`Waiting for ${w.resources.cpu} CPU cores`);for(const r of [...w.resources.named,...w.resources.pools])out.push(`Waiting for resource ${r}`);}
 return [...new Set(out)];
}
/** Human display text is separate from the complete agent-facing intent. */
export function shortUnitTitle(intent: string, fallback = 'Untitled unit'): string {
 const heading = /^# ([^\n]+)\n/.exec(intent)?.[1]?.trim();
 const prose = intent
  .replace(/\b(?:contract|spec):[\w:#./-]+/gi, '')
  .replace(/`[^`]+`/g, '')
  .replace(/(?:https?:\/\/|(?:\.?\.?\/)?[\w@*{}.-]+\/)[^\s,;]+/g, '')
  .replace(/\b[\w*-]+\.(?:[cm]?[jt]sx?|json|md|css|html|ya?ml|toml|sh)\b/g, '')
  .replace(/\b(?:[a-z]+(?:[A-Z][a-z0-9]+)+|[a-z0-9]+(?:[_-][a-z0-9]+)+)\b/g, '')
  .split(/(?:[.;!?](?:\s|$)|\n|:\s)/, 1)[0]!
  .replace(/\s+/g, ' ').replace(/^[\s,:–—-]+|[\s,:–—-]+$/g, '').trim();
 const value = heading || prose || fallback;
 // Three condensed lines can carry the complete action and its system/slice.
 // Only genuinely long prose is elided, at the tail rather than in the middle.
 if (value.length <= 96) return value;
 return value.slice(0,95).replace(/\s+\S*$/, '').trimEnd()+'…';
}
