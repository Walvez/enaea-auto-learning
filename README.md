# 中国教育干部网络学院（新版 estudy）自动连续学习脚本

一个 **ScriptCat（`.user.js`）用户脚本**：在 https://estudy.enaea.edu.cn 新版平台上，以 **1.0x 正常倍速**自动、连续地完成当前项目内**所有未完成的视频课程**，自动接续「下一集 / 下一课程 / 下一小节 / 下一大章」，直到全部指定视频课程完成即停止。
不加速、不拖动进度（不 seek）、不伪造学时、不调用任何写接口、不上传/保存 Cookie 或 Token。

> 核心原则：**平台"官方显示"的进度才算完成**（目录/分集进度条 `aria-valuenow` 与 "N%" 文案）。脚本不会把 `currentTime≈duration` 当成平台完成。

---

## 1. 文件清单

| 文件 | 说明 |
|---|---|
| `enaea-auto-learning.user.js` | 脚本本体（单文件，约 1016 行） |
| `README.md` | 本说明 |
| `TEST_REPORT.md` | 测试报告（夹具回归 + 真实站勘察结论，明确区分模拟/真实） |
| `test/fixture.html` | 本地 SPA 夹具，模拟目录页 + 播放页（类名前缀与真实站一致） |
| `test/driver.mjs` | ego-browser 驱动的回归测试脚本（注入 userscript 跑场景） |
| `test/e1.webm` `e2.webm` `e3.webm` | 夹具用 6 秒短视频（libvpx 生成） |

---

## 2. 安装

1. 安装 **ScriptCat** 浏览器扩展（Chrome/Edge）。
2. 打开 ScriptCat → 新建脚本 / 导入脚本，把 `enaea-auto-learning.user.js` 的全部内容粘贴进来并保存。
   - 或直接把 `.user.js` 文件拖入 ScriptCat 导入。
3. 打开 https://estudy.enaea.edu.cn 并登录，进入「必修课 / 选修课」目录页。
4. 页面**右下角**出现悬浮面板即安装成功（也可在 ScriptCat 菜单里看到脚本命令）。

脚本通过 `@match https://estudy.enaea.edu.cn/web/*` 生效，纯页面内运行，**不依赖任何本地服务**。

---

## 3. 使用

- 点击面板上的 **【开始自动学习】** 才开始，脚本按下面顺序自动进行：
  1. **SCANNING** 扫描目录（自动展开所有折叠的大章/小节）；
  2. **SELECTING** 选第一个进度 <100% 的课程；
  3. 进入课程 → **依次播放本课程未完成分集**；
  4. 每集**真正播放结束**后 → **NEXT_EPISODE** 切下一集；
  5. 本课程最后一集结束并确认完成后 → 返回目录 → **NEXT_COURSE** 选下一门未完成课程；
  6. 课程可能跨**小节（NEXT_SECTION）**、跨**大章（NEXT_CHAPTER）**，脚本都会自动展开并进入；
  7. 全部指定视频课程完成后进入 **COMPLETED**，停止且**不会重播**。
- 按钮：**开始自动学习 / 暂停 / 继续 / 停止 / 重新扫描目录**。
  - **停止**后不会自动重启；**暂停**会真正暂停 `<video>`；**继续**从暂停处继续。
- 面板显示字段：
  - 当前大章、当前小节、当前课程、当前分集；
  - 当前视频进度（时间 + 进度条）；
  - 平台显示的课程进度；
  - 已完成课程数量（x / 总数）；
  - 播放速度（恒为 1.0x）；
  - 最近一次错误。
- ScriptCat 菜单里也注册了同名命令，可在无面板时调用。

---

## 4. 完成判定依据（关键设计）

- **以平台显示为准**：
  - 目录页每门课的进度条 `[role="progressbar"][aria-valuenow]`（0–100）+ 文本 "N%"；
  - 播放页每个分集的 `[role="progressbar"][aria-valuenow]` + "N%"。
- **不**用 `currentTime ≈ duration` 判断课程完成——它只用来判断"这一集播放到结尾"，最终是否算完成仍看平台进度是否到位。
- 每集结束用 `HTMLMediaElement` 的 `ended` 事件 + 播放到尾部 + 非暂停状态判定；结束后等待平台进度回写（`syncWaitMs`）再读取；若仍未达阈值则**有限重试**（超出 `courseAttemptCap` / `errorCap` 则标记人工或报错停止）。
- 外层的"重新扫描目录"循环会自愈个别进度延迟同步的情况。

