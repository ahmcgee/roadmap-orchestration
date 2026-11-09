// D2/D3/D4/D7: selected metadata only, with explicit evidence availability.
import { closeSync } from 'node:fs';
import { basename, join } from 'node:path';
import { invocationDir } from '../pipeline/invoke.ts';
import { invocationIdOf, parseInvocationId } from '../core/ids.ts';
import { sha256Hex } from '../core/json.ts';
import { RUNNER_FILE_READERS } from '../core/records.ts';
import { launchSha256 } from '../runner/launch.ts';
import { inputPath } from '../input/inforce.ts';
import { ConsoleError, type Envelope } from '../observation/protocol.ts';
import { openEvidence, readEvidence } from './evidence.ts';
import type { Invocation } from '../tui/types.ts';
import type { Availability } from './detail-protocol.ts';
export function detailAvailability(e:Envelope,i:Invocation) {
 const inv=invocationIdOf(i.id),root=e.data.display.run.runDir,dir=invocationDir(root,inv);
 const probe=(name:string,absent:Availability='unavailable'):Availability=>{try{const fd=openEvidence(root,join(dir,name));closeSync(fd);return 'available';}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return absent;throw error;}};
 const terminal=e.data.events.find(ev=>ev.type==='done'&&ev.kind==='proc.spawn'&&ev.op===parseInvocationId(inv).op);
 let result:Availability=probe('result.json',terminal?.type==='done'&&terminal.kind==='proc.spawn'&&terminal.outcome.kind==='result'?'pruned':'not-recorded');
 if(result==='available'){
  const bytes=readEvidence(root,join(dir,'result.json')),r=RUNNER_FILE_READERS['result.json'](JSON.parse(bytes.toString()),'result.json');
  if(r.inv!==inv||r.op!==parseInvocationId(inv).op||r.arc!==e.arc)throw new ConsoleError('corruption','selected result identity mismatch');
  if(terminal?.type==='done'&&terminal.kind==='proc.spawn'&&terminal.outcome.kind==='result'&&sha256Hex(bytes)!==terminal.outcome.resultSha256)throw new ConsoleError('corruption','selected result digest mismatch');
 }
 let prompt:Availability=i.execution==='agent'?'not-recorded':i.execution==='command'?'not-applicable':'unavailable';
 if(i.execution==='agent'){
  try{
   const launch=RUNNER_FILE_READERS['launch.json'](JSON.parse(readEvidence(root,join(dir,'launch.json')).toString()),'launch.json');
   if(launchSha256(launch)!==i.launchSha256)throw new ConsoleError('corruption','selected launch binding changed');
   const hash=launch.stdinPath?/^([a-f0-9]{64})\.prompt\.txt$/.exec(basename(launch.stdinPath))?.[1]:null;
   if(hash){try{const bytes=readEvidence(root,inputPath(root,hash as any,'prompt.txt'));if(sha256Hex(bytes)!==hash)throw new ConsoleError('corruption','selected prompt digest mismatch');prompt='available';}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')prompt='pruned';else throw error;}}
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')prompt='pruned';else throw error;}
 }
 return {result,prompt,history:i.execution==='agent'?probe('stdout'):i.execution==='command'?'not-applicable' as Availability:'unavailable' as Availability,logs:{stdout:probe('stdout'),stderr:probe('stderr'),runner:probe('runner.log')}};
}
