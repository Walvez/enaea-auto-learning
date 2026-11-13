// Ego-browser driven fixture tests for enaea-auto-learning.user.js
// Run: ego-browser nodejs < driver.mjs
import { readFileSync } from 'node:fs';

const SRC = readFileSync('/Volumes/ExternalSSD/Codex/script/enaea-auto-learning.user.js', 'utf8');
const BASE = 'http://127.0.0.1:8791/fixture.html';
const PROJ = 'business_id=2120807708913364994&activity_id=2120808048562466817';

const results = [];
function rec(name, ok, detail) { results.push({ name, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + JSON.stringify(detail) : '')); }

async function inject(page) {
  await page.evaluate((code) => { const s = document.createElement('script'); s.textContent = code; document.body.appendChild(s); }, SRC);
}
async function ev(page, expr) { return await page.evaluate(expr); }
async function poll(page, expr, pred, timeout = 120000, label = '') {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try { last = await ev(page, expr); } catch (e) { last = undefined; }
    if (pred(last)) return last;
    await page.waitForTimeout(300);
  }
  throw new Error('poll timeout [' + label + '] last=' + JSON.stringify(last));
}
async function boot(page) {
  await poll(page, '!!(window.__ENAEA_AUTO__ && window.__ENAEA_AUTO__.S)', (v) => v, 10000, 'inject');
  await page.waitForTimeout(600);
  await ev(page, 'window.__ENAEA_AUTO__.CFG.syncWaitMs=200; window.__ENAEA_AUTO__.CFG.playerReadyTimeout=8000; window.__ENAEA_AUTO__.CFG.scanStableMs=150; window.__ENAEA_AUTO__.CFG.stallMs=8000;');
}
async function ready(page) {
  // ensure catalog DOM rendered AND userscript injected; retry goto+inject if lost
  for (let i = 0; i < 3; i++) {
    const ok = await ev(page, "!!(window.__ENAEA_AUTO__ && window.__ENAEA_AUTO__.S) && !!document.querySelector('.collapseList_test')").catch(() => false);
    if (ok) return;
    await page.goto(BASE + '?reset=1&' + PROJ + '&_t=' + Date.now(), { timeout: 20000 });
    await ev(page, "localStorage.removeItem('enaea_state'); localStorage.removeItem('enaea_lock');");
    if (!(await ev(page, "!!document.querySelector('.collapseList_test')").catch(() => false))) { await page.waitForTimeout(500); }
    await inject(page);
    await boot(page);
  }
  throw new Error('ready failed: catalog/inject not present');
}
async function freshStart(page) {
  await page.goto(BASE + '?reset=1&' + PROJ + '&_t=' + Date.now(), { timeout: 20000 });
  await ev(page, "localStorage.removeItem('enaea_state'); localStorage.removeItem('enaea_lock');");
  await inject(page);
  await boot(page);
  await ready(page);
}
async function freshStartNoReset(page) {
  await page.goto(BASE + '?reset=1&' + PROJ + '&_t=' + Date.now(), { timeout: 20000 });
  await ev(page, "localStorage.removeItem('enaea_state'); localStorage.removeItem('enaea_lock');");
  await page.goto(BASE + '?' + PROJ + '&_t=' + Date.now(), { timeout: 20000 });
  await inject(page);
  await boot(page);
  await ready(page);
}
const sumExpr = `(()=>{const d=window.FIXTURE.data;let s=0,n=0,done=0;for(const c of d.chapters)for(const x of c.sections)for(const co of x.courses)for(const e of co.episodes){s+=(e.progress||0);n++;if(e.progress>=100)done++;}return {sum:s,n,done};})()`;

