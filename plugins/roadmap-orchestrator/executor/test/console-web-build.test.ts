import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
const root = fileURLToPath(new URL('../', import.meta.url));
function files(root: string, dir = root): string[] { return readdirSync(dir, { withFileTypes:true }).flatMap(f=>f.isDirectory()?files(root,join(dir,f.name)):[relative(root,join(dir,f.name))]).sort(); }
test('committed console exactly matches a clean deterministic build', {timeout:60_000}, t=>{
  const out=mkdtempSync(join(tmpdir(),'console-build-'));t.after(()=>rmSync(out,{recursive:true,force:true}));
  const built=spawnSync(process.execPath,['scripts/build-console.ts','--out',out],{cwd:root,encoding:'utf8',timeout:50_000});
  assert.equal(built.status,0,`${built.stdout}\n${built.stderr}\nRun npm run build:console`);
  const expected=files(join(root,'web')),actual=files(out);
  assert.deepEqual(actual,expected,'Console file set drifted. Run npm run build:console');
  for(const path of expected)assert.deepEqual(readFileSync(join(out,path)),readFileSync(join(root,'web',path)),`${path} drifted. Run npm run build:console`);
});
