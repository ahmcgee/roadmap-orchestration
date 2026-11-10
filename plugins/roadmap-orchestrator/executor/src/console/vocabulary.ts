// D1/D2/D3: cheap display vocabulary; no retained-evidence reads.
import type { WaitingFor } from '../status.ts';
import type { Signal } from './view-protocol.ts';
import type { BackendHold } from './activity-protocol.ts';
export const stageWords = (stage:string):string => ({'pre-build':'Plan review',build:'Build',lanes:'Checks',gate:'Review',candidate:'Integration check',ff:'Merge',snapshot:'Publish snapshot',retire:'Complete',prepare:'Prepare re-entry',quiesce:'Stop workloads',evidence:'Collect evidence',salvage:'Save changes',teardown:'Release resources',reproduce:'Reproduce finding',verifier:'Review',baseline:'Baseline checks','campaign-audit':'Holistic audit',campaignAudit:'Holistic audit','experience-verdict':'Experience review',experienceVerdict:'Experience review',packReview:'Plan review'}[stage] ?? (stage.startsWith('lane:')?(!stage.slice(5)||stage.slice(5)==='null'?'Checks':`Check: ${stage.slice(5)}`):plainWords(stage)));
export const stateWords = (state:string):string => ({running:'Running',preparing:'Preparing',ready:'Ready',waiting:'Waiting',held:'On hold',blocked:'Blocked',parked:'On hold',merged:'Merged',cut:'Withdrawn',superseded:'Replaced','awaiting-admission':'Waiting',complete:'Complete',holding:'Holding',done:'Done',draining:'Draining',stopping:'Stopping','no-owner':'Stopped',refused:'Refused'}[state] ?? state);
/** A recorded enum, as words: "owner-request" reads "Owner request". */
export const plainWords = (value:string):string => {const words=value.replace(/([a-z])([A-Z])/g,'$1 $2').replaceAll('-',' ').replaceAll('_',' ').toLowerCase();return words.charAt(0).toUpperCase()+words.slice(1);};
export const requestReasonWords = (reason:string):string => ({'attempt-cap':'Retry limit reached','chargeable-bound':'Failure limit reached','base-red':'Baseline checks failing','candidate-red':'Integration check failing','spec-wrong':'Spec needs changing','split-proposal':'Proposed unit split','process-fault':'Process fault','usage-limit':'Usage limit reached','owner-request':'Owner request','env-blocked':'Environment blocked'}[reason] ?? plainWords(reason));
export const activityKindWords = (kind:string):string => ({'stage-outcome':'Stage result','plan-applied':'Plan updated','arc-completed':'Arc completed','stop-completed':'Arc stopped','request-raised':'Decision requested','request-acknowledged':'Decision answered','audit-started':'Audit started','audit-ended':'Audit finished','finding-opened':'Finding opened','finding-transition':'Finding updated',decision:'Root decision','backend-park':'Backend unavailable','backend-closure':'Backend available again','invocation-started':'Run started','invocation-ended':'Run finished'}[kind] ?? plainWords(kind));
/** A recorded role in words: agents by what they do, command roles as their check ("lane:unit" is "Check: unit"). */
export const roleWords = (role:string):string => ({build:'Builder',verifier:'Reviewer',packReview:'Plan reviewer',experienceVerdict:'Experience reviewer',campaignAudit:'Holistic auditor'} as Record<string,string>)[role] ?? (role.startsWith('lane:')?stageWords(role):plainWords(role));
export const backendWords = (backend:string):string => ({claude:'Claude',codex:'Codex'} as Record<string,string>)[backend] ?? plainWords(backend);
/** The one way an agent is named: role, then model (or backend when no model is recorded). */
export const agentParts = (a:{role:string|null;backend:string|null;model:string|null}):string[] => [a.role?roleWords(a.role):null,a.model??(a.backend?backendWords(a.backend):null)].filter((v):v is string=>v!==null);
export const agentWords = (a:{role:string|null;backend:string|null;model:string|null}):string => agentParts(a).join(', ')||'Not recorded';
/** A recorded result, as words and the status signal it shows: stage results, runs, checks and reviews share it. */
const outcomes:Record<string,[string,Signal]>={running:['Running','active'],started:['Started','active'],pass:['Passed','passed'],green:['Passed','passed'],success:['Succeeded','passed'],approve:['Approved','passed'],published:['Published','passed'],'probe passed':['Probe passed','passed'],
 empty:['No workloads running','passed'],captured:['Evidence captured','passed'],committed:['Changes saved','passed'],'committed-contract-touched':['Changes saved; contract updated','passed'],released:['Resources released','passed'],
 fail:['Failed','failed'],red:['Failed','failed'],'process-fault':['Process fault','failed'],'executor-fault':['Executor fault','failed'],'probe failed':['Probe failed','failed'],'cleanup-failed':['Cleanup failed','failed'],'commit-failed':['Commit failed','failed'],
 revise:['Changes requested','held'],unmerged:['Unmerged changes','held'],'pre-delivery':['Not delivered yet','pending']};
