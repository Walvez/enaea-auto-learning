# 测试报告 · enaea-auto-learning.user.js

> 本报告明确区分 **真实站点勘察** 与 **本地夹具回归**，二者证据分开陈述。
> 真实站点只做**只读 DOM/行为勘察**（不把真实课程播放到底，避免真实消耗学时）；功能逻辑用**本地 SPA 夹具**做全流程回归。

---

## 0. 环境

| 项 | 值 |
|---|---|
| 时间 | 2026-11-13（Asia/Singapore） |
| 浏览器 | ego-browser v2.2.0 (macOS)，复用用户已登录会话（**不重新登录、不导出凭据**） |
| 平台 | https://estudy.enaea.edu.cn 新版（React SPA + grt 组件库） |
| 脚本 | `enaea-auto-learning.user.js`（node `--check` 语法通过，约 1016 行） |
| 夹具服务 | `python3 -m http.server 8791` 提供 `test/` 目录 |
| 夹具驱动 | `ego-browser nodejs < test/driver.mjs` |

---

## 1. 真实站点勘察结论（verified live，只读）

### 1.1 关键 URL

- 目录页（必修课）：
  `https://estudy.enaea.edu.cn/web/104/2120807708913364994/requiredCourse?path=requiredCourse&activity_id=2120808048562466817&plan_id=2120808046939271168&version=202611130949006&template_id=104&business_id=2120807708913364994`
- 播放页：
  `https://estudy.enaea.edu.cn/web/player/project?activity_id=2120808048562466817&business_id=2120807708913364994&task_id=...&template_id=104&resource_id=...`
- 当前项目：`business_id=2120807708913364994`，`activity_id=2120808048562466817`

### 1.2 目录页结构

- 根：`div.collapseList_sovk9192 > div.grt-collapse > 3× div.grt-collapse-item`（**大章**，默认展开）。
- 大章标题：`.grt-collapse-header > .grt-collapse-header-text > div.panel-header_*`。
- 大章内容：`.grt-collapse-content > .grt-collapse-content-box > .section-info_* > .sectionSecond-info_* > 嵌套 .grt-collapse > .grt-collapse-item`（**小节**，默认折叠）。
- 课程卡片：`.section-box_*`，内含 `[class*=list-title_] > span`（标题）、`[role="progressbar"][aria-valuenow]`（0–100）、`[class*=progress-label_]`（"N%"）、时长、讲师。
- **层级判定**：课程到根之间 `.grt-collapse-item` 祖先数量即为 depth（大章=0，小节=1）。

### 1.3 目录清单（实测 79 门，无分页）

| 大章 | 小节（课程数） |
|---|---|
| 理论教育（17） | 政治理论学习(5)、维护国家安全(5)、严格遵守党章党规党纪(5)、发展对象的确定和考察(2) |
| 党性教育（含VR参观）（42） | 红色VR云参观沉浸式体验课程(17)、党史之声(14)、榜样之声(11) |
| 知识技能教育（20） | 学习方法和能力提升(6)、人工智能与网络素养(5)、职业规划和就业指导(4)、人际交往与情绪管理(5) |

- 除首门《习近平党建文选》约 4% 外，其余均 0%。
- **注意**：命名含 "VR" 的课程在播放页仍是**普通视频课**（有时长/讲师/进度条），不是特殊播放器 → 脚本按普通视频处理。
- **无分页**（未出现 `grt-pagination` 的翻页需求）。

### 1.4 播放页结构

- `HTML5 <video>` 位于 `.xgplayer.xgplayer-pc.not-allow-autoplay`（xgplayer 库），`blob:` 源，`playbackRate=1`，初始 `paused`、`autoplay=false`。
- 右侧播放列表：`[class*=play-list_*] > [class*=item-wrap_*]`，每个分集含 `[class*=name-span_*]`（如「第一集 …（1）」）、`[role="progressbar"][aria-valuenow]`、`[class*=rate-span_*]`（"N%"）、`[class*=item-info_*]`（时长）；`data-checked="true"` 表示当前分集。
- 示例课程（首门）分集：第一集 8%(29:58)、第二集 1%(29:06)、第三集 3%(30:05)；目录课程 % = 各集进度四舍五入平均 = 4%。
- 返回目录：面包屑 "课程学习" 的 `span[class*=return-icon_]`。
- 通用导航按钮：`span.next-btn_*`（下一个课程）、`span.prev-btn_*`（上一个课程）、"项目首页"。
- 切集只需点击 `name-span`（会更新 URL 的 `resource_id`）；实测**合成点击**即可切集并**从上次位置续播**（第 2 集已累积 19s → currentTime≈19.3s）。

