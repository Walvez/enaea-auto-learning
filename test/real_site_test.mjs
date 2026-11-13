import fs from 'node:fs/promises';

const SRC = await fs.readFile('/Volumes/ExternalSSD/Codex/script/enaea-auto-learning.user.js', 'utf8');
const CAT = 'https://estudy.enaea.edu.cn/web/104/2120807708913364994/requiredCourse?path=requiredCourse&activity_id=2120808048562466817&plan_id=2120808046939271168&version=202611130949006&template_id=104&business_id=2120807708913364994';

const task = await taskSpace('enaea-auto-learning');
const page = await task.newPage();
await page.goto(CAT, { timeout: 60000 });
await page.waitForTimeout(5000);

// 记录「旧脚本(1.0.7，ScriptCat实例)」面板的初始显示（用于对照 bug）
const oldPanel = await page.evaluate(() => {
  const h = document.querySelector('#__enaea_panel_host__');
  if (!h || !h.shadowRoot) return null;
  const g = (id) => { const e = h.shadowRoot.querySelector('#' + id); return e ? e.textContent.replace(/\s+/g, ' ').trim() : null; };
  return { status: g('status'), course: g('course'), cprog: g('cprog'), done: g('donecount') };
});
console.log('OLD_PANEL', JSON.stringify(oldPanel));

// 移除 ScriptCat 实例的面板并清掉“已激活”标记，让 MAIN-world 的单实例可以启动（旧实例处于“待机”不会驱动导航）
const pre = await page.evaluate(() => {
  const h = document.querySelector('#__enaea_panel_host__'); if (h) h.remove();
  document.documentElement.removeAttribute('data-enaea-active');
  return { hosts: document.querySelectorAll('#__enaea_panel_host__').length };
});
console.log('PRE_CLEAN', JSON.stringify(pre));

// 注入最新版 1.0.8 到页面主世界
await page.evaluate((s) => { const el = document.createElement('script'); el.textContent = s; document.documentElement.appendChild(el); el.remove(); }, SRC);
await page.waitForFunction(() => !!window.__ENAEA_AUTO__, undefined, { timeout: 10000 });
const inj = await page.evaluate(() => ({ hosts: document.querySelectorAll('#__enaea_panel_host__').length, hasAuto: !!window.__ENAEA_AUTO__, ver: window.__ENAEA_AUTO__ && window.__ENAEA_AUTO__.CFG }));
console.log('INJECTED', JSON.stringify({ hosts: inj.hosts, hasAuto: inj.hasAuto }));

// 真正点击开始，在真实站点上跑
await page.evaluate(() => window.__ENAEA_AUTO__.Controls.start());

let hit = null;
for (let i = 0; i < 70; i++) {
  await page.waitForTimeout(1000);
  const st = await page.evaluate(() => {
    const S = window.__ENAEA_AUTO__.S;
    return { phase: S.phase, sub: S.sub, total: S.totalCourses, done: S.completedCount, cur: S.current ? S.current.title : null, err: S.lastError };
  });
  if (i % 4 === 0) console.log('T' + i, JSON.stringify(st));
  if (st.cur && /深入学习领会习近平党建思想的内涵体系/.test(st.cur)) { hit = st; break; }
  if (st.phase === 'ERROR' || st.phase === 'COMPLETED') { hit = st; break; }
}

const final = await page.evaluate(() => {
  const S = window.__ENAEA_AUTO__.S;
  const h = document.querySelector('#__enaea_panel_host__');
  let panel = null;
  if (h && h.shadowRoot) {
    const g = (id) => { const e = h.shadowRoot.querySelector('#' + id); return e ? e.textContent.replace(/\s+/g, ' ').trim() : null; };
    panel = { status: g('status'), course: g('course'), cprog: g('cprog'), done: g('donecount') };
  }
  return { phase: S.phase, sub: S.sub, total: S.totalCourses, done: S.completedCount, cur: S.current ? S.current.title : null, err: S.lastError, panel };
});
console.log('FINAL', JSON.stringify(final, null, 1));

try { await page.evaluate(() => window.__ENAEA_AUTO__.Controls.stop()); } catch (e) {}
const after = await page.evaluate(() => ({ phase: window.__ENAEA_AUTO__.S.phase }));
console.log('AFTER_STOP', JSON.stringify(after));

console.log('\n===== VERDICT =====');
const passSkip = final.done === 1 && final.total === 79;
const passNext = !!(final.cur && /深入学习领会习近平党建思想的内涵体系/.test(final.cur)) && !/党建文选/.test(final.cur || '');
console.log('completedCount/total =', final.done + '/' + final.total, passSkip ? 'PASS(完成课程已计为100并跳过)' : 'FAIL');
console.log('picked next course    =', final.cur, passNext ? 'PASS(未再进入已刷完的《党建文选》，进入了下一门)' : 'FAIL');
console.log('phase =', final.phase, 'err =', final.err);

await task.finish({ keep: [] }).catch(() => {});
