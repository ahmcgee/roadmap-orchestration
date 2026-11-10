// Test-only process isolation for RSS: no fixture generation, browser, HTTP server,
// or projection working set is loaded in this host. Production worker is unchanged.
import { Worker } from 'node:worker_threads';
const baselineRss=process.memoryUsage().rss;
const worker=new Worker(new URL('../../src/console/worker.ts',import.meta.url),{workerData:JSON.parse(process.argv[2]!)});
worker.on('message',m=>{if(m.kind==='ready')process.send!({kind:'ready',baselineRss,rss:process.memoryUsage().rss});else if(m.id!==undefined)process.send!(m);});
worker.on('error',error=>{process.stderr.write(String(error));process.exitCode=1;process.disconnect();});
process.on('message',(m:any)=>{if(m.kind==='sample')process.send!({id:m.id,value:{rss:process.memoryUsage().rss,baselineRss}});else worker.postMessage(m);});
process.on('disconnect',()=>{void worker.terminate().then(()=>process.exit());});
