import assert from 'node:assert/strict';
const { graphLayout, graphCurves, NODE_WIDTH, NODE_HEIGHT, ROW_GAP, COLUMN_GAP } = await import(new URL('../../web-src/app/graph-layout.ts',import.meta.url).href);
import { graphView } from '../../src/console/views.ts';
const {graphData}=await import(new URL('../../web-src/app/graph-data.ts',import.meta.url).href);
type Point = {x:number;y:number};
type GraphEnvelope = import('../../src/observation/protocol.ts').Envelope;
/** Check actual curve geometry, independently of SVG serialization or renderer visibility. */
export function assertGraphGeometry(e: GraphEnvelope) {
  const started=performance.now(), input=graphData({...e,data:graphView(e)}), layout=graphLayout(input), curves=graphCurves(input,layout.positions);
  const expectedEdges:[string,string][] = e.data.display.status.edges.flatMap(edge=>edge.type==='after'?[[edge.effective,edge.unit] as [string,string]]:edge.type==='milestone'?[[`milestone:${edge.milestone}`,edge.unit] as [string,string]]:[]);
  for(const gate of e.data.plan?.milestones??[])for(const id of gate.units)expectedEdges.push([id,`milestone:${gate.id}`]);
  const elapsed=performance.now()-started;
  assert.ok(elapsed<300,`layout and curves took ${elapsed.toFixed(1)}ms`);
  assert.deepEqual(layout.positions,graphLayout(input).positions,'deterministic positions');
  assert.deepEqual(curves,graphCurves(input,layout.positions),'deterministic curves');
  assert.equal(curves.length,expectedEdges.length,'every semantic edge has a curve');
  assert.deepEqual(curves.map((c:{source:string;target:string})=>[c.source,c.target]),expectedEdges,'complete, exact endpoints');
  assert.ok(ROW_GAP>=.6*NODE_HEIGHT);assert.ok(COLUMN_GAP>=1.5*NODE_WIDTH);
  const positions=[...layout.positions] as [string,Point][];
  for(let i=0;i<positions.length;i++)for(let j=i+1;j<positions.length;j++){
    const [a,p]=positions[i]!,[b,q]=positions[j]!,dx=Math.abs(p.x-q.x),dy=Math.abs(p.y-q.y);
    if(dx<1)assert.ok(dy>=NODE_HEIGHT+ROW_GAP-1e-6,`${a}, ${b}: vertical spacing`);
    else assert.ok(dx>=NODE_WIDTH+COLUMN_GAP-1e-6,`${a}, ${b}: column spacing`);
  }
  for(let i=1;i<layout.bands.length;i++)assert.ok(layout.bands[i].x>layout.bands[i-1].x+layout.bands[i-1].width,'milestones stay left to right');
  function yAt(x:number,a:Point,b:Point){
    let low=0,high=1;
    for(let i=0;i<30;i++){const t=(low+high)/2,u=1-t,mid=(a.x+b.x)/2,px=u*u*u*a.x+3*u*u*t*mid+3*u*t*t*mid+t*t*t*b.x;if(px<x)low=t;else high=t;}
    const t=(low+high)/2;return a.y+(b.y-a.y)*(3*t*t-2*t*t*t);
  }
  const localSegments=new Set<string>();
  for(const curve of curves){
    const source=layout.positions.get(curve.source),target=layout.positions.get(curve.target),first=curve.points[0],last=curve.points.at(-1);
    assert.equal(first.x,source.x+NODE_WIDTH/2+3);assert.equal(first.y,source.y);
    assert.equal(last.x,target.x-NODE_WIDTH/2-5);assert.equal(last.y,target.y);
    assert.ok(last.x>first.x,'every dependency advances through milestone/dependency ranks');
    for(let i=1;i<curve.points.length;i++){
      const a=curve.points[i-1],b=curve.points[i];
      assert.ok(b.x>a.x,'curves never turn back toward an outside lane');
      for(const p of [a,b]){
        assert.ok(p.x>=first.x&&p.x<=last.x,'no horizontal detour outside the two endpoints');
        assert.ok(p.y>=Math.min(first.y,last.y)-NODE_HEIGHT&&p.y<=Math.max(first.y,last.y)+NODE_HEIGHT,'no vertical off-region detour');
      }
      for(const [id,p] of positions){
        if(id===curve.source||id===curve.target)continue;
        const left=Math.max(a.x,p.x-NODE_WIDTH/2-2),right=Math.min(b.x,p.x+NODE_WIDTH/2+2);
        if(left>=right)continue;
        const ys=[yAt(left,a,b),yAt(right,a,b)],top=p.y-NODE_HEIGHT/2-2,bottom=p.y+NODE_HEIGHT/2+2;
        assert.ok(Math.max(...ys)<=top||Math.min(...ys)>=bottom,`${curve.source} -> ${curve.target} passes through ${id}`);
      }
    }
    // Local clearance points stay within one card height of the original S at
    // the obstructing rank. They cannot become an above/below-band corridor.
    for(let i=1;i<curve.points.length-1;i+=2){const a=curve.points[i],b=curve.points[i+1];assert.equal(a.y,b.y);assert.ok(Math.abs(a.y-yAt((a.x+b.x)/2,first,last))<=NODE_HEIGHT,'bow stays beside the obstructing unit');const key=[a.x,b.x,a.y].join(':');assert.ok(!localSegments.has(key),'independent bows never share a segment beside a unit');localSegments.add(key);}
  }
  return {elapsed,curves:curves.length};
}
