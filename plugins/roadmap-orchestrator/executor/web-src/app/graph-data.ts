import type { GraphView, ViewEnvelope, Signal } from '../../src/console/view-protocol.ts';
// Rendering inputs only. Geometry and focus use the same ordered nodes/relationships as before.
// dev.81 (D2): withdrawn units (superseded or cut) are hidden unless `showWithdrawn`. Hidden, a withdrawn unit is dropped
// and every edge with an end at it is re-pointed to its successor (`supersededBy`, else a cut unit's first carrier,
// transitively to a live unit), or dropped when it has none; band membership is unchanged. Shown, each keeps its own band
// and `successor` names the unit the layout places it immediately before. `hiddenWithdrawn` counts what is dropped.
export function graphData(e:ViewEnvelope<GraphView>,showWithdrawn=false) {
  const all=new Map(e.data.units.map(u=>[u.id,u]));
  const successorOf=(id:string)=>{const u=all.get(id)!;return u.supersededBy??u.carriedBy[0]??null;};
  const withdrawn=new Set(e.data.units.filter(u=>u.signal==='withdrawn').map(u=>u.id));
  const hidden=showWithdrawn?new Set<string>():withdrawn;
  /** What an edge end at `id` shows: itself, its live successor when it is hidden, or null (the edge is dropped). */
  const live=(id:string):string|null=>{let at:string|null=id;for(const seen=new Set<string>();at!==null&&hidden.has(at);at=successorOf(at)){if(seen.has(at))throw new Error(`withdrawn units succeed each other in a cycle through ${at}`);seen.add(at);}return at;};
  // dev.82: a unit the endgame took over says so: handed over to the architect, sent back in, or closed by a fix.
  const word=(u:GraphView['units'][number])=>u.endgame?.relation==='handed-over'?'Handed over':u.endgame?.relation==='closed'?`Closed by fix ${u.endgame.commit?.slice(0,10)??''}`.trim():u.endgame?.relation==='released'?`Resumed: ${stateWords(u.state)}`:stateWords(u.state);
  const units=e.data.units.filter(u=>!hidden.has(u.id)).map(u=>({...u,state:word(u),stage:stageWords(u.stage),successor:withdrawn.has(u.id)&&!hidden.has(u.id)?successorOf(u.id):null}));
  const milestones=e.data.milestones.map(g=>({...g,units:g.memberIds.filter(id=>!hidden.has(id))}));
  // A group's counts are its own units', hidden ones included (as a milestone's are its membership's): `ids` what is drawn.
  const counts=(ids:string[])=>{const live=ids.filter(id=>!withdrawn.has(id));return {passed:live.filter(id=>all.get(id)!.signal==='passed').length,total:live.length,withdrawn:ids.length-live.length};};
  const groups=e.data.groups.map(g=>({...g,...counts(g.ids),ids:g.ids.filter(id=>!hidden.has(id))})).filter(g=>g.ids.length>0);
  const end=(id:string)=>id.startsWith('milestone:')?id:live(id);
  // A re-pointed edge that duplicates one already drawn is drawn once.
  const key=(kind:string,source:string,target:string)=>`${kind}|${source}|${target}`;
  const seen=new Set(e.data.edges.flatMap(edge=>edge.kind==='contingent'?[]:[key(edge.kind,edge.source,edge.target)]));
  const shown=e.data.edges.flatMap(edge=>{
    if(edge.kind==='contingent')return [];
    const source=end(edge.source),target=end(edge.target);
    if(source===edge.source&&target===edge.target)return [edge];
    if(source===null||target===null||source===target||seen.has(key(edge.kind,source,target)))return [];
    seen.add(key(edge.kind,source,target));return [{...edge,source,target}];
  });
  const dependencies=shown.flatMap<{type:'after';unit:string;effective:string}|{type:'milestone';unit:string;milestone:string}>(edge=>edge.kind==='after'?[{type:'after' as const,unit:edge.target,effective:edge.source}]:edge.kind==='milestone'?[{type:'milestone' as const,unit:edge.target,milestone:edge.source.slice(10)}]:[]);
  const edges=shown.map(edge=>[edge.source,edge.target] as [string,string]);
  return {arc:e.arc,revision:e.revision,units,milestones,groups,noMilestone:e.data.noMilestone,hiddenWithdrawn:hidden.size,withdrawn:withdrawn.size,dependencies,graph:{units:[...units.map(u=>({id:u.id,label:u.id,status:u.signal,meta:u.signal==='withdrawn'&&u.endgame?.relation!=='closed'?'withdrawn':u.state,word:u.state,finished:u.signal==='pending'&&u.stageFinished})),...milestones.map(g=>({id:`milestone:${g.id}`,label:g.id,status:g.signal,meta:g.state,word:g.passed?'Passed':'Not passed yet',finished:false}))],edges}};
}
// Pure vocabulary, no protocol/server runtime imports.
import { stateWords, stageWords } from '../../src/console/vocabulary.ts';
export type GraphData=ReturnType<typeof graphData>;
