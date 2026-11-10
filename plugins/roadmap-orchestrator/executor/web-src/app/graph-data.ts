import type { GraphView, ViewEnvelope, Signal } from '../../src/console/view-protocol.ts';
// Rendering inputs only. Geometry and focus use the same ordered nodes/relationships as before.
export function graphData(e:ViewEnvelope<GraphView>) {
  const units=e.data.units.map(u=>({...u,state:stateWords(u.state),stage:stageWords(u.stage)}));
  const milestones=e.data.milestones.map(g=>({...g,units:g.memberIds}));
  const dependencies=e.data.edges.flatMap<{type:'after';unit:string;effective:string}|{type:'milestone';unit:string;milestone:string}>(edge=>edge.kind==='after'?[{type:'after' as const,unit:edge.target,effective:edge.source}]:edge.kind==='milestone'?[{type:'milestone' as const,unit:edge.target,milestone:edge.source.slice(10)}]:[]);
  const edges=e.data.edges.flatMap(edge=>edge.kind==='contingent'?[]:[[edge.source,edge.target] as [string,string]]);
  return {arc:e.arc,revision:e.revision,units,milestones,dependencies,graph:{units:[...units.map(u=>({id:u.id,label:u.id,status:u.signal,meta:u.signal==='withdrawn'?'withdrawn':u.state,word:u.state,finished:u.signal==='pending'&&u.stageFinished})),...milestones.map(g=>({id:`milestone:${g.id}`,label:g.id,status:(g.passed?'passed':g.state==='walking'?'active':g.state==='blocked'?'held':'pending') as Signal,meta:g.state,word:g.passed?'Passed':'Not passed yet',finished:false}))],edges}};
}
// Pure vocabulary, no protocol/server runtime imports.
import { stateWords, stageWords } from '../../src/console/vocabulary.ts';
export type GraphData=ReturnType<typeof graphData>;