export const outcomeWords = (outcome:string):string => outcomes[outcome]?.[0] ?? plainWords(outcome);
export const outcomeSignal = (outcome:string):Signal => outcomes[outcome]?.[1] ?? 'pending';
/** A run's own result. A run that succeeded only finished: a review's verdict is its stage result, not the run's. */
export const runOutcomeWords = (outcome:string):string => outcome==='success'?'Run finished':outcomeWords(outcome);
/** An audit's result: its judged verdict when recorded (as `status` shows it), else how its job ended. */
export const auditResultWords = (a:{verdict:string|null;outcome:string}):string => a.verdict?({pass:'Pass (no problems found)',revise:'Revise (found problems)',abandoned:'Abandoned'} as Record<string,string>)[a.verdict]??plainWords(a.verdict):a.outcome==='completed'?'Finished':plainWords(a.outcome);
export const decisionKindWords = (kind:string):string => ({ruling:'Ruling',patch:'Patched',reenter:'Re-entered',cut:'Withdrawn',steer:'Steered',divergence:'Divergence',reverse:'Reversed'} as Record<string,string>)[kind] ?? plainWords(kind);
export const ruledByWords = (r:{type:string;role?:string}):string => r.type==='architect'?'Architect':r.type==='judgment'&&r.role?roleWords(r.role):plainWords(r.type);
export const holdClassWords = (c:string):string => ({'usage-limit':'Usage limit','rate-limit':'Rate limit',auth:'Sign-in needed',outage:'Outage'} as Record<string,string>)[c] ?? plainWords(c);
export const closureWords = (h:Pick<BackendHold,'closure'|'terminalAt'>):string => h.closure?h.closure.kind==='park-updated'?'Continued by a later hold':h.closure.kind==='probe'?'Ended by a successful check':'Resumed':h.terminalAt?'Arc ended; no resume recorded':'Still unavailable';
/** A stage as the unit stands in it: "Finished: Review" once that stage's last attempt has ended. */
export const stageStatusWords = (stage:string,finished:boolean):string => finished?`Finished: ${stageWords(stage)}`:stageWords(stage);
const count = (n:number,one:string,many=one+'s') => `${n} ${n===1?one:many}`;
/** How many runs were timed: "1 run, not timed." */
export const timedWords = (c:{measured:number;unmeasured:number}):string => {const n=c.measured+c.unmeasured;return !n?'No runs recorded.':`${count(n,'run')}${c.unmeasured===0?', all timed':c.measured===0?', not timed':`, ${c.unmeasured} not timed`}.`;};
/** How many runs have a known cost: "Cost known for 1 run." */
export const costWords = (c:{recorded:number;estimated:number;unavailable:number}):string => {const parts=[...(c.recorded?[`known for ${count(c.recorded,'run')}`]:[]),...(c.estimated?[`estimated for ${c.estimated}`]:[]),...(c.unavailable?[`missing for ${c.unavailable}`]:[])];return parts.length?`Cost ${parts.join(', ')}.`:'No cost recorded.';};
export const waitCountWords = (c:{measured:number;unmeasured:number}):string => !c.measured&&!c.unmeasured?'No waits measured.':`${count(c.measured,'wait')} measured${c.unmeasured?`, ${c.unmeasured} with no recorded length`:''}.`;
/** State filter choices: one option per display word, sending every recorded state that reads that way. */
export const stateChoices = (states:readonly string[]):{label:string;value:string}[] => {const by=new Map<string,string[]>();for(const s of states)by.set(stateWords(s),[...(by.get(stateWords(s))??[]),s]);return [...by].map(([label,values])=>({label,value:values.join(',')}));};
/** The one display word for each status signal, everywhere a status is shown. */
export const signalWords = {passed:'Passed',active:'Running',held:'On hold',failed:'Failed',pending:'Pending',withdrawn:'Withdrawn'} as const;
export const reasonWords = (reason:string):string => ({'cpu-tokens':'CPU capacity','cpu-pressure':'CPU pressure','memory-pressure':'Memory pressure','publication-slot':'Integration slot','admission-hold:base-red':'Baseline hold','admission-hold:dependency':'Dependency','admission-hold:milestone':'Milestone gate','admission-hold:paused':'Paused','admission-hold:host-pressure':'Host pressure'}[reason] ?? reason.replace(/^admission-hold:/,'').replace(/^named-resource:/,'Resource: ').replaceAll('-',' '));
/** "u32", "u32 and u34", "u32, u34 and u36". */
export const listWords = (items:readonly string[]):string => items.length<2?items.join(''):`${items.slice(0,-1).join(', ')} and ${items.at(-1)}`;
/** What a unit waits for, in words. `milestones` says why each unpassed milestone has not passed (console/milestones.ts). */
export function waitWords(w:WaitingFor|null,milestones:ReadonlyMap<string,string>):string[] {
 if(!w)return[];
 const unpassed=(m:string)=>`Milestone ${m} has not passed${milestones.has(m)?`: ${milestones.get(m)}`:''}`;
 const deps=[...w.deps,...w.admission.flatMap(a=>a.type==='dependency'?[a.unit]:[])],out=[...(deps.length?[`Waiting for ${listWords([...new Set(deps)])}`]:[]),...w.milestones.map(unpassed),...w.edges.map(d=>`Waiting for decision ${d}`)];
 for(const a of w.admission){switch(a.type){case 'dependency':break;case 'milestone':out.push(unpassed(a.milestone));break;case 'base-red':out.push('Baseline hold: baseline checks are failing');break;case 'blocking-item':out.push(`Human decision needed: ${a.id}`);break;case 'host-pressure':out.push('Host CPU pressure');break;case 'known-defect':out.push(`Waiting for fix from ${a.fixUnit}`);break;case 'backend-parked':out.push(`${a.backend} is parked`);break;default:out.push(reasonWords(a.type));}}
 if(w.pressureBlocked)out.push('Host CPU or memory pressure');if(w.envBlocked)out.push('Resource environment is unavailable');
 if(w.resources){if(w.resources.publication)out.push('Queued for the integration slot');if(w.resources.cpu)out.push(`Waiting for ${w.resources.cpu} CPU cores`);for(const r of [...w.resources.named,...w.resources.pools])out.push(`Waiting for resource ${r}`);}
 return [...new Set(out)];
}
/**
 * Human display text is separate from the complete agent-facing intent. Code, paths and identifiers are dropped, except
 * the ids of the arc's own `units` ("Continues u-web-read's work"); a leading ruling reference ("C-356: ...") stays a prefix.
 */