### 1.5 行为 / 合规观察

- 首次直接播放被浏览器拦截（`NotAllowedError: user didn't interact`）；**一次真实点击后即可 1x 播放**。
- 播放心跳向上报 `video_speed:1`（确认 1x）；VOD 分片来自 `enaea-vod.grtcloud.net`。
- 进度接口（**仅勘察，脚本不调用**）：`POST https://apaas.grtcloud.net/api/grt-user-center-service/user/chapter/v1/video-progress`，头 `authorization: <localStorage grtPcToken 原始值>`，body `{resource_ids,...}` → 返回 `rate/is_finish/accumulated_play_duration` 等。
- **决策**：为遵守「不保存/导出 Token」，脚本**不调用该接口**，只用 DOM 显示的进度条作为完成依据；外层重扫自愈轻微同步延迟。

---

## 2. 夹具回归测试（本地模拟，全流程）

> 夹具 `test/fixture.html` 复刻真实站类名前缀（`grt-collapse-*`、`collapseList_*`、`section-box_*`、`list-title_*`、`item-wrap_*`、`name-span_*`、`rate-span_*`、`progress-label_*`、`return-icon_*`），实现折叠展开、课程点击→播放页、分集切换+播放、`ended` 后进度置 100、localStorage 持久化。用 6 秒 webm 短视频缩短时长。

### 2.1 夹具结构（覆盖跨集/跨节/跨章）

- 理论教育 / 政治理论学习：**课程A（两集）**、课程B（一集）
- 理论教育 / 维护国家安全：课程C（一集）→ 覆盖**跨小节**
- 党性教育 / 红色VR云参观：课程D（一集）→ 覆盖**跨大章**
- 知识技能教育 / 学习方法和能力提升：课程E（一集）
- 另设一个「非视频」场景（无分集 / 无 `<video>`）用于人工标记用例。

### 2.2 用例与结果：**17 / 17 全部通过**

| 场景 | 覆盖点 | 结果 |
|---|---|---|
| S1 全流程 | 起始 IDLE；开始后全自动；**倍速恒 1.0x**；播放→下一集→下一课程→跨小节→跨大章；最终 **COMPLETED**；5 门课程全部 100%；已完成计数 5/5；每门仅一次尝试（无死循环）；完成后**不重播/不重启** | ✅ |
| S2 手动停止 | 播放中点【停止】→ 真正停住、不再前进、**不自动重启** | ✅ |
| S3 暂停/继续 | 点【暂停】→ `<video>` 真正 `paused`；点【继续】→ 恢复 `playing` | ✅ |
| S4 刷新续跑 | 刷新后状态 RUNNING → **自动续跑**并最终完成 | ✅ |
| S5 非视频项 | 无分集/无视频课程被**标记为人工处理**（manual），其余课程仍全部自动完成 | ✅ |

> 说明：早期版本曾出现「暂停/停止只改状态却未真正 `video.pause()`，导致暂停后仍在后台推进到下一集」以及「非视频课程因检测到空 `<video>` 而误判为可播放」两类缺陷；已修复（`Controls.pause/resume` 直接操作媒体元素；`handlePlayerCourse` 先探测无视频→返回 `no-video` 交人工；内层循环对 PAUSED/STOPPED 正确让出）。修复后 17 项断言全绿。

---

## 3. 复现步骤

```bash
# 1) 启动夹具静态服务（保持运行）
cd /Volumes/ExternalSSD/Codex/script/test
python3 -m http.server 8791

# 2) 另开终端跑回归（ego-browser 注入 userscript）
cd /Volumes/ExternalSSD/Codex/script
ego-browser nodejs < test/driver.mjs
```

- 场景通过阈值已缩短（driver 内 `syncWaitMs=200 / playerReadyTimeout=8000 / scanStableMs=150 / stallMs=8000`）。
- 夹具支持 `?reset=1` 清空进度；提供 `window.FIXTURE`（reset/save/data/forceEndCurrent）便于构造用例。

---

## 4. 未覆盖 / 建议在真实站点做的验收

以下为**夹具无法等同真实环境**、建议上线前人工验证的项（脚本已实现相应逻辑，但未在真实播放到底的场景全量实测）：

