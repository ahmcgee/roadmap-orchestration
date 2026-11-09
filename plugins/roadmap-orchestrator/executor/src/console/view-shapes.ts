// Pure runtime validators shared by server and browser.
import { CONSOLE_UI_SCHEMA } from './view-protocol.ts';
type Check = (v: unknown) => boolean;
const str: Check = v => typeof v === 'string';
const bool: Check = v => typeof v === 'boolean';
const nat: Check = v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const num: Check = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const date: Check = v => typeof v === 'string' && Number.isFinite(Date.parse(v));
const nullable = (check: Check): Check => v => v === null || check(v);
const array = (check: Check): Check => v => Array.isArray(v) && v.every(check);
function object(fields: Record<string, Check>, optional: Record<string, Check> = {}): Check {
  return v => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const record = v as Record<string, unknown>;
    return Object.keys(record).every(k => Object.hasOwn(fields, k) || Object.hasOwn(optional, k))
      && Object.entries(fields).every(([k, check]) => Object.hasOwn(record, k) && check(record[k]))
      && Object.entries(optional).every(([k, check]) => !Object.hasOwn(record, k) || check(record[k]));
  };
}
const oneOf = (...values: unknown[]): Check => v => values.includes(v);
const dictionary = (check: Check): Check => v => !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(check);
const scope = object({basis: oneOf('current', 'recorded-arc'), from: nullable(date), to: nullable(date)});
const base = {uiSchema: oneOf(CONSOLE_UI_SCHEMA), viewVersion: (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v), scope};
const detail = object({type: oneOf('unit', 'invocation', 'request', 'event', 'resource'), id: str});
const preview = object({text: str, truncated: bool, detail});
export const shellShape = object({...base,
  identity: object({arc: str}), lifecycle: object({state: str, startedAt: nullable(date), endedAt: nullable(date)}),
  progress: object({total: nat, countsByState: dictionary(nat), merged: nat, withdrawn: nat}),
  spend: object({costUsd: num, estimatedCalls: nat, unavailableCalls: nat}),
  attention: object({total: nat, blocking: nat, informational: nat}), availableRange: object({from: nullable(date), to: nullable(date)}),
});
const edge: Check = v => [
  object({kind: oneOf('after'), source: str, target: str, on: str, met: bool}),
  object({kind: oneOf('milestone'), source: str, target: str, passed: bool}),
  object({kind: oneOf('feeds'), source: str, target: str}),
  object({kind: oneOf('contingent'), target: str, edge: str, condition: preview, resolved: bool}),
].some(check => check(v));
export const graphShape = object({...base,
  units: array(object({id: str, title: str, titleTruncated: bool, signal: oneOf('passed', 'active', 'held', 'pending', 'failed', 'withdrawn'), state: str, stage: str, systems: array(str), lineageRef: nullable(str)})),
  milestones: array(object({id: str, state: str, passed: bool, memberIds: array(str)}, {name: str})),
  edges: array(edge), focus: object({activeIds: array(str), firstUncleared: nullable(str)}),
});
const signal=oneOf('passed','active','held','pending','failed','withdrawn');
const money=object({costUsd:nullable(num),recorded:nat,estimated:nat,unavailable:nat});
const subject=object({type:oneOf('unit','arc','job'),id:str,title:str});
const invocation=object({id:str,routeId:str,unit:str,stage:str,attempt:nat,kind:oneOf('agentic','deterministic'),execution:str,status:signal,startedAt:date,label:str,round:nullable(nat),spend:money,subject,systems:array(str),endedAt:nullable(date),outcome:str},{elapsedMs:num,model:str});
const unit=object({id:str,title:str,state:str,stage:str,signal,startedAt:nullable(date),endedAt:nullable(date),arcEndedAt:nullable(date),elapsedMs:nullable(num),attempts:nat,rounds:nat,spend:money,reasons:array(str),waitSince:nullable(date),lineage:nullable(object({reenters:str}))});
const related=object({id:str,title:str,state:str,signal,source:str,target:str,unmet:bool});
const page=(row:Check)=>object({rows:array(row),next:nullable(str),total:nat});
const text=object({text:str,next:nullable(str)});
const gate=object({id:str,name:nullable(str),passed:bool});
const step=object({housekeeping:bool,id:str,stage:str,label:str,attempt:nat,sequence:nat,round:nat,at:date,endedAt:nullable(date),outcome:str,findingTitles:array(str),activities:array(str),notes:array(str)});
export const unitSummaryShape=object({...base,unit});
export const invocationShape=object({...base,invocation,actor:object({role:str,backend:nullable(str),model:nullable(str),requestedModel:nullable(str)}),measured:nullable(object({wallMs:num,runMs:num,waitMs:num})),reservedCpu:nullable(num),related:page(related)});
export const unitShape=object({...base,unit,feeds:array(gate),waits:array(gate),depends:page(related),usedBy:page(related),journey:page(step),invocations:page(invocation),acceptance:page(str),waiting:page(object({at:date,stage:str,totalMs:num,reasons:array(object({reason:str,ms:num}))})),checks:page(object({id:str,outcome:str})),requests:page(object({id:str,summary:str,recommendation:str})),intent:text});
export const milestoneShape=object({...base,id:str,name:nullable(str),state:str,passed:bool,total:nat,merged:nat,members:page(related),intent:text});
export const metadataShape=object({protocol:str,instance:str,repoId:str,arc:str,epoch:str,highWater:nat,revision:nat,observedAt:date,checkedAt:date,uiSchema:oneOf(CONSOLE_UI_SCHEMA),selected:nullable(str),viewVersions:object(Object.fromEntries(['shell','graph','timeline','activity','holistic','effort','resources','attention'].map(k=>[k,base.viewVersion])))},{kind:str});
