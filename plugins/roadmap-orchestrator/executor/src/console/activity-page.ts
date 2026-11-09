// Lazy enrichment of just the selected page; the retained summary index never reads reports.
import { ConsoleError, type Envelope } from '../observation/protocol.ts';
import { invocationDirName, invocationIdOf } from '../core/ids.ts';
import { record } from '../tui/projection.ts';
import { retainedReport } from './reports.ts';
import { preview } from './views.ts';
import type { ConsoleActivity } from './activity-query.ts';
export function activityPage(e:Envelope,activity:ConsoleActivity,params:Record<string,string>){
  const data=activity.page(e,params),entries=new Map(activity.index(e).entries.map(entry=>[entry.row.id,entry]));
  const invocations=new Map(e.data.display.invocations.map(i=>[invocationDirName(invocationIdOf(i.id)),i]));
  const rows=data.rows.map(row=>{
    if(row.kind!=='stage-outcome'||row.stage!=='gate'||row.outcome!=='revise')return row;
    const titles:string[]=[];
    for(const id of entries.get(row.id)?.invocations??[]){const i=invocations.get(id);if(!i||i.execution!=='agent'||!i.endedAt||Number(id.split('-')[0])>data.page.asOf.highWater)continue;
      const report=retainedReport(e,i.id);
      if(Array.isArray(report?.['findings']))for(const finding of report['findings']){const f=record(finding),title=f['title']??f['what']??f['summary']??f['description'];if(typeof title==='string')titles.push(title);}
    }
    return {...row,summary:preview(`Review sent ${row.subject.id} back: ${titles[0]??'changes requested'}`,row.detail)};
  });
  const result={...data,rows};
  if(Buffer.byteLength(JSON.stringify({...e,data:result})+'\n')>(data.page.limit===100?128:64)*1024)throw new ConsoleError('unavailable','Activity response exceeds its byte ceiling; narrow the range or page size');
  return result;
}