---

## 5. 状态机

```
IDLE
  └─(开始)→ RUNNING
        SCANNING → SELECTING → PLAYING → WAITING_CONFIRMATION
              → NEXT_EPISODE / NEXT_COURSE / NEXT_SECTION / NEXT_CHAPTER → (回到 SELECTING/PLAYING)
RUNNING ↔ PAUSED        （暂停/继续）
RUNNING → STOPPED       （手动停止，不自动重启）
RUNNING → COMPLETED     （全部视频课程完成，不重播）
RUNNING → ERROR         （连续错误超限）
```

---

## 6. 目录 / 播放页适配（新版 estudy）

新版是 **React SPA + `grt` 组件库 + CSS Modules**，类名形如 `section-box_n5L9Q-kf`（`本地名_构建hash`）。脚本统一用 **[class*="本地名_"]** 前缀匹配，避免构建 hash 变化导致失效：

| 结构 | 选择器（前缀匹配） |
|---|---|
| 折叠项（大章=顶层，小节=嵌套） | `.grt-collapse-item` / `.grt-collapse-header` / `.grt-collapse-content` |
| 课程卡片 | `[class*="section-box_"]` |
| 课程标题 | `[class*="list-title_"]` |
| 进度条 / 百分比文本 | `[role="progressbar"]` / `[class*="progress-label_"]` |
| 播放页分集项 / 分集名 / 分集百分比 | `[class*="item-wrap_"]` / `[class*="name-span_"]` / `[class*="rate-span_"]` |
| 播放列表容器 | `[class*="play-list"]` |
| 返回目录（面包屑"课程学习"） | `[class*="return-icon_"]` |

- **"大章 / 小节"层级**用祖先 `.grt-collapse-item` 的数量（depth）判定，天然适配跨章跨节。
- **SPA 路由检测**：包装 `history.pushState/replaceState` + 监听 `popstate/hashchange` + 定时轮询，识别"目录页 → 播放页 → 目录页"以及切换分集时 URL 里 `resource_id` 的变化。

> 以上选择器来自**真实站点的实际 DOM 勘察**（不是对旧版 study.enaea.edu.cn 的猜测）。

---

## 7. 持久化与多标签

- 存储：`GM_getValue / GM_setValue`（无 GM 环境回退 `localStorage`），键：`enaea_state`、`enaea_lock`。
- 刷新/重开页面：
  - 状态为 **RUNNING** → **自动续跑**（无需重新点开始）；
  - 状态为 **PAUSED** → 转为 **IDLE**，等待用户手动继续（不会莫名自动跑）。
- **不会**在刷新后无限重开同一门课：完成/尝试次数按课程 key 记账。
- **多标签**：一把锁；抢不到锁的标签只读展示、不重复启动；持锁标签定期心跳续约，关闭后释放。

---

## 8. 异常处理

- 慢加载 / 播放器初始化失败 / 自动播放被拦截：有限等待重试；被拦截时进入"等待用户手势"（点击一次页面任意处即可恢复播放，绝不修改倍速）。
- 网络中断 / 列表延迟渲染 / 状态陈旧：等待 + 重新扫描 + 有限重试。
- 连续错误超过 `errorCap` → 进入 ERROR 并在面板显示"最近一次错误"。
- **验证码 / 确认弹窗 / 考试 / 问卷**：检测到即**暂停并提示人工处理**，不做任何绕过或模拟。

---

## 9. 非视频项

VR 参观、测验、问卷、无分集课程等：**标记为"需人工处理"**，不模拟播放、不伪造进度，脚本会跳过并继续下一项。

---

## 10. 限制与未验证项

- 真实站点目录结构（79 门课、3 大章、无分页）与播放页结构已**实机勘察确认**；但"整段真实播放几十门课跑通"**未在真实环境全量执行**（会真实消耗每门数十分钟学时），改用**本地 SPA 夹具**做全流程逻辑回归（详见 `TEST_REPORT.md`）。
- 平台若大改 DOM/类名，需要更新选择器。
- 脚本只读 DOM 显示进度，不调用后端进度接口、不读写 Token/Cookie。

---

## 11. 隐私与合规

- 单文件、无外链远程 JS、无第三方数据上报。
- 不保存/导出 Cookie、Token。
- 不修改后端数据、不改倍速、不 seek、不伪造播放时长。