1. **真实时长整段播放**：真实课程单集约 30 分钟，脚本按 1.0x 播放到 `ended` 后平台进度回写是否及时（脚本已用 `syncWaitMs` + 重扫兜底）。
2. **真实平台完成回写阈值**：不同课程"完成"对应的 `aria-valuenow` 是否恒为 100（脚本以 100 为完成门槛）。
3. **登录过期 / 验证码 / 确认弹窗**：脚本策略是**暂停并提示人工**，未在真实过期/验证码场景实测（不绕过、不模拟）。
4. **真实 SPA 路由**切换分集时 `resource_id` 变化被 Route hook 捕获的稳定性。
5. **VR/测验/问卷**等非视频项在真实页面的呈现（脚本按"人工处理"标记）。

---

## 5. 结论

- **真实站点**：目录/播放页 DOM 结构、导航机制、完成判定来源（平台显示进度）均已**实机只读确认**。
- **功能逻辑**：本地夹具全流程回归 **17/17 通过**，覆盖跨集/跨节/跨章、暂停/继续/停止、刷新续跑、非视频人工标记、完成后不重播、恒 1.0x。
- 脚本**不改倍速、不 seek、不伪造时长、不读写 Token/Cookie、不调写接口**；待真实环境做第 4 节的少量人工验收即可。

---

## 6. 真实站点冒烟测试（v1.0.1，2026-11-13，ego-browser 实机）

在用户**已登录**的真实环境 `https://estudy.enaea.edu.cn` 直接注入 userscript 运行，验证“无 video 元素 / 进去就退出”问题已修复：

| 用例 | 条件 | 结果 |
|---|---|---|
| R1 自动选课进播放页 | 真实目录点第一门未完成课 | 进入播放页，`<video>` 正常找到（readyState 4） |
| R2 无手势启动 | 纯脚本 `Controls.start()`（无用户手势） | 自动转为**静音连续播放**，`currentTime` 稳定 1.0x 递增（12s 内 1.4→13.4），**不再**一直停在 WAITING_USER_GESTURE，也无“无 video 元素”报错 |
| R3 带手势启动 | 页面先真实鼠标点击后再启动 | **带声音**正常播放（`muted=false`），`currentTime` 1.0x 递增 |
| R4 夹具回归 | 修复后再跑 `test/driver.mjs` | **17/17 通过**（未回归） |

**结论**：真实站点上“进入后立刻退出 / 无 video 元素”已解决；根因是
(1) 切集时 `<video>` 重建的瞬时检测失败、(2) 浏览器自动播放策略拦截 `play()`。1.0.1 通过“轮询等待 video + 静音兜底播放 + 陈旧错误清理”修复。

> 说明：真实测试仅播放了数十秒真实课程（`发展党员五个阶段任务要求` 等）用于验证可播放性，属用户授权的 `试试`；未做任何进度伪造，之后未再持续跑真实播放。整段“几十门课全部学时跑完”仍以夹具回归验证逻辑，不做真实全量消耗。

---

## 7. 选课错乱（漏课）修复验证（v1.0.2，2026-11-13，真实站点）

**问题**：进入后面章节的课，跳过前面未刷的课。

**定位（真实站点实测）**：折叠目录的小节内容为**按需渲染**。旧 `expandAllCollapses` 一次性持有整批小节节点后逐一点击，React 重渲染使后续点击落在失效节点上，**每轮只有 1 个小节真正展开**；8 轮后仍漏掉“理论教育”的前 3 个小节（政治理论学习 / 维护国家安全 / 严格遵守党章党规党纪，共 15 门），扫描只得到 **64 门**（应为 79），于是从残缺列表里选了后面的课。

**修复**：`expandAllCollapses` 改为**每次点击前重新查询 DOM、只点“当前无课程内容”的小节**，逐节展开并等待渲染，绝不点击已展开项。

| 验证项 | 结果 |
|---|---|
| 全量扫描 | `理论教育17 + 党性教育42 + 知识技能教育20 = 79` ✔ |
| 幂等性（连扫 2 次） | 两次均为 79，不重复不丢 ✔ |
| 选课结果 | 首选 = `理论教育§政治理论学习§《习近平党建文选》第一卷、第二卷学习辅导`（4%，第一门未完成）✔ |
| 真机进入 | 点开始后正确进入该第一门课并播放（无手势时静音兜底）✔ |
| 夹具回归 | `test/driver.mjs` 仍全绿（见第 2 节）✔ |

**附带**：状态版本升到 v2，升级时清空旧版被污染的 `totalCourses/current/manualKeys` 等动态态；从播放页启动会先回目录权威重扫再选课。