export function shortUnitTitle(intent: string, fallback = 'Untitled unit', units: ReadonlySet<string> = new Set()): string {
 const heading = /^# ([^\n]+)\n/.exec(intent)?.[1]?.trim();
 const kept: string[] = [];
 const restore = (text: string) => text.replace(/\uE000(\d+)\uE001/g, (_, n: string) => kept[Number(n)]!);
 const stripped = intent
  .replace(/`?([A-Za-z0-9][\w.-]*[A-Za-z0-9])`?/g, (match, id: string) => units.has(id) ? `\uE000${kept.push(id) - 1}\uE001` : match)
  .replace(/\b(?:contract|spec):[\w:#./-]+/gi, '')
  .replace(/`[^`]+`/g, '')
  .replace(/(?:https?:\/\/|(?:\.?\.?\/)?[\w@*{}.-]+\/)[^\s,;]+/g, '')
  .replace(/\b[\w*-]+\.(?:[cm]?[jt]sx?|json|md|css|html|ya?ml|toml|sh)\b/g, '')
  .replace(/\b(?:[a-z]+(?:[A-Z][a-z0-9]+)+|[a-z0-9]+(?:[_-][a-z0-9]+)+)\b/g, '');
 const ruling = /^\s*([A-Z][A-Z0-9]*-\d+):\s+/.exec(stripped);
 const first = (ruling ? stripped.slice(ruling[0].length) : stripped).split(/(?:[.;!?](?:\s|$)|\n|:\s)/, 1)[0]!
  .replace(/\s+/g, ' ').replace(/^[\s,:–—-]+|[\s,:–—-]+$/g, '').trim();
 const prose = restore(ruling ? (first ? `${ruling[1]}: ${first}` : ruling[1]!) : first);
 const value = heading || prose || fallback;
 // Three condensed lines can carry the complete action and its system/slice.
 // Only genuinely long prose is elided, at the tail rather than in the middle.
 if (value.length <= 96) return value;
 return value.slice(0,95).replace(/\s+\S*$/, '').trimEnd()+'…';
}