async function main() {
  const task = await taskSpace('enaea-fixture-test');
  let page;
  try { page = task.page('p1'); } catch (e) { page = await task.newPage('p1'); }
  if (!page) page = await task.newPage('p1');

  // ---------- Scenario 1: full run: episode->next, section->next, chapter->next, 1.0x, COMPLETED ----------
  try {
    await freshStart(page);
    const idle = await ev(page, 'window.__ENAEA_AUTO__.S.phase');
    rec('S1-idle-init', idle === 'IDLE', { idle });
    await ev(page, 'window.__ENAEA_AUTO__.Controls.start()');
    // capture playback rate during playback
    let rate = null;
    try { rate = await poll(page, "(()=>{const v=document.querySelector('video');return (v&&v.currentSrc)?{r:v.playbackRate,d:v.duration}:null;})()", (v) => !!v, 20000, 'rate'); } catch (e) {}
    rec('S1-playback-rate-1x', rate && Math.abs(rate.r - 1) < 0.001, rate);
    const phase = await poll(page, 'window.__ENAEA_AUTO__.S.phase', (v) => v === 'COMPLETED' || v === 'ERROR', 180000, 'complete');
    const st = await ev(page, `(()=>{const d=window.FIXTURE.data;const all=[];for(const c of d.chapters)for(const s of c.sections)for(const co of s.courses){const avg=co.episodes.length?Math.round(co.episodes.reduce((a,e)=>a+(e.progress||0),0)/co.episodes.length):0;all.push({t:co.title,p:avg,eps:co.episodes.map(e=>e.progress)});}const S=window.__ENAEA_AUTO__.S;return {phase:S.phase,completedCount:S.completedCount,total:S.totalCourses,attempts:S.attemptByKey,all,err:S.lastError};})()`);
    rec('S1-phase-completed', st.phase === 'COMPLETED', { phase: st.phase, err: st.err });
    rec('S1-all-courses-100', st.all.length === 5 && st.all.every((c) => c.p === 100), st.all);
    rec('S1-completed-count', st.completedCount === 5 && st.total === 5, { c: st.completedCount, t: st.total });
    rec('S1-single-attempt-each', Object.keys(st.attempts).length === 5 && Object.values(st.attempts).every((n) => n === 1), st.attempts);
    // no restart after completed
    await page.waitForTimeout(3000);
    const after = await ev(page, '({phase:window.__ENAEA_AUTO__.S.phase, playing:(()=>{const v=document.querySelector("video");return v?!v.paused:false})()})');
    rec('S1-no-restart-after-complete', after.phase === 'COMPLETED' && !after.playing, after);
  } catch (e) { rec('S1-EXCEPTION', false, String(e)); }

  // ---------- Scenario 2: manual stop halts and does not auto restart ----------
  try {
    await freshStart(page);
    await ev(page, 'window.__ENAEA_AUTO__.Controls.start()');
    try {
      await poll(page, '(()=>{const v=document.querySelector("video");return !!(v&&v.currentSrc&&(!v.paused||v.ended));})()', (v) => v, 45000, 'playing');
    } catch (e) {
      const dbg = await ev(page, `(()=>{const S=window.__ENAEA_AUTO__.S;const v=document.querySelector('video');return {phase:S.phase,sub:S.sub,err:S.lastError,video:!!v,src:v&&v.currentSrc,paused:v&&v.paused,locked:true,catalog:!!document.querySelector('.collapseList_test')};})()`);
      throw new Error('playing timeout dbg=' + JSON.stringify(dbg));
    }
    const sum1 = await ev(page, sumExpr);
    await ev(page, 'window.__ENAEA_AUTO__.Controls.stop()');
    await page.waitForTimeout(3500);
    const st = await ev(page, '({phase:window.__ENAEA_AUTO__.S.phase, playing:(()=>{const v=document.querySelector("video");return v?!v.paused:false})()})');
    const sum2 = await ev(page, sumExpr);
    rec('S2-phase-stopped', st.phase === 'STOPPED', st);
    rec('S2-video-paused', !st.playing, st);
    rec('S2-no-further-progress', sum2.sum === sum1.sum, { before: sum1, after: sum2 });
    await page.waitForTimeout(2500);
    const st2 = await ev(page, 'window.__ENAEA_AUTO__.S.phase');
    rec('S2-no-auto-resume', st2 === 'STOPPED', { st2 });
  } catch (e) { rec('S2-EXCEPTION', false, String(e)); }

  // ---------- Scenario 3: pause / resume ----------
  try {
    await freshStart(page);
    await ev(page, 'window.__ENAEA_AUTO__.Controls.start()');
    await poll(page, '(()=>{const v=document.querySelector("video");return !!(v&&v.currentSrc&&!v.paused);})()', (v) => v, 30000, 'playing');
    await ev(page, 'window.__ENAEA_AUTO__.Controls.pause()');
    await page.waitForTimeout(800);
    const p1 = await ev(page, '({phase:window.__ENAEA_AUTO__.S.phase, paused:(()=>{const v=document.querySelector("video");return v?v.paused:null})()})');
    rec('S3-paused-state', p1.phase === 'PAUSED' && p1.paused === true, p1);
    await ev(page, 'window.__ENAEA_AUTO__.Controls.resume()');
    await page.waitForTimeout(1500);
    const p2 = await ev(page, '({phase:window.__ENAEA_AUTO__.S.phase, paused:(()=>{const v=document.querySelector("video");return v?v.paused:null})()})');
    rec('S3-resumed-running', p2.phase === 'RUNNING' && p2.paused === false, p2);
  } catch (e) { rec('S3-EXCEPTION', false, String(e)); }

  // ---------- Scenario 4: reload resume keeps RUNNING and continues to completion ----------
  try {
    await freshStartNoReset(page);
    await ev(page, 'window.__ENAEA_AUTO__.Controls.start()');
    // wait until at least one episode completed (100)
    await poll(page, sumExpr, (v) => v && v.done >= 1, 40000, 'one-episode-done');
    const mid = await ev(page, sumExpr);
    await page.reload();
    await inject(page);
    await page.waitForTimeout(300);
    await poll(page, '!!(window.__ENAEA_AUTO__ && window.__ENAEA_AUTO__.S)', (v) => v, 10000, 'reinject');
    await page.waitForTimeout(600);
    const phaseAfterReload = await ev(page, 'window.__ENAEA_AUTO__.S.phase');
    rec('S4-auto-resume-running', phaseAfterReload === 'RUNNING', { phaseAfterReload, mid });
    const phase = await poll(page, 'window.__ENAEA_AUTO__.S.phase', (v) => v === 'COMPLETED' || v === 'ERROR', 180000, 'complete-after-reload');
    const st = await ev(page, `(()=>{const d=window.FIXTURE.data;let done=0,n=0;for(const c of d.chapters)for(const s of c.sections)for(const co of s.courses)for(const e of co.episodes){n++;if(e.progress>=100)done++;}return {phase:window.__ENAEA_AUTO__.S.phase,done,n};})()`);
    rec('S4-completes-after-reload', st.phase === 'COMPLETED' && st.done === st.n, st);
  } catch (e) { rec('S4-EXCEPTION', false, String(e)); }

  // ---------- Scenario 5: no-video course marked manual (VR/quiz) ----------
  try {
    await freshStart(page);
    // make first course non-video (no episodes) to simulate VR/quiz item
    await ev(page, `(()=>{const d=window.FIXTURE.data;d.chapters[0].sections[0].courses[0].episodes=[];d.chapters[0].sections[0].courses[0].nonVideo=true; window.FIXTURE.save(); window.FIXTURE.renderCatalog();})()`);
    await ev(page, 'window.__ENAEA_AUTO__.Controls.start()');
    const manualCount = await poll(page, 'Object.keys(window.__ENAEA_AUTO__.S.manualKeys||{}).length', (v) => v >= 1, 60000, 'manual');
    const st = await ev(page, '({phase:window.__ENAEA_AUTO__.S.phase, manual:window.__ENAEA_AUTO__.S.manualKeys, notes:window.__ENAEA_AUTO__.S.manualNotes})');
    const manualKey0 = Object.keys(st.manual || {})[0] || '';
    rec('S5-nonvideo-marked-manual', manualCount >= 1 && /课程A/.test(manualKey0), { manualCount, manualKey0, phase: st.phase });
    // rest should still auto-complete
    const fin = await poll(page, 'window.__ENAEA_AUTO__.S.phase', (v) => v === 'COMPLETED' || v === 'ERROR', 120000, 'rest-complete');
    rec('S5-rest-completes', fin === 'COMPLETED', { fin });
  } catch (e) { rec('S5-EXCEPTION', false, String(e)); }

  // ---------- Scenario 6: 平台把后面某集设为当前集时，仍从第一集(最小未完成)开始，不跳集 ----------
  try {
    const url = BASE + '?reset=1&seed=skip&' + PROJ + '&_t=' + Date.now();
    await page.goto(url, { timeout: 20000 });
    await ev(page, "localStorage.removeItem('enaea_state'); localStorage.removeItem('enaea_lock');");
    await inject(page);
    await boot(page);
    await poll(page, "!!(window.__ENAEA_AUTO__ && window.__ENAEA_AUTO__.S) && !!document.querySelector('.collapseList_test')", (v) => v, 10000, 'seed-ready');
    await ev(page, 'window.FIXTURE.activationLog = []');
    await ev(page, 'window.__ENAEA_AUTO__.Controls.start()');
    const phase = await poll(page, 'window.__ENAEA_AUTO__.S.phase', (v) => v === 'COMPLETED' || v === 'ERROR', 120000, 'skip-complete');
    const st = await ev(page, `(()=>{const d=window.FIXTURE.data;const co=d.chapters[0].sections[0].courses[0];return {phase:window.__ENAEA_AUTO__.S.phase, eps:co.episodes.map(e=>e.progress), log:(window.FIXTURE.activationLog||[]).slice(0,8), err:window.__ENAEA_AUTO__.S.lastError};})()`);
    rec('S6-start-from-first-episode', st.log[0] === 0, { first: st.log[0], log: st.log });
    rec('S6-all-episodes-100', st.eps.length === 3 && st.eps.every((p) => p >= 100), st.eps);
    rec('S6-completed', st.phase === 'COMPLETED', { phase: st.phase, err: st.err });
  } catch (e) { rec('S6-EXCEPTION', false, String(e)); }

  await task.finish({ keep: [] }).catch(() => {});
  const passed = results.filter((r) => r.ok).length;
  console.log('\n===== SUMMARY: ' + passed + '/' + results.length + ' passed =====');
  const failed = results.filter((r) => !r.ok);
  if (failed.length) console.log('FAILED:', JSON.stringify(failed, null, 1));
}

main().catch((e) => { console.error('DRIVER ERROR', e); process.exit(1); });
