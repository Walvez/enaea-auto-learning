// ==UserScript==
// @name         中国教育干部网络学院 自动连续学习（新版 estudy）
// @namespace    https://estudy.enaea.edu.cn/
// @version      1.0.1
// @updateURL    https://raw.githubusercontent.com/Walvez/enaea-auto-learning/main/enaea-auto-learning.user.js
// @downloadURL  https://raw.githubusercontent.com/Walvez/enaea-auto-learning/main/enaea-auto-learning.user.js
// @description  新版 estudy.enaea.edu.cn 自动顺序学习：保持 1.0x 正常播放，播放完自动切换下一集/下一课程/下一小节/下一大章；跨页保存进度；右下角控制面板。仅在本学习项目内生效，不改写服务器记录、不倍速、不拖进度条。
// @author       enaea-auto-learning
// @match        https://estudy.enaea.edu.cn/web/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* =========================================================================
   *  重要说明
   *  - 本脚本只“顺序正常播放”视频：固定 1.0x，不拖动进度条，不伪造学时。
   *  - 完成判定以站点“正式展示的进度”为准：
   *      · 课程目录页：课程圆环 aria-valuenow（0-100，100=完成）
   *      · 播放器目录：分集右侧进度 aria-valuenow（0-100）
   *    不读取、不保存、不导出任何 Cookie/Token，不调用写接口。
   *  - 仅作用于 business_id / activity_id 匹配的当前学习项目。
   * ========================================================================= */

  /* ------------------------------ 配置 ------------------------------ */
  const CFG = {
    businessId: '2120807708913364994',
    activityId: '2120808048562466817',
    // 课程目录页兜底地址（当脚本启动时不在目录/播放器页面时用于导航）
    catalogUrl:
      'https://estudy.enaea.edu.cn/web/104/2120807708913364994/requiredCourse' +
      '?path=requiredCourse&activity_id=2120808048562466817' +
      '&plan_id=2120808046939271168&version=202611130949006' +
      '&template_id=104&business_id=2120807708913364994',

    playbackRate: 1.0,
    syncWaitMs: 4500,          // 视频结束后等待平台同步的毫秒数
    episodeSelectTimeout: 15000,
    playerReadyTimeout: 30000,
    courseAttemptCap: 4,       // 同一课程最多进入次数（无进展则标记人工）
    errorCap: 12,              // 连续异常上限
    scanStableMs: 900,
    stallMs: 150000,           // 播放位置长时间不动判定卡住
    debug: true,
  };

  /* ------------------------------ 工具 ------------------------------ */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = () => Date.now();
  const log = (...a) => { if (CFG.debug) { try { console.log('%c[ENAEA]', 'color:#3b70ff', ...a); } catch (e) {} } };
  const round = (n) => Math.round(n);

  async function waitUntil(fn, { timeout = 15000, interval = 250, label = '' } = {}) {
    const t0 = now();
    for (;;) {
      let v;
      try { v = await fn(); } catch (e) { v = false; }
      if (v) return v;
      if (now() - t0 > timeout) throw new Error('waitUntil timeout: ' + (label || fn.name || 'condition'));
      await sleep(interval);
    }
  }

  /* --------------------------- GM 存储封装 --------------------------- */
  async function sget(key) {
    key = 'enaea_' + key;
    try {
      if (typeof GM_getValue === 'function') { const v = GM_getValue(key); return v === undefined ? null : v; }
      if (typeof GM !== 'undefined' && GM && typeof GM.getValue === 'function') return await GM.getValue(key, null);
    } catch (e) {}
    try { const s = localStorage.getItem(key); return s == null ? null : JSON.parse(s); } catch (e) { return null; }
  }
  async function sset(key, val) {
    key = 'enaea_' + key;
    try {
      if (typeof GM_setValue === 'function') { GM_setValue(key, val); return; }
      if (typeof GM !== 'undefined' && GM && typeof GM.setValue === 'function') { await GM.setValue(key, val); return; }
    } catch (e) {}
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }

  /* ------------------------------ 状态 ------------------------------ */
  const PHASE = {
    IDLE: 'IDLE', RUNNING: 'RUNNING', PAUSED: 'PAUSED', STOPPED: 'STOPPED',
    COMPLETED: 'COMPLETED', ERROR: 'ERROR',
  };

  const S = {
    phase: PHASE.IDLE,
    sub: 'IDLE',                 // 当前子步骤（展示用）
    tabId: Math.random().toString(36).slice(2) + now().toString(36),
    current: null,               // {key, chapter, section, title, progress}
    lastOpenedKey: null,
    attemptByKey: {},            // key -> 进入次数
    doneKeys: {},                // key -> true（本地认为完成）
    manualKeys: {},              // 需要人工处理（VR/测验/卡住）
    manualNotes: {},             // key -> 原因
    completedCount: 0,
    totalCourses: 0,
    lastError: '',
    errorStreak: 0,
    catalogUrl: CFG.catalogUrl,
    lock: null,                  // {owner, ts}
    lastTick: now(),
  };

  let saveTimer = null;
  function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      S.lastTick = now();
      await sset('state', {
        phase: S.phase, sub: S.sub, current: S.current,
        lastOpenedKey: S.lastOpenedKey, attemptByKey: S.attemptByKey,
        doneKeys: S.doneKeys, manualKeys: S.manualKeys, manualNotes: S.manualNotes,
        completedCount: S.completedCount, totalCourses: S.totalCourses,
        lastError: S.lastError, catalogUrl: S.catalogUrl, ts: now(),
      });
    }, 120);
  }

  async function loadState() {
    const st = await sget('state');
    if (st && typeof st === 'object') {
      S.phase = st.phase || PHASE.IDLE;
      S.sub = st.sub || 'IDLE';
      S.current = st.current || null;
      S.lastOpenedKey = st.lastOpenedKey || null;
      S.attemptByKey = st.attemptByKey || {};
      S.doneKeys = st.doneKeys || {};
      S.manualKeys = st.manualKeys || {};
      S.manualNotes = st.manualNotes || {};
      S.completedCount = st.completedCount || 0;
      S.totalCourses = st.totalCourses || 0;
      S.lastError = st.lastError || '';
      S.catalogUrl = st.catalogUrl || CFG.catalogUrl;
      // 运行态来自上次运行，若为运行/暂停则保持；其它状态不自动恢复
      if (![PHASE.RUNNING, PHASE.PAUSED].includes(S.phase)) S.phase = PHASE.IDLE;
      if (S.phase === PHASE.PAUSED) S.phase = PHASE.IDLE; // 关闭前是暂停 => 重新打开需手动继续
    }
  }

  function setPhase(p, sub) {
    S.phase = p;
    if (sub) S.sub = sub;
    S.lastTick = now();
    save();
    updatePanel();
  }

  /* --------------------------- 页面/项目判定 --------------------------- */
  function params() { try { return new URLSearchParams(location.search); } catch (e) { return new URLSearchParams(''); } }

  function projectMatches() {
    const p = params();
    const bid = p.get('business_id');
    const aid = p.get('activity_id');
    if (bid && bid !== CFG.businessId) return false;
    if (aid && CFG.activityId && aid !== CFG.activityId) return false;
    if (!bid && !location.pathname.includes(CFG.businessId)) return false;
    return true;
  }

  function isPlayerPage() {
    if (/\/web\/player\/project/.test(location.pathname)) return true;
    try { if (/\/player\//.test(location.pathname)) return true; } catch (e) {}
    // 播放器页特征：返回目录图标 / 播放器容器；即使是无视频的 VR/测验页也需识别，避免被误判后跳转
    if (document.querySelector('[class*="return-icon_"]')) return true;
    if (document.querySelector('[class*="play-list_"]') || document.querySelector('[class*="playList"]')) return true;
    if (document.querySelector('video') && document.querySelector('[class*="play-list"]')) return true;
    return false;
  }
  function isCatalogPage() {
    if (/requiredCourse|optionalCourse|courseList/i.test(location.pathname)) return true;
    return !!document.querySelector('[class*="collapseList_"]') && !!document.querySelector('[class*="section-box_"]');
  }

  /* ------------------------------ 选择器 ------------------------------ */
  // 站点为 CSS Modules（localName_hash），hash 随发版改变，故一律用 [class*="localName_"] 前缀匹配。
  const SEL = {
    collapseItem: '.grt-collapse-item',
    collapseHeader: '.grt-collapse-header',
    collapseContent: '.grt-collapse-content',
    sectionBox: '[class*="section-box_"]',
    listTitle: '[class*="list-title_"]',
    progressLabel: '[class*="progress-label_"]',
    progressBar: '[role="progressbar"]',
    itemWrap: '[class*="item-wrap_"]',
    episodeName: '[class*="name-span_"]',
    rateSpan: '[class*="rate-span_"]',
    playList: '[class*="play-list"]',
    returnIcon: '[class*="return-icon_"]',
  };

  function qa(sel, root = document) { try { return Array.prototype.slice.call(root.querySelectorAll(sel)); } catch (e) { return []; } }
  function q(sel, root = document) { try { return root.querySelector(sel); } catch (e) { return null; } }
  function collapseDepth(el) { let d = 0, p = el.parentElement; while (p) { if (p.classList && p.classList.contains('grt-collapse-item')) d++; p = p.parentElement; } return d; }
  function headerTitle(item) {
    const h = item.querySelector(':scope > ' + SEL.collapseHeader);
    if (!h) return '';
    // 去掉 svg/图片，只取文本
    const clone = h.cloneNode(true);
    qa('svg,img', clone).forEach((n) => n.remove());
    return (clone.textContent || '').replace(/\s+/g, ' ').trim();
  }
  function itemActive(item) {
    const c = item.querySelector(':scope > ' + SEL.collapseContent);
    return !!(item.classList.contains('grt-collapse-item-active') || (c && c.classList.contains('grt-collapse-content-active')));
  }
  function courseTitle(box) {
    const tt = box.querySelector(SEL.listTitle);
    if (!tt) return (box.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const span = tt.querySelector('span');
    return ((span || tt).textContent || '').replace(/\s+/g, ' ').trim();
  }
  function parsePct(txt) { const m = String(txt || '').match(/(\d+(?:\.\d+)?)\s*%/); return m ? parseFloat(m[1]) : null; }
  function courseProgress(box) {
    const bar = box.querySelector(SEL.progressBar);
    if (bar) { const v = parseFloat(bar.getAttribute('aria-valuenow')); if (!isNaN(v)) return v; }
    const lab = box.querySelector(SEL.progressLabel);
    const p = parsePct(lab ? lab.textContent : '');
    return p == null ? 0 : p;
  }
  function courseHasDuration(box) { return /时长\s*[:：]?\s*\d{1,2}\s*[:：]\s*\d{2}/.test((box.textContent || '')); }

  /* --------------------------- 目录扫描 --------------------------- */
  async function expandAllCollapses() {
    // 逐层展开：只点“未展开”的头部；大章展开后其下小节才出现，故多轮。
    for (let pass = 0; pass < 8; pass++) {
      const items = qa(SEL.collapseItem);
      let clicked = 0;
      for (const it of items) {
        const h = it.querySelector(':scope > ' + SEL.collapseHeader);
        if (!h) continue;
        if (!itemActive(it)) {
          try { h.click(); } catch (e) {}
          clicked++;
        }
      }
      await sleep(500);
      if (clicked === 0) break;
    }
  }

  async function waitCourseListStable() {
    let last = -1, stable = 0;
    const t0 = now();
    while (now() - t0 < 20000) {
      const n = qa(SEL.sectionBox).length;
      if (n === last && n > 0) { stable += 250; if (stable >= CFG.scanStableMs) return n; }
      else { stable = 0; last = n; }
      await sleep(250);
    }
    return qa(SEL.sectionBox).length;
  }

  async function scanCatalog() {
    await expandAllCollapses();
    await waitCourseListStable();
    const tops = qa(SEL.collapseItem).filter((it) => collapseDepth(it) === 0);
    const chapters = [];
    for (const top of tops) {
      const chapterTitle = headerTitle(top);
      const subs = Array.prototype.slice.call(top.querySelectorAll(SEL.collapseItem)).filter((it) => collapseDepth(it) === 1);
      const sections = [];
      for (const sub of subs) {
        const sectionTitle = headerTitle(sub);
        const boxes = Array.prototype.slice.call(sub.querySelectorAll(SEL.sectionBox));
        const courses = boxes.map((box) => {
          const title = courseTitle(box);
          const progress = courseProgress(box);
          return {
            title, progress,
            hasDuration: courseHasDuration(box),
            chapter: chapterTitle, section: sectionTitle,
            key: chapterTitle + '§' + sectionTitle + '§' + title,
          };
        });
        sections.push({ title: sectionTitle, courses });
      }
      chapters.push({ title: chapterTitle, sections });
    }
    return chapters;
  }

  function flatten(chapters) {
    const out = [];
    for (const c of chapters) for (const s of c.sections) for (const co of s.courses) out.push(co);
    return out;
  }

  function pickNextCourse(chapters) {
    const all = flatten(chapters);
    S.totalCourses = all.length;
    S.completedCount = all.filter((c) => c.progress >= 100).length;
    for (const c of all) {
      if (S.manualKeys[c.key]) continue;
      if (c.progress >= 100) continue;
      return c;
    }
    return null;
  }

  function findCourseElement(key) {
    const boxes = qa(SEL.sectionBox);
    for (const box of boxes) {
      // 计算该 box 所属大章/小节
      let chapter = '', section = '';
      let p = box.parentElement;
      while (p) {
        if (p.classList && p.classList.contains('grt-collapse-item')) {
          const t = headerTitle(p);
          if (collapseDepth(p) === 1 && !section) section = t;
          if (collapseDepth(p) === 0 && !chapter) chapter = t;
        }
        p = p.parentElement;
      }
      const k = chapter + '§' + section + '§' + courseTitle(box);
      if (k === key) return box;
    }
    return null;
  }

  /* --------------------------- 导航动作 --------------------------- */
  async function enterCourse(course) {
    // 统计进入次数
    S.attemptByKey[course.key] = (S.attemptByKey[course.key] || 0) + 1;
    S.lastOpenedKey = course.key;
    S.current = { key: course.key, chapter: course.chapter, section: course.section, title: course.title, progress: course.progress };
    save();
    setPhase(S.phase, 'SELECTING');
    const el = findCourseElement(course.key);
    if (!el) throw new Error('未找到课程元素: ' + course.title);
    const clickTarget = el.querySelector(SEL.listTitle) || el;
    clickTarget.click();
    // 等待进入播放器
    await waitUntil(() => isPlayerPage(), { timeout: 20000, label: 'enter player' });
    await waitForPlayerReady();
  }

  async function goToCatalog() {
    if (!isPlayerPage()) return;
    setPhase(S.phase, 'NEXT_COURSE');
    const ret = document.querySelector(SEL.returnIcon);
    if (ret) { ret.click(); }
    else {
      // 兜底：找到含“课程学习”的可点元素
      const el = qa('span,div,a').find((e) => (e.textContent || '').trim() === '课程学习' && e.getBoundingClientRect().top < 160);
      if (el) el.click(); else location.href = S.catalogUrl;
    }
    await waitUntil(() => isCatalogPage(), { timeout: 20000, label: 'back to catalog' });
    await waitCourseListStable();
  }

  /* --------------------------- 播放器辅助 --------------------------- */
  // 收集主文档 + 同源 iframe 内的所有 video（部分课程播放器可能嵌在同源 iframe 中）
  function collectVideos() {
    let out = qa('video');
    const frames = qa('iframe');
    for (const f of frames) {
      try { const d = f.contentDocument; if (d) out = out.concat(Array.prototype.slice.call(d.querySelectorAll('video'))); } catch (e) {}
    }
    return out;
  }
  function videoUsable(v) { return !!v && (v.readyState > 0 || (isFinite(v.duration) && v.duration > 0) || !!v.currentSrc); }
  function getVideo() {
    const all = collectVideos();
    const vids = all.filter(videoUsable);
    return vids[0] || all[0] || null;
  }
  // 等待 video 真正出现并可用（应对 xgplayer 切集/进课时对 <video> 的销毁重建）
  async function waitForVideo(timeout) {
    const t0 = now();
    let last = null;
    while (now() - t0 < (timeout || CFG.playerReadyTimeout)) {
      if ([PHASE.STOPPED, PHASE.ERROR, PHASE.IDLE].includes(S.phase)) return null;
      const v = getVideo();
      last = v;
      if (videoUsable(v)) return v;
      await sleep(250);
    }
    return last || getVideo();
  }

  async function waitForPlayerReady() {
    await waitUntil(() => isPlayerPage(), { timeout: CFG.playerReadyTimeout, label: 'player page' });
    // 视频或目录二者至少就绪
    await waitUntil(() => {
      const v = getVideo();
      const hasList = qa(SEL.itemWrap).length > 0;
      return (v && (v.duration > 0 || v.readyState >= 2)) || hasList;
    }, { timeout: CFG.playerReadyTimeout, label: 'player ready' });
    await sleep(600);
  }

  function readEpisodes() {
    const items = qa(SEL.itemWrap);
    return items.map((it, i) => {
      const nameEl = it.querySelector(SEL.episodeName) || it;
      const bar = it.querySelector(SEL.progressBar);
      let aria = null;
      if (bar) { const v = parseFloat(bar.getAttribute('aria-valuenow')); if (!isNaN(v)) aria = v; }
      if (aria == null) { const rs = it.querySelector(SEL.rateSpan); if (rs) aria = parsePct(rs.textContent); }
      const active = it.getAttribute('data-checked') === 'true';
      return { index: i, title: (nameEl.textContent || '').replace(/\s+/g, ' ').trim(), aria, active, el: it };
    });
  }

  function activeEpisodeIndex() {
    const eps = readEpisodes();
    const a = eps.find((e) => e.active);
    return a ? a.index : -1;
  }

  async function ensurePlaybackRate() {
    const v = getVideo();
    if (!v) return;
    if (Math.abs((v.playbackRate || 1) - CFG.playbackRate) > 0.001) {
      try { v.playbackRate = CFG.playbackRate; } catch (e) {}
    }
  }

  function clearLastErrorIfBenign() {
    if (!gestureGateArmed && S._mutedNote) { S.lastError = S._mutedNote; updatePanel(); }
  }
  async function ensurePlaying() {
    // 暂停/停止/出错状态下绝不主动播放
    if (S.phase === PHASE.PAUSED || S.phase === PHASE.STOPPED || S.phase === PHASE.ERROR || S.phase === PHASE.IDLE) return;
    // 关键：视频可能刚开始/切集时被销毁重建，等待它真正出现，而不是一发现没有就报错退出
    const v = await waitForVideo(CFG.playerReadyTimeout);
    if (!v) throw new Error('无 video 元素（等待超时）');
    await ensurePlaybackRate();
    if (v.paused) {
      // 若之前已判定需要静音自动播放，则保持静音，避免“取消静音”再次触发浏览器拦截
      if (S._mutedAutoplay) { try { v.muted = true; } catch (_) {} }
      try {
        await v.play();
      } catch (e) {
        // 严格自动播放策略：静音播放取得播放权（不改倍速、不拖动）；保持静音以保证连续播放
        try {
          v.muted = true;
          S._mutedAutoplay = true;
          await v.play();
          S._mutedNote = '提示：浏览器限制自动播放，已静音自动播放（学时仍正常累计）；点击页面任意处可恢复声音。';
          S.lastError = S._mutedNote;
          installUnmuteOnGesture();
          updatePanel();
        } catch (e2) {
          // 静音仍被拦截：提示用户点击页面一次（保留兜底）
          armGestureGate();
          throw new Error('AUTOPLAY_BLOCKED');
        }
      }
      S.errorStreak = 0;
    }
    clearLastErrorIfBenign();
  }

  let gestureGateArmed = false;
  let unmuteArmed = false;
  function installUnmuteOnGesture() {
    if (unmuteArmed) return; unmuteArmed = true;
    const h = async () => {
      document.removeEventListener('click', h, true);
      document.removeEventListener('keydown', h, true);
      unmuteArmed = false;
      const v = getVideo();
      try { if (v) v.muted = false; } catch (e) {}
      S._mutedAutoplay = false; S._mutedNote = '';
      if (S.lastError && /静音/.test(S.lastError)) { S.lastError = ''; updatePanel(); }
    };
    document.addEventListener('click', h, true);
    document.addEventListener('keydown', h, true);
  }

  function armGestureGate() {
    if (gestureGateArmed) return;
    gestureGateArmed = true;
    setPhase(S.phase, 'WAITING_USER_GESTURE');
    S.lastError = '浏览器拦截了自动播放，请在页面上点击一次以继续。';
    updatePanel();
    const handler = async () => {
      document.removeEventListener('click', handler, true);
      document.removeEventListener('keydown', handler, true);
      gestureGateArmed = false;
      S._mutedAutoplay = false; S._mutedNote = '';
      const v = getVideo();
      try { if (v) { v.muted = false; await v.play(); } } catch (e) {}
      S.lastError = '';
      updatePanel();
    };
    document.addEventListener('click', handler, true);
    document.addEventListener('keydown', handler, true);
  }

  function videoTimeInfo() {
    const v = getVideo();
    if (!v) return { cur: 0, dur: 0, rate: 1, paused: true };
    return { cur: v.currentTime || 0, dur: v.duration || 0, rate: v.playbackRate || 1, paused: !!v.paused };
  }

  async function selectEpisode(index) {
    const eps = readEpisodes();
    const target = eps.find((e) => e.index === index);
    if (!target) throw new Error('分集不存在: ' + index);
    if (target.active) return; // 已经是当前集
    const nameEl = target.el.querySelector(SEL.episodeName) || target.el;
    nameEl.click();
    // 等待该集变为 active 且视频就绪
    await waitUntil(() => {
      const eps2 = readEpisodes();
      const t = eps2.find((e) => e.index === index);
      const v = getVideo();
      return t && t.active && videoUsable(v);
    }, { timeout: CFG.episodeSelectTimeout, label: 'episode active' });
    await sleep(400);
  }

  // 等待当前视频播完；支持暂停、停止、卡顿检测
  async function waitForEnded() {
    const v0 = getVideo();
    if (!v0) return 'novideo';
    let lastCT = -1, lastChange = now(), resumedForGesture = false;

    return await new Promise((resolve) => {
      let done = false;
      const finish = (reason) => {
        if (done) return; done = true;
        clearInterval(iv);
        const vv = getVideo(); if (vv) vv.removeEventListener('ended', onEnded);
        resolve(reason);
      };
      const onEnded = () => finish('ended');
      v0.addEventListener('ended', onEnded);
      const iv = setInterval(async () => {
        try {
          if (done) return;
          if ([PHASE.STOPPED, PHASE.COMPLETED, PHASE.ERROR, PHASE.IDLE].includes(S.phase)) { finish('stopped'); return; }
          const v = getVideo();
          if (!v) { finish('novideo'); return; }
          // 强制 1.0x
          if (Math.abs((v.playbackRate || 1) - CFG.playbackRate) > 0.001) { try { v.playbackRate = CFG.playbackRate; } catch (e) {} }
          if (v.ended) { finish('ended'); return; }
          if (v.duration && isFinite(v.duration) && v.currentTime >= v.duration - 0.6 && !v.paused) { finish('near-end'); return; }
          // 暂停态（用户暂停）：不结束，等待
          if (S.phase === PHASE.PAUSED) { lastChange = now(); lastCT = v.currentTime; return; }
          // 意外暂停（非用户暂停）尝试恢复
          if (v.paused) {
            try { if (S._mutedAutoplay) v.muted = true; await v.play(); } catch (e) { if (!resumedForGesture) { resumedForGesture = true; armGestureGate(); } }
          }
          // 卡顿检测
          if (Math.abs(v.currentTime - lastCT) > 0.3) { lastCT = v.currentTime; lastChange = now(); }
          else if (now() - lastChange > CFG.stallMs) { finish('stall'); }
        } catch (e) { /* ignore */ }
      }, 800);
    });
  }

  /* --------------------------- 单门课程处理 --------------------------- */
  async function handlePlayerCourse() {
    // 先判定“是否为可播放的视频课程”：等待出现（有 src 的视频）或有分集列表
    const t0 = now();
    let usable = false;
    while (now() - t0 < CFG.playerReadyTimeout) {
      const vv = getVideo();
      const ee = readEpisodes();
      if ((vv && (vv.currentSrc || (isFinite(vv.duration) && vv.duration > 0) || vv.readyState >= 1)) || ee.length > 0) { usable = true; break; }
      if ([PHASE.STOPPED, PHASE.ERROR, PHASE.IDLE].includes(S.phase)) break;
      await sleep(300);
    }
    // 既无视频也无分集：判定为 VR/测验/问卷等非视频项
    if (!usable && !getVideo() && readEpisodes().length === 0) return { status: 'no-video' };

    await waitForPlayerReady();
    // 每次进入课程都重新以“服务器/展示进度”为准，清空本次会话的本地完成记录
    for (const k in localDone) delete localDone[k];
    const v = getVideo();
    const eps = readEpisodes();
    if (!v && eps.length === 0) return { status: 'no-video' };

    // 单视频、无分集列表：当作一集处理
    if (eps.length === 0) {
      setPhase(S.phase, 'PLAYING');
      await ensurePlaying();
      const r = await waitForEnded();
      await sleep(CFG.syncWaitMs);
      return { status: r === 'novideo' ? 'no-video' : 'done' };
    }

    // 依据 aria 判定未完成分集
    let work = eps.filter((e) => !episodeEffectivelyDone(e));
    if (work.length === 0) return { status: 'all-done' };

    // 先恢复到未完成的最小 index
    let guard = 0;
    while (S.phase === PHASE.RUNNING || S.phase === PHASE.PAUSED) {
      // 暂停：立即暂停真实视频并原地等待，绝不切到下一集
      if (S.phase === PHASE.PAUSED) {
        const vp = getVideo();
        if (vp && !vp.paused) { try { vp.pause(); } catch (e) {} }
        await sleep(400);
        continue;
      }
      const epsNow = readEpisodes();
      const firstUnfinished = epsNow.find((e) => !episodeEffectivelyDone(e));
      if (!firstUnfinished) break;

      setPhase(S.phase, 'NEXT_EPISODE');
      S.currentEpisode = { index: firstUnfinished.index, title: firstUnfinished.title };
      updatePanel();
      try {
        await selectEpisode(firstUnfinished.index);
        if (S.phase === PHASE.STOPPED || S.phase === PHASE.ERROR) break;
        if (S.phase === PHASE.PAUSED) continue;
        setPhase(S.phase, 'PLAYING');
        await ensurePlaying();
        if (S.phase === PHASE.PAUSED || S.phase === PHASE.STOPPED) { if (S.phase === PHASE.PAUSED) continue; break; }
        // 检查 playbackRate
        await ensurePlaybackRate();
        const r = await waitForEnded();
        if (r === 'stopped') break;
        if (r === 'novideo') return { status: 'no-video' };
        if (S.phase === PHASE.STOPPED || S.phase === PHASE.ERROR) break;
        setPhase(S.phase, 'WAITING_CONFIRMATION');
        await sleep(CFG.syncWaitMs);
        if (S.phase === PHASE.STOPPED || S.phase === PHASE.ERROR) break;
        // 标记为本地完成（后续以目录页 aria 复核）
        markEpisodeDoneLocal(firstUnfinished.index);
      } catch (e) {
        if (/AUTOPLAY_BLOCKED/.test(e.message)) {
          // 等待用户手势期间暂停循环
          await waitUntil(() => !gestureGateArmed || S.phase !== PHASE.RUNNING, { timeout: 10 * 60 * 1000, label: 'gesture' }).catch(() => {});
        } else {
          throw e;
        }
      }
      if (++guard > 200) throw new Error('分集循环保护触发');
    }
    return { status: 'done' };
  }

  // 本地记录：把当前课程的某一集标记完成（用于本会话内跳过，最终以目录 aria 为准）
  const localDone = {}; // key#index -> true
  function currentCourseKeyPrefix() { return S.current ? S.current.key : ''; }
  function markEpisodeDoneLocal(index) {
    const k = currentCourseKeyPrefix() + '#' + index;
    localDone[k] = true;
  }
  // 让 readEpisodes 的 aria 也受本地完成影响：这里采用在 handle 里过滤时叠加 localDone
  function episodeEffectivelyDone(e) {
    if (localDone[currentCourseKeyPrefix() + '#' + e.index]) return true;
    return e.aria != null && e.aria >= 100;
  }

  /* --------------------------- 引擎主循环 --------------------------- */
  let loopAlive = false;
  async function engineLoop() {
    if (loopAlive) return;
    loopAlive = true;
    log('engine loop start');
    try {
      while (S.phase === PHASE.RUNNING || S.phase === PHASE.PAUSED) {
        if (S.phase === PHASE.PAUSED) {
          const v = getVideo(); if (v && !v.paused) { try { v.pause(); } catch (e) {} }
          await sleep(600);
          continue;
        }
        try {
          if (isCatalogPage()) {
            await stepCatalog();
          } else if (isPlayerPage()) {
            await stepPlayer();
          } else {
            // 不在目标页面：若曾有目录地址则跳回，否则提示
            setPhase(S.phase, 'WAITING_PAGE');
            if (S.catalogUrl && now() - (S._lastRedirect || 0) > 15000) {
              S._lastRedirect = now();
              location.href = S.catalogUrl;
            }
            await sleep(1500);
          }
          S.errorStreak = 0;
        } catch (e) {
          await handleStepError(e);
        }
      }
    } finally {
      loopAlive = false;
      log('engine loop end');
    }
  }

  async function stepCatalog() {
    setPhase(S.phase, 'SCANNING');
    const chapters = await scanCatalog();
    const next = pickNextCourse(chapters);
    updatePanel();
    if (!next) {
      // 没有未完成课程：区分是否有“人工处理”项
      const all = flatten(chapters);
      const manualCount = all.filter((c) => S.manualKeys[c.key]).length;
      const unfinished = all.filter((c) => c.progress < 100 && !S.manualKeys[c.key]).length;
      if (unfinished === 0) {
        setPhase(PHASE.COMPLETED, 'COMPLETED');
        S.lastError = manualCount ? ('已完成全部可自动课程；' + manualCount + ' 门需人工处理（见 TEST/面板）。') : '';
        updatePanel();
        return;
      }
      setPhase(PHASE.ERROR, 'ERROR');
      S.lastError = '未找到可继续的未完成课程（可能全部卡住或需人工处理）。';
      updatePanel();
      return;
    }
    await enterCourse(next);
  }

  async function stepPlayer() {
    // 若当前不在本项目对应课程，返回目录
    const res = await handlePlayerCourse();
    if (res.status === 'no-video') {
      // 记为需要人工处理（VR/测验/异常）
      if (S.current) {
        S.manualKeys[S.current.key] = true;
        S.manualNotes[S.current.key] = '进入后未检测到视频播放器（可能为 VR/测验/问卷或加载失败）';
      }
      save();
      await goToCatalog();
      return;
    }
    // 课程处理后返回目录复核
    await goToCatalog();
  }

  async function handleStepError(e) {
    S.errorStreak = (S.errorStreak || 0) + 1;
    S.lastError = String(e && e.message ? e.message : e);
    save(); updatePanel();
    log('step error:', S.lastError, 'streak', S.errorStreak);
    // 同一课程尝试次数保护
    if (S.current) {
      const key = S.current.key;
      if ((S.attemptByKey[key] || 0) >= CFG.courseAttemptCap) {
        S.manualKeys[key] = true;
        S.manualNotes[key] = '多次尝试未通过（' + S.lastError + '）';
        S.lastError = '课程多次尝试失败，已标记人工：' + S.current.title;
        save();
        try { await goToCatalog(); } catch (e2) {}
        S.errorStreak = 0;
        return;
      }
    }
    if (S.errorStreak >= CFG.errorCap) {
      setPhase(PHASE.ERROR, 'ERROR');
      return;
    }
    await sleep(3000 * Math.min(S.errorStreak, 4));
    // 尽量回到目录重新定位
    try { if (isPlayerPage()) await goToCatalog(); } catch (e3) {}
  }

  /* --------------------------- 多标签锁 --------------------------- */
  async function acquireLock() {
    const l = await sget('lock');
    if (l && l.owner && l.owner !== S.tabId && now() - (l.ts || 0) < 12000) {
      return false;
    }
    await sset('lock', { owner: S.tabId, ts: now() });
    return true;
  }
  async function heartbeatLock() {
    if (S.phase !== PHASE.RUNNING && S.phase !== PHASE.PAUSED) return;
    const l = await sget('lock');
    if (!l || l.owner === S.tabId || now() - (l.ts || 0) >= 12000) {
      await sset('lock', { owner: S.tabId, ts: now() });
    }
  }
  async function releaseLock() {
    const l = await sget('lock');
    if (l && l.owner === S.tabId) await sset('lock', { owner: '', ts: 0 });
  }

  /* --------------------------- 控制动作 --------------------------- */
  const Controls = {
    async start() {
      if (S.phase === PHASE.RUNNING) return;
      const ok = await acquireLock();
      if (!ok) {
        S.lastError = '检测到另一个标签页正在运行自动学习，已阻止本页启动。';
        updatePanel();
        return;
      }
      // 若当前不在目录/播放器页，先回目录
      S.lastError = '';
      S.errorStreak = 0;
      setPhase(PHASE.RUNNING, 'SCANNING');
      // 若在目标站的其他页，跳到目录
      if (!isCatalogPage() && !isPlayerPage()) {
        try { location.href = S.catalogUrl; return; } catch (e) {}
      }
      engineLoop();
    },
    async pause() {
      if (S.phase !== PHASE.RUNNING) return;
      setPhase(PHASE.PAUSED, 'PAUSED');
      // 立即暂停真实视频，避免引擎阻塞在 waitForEnded 中时暂停不生效
      const v = getVideo(); if (v && !v.paused) { try { v.pause(); } catch (e) {} }
      updatePanel();
    },
    async resume() {
      if (S.phase === PHASE.PAUSED) {
        setPhase(PHASE.RUNNING, 'RESUME');
        const v = getVideo(); if (v && v.paused && !v.ended) { try { const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {} }
        engineLoop();
      } else if (S.phase === PHASE.STOPPED || S.phase === PHASE.IDLE) { await Controls.start(); }
    },
    async stop() {
      // 手动停止：暂停视频，进入 STOPPED，不自动重启
      if (S.phase === PHASE.COMPLETED) return;
      setPhase(PHASE.STOPPED, 'STOPPED');
      const v = getVideo(); if (v && !v.paused) { try { v.pause(); } catch (e) {} }
      await releaseLock();
      // 停止后不自动恢复：清除运行态
      S.phase = PHASE.STOPPED;
      save();
    },
    async rescan() {
      try {
        if (isPlayerPage()) await goToCatalog();
        if (isCatalogPage()) {
          const ch = await scanCatalog();
          pickNextCourse(ch);
          S.lastError = '';
          updatePanel();
        }
      } catch (e) { S.lastError = '重新扫描失败: ' + e.message; updatePanel(); }
    },
  };

  /* --------------------------- 面板 UI --------------------------- */
  let panelHost = null, panelRoot = null, panelEls = {};

  function buildPanel() {
    if (panelHost) return;
    panelHost = document.createElement('div');
    panelHost.id = '__enaea_panel_host__';
    panelHost.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;';
    panelRoot = panelHost.attachShadow ? panelHost.attachShadow({ mode: 'open' }) : panelHost;
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <style>
        *{box-sizing:border-box;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;}
        .card{width:300px;background:#fff;border:1px solid #dbe0ee;border-radius:12px;box-shadow:0 8px 28px rgba(20,40,90,.18);overflow:hidden;font-size:12px;color:#222;}
        .hd{display:flex;align-items:center;gap:8px;padding:8px 12px;background:linear-gradient(135deg,#3b70ff,#5b8cff);color:#fff;font-weight:600;}
        .hd .dot{width:8px;height:8px;border-radius:50%;background:#9fe0a0;}
        .hd .dot.run{background:#b8ff9f;box-shadow:0 0 8px #9dff7a;}
        .hd .dot.pause{background:#ffd27a;}.hd .dot.err{background:#ff9a9a;}.hd .dot.done{background:#7ee0ff;}
        .hd .title{flex:1;}
        .hd .mini{cursor:pointer;padding:0 6px;opacity:.9;}
        .bd{padding:10px 12px;max-height:70vh;overflow:auto;}
        .row{display:flex;gap:6px;margin:3px 0;line-height:1.35;}
        .row .k{color:#7a8699;flex:0 0 84px;}
        .row .v{flex:1;word-break:break-all;}
        .bar{height:6px;background:#eef2fb;border-radius:4px;overflow:hidden;margin:6px 0;}
        .bar>i{display:block;height:100%;width:0;background:#3b70ff;transition:width .3s;}
        .btns{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;}
        button{cursor:pointer;border:1px solid #cfd8ee;background:#f7f9ff;color:#274;border-radius:8px;padding:5px 9px;font-size:12px;}
        button:hover{background:#eef3ff;}
        button.primary{background:#3b70ff;color:#fff;border-color:#3b70ff;}
        button.danger{background:#fff1f1;color:#c0392b;border-color:#f3c9c9;}
        button:disabled{opacity:.45;cursor:not-allowed;}
        .err{color:#c0392b;margin-top:6px;word-break:break-all;}
        .collapsed .bd{display:none;}
        .tag{font-size:10px;background:#eef3ff;color:#3b70ff;border-radius:6px;padding:1px 6px;}
      </style>
      <div class="card" id="card">
        <div class="hd">
          <span class="dot" id="dot"></span>
          <span class="title" id="status">ENAEA 自动学习</span>
          <span class="mini" id="toggle">—</span>
        </div>
        <div class="bd">
          <div class="row"><span class="k">当前大章</span><span class="v" id="chapter">-</span></div>
          <div class="row"><span class="k">当前小节</span><span class="v" id="section">-</span></div>
          <div class="row"><span class="k">当前课程</span><span class="v" id="course">-</span></div>
          <div class="row"><span class="k">当前分集</span><span class="v" id="episode">-</span></div>
          <div class="row"><span class="k">视频进度</span><span class="v" id="vprog">-</span></div>
          <div class="bar"><i id="vbar"></i></div>
          <div class="row"><span class="k">平台课程进度</span><span class="v" id="cprog">-</span></div>
          <div class="row"><span class="k">已完成课程</span><span class="v" id="donecount">-</span></div>
          <div class="row"><span class="k">播放速度</span><span class="v" id="rate">1.0x</span></div>
          <div class="row"><span class="k">最近错误</span><span class="v err" id="err">-</span></div>
          <div class="btns">
            <button class="primary" id="btnStart">开始自动学习</button>
            <button id="btnPause">暂停</button>
            <button id="btnResume">继续</button>
            <button class="danger" id="btnStop">停止</button>
            <button id="btnRescan">重新扫描目录</button>
          </div>
        </div>
      </div>`;
    panelRoot.appendChild(wrap);
    document.documentElement.appendChild(panelHost);
    panelEls = {
      card: panelRoot.getElementById('card'),
      dot: panelRoot.getElementById('dot'),
      status: panelRoot.getElementById('status'),
      toggle: panelRoot.getElementById('toggle'),
      chapter: panelRoot.getElementById('chapter'),
      section: panelRoot.getElementById('section'),
      course: panelRoot.getElementById('course'),
      episode: panelRoot.getElementById('episode'),
      vprog: panelRoot.getElementById('vprog'),
      vbar: panelRoot.getElementById('vbar'),
      cprog: panelRoot.getElementById('cprog'),
      donecount: panelRoot.getElementById('donecount'),
      rate: panelRoot.getElementById('rate'),
      err: panelRoot.getElementById('err'),
      btnStart: panelRoot.getElementById('btnStart'),
      btnPause: panelRoot.getElementById('btnPause'),
      btnResume: panelRoot.getElementById('btnResume'),
      btnStop: panelRoot.getElementById('btnStop'),
      btnRescan: panelRoot.getElementById('btnRescan'),
    };
    panelEls.btnStart.onclick = () => Controls.start();
    panelEls.btnPause.onclick = () => Controls.pause();
    panelEls.btnResume.onclick = () => Controls.resume();
    panelEls.btnStop.onclick = () => Controls.stop();
    panelEls.btnRescan.onclick = () => Controls.rescan();
    panelEls.toggle.onclick = () => {
      panelEls.card.classList.toggle('collapsed');
      panelEls.toggle.textContent = panelEls.card.classList.contains('collapsed') ? '+' : '—';
    };
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  const STATUS_TEXT = {
    IDLE: '待机（点击开始）', RUNNING: '运行中', PAUSED: '已暂停', STOPPED: '已停止',
    COMPLETED: '全部完成', ERROR: '异常需处理',
  };
  const SUB_TEXT = {
    SCANNING: '扫描目录', SELECTING: '选择课程', PLAYING: '正常播放', WAITING_CONFIRMATION: '等待平台确认',
    NEXT_EPISODE: '切换下一集', NEXT_COURSE: '返回目录/下一门', PAUSED: '已暂停', STOPPED: '已停止',
    WAITING_USER_GESTURE: '等待用户点击继续', WAITING_PAGE: '等待进入课程页', COMPLETED: '完成',
  };

  function updatePanel() {
    if (!panelEls.status) return;
    const p = S.phase;
    panelEls.status.textContent = 'ENAEA · ' + (STATUS_TEXT[p] || p) + (S.sub && SUB_TEXT[S.sub] ? ' / ' + SUB_TEXT[S.sub] : '');
    const dot = panelEls.dot;
    dot.className = 'dot' + (p === PHASE.RUNNING ? ' run' : p === PHASE.PAUSED ? ' pause' : p === PHASE.ERROR ? ' err' : p === PHASE.COMPLETED ? ' done' : '');
    const c = S.current || {};
    panelEls.chapter.textContent = c.chapter || '-';
    panelEls.section.textContent = c.section || '-';
    panelEls.course.textContent = c.title || '-';
    panelEls.episode.textContent = S.currentEpisode ? ('第' + (S.currentEpisode.index + 1) + '集 · ' + (S.currentEpisode.title || '')) : '-';
    const t = videoTimeInfo();
    if (t.dur > 0) {
      const pct = Math.min(100, (t.cur / t.dur) * 100);
      panelEls.vprog.textContent = fmtTime(t.cur) + ' / ' + fmtTime(t.dur) + ' (' + pct.toFixed(0) + '%)';
      panelEls.vbar.style.width = pct + '%';
    } else { panelEls.vprog.textContent = '-'; panelEls.vbar.style.width = '0'; }
    panelEls.cprog.textContent = (c.progress != null ? c.progress + '%' : '-') + (c.key && S.manualKeys[c.key] ? ' (人工)' : '');
    panelEls.donecount.textContent = (S.completedCount || 0) + ' / ' + (S.totalCourses || '?');
    panelEls.rate.textContent = (t.rate || 1).toFixed(1) + 'x';
    panelEls.err.textContent = S.lastError || '-';
    // 按钮可用性
    panelEls.btnStart.disabled = (p === PHASE.RUNNING || p === PHASE.PAUSED);
    panelEls.btnPause.disabled = (p !== PHASE.RUNNING);
    panelEls.btnResume.disabled = !(p === PHASE.PAUSED || p === PHASE.STOPPED || p === PHASE.IDLE);
    panelEls.btnStop.disabled = !(p === PHASE.RUNNING || p === PHASE.PAUSED);
  }

  /* --------------------------- 路由侦测 --------------------------- */
  function hookHistory() {
    const fire = () => { try { onRoute(); } catch (e) {} };
    for (const m of ['pushState', 'replaceState']) {
      const orig = history[m];
      if (orig && !orig.__enaeaHooked) {
        const wrapped = function () { const r = orig.apply(this, arguments); fire(); return r; };
        wrapped.__enaeaHooked = true;
        history[m] = wrapped;
      }
    }
    window.addEventListener('popstate', fire);
    window.addEventListener('hashchange', fire);
  }

  let lastHref = '';
  let routeTimer = null;
  function onRoute() {
    const href = location.href;
    if (href === lastHref) return;
    lastHref = href;
    if (routeTimer) clearTimeout(routeTimer);
    routeTimer = setTimeout(() => {
      buildPanel();
      updatePanel();
      // 若运行中且当前在目标页面，唤醒引擎（引擎循环本就在跑，这里主要处理刷新/直达页）
      if ((S.phase === PHASE.RUNNING) && !loopAlive) engineLoop();
    }, 400);
  }

  /* --------------------------- 启动引导 --------------------------- */
  async function boot() {
    if (window.__ENAEA_AUTO_BOOTED__) return;
    window.__ENAEA_AUTO_BOOTED__ = true;

    await loadState();

    if (!projectMatches()) {
      log('非目标学习项目，脚本待机不注入面板。');
      return; // 不在本项目不做任何事
    }

    hookHistory();
    buildPanel();
    updatePanel();

    // 记录目录地址
    if (isCatalogPage()) S.catalogUrl = location.href;

    // 周期性刷新面板与锁心跳
    setInterval(() => { updatePanel(); heartbeatLock(); }, 1000);

    // 交互后允许自动播放：记录一次全局手势
    const unlock = () => { S._gestureSeen = true; };
    document.addEventListener('click', unlock, { once: true, capture: true });

    // 自动恢复：若上次为运行态
    if (S.phase === PHASE.RUNNING) {
      log('检测到上次运行态，自动恢复');
      engineLoop();
    } else {
      S.phase = S.phase === PHASE.COMPLETED ? PHASE.COMPLETED : PHASE.IDLE;
      updatePanel();
    }

    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('▶ 开始自动学习', () => Controls.start());
      GM_registerMenuCommand('⏸ 暂停', () => Controls.pause());
      GM_registerMenuCommand('⏯ 继续', () => Controls.resume());
      GM_registerMenuCommand('⏹ 停止', () => Controls.stop());
      GM_registerMenuCommand('🔄 重新扫描目录', () => Controls.rescan());
    }
  }

  // 定期检测路由（无 pushState 场景兜底）
  setInterval(() => {
    if (!window.__ENAEA_AUTO_BOOTED__) return;
    if (location.href !== lastHref) onRoute();
  }, 1200);

  // 暴露测试钩子（供 fixture 自动化测试使用）
  window.__ENAEA_AUTO__ = {
    S, CFG, PHASE, Controls,
    scanCatalog, flatten, pickNextCourse, findCourseElement,
    readEpisodes, handlePlayerCourse, handleStepError,
    isCatalogPage, isPlayerPage, projectMatches,
    engineLoop, boot, updatePanel, markEpisodeDoneLocal, localDone,
    _internal: { getVideo, ensurePlaying, waitForEnded, selectEpisode, videoTimeInfo, enterCourse, goToCatalog, expandAllCollapses },
  };

  boot();
})();
