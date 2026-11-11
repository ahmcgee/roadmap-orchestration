// Test-only process isolation for RSS: no fixture generation, browser, HTTP server,
// or projection working set is loaded in this host. It runs the production serve worker and the collector it asks for,
// joined by their own channel as src/console/http.ts joins them; the workers are unchanged.
import { MessageChannel, Worker } from 'node:worker_threads';
const baselineRss=process.memoryUsage().rss;
const args=JSON.parse(process.argv[2]!);
const serve=new Worker(new URL('../../src/console/worker.ts',import.meta.url),{workerData:args});
const collectors=new Map<string,Worker>();
serve.on('message',(m:any)=>{
 if(m.kind==='ready')process.send!({kind:'ready',baselineRss,rss:process.memoryUsage().rss});
 else if(m.kind==='maintain'){const {port1,port2}=new MessageChannel();const c=new Worker(new URL('../../src/console/collector.ts',import.meta.url),{workerData:{run:m.run,hostDir:args.hostDir,common:args.common,port:port1},transferList:[port1]});c.on('message',()=>{});c.on('error',error=>{process.stderr.write(String(error));process.exitCode=1;process.disconnect();});collectors.set(m.arc,c);serve.postMessage({kind:'collector',arc:m.arc,port:port2},[port2]);}
 else if(m.kind==='release'){void collectors.get(m.arc)?.terminate();collectors.delete(m.arc);}
 else if(m.kind==='check-now')collectors.get(m.arc)?.postMessage({kind:'check-now'});
 else if(m.kind==='reply')process.send!({id:m.id,value:JSON.parse(m.json)});
 else if(m.kind==='value'||m.kind==='error')process.send!(m);
});
serve.on('error',error=>{process.stderr.write(String(error));process.exitCode=1;process.disconnect();});
process.on('message',(m:any)=>{if(m.kind==='sample')process.send!({id:m.id,value:{rss:process.memoryUsage().rss,baselineRss}});else serve.postMessage({...m,arrivedAt:Date.now(),patient:true});});
process.on('disconnect',()=>{void Promise.all([serve.terminate(),...[...collectors.values()].map(c=>c.terminate())]).then(()=>process.exit());});
