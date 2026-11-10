import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { serveConsole } from '../../src/console/http.ts';
import { absPath } from '../../src/core/values.ts';
import { gitCommonDir } from '../../src/git/git.ts';
import { consoleAgentFixture } from '../fixtures/console-agent.ts';
import { ConsoleBrowser } from '../helpers/console-browser.ts';
import { tmpDir } from '../helpers/repo.ts';
import { until } from '../fixtures/exec-common.ts';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/transcripts/file-tools/${name}.jsonl`, import.meta.url), 'utf8');
test('file tools render real diffs, numbered code, compact Reads, open errors and literal shell writes in Chromium', { timeout: 120_000 }, async t => {
  const f = await consoleAgentFixture(), b = new ConsoleBrowser(tmpDir('console-file-tools'));
  const s = await serveConsole({ repo: absPath(f.d.repo), common: gitCommonDir(absPath(f.d.repo)), hostDir: f.hostDir, host: '127.0.0.1', port: 0 });
  t.after(async () => { await b.close(); await s.close(); f.close(); });
  await b.initialize();
  const open = async (name: string) => {
    writeFileSync(f.transcript, fixture(name));
    await b.call('browser_navigate', { url: `${s.url}/#/arcs/${f.arc}/graph/invocations/${f.routeId}` });
    await until(async () => await b.evaluate<boolean>('() => Boolean(document.querySelector(".history-code-line"))'), 12_000, 'hydrated file content');
  };
  await open('plain4');
  await until(async () => await b.evaluate<boolean>('() => document.querySelectorAll(".history-file-update").length === 2 && document.querySelectorAll(".history-diff").length === 3'), 12_000, 'real overwritten files');
  assert.equal(await b.evaluate('() => document.querySelectorAll(".history-file-create").length'), 2);
  assert.equal(await b.evaluate('() => document.querySelectorAll("[data-tool=Edit] .history-diff mark").length'), 4);
  assert.match(await b.evaluate<string>('() => document.querySelector("[data-tool=Edit] .history-diff-count").textContent'), /\+2 −2/);
  assert.match(await b.evaluate<string>('() => document.querySelector("[data-tool=Edit] .history-diff-hunk").textContent'), /@@ -1,5 \+1,5 @@/);
  assert.ok(await b.evaluate<number>('() => document.querySelectorAll(".history-syntax").length') > 0);
  assert.equal(await b.evaluate('() => document.querySelectorAll("[data-tool=Write] .tool-output, [data-tool=Edit] .tool-output").length'), 0);
  assert.doesNotMatch(await b.evaluate<string>('() => document.querySelector(".history-scroll").innerText'), /File created successfully|file state is current|"old_string"/);
  assert.equal(await b.evaluate('() => document.querySelectorAll("[data-tool=Write] .history-tool-ok, [data-tool=Edit] .history-tool-ok").length'), 5);

  assert.ok(await b.evaluate<number>('()=>document.querySelectorAll(".changed-files button").length')>0,'identified files have whole-row navigation targets');
  await b.evaluate('()=>{document.querySelector(".changed-files").open=true;document.querySelector(".changed-files button").click();return true;}');
  assert.equal(await b.evaluate('()=>document.querySelector(".history-controls").textContent.includes("Following live tail")'),false,'file navigation pauses following');
  for(const theme of ['light','dark']){
    const contrast=await b.evaluate<{code:number;marker:number;font:string;lineHeight:string}[]>(`()=>{
      document.documentElement.dataset.theme='${theme}';
      const context=document.createElement('canvas').getContext('2d',{willReadFrequently:true});context.canvas.width=context.canvas.height=1;
      const rgba=color=>{context.clearRect(0,0,1,1);context.fillStyle=color;context.fillRect(0,0,1,1);return [...context.getImageData(0,0,1,1).data];};
      const lum=color=>{const c=color.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return .2126*c[0]+.7152*c[1]+.0722*c[2];};
      const ratio=(a,b)=>(Math.max(lum(a),lum(b))+.05)/(Math.min(lum(a),lum(b))+.05);
      return ['add','remove'].map(kind=>{const row=document.querySelector('.history-diff-'+kind),code=row.querySelector('code'),marker=row.querySelector('.history-diff-marker'),style=getComputedStyle(code),background=rgba(getComputedStyle(row).backgroundColor);return {code:ratio(rgba(style.color),background),marker:ratio(rgba(getComputedStyle(marker).color),background),font:style.fontSize,lineHeight:style.lineHeight};});
    }`);
    for(const row of contrast){assert.ok(row.code>=4.5,`${theme} code contrast ${row.code}`);assert.ok(row.marker>=3,`${theme} gutter contrast ${row.marker}`);assert.equal(row.font,'12px');assert.equal(row.lineHeight,'18px');}
  }

  await open('edge-cases');
  const row = (id: string) => `document.querySelector('[data-tool-id="${id}"]')`;
  await until(async () => await b.evaluate<boolean>(`() => ${row('overwrite-write')}.querySelector('.history-diff') !== null`), 12_000, 'long overwrite diff');
  assert.equal(await b.evaluate(`() => ${row('edit-error')}.querySelector('.tool-output').open`), true);
  assert.match(await b.evaluate<string>(`() => ${row('edit-error')}.innerText`), /string not found/);
  assert.equal(await b.evaluate(`() => getComputedStyle(${row('edit-error')}.querySelector('.tool-output pre')).color === getComputedStyle(${row('edit-error')}.querySelector('.history-tool-error')).color`), true);
  assert.equal(await b.evaluate(`() => ${row('read-existing')}.querySelector('details').open`), false);
  assert.match(await b.evaluate<string>(`() => ${row('read-existing')}.querySelector('summary').textContent`), /Read\s+src\/existing.ts.*lines 1–2/);
  assert.equal(await b.evaluate(`() => ${row('read-existing')}.querySelectorAll('header').length`), 0);
  assert.ok(await b.evaluate<number>(`() => ${row('read-existing')}.querySelector('summary').getBoundingClientRect().height`) <= 28, 'Read stays on one compact row');
  assert.equal(await b.evaluate(`() => { ${row('read-existing')}.querySelector('details').open=true; return true; }`), true);
  assert.match(await b.evaluate<string>(`() => ${row('read-existing')}.querySelector('pre').textContent`), /const ready = false;/);
  assert.match(await b.evaluate<string>(`() => ${row('overwrite-read')}.querySelector('.history-diff').textContent`), /const ready = false;/);
  assert.equal(await b.evaluate(`() => ${row('overwrite-read')}.querySelector('.history-file-update').textContent`), 'overwrote existing file');
  assert.match(await b.evaluate<string>(`() => ${row('replace-all')}.innerText`), /replace_all/);
  assert.deepEqual(await b.evaluate(`() => [...${row('replace-all')}.querySelectorAll('.history-diff-remove .history-line-number')].map(n=>n.textContent)`), ['10', '12']);
  assert.equal(await b.evaluate(`() => ${row('multi')}.querySelectorAll('.history-line-number').length`), 0);
  assert.match(await b.evaluate<string>(`() => ${row('multi')}.innerText`), /\+2 −2/);
  assert.equal(await b.evaluate(`() => ${row('unknown-write')}.querySelector('.history-file-badge')`), null);
  assert.equal(await b.evaluate(`() => ${row('unrecoverable-overwrite')}.querySelector('.history-diff')`), null);
  assert.equal(await b.evaluate(`() => ${row('unrecoverable-overwrite')}.querySelector('.history-file-update').textContent`), 'overwrote existing file');
  assert.equal(await b.evaluate(`() => ${row('new-long')}.querySelectorAll('.history-code-line').length`), 40);
  assert.equal(await b.evaluate(`() => ${row('new-long')}.querySelectorAll('.history-line-number')[39].textContent`), '40');
  assert.match(await b.evaluate<string>(`() => ${row('new-long')}.querySelector('button').textContent`), /Show all/);
  await b.evaluate(`() => { ${row('new-long')}.querySelector('button').click(); return true; }`);
  await until(async () => await b.evaluate<number>(`() => ${row('new-long')}.querySelectorAll('.history-code-line').length`) === 65, 12_000, 'all new-file lines');
  assert.equal(await b.evaluate(`() => ${row('overwrite-write')}.querySelectorAll('.history-diff-line').length`), 40);
  await b.evaluate(`() => { ${row('overwrite-write')}.querySelector('button').click(); return true; }`);
  await until(async () => await b.evaluate<number>(`() => ${row('overwrite-write')}.querySelectorAll('.history-diff-line').length`) > 100, 12_000, 'all diff lines');
  assert.match(await b.evaluate<string>(`() => ${row('heredoc')}.innerText`), /writes notes.md/);
  assert.equal(await b.evaluate(`() => ${row('heredoc')}.querySelector('.history-command code').textContent`), "cat > 'notes.md' <<'EOF'\n# Notes\nRecorded shell change.\nEOF");
  for (const id of ['tee', 'python', 'node', 'sed']) assert.ok(await b.evaluate<string>(`() => ${row(id)}.querySelector('.history-command code').textContent`));
  assert.match(await b.evaluate<string>(`() => ${row('edit-result-patch')}.querySelector('.history-diff-hunk').textContent`), /@@ -7,2 \+7,2 @@/);
  assert.match(await b.evaluate<string>(`() => ${row('edit-result-patch')}.querySelector('.history-diff-remove').textContent`), /const ready = false;/);
  assert.equal(await b.evaluate('() => getComputedStyle(document.querySelector(".history-event")).marginBottom'), '4px');
  assert.equal(await b.evaluate('() => Boolean(document.querySelector(".history-scroll script"))'), false);
  assert.equal(await b.evaluate('() => Boolean(window.fileToolExecuted)'), false);
  assert.match(await b.evaluate<string>(`() => ${row('html-content')}.querySelector('.history-code').textContent`), /<script>window.fileToolExecuted=true<\/script>/);
});
