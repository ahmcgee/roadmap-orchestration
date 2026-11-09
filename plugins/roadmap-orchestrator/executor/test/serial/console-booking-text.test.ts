import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {serveConsole} from '../../src/console/http.ts';
import {gitCommonDir} from '../../src/git/git.ts';
import {absPath} from '../../src/core/values.ts';
import {opKey,unitId,resourceUnit} from '../../src/core/ids.ts';
import {investigationFixture} from '../fixtures/console-investigations.ts';
import {ConsoleBrowser} from '../helpers/console-browser.ts';
import {tmpDir} from '../helpers/repo.ts';
import {until} from '../fixtures/exec-common.ts';
test('short resource holds display integer milliseconds instead of subtraction artifacts',{timeout:30000},async t=>{
 const f=await investigationFixture();t.after(()=>f.close());
 const origin=Date.parse(JSON.parse(readFileSync(f.runDir+'/events.jsonl','utf8').split('\n')[0]!).at);
 const holder={type:'stage' as const,unit:unitId('u1'),stage:'build' as const,attempt:1};
 // Both records have exact integer-ms timestamps; their seconds-based display projection does not.
 t.mock.timers.enable({apis:['Date'],now:origin+1284});
 const reserve=f.journal.begin({kind:'resource.transition',key:opKey('short-hold'),parent:{type:'arc'},deadlineAt:null,body:()=>({expect:{holder,resources:[resourceUnit('short-slot')],edge:{type:'reserve'},waited:{totalMs:0,byReasonMs:{}}},post:null})});f.journal.done(reserve.op,'resource.transition',{kind:'transitioned'},null);
 t.mock.timers.tick(805);
 const clean=f.journal.begin({kind:'resource.transition',key:opKey('short-clean'),parent:{type:'arc'},deadlineAt:null,body:()=>({expect:{holder,resources:[resourceUnit('short-slot')],edge:{type:'clean',from:'reserved'}},post:null})});f.journal.done(clean.op,'resource.transition',{kind:'transitioned'},null);
 const release=f.journal.begin({kind:'resource.transition',key:opKey('short-release'),parent:{type:'arc'},deadlineAt:null,body:()=>({expect:{holder,resources:[resourceUnit('short-slot')],edge:{type:'release'}},post:null})});f.journal.done(release.op,'resource.transition',{kind:'transitioned'},null);t.mock.timers.reset();
 const s=await serveConsole({repo:absPath(f.d.repo),common:gitCommonDir(absPath(f.d.repo)),hostDir:f.hostDir,host:'127.0.0.1',port:0});const b=new ConsoleBrowser(tmpDir('console-booking-text'));t.after(async()=>{await b.close();await s.close();});await b.initialize();await b.call('browser_navigate',{url:s.url});
 await until(async()=>/Connected/.test(await b.evaluate<string>('()=>document.body.innerText')),10000,'overview');
 const snapshot=await b.call('browser_snapshot',{}),line=snapshot.split('\n').find(l=>l.includes('link "Resources"'))!;assert.ok(line);await b.call('browser_click',{element:'Resources',target:/\[ref=(\w+)\]/.exec(line)![1]});
 await b.evaluate(`()=>{location.hash='#/arcs/${f.arc}/resources?from=${new Date(origin).toISOString()}&to=${new Date(origin+3000).toISOString()}';return true;}`);
 await until(async()=>/Resource booking details/.test(await b.evaluate<string>('()=>document.body.innerText')),10000,'recorded hold');
 const cells=await b.evaluate<string[]>('()=>[...[...document.querySelectorAll("table[aria-label=\\"Resource bookings\\"] tbody tr")].find(r=>r.cells[0].textContent==="short-slot").cells].map(c=>c.textContent)');assert.equal(cells[0],'short-slot');assert.match(cells[1]!,/^u1 /);assert.equal(cells[2],'done');assert.equal(cells[3],'1s');assert.equal(cells[4],'805 ms');assert.doesNotMatch(cells.join(' '),/\d+\.\d+ ms/);
});
