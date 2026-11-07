/**
 * Deterministic console scale fixture; no paid backend or executor is started.
 * From executor/: node test/helpers/scale-arc.ts <outDir> [--units 300] [--days 7] [--seed console-week] [--live]
 * Creates <outDir>/repo (outDir must be empty), retained production records and manifest.json;
 * prints the repo path to stdout. Then: bin/roadmap console start --repo <printed path>
 * --live owns the fixture and appends one paired stream-json event every 4 seconds,
 * stopping after two hours (or SIGINT/SIGTERM). Console configuration defaults to
 * 0.0.0.0:4749. Live mode claims the normal host lease so the CLI console sees it.
 * An existing live executor is never displaced. The historical anchor is fixed; --live appends at actual wall time.
 * Serial helper: generation temporarily scopes Date and git commit dates, restored in finally.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { readRepoConfig } from '../../src/preflight/checks.ts';
import { setupCorpusArc } from '../fixtures/corpus-unit.ts';
import { contextFor } from '../fixtures/unit-common.ts';
import { milestoneJson } from '../fixtures/walk-common.ts';
import { makeForge } from './forge.ts';
import type { GhPull } from '../fakes/gh-store.ts';
import { git } from './repo.ts';
import { arcId, commandId, cpuToken, type ResourceUnit, edgeId, findingId, implementerSessionId, invocationDirName, jobId, judgmentSessionId, laneId, milestoneId, obligationId, opKey, planRev, sha, sha256, specRev, unitId, visionClauseId, INTEGRATION_SLOT } from '../../src/core/ids.ts';
import { absPath, isoTime, repoPath } from '../../src/core/values.ts';
import { sha256Hex } from '../../src/core/json.ts';
import type { JsonValue } from '../../src/core/json.ts';
import type { Parent, Holder } from '../../src/core/events.ts';
import type { LaunchFile, ResultFile, Stage } from '../../src/core/records.ts';
import { pinDispatch } from '../../src/pipeline/dispatch.ts';
import { at, start, record } from '../../src/pipeline/stages.ts';
import { invocationDir } from '../../src/pipeline/invoke.ts';
import { runnerFiles } from '../../src/runner/files.ts';
import { launchSha256 } from '../../src/runner/launch.ts';
import { commitRevisionNow, inputPath, keepInput, keptPayload, requirePlanInForce, specShaInForce } from '../../src/input/inforce.ts';
import { raiseNeedsUser } from '../../src/needsuser.ts';
import { claimHost, releaseHost } from '../../src/host/lock.ts';
import { publishOwner } from '../../src/host/owner.ts';
import { selfIdentity } from '../../src/host/liveness.ts';
import { HOST_DIR, openHostDir } from '../../src/host/hostdir.ts';

export type ScaleOptions = { units?: number; days?: number; seed?: string };
export const SCALE_NOW = '2026-11-07T20:00:00.000Z';
const DAY = 86_400_000;
const SYSTEMS = ['identity', 'catalog', 'booking', 'billing', 'notifications', 'search', 'analytics', 'operations'];
const FEATURES = ['idempotent command ingestion', 'cursor pagination contract', 'tenant isolation boundary', 'retry-safe outbox delivery', 'optimistic concurrency checks', 'migration compatibility', 'retention policy enforcement', 'structured failure diagnostics'];
export type ScaleManifest = {
  arc: string; repo: string; runDir: string; hostDir: string; seed: string; days: number; now: string; startedAt: string;
  units: number; systems: string[]; milestones: number; passedMilestones: number; dependencies: number; contingentEdges: number;
  invocations: number; agentInvocations: number; attempts: number; stageAttempts: number; buildRounds: Record<string, number>; live: { unit: string; stage: string; routeId: string; transcript: string }[];
  merged: number; withdrawn: number; parked: number; openAttention: number; ackedAttention: number; costUsd: number; events: number;
};

function random(seed: string) {
  let n = parseInt(sha256Hex(seed).slice(0, 8), 16);
  return () => { n ^= n << 13; n ^= n >>> 17; n ^= n << 5; return (n >>> 0) / 0x100000000; };
}
function historicalClock(initial: number) {
  const Original = Date; let clock = initial;
  globalThis.Date = new Proxy(Original, {
    construct(target, args) { return Reflect.construct(target, args.length ? args : [clock]); },
    apply() { return new Original(clock).toString(); },
    get(target, key, receiver) { return key === 'now' ? () => clock : Reflect.get(target, key, receiver); },
  });
  return { set(value: number) { clock = value; }, restore() { globalThis.Date = Original; } };
}
function intent(i: number) {
  const system = SYSTEMS[(i - 1) % SYSTEMS.length]!;
  const feature = FEATURES[Math.floor((i - 1) / SYSTEMS.length) % FEATURES.length]!;
  return `Implement ${feature} for the ${system} system, slice ${i}. Read src/${system}/service.ts, src/${system}/repository.ts and test/${system}/contract.test.ts before editing. Preserve the request/response envelopes in contracts/${system}.md §3.2 and the tenant-scoped transaction boundary in docs/architecture/${system}.md §4. Every accepted command must have one durable effect even when the caller retries after a timeout; reject stale versions with the documented conflict code and preserve the original correlation ID. Add acceptance coverage for an empty page, a duplicate delivery, a cancelled request, and an interleaving of two tenants. Follow ruling C-1 and obligation I-1; cite the relevant file and line in your final report. Run the local contract lane, the migration compatibility lane and the integration witness after your last edit. Keep public exports stable, retain the existing telemetry fields, and explain any remaining uncertainty with concrete evidence. Coordinate the shared outbox and billing boundaries through the recorded dependencies; do not infer that a queued prerequisite has already shipped.`;
}

export async function generateScaleArc(outDir: string, options: ScaleOptions = {}) {
  const count = options.units ?? 300, days = options.days ?? 7, seed = options.seed ?? 'console-week';
  if (!Number.isInteger(count) || count < 40 || count > 2000) throw new Error('--units must be an integer between 40 and 2000');
  if (!Number.isFinite(days) || days < 1 || days > 60) throw new Error('--days must be between 1 and 60');
  const out = resolve(outDir);
  if (existsSync(out) && readdirSync(out).length) throw new Error(`Refusing nonempty output directory: ${out}`);
  mkdirSync(out, { recursive: true });
  const now = Date.parse(SCALE_NOW), origin = now - days * DAY - 3_600_000;
  const rng = random(seed), arc = arcId(`scale-${sha256Hex(`${seed}:${count}:${days}`).slice(0, 12)}`);
  const repo = join(out, 'repo'), planDir = join(out, 'plan'), runDir = absPath(join(repo, '.git', 'roadmap-runtime', arc)), hostDir = absPath(join(out, 'host'));
  const clock = historicalClock(origin);
  const oldDates = [process.env['GIT_AUTHOR_DATE'], process.env['GIT_COMMITTER_DATE']];
  process.env['GIT_AUTHOR_DATE'] = process.env['GIT_COMMITTER_DATE'] = new Date(origin).toISOString();
  let closeJournal: (() => void) | undefined;
  try {
    // Same corpus/plan/spec initialization as investigationFixture, relocated before any journal write.
    const config = { webConsole: { host: '0.0.0.0', port: 4749 }, systemsMap: { systems: Object.fromEntries(SYSTEMS.map(s => [s, { paths: [`src/${s}/**`, `test/${s}/**`, `contracts/${s}.md`] }])) } };
    const base = await setupCorpusArc([], { ...config, units: Array.from({ length: count }, (_, i) => ({ id: `u${i + 1}` })) });
    cpSync(base.d.repo, repo, { recursive: true }); cpSync(dirname(base.d.planPath), planDir, { recursive: true });
    for (const file of readdirSync(planDir)) if (file.endsWith('.json')) {
      const path = join(planDir, file);
      writeFileSync(path, readFileSync(path, 'utf8').replaceAll(dirname(base.d.planPath), planDir).replaceAll(base.d.repo, repo));
    }

    writeFileSync(join(repo, '.roadmap', 'config.json'), JSON.stringify(config));
    const planPath = join(planDir, 'plan.json'), plan = JSON.parse(readFileSync(planPath, 'utf8'));
    plan.arc = arc; plan.direction = 'Deliver the tenant-safe booking platform in ten verified release gates.'; plan.worktreeRoot = join(out, 'worktrees');
    const merged = Math.round(count * .55), withdrawn = Math.max(2, Math.round(count * .04)), parkedCount = Math.max(2, Math.round(count * .04));
    const reentryParent = merged + 1;
    for (let i = 1; i <= count; i++) {
      const u = plan.units[i - 1]; u.systems = [SYSTEMS[(i - 1) % 8]];
      // A long same-system chain, cross-system layers, and periodic fan-in/fan-out hubs.
      const after = new Set<number>();
      if (i > 8) after.add(i - 8);
      if (i > 16 && i % 8 === 1) for (let k = 1; k <= 8; k++) after.add(i - k);
      if (i > 16 && i % 8 !== 1) after.add(Math.floor((i - 1) / 8) * 8 - 7);
      u.after = [...after].sort((a,b) => a-b).map(n => `u${n}`);
      if (i > merged + 12 && i % 29 === 0) u.contingent = [{ id: `e-${i}`, condition: `Owner confirms ${u.systems[0]} migration window and rollback drill.` }];
      if (i === merged + 2) u.after = ['u8'];
      if (i > Math.floor(count*.71) && i < count-withdrawn) u.after = [`u${8 + i % Math.max(1,merged-8)}`];
      const specPath = join(planDir, `u${i}.json`), spec = JSON.parse(readFileSync(specPath, 'utf8'));
      spec.intent = intent(i); spec.acceptance[0].clause = `${u.systems[0]}: ${FEATURES[Math.floor((i-1)/8)%8]} preserves contract §3.2 (slice ${i}). Requests handled by src/${u.systems[0]}/service.ts and src/${u.systems[0]}/repository.ts must retain the tenant-scoped transaction boundary from docs/architecture/${u.systems[0]}.md §4. A duplicate command returns the original result without a second outbox row; stale versions return the documented conflict envelope with the original correlation ID. Evidence in test/${u.systems[0]}/contract.test.ts must cover empty pages, cancellation and interleaved tenants, as required by contracts/${u.systems[0]}.md, ruling C-1 and obligation I-1.`;
      writeFileSync(specPath, JSON.stringify(spec));
    }
    const milestones = Math.min(10, Math.floor(count / 4)), passedMilestones = Math.floor(milestones / 2);
    plan.milestones = Array.from({ length: milestones }, (_, m) => milestoneJson({ id: `MS-${m+1}`, text: `${SYSTEMS[m%8]} release gate ${m+1}: tenant journey, recovery and rollback`, units: Array.from({ length: Math.floor(count/milestones) }, (_, k) => `u${m * Math.floor(count/milestones)+k+1}`), journeys: [{ id: `J-${m+1}`, text: 'Create, amend and cancel a tenant booking; verify replay and rollback.', via: 'shell', entry: 'node --test test/contract.test.js', budget: null }] }));
    writeFileSync(planPath, JSON.stringify({...plan,units:plan.units.filter((u:{id:string})=>u.id!==`u${merged+2}`).map((u:{after:string[]})=>({...u,after:u.after.filter(id=>id!==`u${merged+2}`)})),milestones:plan.milestones.map((m:{units:string[]})=>({...m,units:m.units.filter(id=>id!==`u${merged+2}`)}))})); mkdirSync(runDir, { recursive: true });
    const d = { ...base.d, arc, repo, planPath, runDir, hostDir, config: readRepoConfig(absPath(repo))!, binDir: join(out,'forge','bin') };
    const r = contextFor(d), j = r.journal, head = sha(git(repo, 'rev-parse', 'HEAD')); closeJournal = () => j.close();
    const refs=spawnSync('git',['-C',repo,'update-ref','--stdin'],{input:plan.units.map((u:{id:string})=>`update refs/heads/roadmap/${arc}/${u.id} ${head}`).join('\n')+'\n',encoding:'utf8'});
    if(refs.status!==0) throw new Error(refs.stderr);
    const pinned = new Set<string>();
    const begin = (id: string, stage: Exclude<Stage,'retire'>) => { const u = unitId(id); if (!pinned.has(id)) { pinDispatch(r.ctx, requirePlanInForce(runDir,j.view).plan.units.find(u=>u.id===id)!, { rev: specRev(1), sha256: specShaInForce(j.view,u)! }); pinned.add(id); } return start(r.ctx,u,stage); };
    const excerpts = ['m1-live','m1-dev55'].map(name => readFileSync(new URL(`./scale-transcripts/${name}.jsonl`,import.meta.url),'utf8'));
    let invocations = 0, agentInvocations = 0, costUsd = 0;
    const invokedAttempts = new Map<string, Set<number>>();
    const buildRounds: Record<string,number> = {}, live: ScaleManifest['live'] = [];
    let cursor = origin;
    const setTime = (value: number) => { cursor = Math.max(cursor, value); clock.set(cursor); };
    const advance = (ms: number) => setTime(cursor + ms);
    const resource = (holder: Holder, resources: ResourceUnit[], reserve: boolean, parent: Parent) => {
      if(!reserve) { const clean=j.begin({kind:'resource.transition',key:opKey(`scale:clean:${j.view.highWater()}`),parent,deadlineAt:null,body:()=>({expect:{holder,resources,edge:{type:'clean',from:'reserved'}},post:null})}); j.done(clean.op,'resource.transition',{kind:'transitioned'},null); }
      const op = j.begin({kind:'resource.transition',key:opKey(`scale:resource:${j.view.highWater()}`),parent,deadlineAt:null,body:()=>({expect:{holder,resources,edge:{type:reserve?'reserve':'release'},...(reserve?{waited:{totalMs:0,byReasonMs:{}}}:{})},post:null})}); j.done(op.op,'resource.transition',{kind:'transitioned'},null);
    };
    const invoke = (parent: Parent, agent: boolean, active = false, failed = false, verdict: JsonValue = { summary: 'Contract implementation verified against the recorded acceptance.' }, limit = false) => {
      const unit = parent.type === 'stage' ? parent.unit : unitId('u1'), attempt = parent.type === 'stage' ? parent.attempt : 1;
      const role = parent.type === 'job' ? 'campaignAudit' as const : parent.type === 'stage' && parent.stage === 'gate' ? 'verifier' as const : 'build' as const;
      const routingRev = r.ctx.routing(null).rev;
      const session = implementerSessionId(`00000000-0000-4000-8000-${String(invocations+1).padStart(12,'0')}`);
      const judgment = judgmentSessionId(session);
      const seat = role === 'build' ? {role, session: {backend:'claude' as const,mode:'fresh' as const,id:session}} : {role, session: {backend:'claude' as const,mode:'fresh' as const,id:judgment}};
      const resultSeat = role === 'build' ? {role,session} : {role,session:judgment};
      const brief = `<mode>${role==='verifier'?'gate':role==='campaignAudit'?'checkpoint':'build'}</mode>\n<documents>\n<document index="1"><source>unit specification ${unit}</source><document_content># Intent\n\n${intent(Number(unit.slice(1)))}\n\n## Acceptance\n- Preserve tenant isolation and idempotency.\n- Cite contract evidence and local lane results.</document_content></document>\n<document index="2"><source>contract contracts/${SYSTEMS[(Number(unit.slice(1))-1)%8]}.md</source><document_content># API contract\n\n## §3.2 Commands\nA replay returns the recorded result. A stale version returns Conflict.\n\n${'The durable outbox and transaction must share a tenant boundary.\n'.repeat(40)}</document_content></document>\n</documents>\n<instructions>Read the cited files, implement the intent, run the focused lanes, and report concrete evidence.</instructions>`;
      let launch!: LaunchFile;
      const spawned = j.begin({ kind:'proc.spawn',key:opKey(`scale:inv:${invocations+1}`),parent,deadlineAt:null,body:(op,inv)=>{
        launch = {v:2,arc,op,inv,argv:agent?['claude','-p','--model','claude-opus-5-5','--output-format','stream-json']:['node','--test',`test/${SYSTEMS[(Number(unit.slice(1))-1)%8]}/contract.test.ts`],cwd:absPath(repo),env:{},stdinPath:agent?inputPath(runDir,keepInput(runDir,Buffer.from(brief),'prompt.txt'),'prompt.txt'):null,deadlineAt:isoTime('2026-12-01T00:00:00.000Z'),stallMs:null,graceMs:1000,containment:'session',test:null,terminal:agent?{type:'backend',purpose:'backend',...seat,routingRev,schemaPath:absPath(join(runDir,'report.schema.json')),outputPath:absPath(join(invocationDir(runDir,inv),'stdout'))}:{type:'command',purpose:'lane',expectedExit:0}};
        return {expect:{subject:agent?parent.type==='job'?{purpose:'arc-backend',job:parent.job,role:'campaignAudit',tier:'arc',attempt:1,routingRev}:{purpose:'backend',role:role==='verifier'?'verifier':'build',tier:'med',unit,attempt,routingRev}:{purpose:'lane',unit,lane:laneId('mul'),set:'spec',at:head,redRev:1},launchSha256:launchSha256(launch)},post:null};
      }});
      if(parent.type==='stage') { const attempts=invokedAttempts.get(unit)??new Set<number>(); attempts.add(attempt); invokedAttempts.set(unit,attempts); }
      invocations++; if(agent) agentInvocations++;
      const dir = invocationDir(runDir,spawned.inv); mkdirSync(dir,{recursive:true}); const files = runnerFiles(dir,spawned.inv); files.write('launch.json',launch);
      const transcript = join(dir,'stdout');
      const emit = (event: unknown) => appendFileSync(transcript,JSON.stringify(event)+'\n');
      if(agent) {
        writeFileSync(transcript,JSON.stringify({type:'system',subtype:'init',model:'claude-opus-5-5',tools:['Read','Edit','Write','Bash','StructuredOutput']})+'\n');
        emit({type:'assistant',message:{role:'assistant',content:[{type:'thinking',thinking: Array.from({length:24},(_,i)=>`Reasoning step ${i+1}: trace ${unit}'s tenant key through the repository transaction and compare the retry path with contracts/${SYSTEMS[(Number(unit.slice(1))-1)%8]}.md §3.2. The cancellation path must not commit an unacknowledged outbox row; inspect the version check before broadening the edit.`).join('\n\n')}]}});
        const file = `src/${SYSTEMS[(Number(unit.slice(1))-1)%8]}/service.ts`;
        for(const [n,input,output] of [ ['Read',{file_path:file},'export async function execute(command, tx) { return tx.apply(command); }'], ['Edit',{file_path:file,old_string:'tx.apply(command)',new_string:'tx.applyOnce(command.tenantId, command.id, command)'},'The file has been updated.'], ['Write',{file_path:`test/${SYSTEMS[(Number(unit.slice(1))-1)%8]}/replay.test.ts`,content:'// Verify tenant-scoped replay and optimistic concurrency\n'},'Test file written.'], ['Bash',{command:`sed -n '1,180p' ${file}; python3 - <<'PY'\nfrom pathlib import Path\np = Path('${file}')\ns = p.read_text()\np.write_text(s.replace('legacyVersion', 'expectedVersion'))\nPY`,description:'Inspect and apply the version-boundary edit'},'Updated one version boundary; no other edits.'] ] as const) {
          const id = `scale_${invocations}_${n}`; emit({type:'assistant',message:{role:'assistant',content:[{type:'tool_use',id,name:n,input}]}}); emit({type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:id,content:output}]}});
        }
        // Adapt the real paired Bash/StructuredOutput stream to the retained unit verdict.
        const rows = excerpts[invocations%2]!.trim().split('\n').map(line=>JSON.parse(line));
        for(const row of rows) for(const block of row.message.content) if(block.type==='tool_use' && block.name==='StructuredOutput') block.input=verdict;
        for(const row of rows) { if(active && row.message.content.some((b: {name?: string})=>b.name==='StructuredOutput')) break; emit(row); }
      } else { writeFileSync(transcript,failed?'not ok 3 - duplicate delivery preserves the original result\nAssertionError: expected one outbox row, received two\n':'TAP version 13\nok 1 - empty page\nok 2 - tenant boundary\nok 3 - duplicate delivery\n# tests 3\n# pass 3\n'); }
      writeFileSync(join(dir,'stderr'),failed?'Contract regression at test/booking/contract.test.ts:42\n':'');
      if(agent) { const cost=Math.round((.45+rng()*1.65)*100)/100; costUsd+=cost; j.fact({kind:'meter',inv:spawned.inv,routingRev,subject:parent.type==='job'?{type:'job',job:parent.job,attempt:1,role:'campaignAudit',tier:'arc'}:{type:'seat',unit,attempt,role:role==='verifier'?'verifier':'build',tier:'med'},usage:{inputTokens:2200,outputTokens:1400,cacheReadTokens:24000,cacheWriteTokens:4000,turns:5,costUsd:cost}}); }
      if(active) { if(agent) live.push({unit,stage:parent.type==='stage'?parent.stage:'checkpoint',routeId:invocationDirName(spawned.inv),transcript}); return spawned.inv; }
      const wallMs=agent?180_000+Math.floor(rng()*540_000):20_000+Math.floor(rng()*100_000); advance(wallMs);
      const binding={v:2 as const,arc,op:spawned.op,inv:spawned.inv}, endedAt=isoTime(new Date().toISOString());
      const result: ResultFile=agent?{...binding,type:'backend',...resultSeat,routingRev,outcome:limit?{kind:'process-fault',detail:'Usage limit reached; resume after the overnight reset.'}:{kind:'success',value:verdict},usage:{kind:'unavailable',reason:'absent'},backendErrors:limit?[{class:'usage-limit',message:'Usage limit reached; reset at 07:00 UTC.'}]:[]}:{...binding,type:'command',purpose:'lane',expectedExit:0,exitCode:failed?1:0,verdict:failed?'fail':'pass'};
      files.write('result.json',result); files.write('exit.json',{...binding,child:{type:'exited',code:failed?1:0},cause:'exited',endedAt,quiescedAt:endedAt,cpu:{wallMs,runMs:agent?Math.round(wallMs*.12):Math.round(wallMs*1.8),waitMs:Math.round(wallMs*.03)}});
      if(agent) emit({type:'result',subtype:limit?'error_during_execution':'success',is_error:limit,structured_output:verdict,duration_ms:wallMs,num_turns:5,total_cost_usd:1.2,result:'Recorded contract evidence and completed the focused checks.'});
      j.done(spawned.op,'proc.spawn',{kind:'result',pressure:null,resultSha256:sha256(sha256Hex(readFileSync(join(dir,'result.json')))),summary:agent?{type:'backend',outcome:limit?'process-fault':'success'}:{type:'command',verdict:failed?'fail':'pass'}},null);
      return spawned.inv;
    };
    const previous = keptPayload(runDir,j.view.planApplied()!.payloadSha256);
    // Three revisions: initial plan, withdrawal/re-entry, later scope clarification.
    const parentPark=begin(`u${reentryParent}`,'build');
    j.fact({kind:'stage-outcome',unit:parentPark.unit,stage:'build',attempt:parentPark.attempt,outcome:'process-fault',class:'park',chargeable:false,park:{class:'operator',kind:'design'}});
    const revisedPlan = {...plan,units:plan.units.map((u: {id:string},i:number)=>i>=count-withdrawn?{...u,cut:{reason:'Owner withdrew this experiment after the contract audit.'}}:i===merged+1?{...u,reenters:{unit:`u${reentryParent}`}}:u)};
    commitRevisionNow(j,runDir,{...previous,manifest:{...previous.manifest,specs:{...previous.manifest.specs,[unitId(`u${merged+2}`)]:keepInput(runDir,readFileSync(join(planDir,`u${merged+2}.json`)),'spec.json')},planSha256:keepInput(runDir,Buffer.from(JSON.stringify(revisedPlan)),'plan.json')},source:{type:'command',command:commandId('cmd-0000000000000001')},base:planRev(1),rev:planRev(2),changes:[{type:'unit-added',unit:unitId(`u${merged+2}`)},...revisedPlan.units.slice(count-withdrawn).map((u:{id:string})=>({type:'unit-cut' as const,unit:unitId(u.id)})),{type:'unit-reentered',unit:unitId(`u${merged+2}`),reenters:unitId(`u${reentryParent}`),reset:false}],dispositions:[],divergences:[]},{type:'arc'});
    const pulls: GhPull[]=[];
    const historicalCount=merged+Math.floor(count*.16);
    // Deterministic event agenda: topological units run in daytime bursts. Each day's
    // 23:00–07:00 backend usage-limit park contains no unit work.
    for(let day=0, i=1; day<Math.ceil(days); day++) {
      const dayStart=origin+day*DAY;
      const startIndex=i, endIndex=Math.floor(historicalCount*Math.min(day+1,days)/days);
      setTime(dayStart);
      for(;i<=endIndex;i++) {
        if(i===reentryParent) continue;
        setTime(dayStart + Math.floor((i-startIndex)/Math.max(1,endIndex-startIndex+1)*12*3_600_000));
        const id=`u${i}`, rounds=i%37===0?6:i%19===0?4:i%7===0?2:1; buildRounds[id]=rounds;
        for(let round=1;round<=rounds;round++) {
          const build=begin(id,'build'); const cpu=[1,2,3,4].map(cpuToken); resource(build,cpu,true,build); invoke(build,true); resource(build,cpu,false,build); record(r.ctx,at(build,'build'),'success');
          const checks=begin(id,'lanes'); const red=round<rounds; invoke(checks,false,false,red); record(r.ctx,at(checks,'lanes'),red?'red':'green');
          const gate=begin(id,'gate'); invoke(gate,true,false,false,{decision:red?'revise':'approve',reasons:[red?'Duplicate deliveries create a second outbox row.':'Tenant-scoped replay and the version boundary satisfy contract §3.2.'],findings:red?[{title:'Keep the original result on replay',path:`src/${SYSTEMS[(i-1)%8]}/service.ts`,line:42,severity:'blocking',evidence:['test/booking/contract.test.ts:42']}]:[],directives:red?['Fix the replay transaction and re-run the contract lane.']:[]}); record(r.ctx,at(gate,'gate'),red?'revise':'approve');
        }
        const waited={'cpu-tokens':60_000*(i%9),'cpu-pressure':120_000*(i%7),'memory-pressure':90_000*(i%3),'publication-slot':180_000*(i%11),'admission-hold:base-red':300_000*(i%5)};
        j.fact({kind:'stage-admitted',unit:unitId(id),stage:'candidate',waited:{totalMs:Object.values(waited).reduce((a,b)=>a+b,0),byReasonMs:waited}});
        if(i<=merged) {
          const candidate=begin(id,'candidate'), holder={type:'publication' as const,unit:unitId(id),attempt:candidate.attempt}; resource(holder,[INTEGRATION_SLOT],true,candidate);
          invoke(candidate,false); record(r.ctx,at(candidate,'candidate'),'green'); const ff=begin(id,'ff'); record(r.ctx,at(ff,'ff'),'published'); const snapshot=begin(id,'snapshot'); record(r.ctx,at(snapshot,'snapshot'),'published'); resource(holder,[INTEGRATION_SLOT],false,snapshot);
          pulls.push({number:i,title:`${SYSTEMS[(i-1)%8]}: ${FEATURES[Math.floor((i-1)/8)%8]}`,body:intent(i),state:'MERGED',url:`https://forge.test/tidewater/platform/pull/${i}`,baseRefName:'main',headRefName:`roadmap/${arc}/${id}`,mergeCommit:{oid:head},isDraft:false});
        }
      }
      const audit=jobId('audit',day+1); j.fact({kind:'audit-started',job:audit,triggers:[{type:'final'}],generation:day+1,lenses:['invariants'],integrationSha:head,planRev:planRev(2),ledgerSha256:previous.manifest.rulings.ledgerSha256,obligationsSha256:previous.manifest.obligations,visionSha256:previous.manifest.vision!,owners:[],priorFindings:[],highWater:j.view.highWater(),diffBudget:24000});
      invoke({type:'job',job:audit},true,false,false,{decision:'approve',reasons:['Checkpoint: reviewed tenant replay, migrations and rollback evidence.'],findings:[]});
      j.fact({kind:'audit-ended',job:audit,covered:[{lens:'invariants',from:head,to:head}],findings:[],suppressed:0,outcome:'completed',refused:[]});
      invoke({type:'job',job:jobId('ckpt',day+1)},true,false,false,{decision:day%3===0?'revise':'approve',reasons:['Checkpoint: retain the migration fallback until the release gate passes.'],findings:[]});
      if(day<days-1) { setTime(dayStart+15*3_600_000); j.fact({kind:'backend-park',backend:'claude',class:'usage-limit',inv:invoke({type:'job',job:jobId('ckpt',100+day)},true,false,false,{},true)}); setTime(dayStart+23*3_600_000); j.fact({kind:'resumed',command:commandId(`cmd-${String(100+day).padStart(16,'0')}`),target:{type:'backend',backend:'claude'}}); }
    }
    setTime(now-3_600_000);
    for(let m=1;m<=passedMilestones;m++) { const job=jobId('walk',m), milestone=milestoneId(`MS-${m}`); j.fact({kind:'walk-started',job,milestone,round:1,sha:head,ports:{}}); advance(60_000); j.fact({kind:'walk-ended',job,outcome:'reported',findings:[],proposals:[],dropped:[]}); j.fact({kind:'milestone-passed',milestone,job}); }
    for(let i=historicalCount+1;i<=historicalCount+parkedCount;i++) { const parent=begin(`u${i}`,'build'); j.fact({kind:'stage-outcome',unit:parent.unit,stage:'build',attempt:parent.attempt,outcome:'process-fault',class:'park',chargeable:false,park:{class:'operator',kind:'design'}}); }
    // Four genuinely unsettled agent spawns, plus one active deterministic lane.
    const activeStart=historicalCount+parkedCount+1;
    for(let n=0;n<4;n++) { const id=`u${activeStart+n}`; setTime(now-(4-n)*180_000); const parent=begin(id,n===3?'gate':'build'); resource(parent,[cpuToken(n+1)],true,parent); invoke(parent,true,true); }
    setTime(now-90_000); invoke(begin(`u${activeStart+4}`,'lanes'),false,true);
    const slotUnit=`u${merged+2}`, slot=begin(slotUnit,'candidate'); resource({type:'publication',unit:unitId(slotUnit),attempt:slot.attempt},[INTEGRATION_SLOT],true,slot); invoke(slot,false,true);
    setTime(now-30_000);
    for(const u of r.ctx.plan().units) if(u.contingent.length && Number(u.id.slice(1))%2===0) j.fact({kind:'edge-resolved',edge:edgeId(u.contingent[0]!.id),command:commandId('cmd-0000000000000500'),evidence:'Owner approved the migration window after the rollback drill.'});
    const finding=findingId('F-1'); j.fact({kind:'finding-opened',id:finding,key:sha256('1'.repeat(64)),lens:'invariants',severity:'P2',obligation:obligationId('I-1'),visionClauses:[visionClauseId('V-1')],claim:'Document the replay retention boundary before enabling the last tenant cohort.',evidence:[{path:repoPath('src/booking/service.ts'),blob:null}],mutant:null,source:{type:'job',job:jobId('audit',1)},gateHadPassed:true});
    for(let n=0;n<16;n++) { const request=raiseNeedsUser(j,runDir,{reason:n<5?'owner-request':'revision-notice',blocking:n<5,subject:n%2?{type:'arc'}:{type:'unit',unit:unitId(`u${historicalCount+1+n%parkedCount}`)},summary:n<5?`Resolve ${SYSTEMS[n%8]} migration hold before release gate ${n+6}`:`Review ${SYSTEMS[n%8]} contract clarification and rollout evidence ${n+1}`,recommendation:'Inspect the linked contract lane, confirm the migration window and record the decision before resuming the affected unit.',options:[{id:'retry',label:'Retry with the confirmed migration window'},{id:'defer',label:'Defer to the next release gate'}],evidence:[absPath(live[n%4]!.transcript)]},{type:'arc'}); if(n>=11) j.fact({kind:'needs-user-acked',id:request,command:commandId(`cmd-${String(600+n).padStart(16,'0')}`),choice:'defer'}); }
    const rev2=keptPayload(runDir,j.view.planApplied()!.payloadSha256); commitRevisionNow(j,runDir,{...rev2,source:{type:'command',command:commandId('cmd-0000000000000900')},base:planRev(2),rev:planRev(3),changes:[],dispositions:[],divergences:[]},{type:'arc'});
    makeForge({dir:join(out,'forge'),repo:{host:'forge.test',owner:'tidewater',name:'platform'},pulls});
    const queue = Array.from({length:Math.max(4,Math.floor(count*.06))},(_,n)=>({unit:`u${merged+3+n}`,stage:'candidate',attempt:1,publication:n%3!==2,request:{named:[],pools:[],cpu:n%3===2?4:0,publication:n%3!==2},envBlocked:false,pressureBlocked:n%3===2,queuedAt:now-(n+1)*600_000,reasons:[n%3===2?'cpu-pressure':n%2?'admission-hold:base-red':'publication-slot']}));
    writeFileSync(join(runDir,'sched.json'),JSON.stringify({v:2,arc,pid:process.pid,tasks:[...live.map(i=>({unit:i.unit,state:'in-stage'})),{unit:`u${activeStart+4}`,state:'in-stage'},{unit:slotUnit,state:'in-stage'}],queue,jobQueue:[],drains:[]}));
    const manifest: ScaleManifest={arc,repo,runDir,hostDir,seed,days,now:SCALE_NOW,startedAt:new Date(origin).toISOString(),units:count,systems:SYSTEMS,milestones,passedMilestones,dependencies:plan.units.reduce((n:number,u:{after:string[]})=>n+u.after.length,0),contingentEdges:plan.units.reduce((n:number,u:{contingent?:unknown[]})=>n+(u.contingent?.length??0),0),invocations,agentInvocations,attempts:[...invokedAttempts.values()].reduce((n,a)=>n+a.size,0),stageAttempts:Object.values(j.derived().units).reduce((n,u)=>n+u.counters.attempts,0),buildRounds,live,merged,withdrawn:withdrawn+1,parked:parkedCount,openAttention:11,ackedAttention:5,costUsd:Math.round(costUsd*100)/100,events:j.view.highWater()};
    writeFileSync(join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
    j.close(); closeJournal=undefined;
    return manifest;
  } finally { closeJournal?.(); clock.restore(); for(const [i,key] of ['GIT_AUTHOR_DATE','GIT_COMMITTER_DATE'].entries()) { const old=oldDates[i]; if(old===undefined) delete process.env[key]; else process.env[key]=old; } }
}

/** Claim the same production owner lease used by investigationFixture. No executor or backend runs. */
export async function ownScaleArc(manifest: ScaleManifest) {
  const owner=selfIdentity(), hostDir=absPath(manifest.hostDir); openHostDir(hostDir);
  const result=await claimHost(hostDir,{runDir:absPath(manifest.runDir),arc:arcId(manifest.arc),repo:absPath(manifest.repo),supervisor:owner},async()=>({kind:'reconciled'}));
  if(result.kind!=='claimed') throw new Error('Scale fixture host is already owned');
  publishOwner(hostDir,result.claim,{pid:owner.pid,start:owner.start});
  return () => releaseHost(hostDir,result.claim);
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const [out,...args]=process.argv.slice(2), options: ScaleOptions={}; let live=false;
  if(!out) throw new Error('Usage: node test/helpers/scale-arc.ts <outDir> [--units N] [--days D] [--seed S] [--live]');
  for(let i=0;i<args.length;i++) { const arg=args[i]; if(arg==='--live')live=true; else if(arg==='--units'||arg==='--days'||arg==='--seed') { const value=args[++i]; if(!value)throw new Error(`${arg} requires a value`); if(arg==='--seed')options.seed=value;else if(arg==='--units')options.units=Number(value);else options.days=Number(value); } else throw new Error(`Unknown option: ${arg}`); }
  const started=performance.now(), manifest=await generateScaleArc(out,options);
  process.stdout.write(manifest.repo+'\n'); process.stderr.write(`${manifest.units} units, ${manifest.invocations} invocations, ${manifest.events} events, $${manifest.costUsd.toFixed(2)} in ${((performance.now()-started)/1000).toFixed(2)}s\n`);
  if(live) {
    const release=await ownScaleArc({...manifest,hostDir:HOST_DIR}); let n=0;
    writeFileSync(join(resolve(out),'live.json'),JSON.stringify({pid:process.pid,hostDir:HOST_DIR,startedAt:new Date().toISOString(),stopAt:new Date(Date.now()+2*60*60*1000).toISOString(),transcript:manifest.live[0]!.transcript},null,2)+'\n');
    const timer=setInterval(()=>{ const id=`tail_${++n}`, file=manifest.live[0]!.transcript; appendFileSync(file,JSON.stringify(n%2?{type:'assistant',message:{role:'assistant',content:[{type:'tool_use',id,name:'Bash',input:{command:`node --test test/booking/replay.test.ts # verification pass ${n}`,description:'Verify tenant replay under concurrent delivery'}}]}}:{type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:`tail_${n-1}`,content:`TAP version 13\nok - replay is idempotent (pass ${n/2})\n# tests 6\n# pass 6\n# fail 0`}]}})+'\n'); },4000);
    const stop=()=>{clearInterval(timer);clearTimeout(bound);release();}; const bound=setTimeout(stop,2*60*60*1000); process.once('SIGINT',stop);process.once('SIGTERM',stop);
  }
}
