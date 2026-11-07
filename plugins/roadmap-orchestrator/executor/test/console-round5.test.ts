import assert from 'node:assert/strict';
import {test} from 'node:test';
import {project} from '../src/tui/projection.ts';
import {decodeTranscript,normalize} from '../src/tui/transcript.ts';
test('console structured reports use field-first empty lists while terminal output and literal prose stay unchanged',()=>{
 const report={summary:'Reviewed',blockers:[],notes:[]};
 assert.deepEqual(project(report).map(r=>r.text),['Summary: Reviewed','None recorded: Notes, Blockers']);
 const line=JSON.stringify({type:'result',structured_output:report});
 assert.equal(decodeTranscript(line)[0]!.text,'Summary: Reviewed\nNotes: none recorded\nBlockers: none recorded');
 assert.ok(normalize(line,true).some(s=>s.includes('None recorded: Notes, Blockers')));
 const literal='None recorded: Blockers';assert.equal(decodeTranscript(JSON.stringify({type:'result',result:literal}))[0]!.text,literal);
});
