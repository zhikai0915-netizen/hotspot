# hotspot · DSH GitHub 热榜

给 DeepSeek Harness 装一块**自己的热榜**：按**日 / 周 / 月**追踪 GitHub 上的
模型插件、Skill、MCP 服务、桌宠挂件等小工具，看谁在涨、谁是新面孔、谁正在**飙升**，
并且**为每个项目生成中文简介**说明它是干什么的、解决什么问题。

安装后榜单以**独立可拖拽浮层**显示在页面上；**设置 → GitHub 热榜** 里也能看完整视图。
数据由宿主半侧抓取、采样、排名，浏览器半侧只负责画。

---

## 独立可拖拽浮层（v0.3.0 起）

榜单的主界面是一块**页面级悬浮面板**（挂在 DSH 的 `shell.overlay` 插槽，与桌宠同层，不占对话区）：

| 操作 | 效果 |
|---|---|
| 拖标题栏 | 移动面板（鼠标 / 触摸 / 触控笔统一走 Pointer Events） |
| 拖右下角 | 调整面板大小（最小 300×220） |
| 点标题栏或「—」 | 折叠成一个可拖动的**小药丸**，点药丸再展开 |
| 点「✕」 | 隐藏（在 设置 → GitHub 热榜 里可恢复） |

- **位置、尺寸、模式都会记住**（localStorage 的 `hotspot-panel` 键），刷新页面或重启后回到原处。
- **永远不会丢**：位置与尺寸一律夹进视口，并保证至少 80px 留在屏幕内——窗口缩小、
  拔掉高分辨率显示器之后，面板也不会飘到看不见的地方。
- 浮层与设置页**共用同一个榜单组件**，不会出现两套渲染逻辑不一致。

### 视觉规范（v0.6.0 起）

界面**不写死任何颜色**，全部走 DSH 自己的设计 token `--dsw-*`，因此会自动长成"系统原生"的样子：

| 类别 | 用到的 token |
|---|---|
| 语义色 | `--dsw-alias-label-primary/-secondary/-tertiary/-quaternary`、`-link`、`--dsw-alias-bg-layer-1`、`--dsw-alias-border-l2/l3`、`--dsw-alias-separator-primary`、`--dsw-alias-interactive-bg-hover`、`--dsw-alias-state-success/error/warn-*`、`--dsw-alias-button-primary-fill`、`--dsw-alias-label-primary-inverted` |
| 形状 | `--dsw-radius-md` / `--dsw-radius-panel`、`--dsw-elevation-panel` / `--dsw-elevation-soft` |
| 排版 | `--dsw-font`、`--dsw-font-base-16` |
| 交互 | `--dsw-focus-ring-color` / `--dsw-focus-ring-width`、`--dsw-menu-backdrop-filter` |
| 滚动条 | `--dsw-alias-scrollbar-bg-l2` / `-hover-l2` |

每个变量都带**兜底值**（`var(--dsw-x, …)`）：token 被改名或缺失时界面仍然可用。
好处是——你自己装了皮肤、或者切到暗色主题，这块浮层会跟着变，而不会像以前那样是一块
与周围割裂的灰色板子。

**图标**优先用官方 `@deepseek-ai/dsh-client-ui-primitives` 里的图标组件（经 `require` 取得，
与桌宠插件同一套做法）；取不到就退化成文本字形，绝不因为图标加载失败而崩。

**信息层级重做**：榜单改成可横向滚动的 tab 条、周期改成分段控件、新增一行
「区间 / 剔除 / 更新日程」状态、长说明折叠进「说明」按钮、列表顶部三名加重、
加载时用骨架屏、空状态区分「没数据 / 全被筛掉」、页脚合并成一行紧凑统计。

**无障碍**：`focus-visible` 焦点环、`aria-label` / `role`、尊重 `prefers-reduced-motion`。
浮层默认 460×600、最小 320×240。

> 全局换肤说明：DSH 提供了 `ctx.theme.overrideTokens(source, tokens)`，插件可以叠加一层
> token 覆盖来整体换肤。**本插件刻意不动全局样式**——两个插件都去改全局 token 会互相打架。
> 想要整体换肤请用专门的皮肤包（见下）；本插件只保证自己"长得像系统的一部分"。

---

## 更新日程（v0.4.0 起）

每个榜单**按自己的日程更新，其余时间冻结不变**——不是"一直在刷新"：

| 榜单 | 默认日程 |
|---|---|
| 日榜 | **每天 00:00**（每 24 小时） |
| 周榜 | **每周一 00:00**（= 周日 24:00） |
| 月榜 | **每月 1 号 00:00** |
| 飙升榜 | **每周一 00:00**，其余时间不动（它固定按周统计，日/周/月页签对它无效，界面上会置灰） |
| 总榜 | 每月 1 号 00:00 |
| 抓数据 | **每天 00:00 一次** |

三件事要分清：

1. **抓数据（采样）**：默认每天 0 点去 GitHub 抓一次，7 个查询榜共 **7 次请求/天**
   —— 相比 v0.3.0 的"每 5 分钟一轮"（约 2000 次/天）降了三个数量级，未认证额度绰绰有余。
2. **算榜单**：只有**有人看、且跨过了该榜单的更新边界**时才重算，算完**冻结**。
   没人在看的榜单不会白白消耗额度。
3. **区间**：一律是 [上一个更新边界, 本边界]，而且**两端都取采样**（as-of-boundary）。
   所以"本周涨星"就是上周一 0 点到本周一 0 点，"本月"就是上月 1 号到本月 1 号 ——
   标签即事实。（v0.4.0 拿"最新采样"当终点，会让月榜实际覆盖"上月 1 号到现在"，
   还会把首次运行时那段十几分钟的微弱历史冻结一整个月；v0.5.0 已修。）

界面上会显示每条榜的**下次更新时间与倒计时**，以及当前是不是冻结结果。

- **采样历史还不够跨满一个周期时**，不会退回"按总星数"，而是用现有最早的采样算涨星、
  并**如实标注实际区间**（例如"区间 9 小时（实际短于一个完整周期）"）——比退化成总星数有信息量。
- **手动点"刷新"**会绕过冻结，并**强制重新抓一次数据**（这是显式的人工干预）。
- 日程全部可配（见下面的配置示例）：`every` 支持 `day` / `week` / `month`；
  `weekday` 用 0=周日 … 6=周六；`month.day` 超出当月天数时按当月最后一天算（31 号在 2 月 = 2/28）。

---

## 榜单质量：模型相关性判定 + 综合打分（v0.5.0 起）

光按话题抓 GitHub 是**不够**的。实测把原始榜单跑出来之后，问题很明显：

| 榜单 | 条目 | ★>5万 的项目 | 中位星数 |
|---|---|---|---|
| `dsh-plugin` | 50 | **5**（rea ★254k、deepseek-harness ★250k…） | 7,625 |
| `agent-skills` | 50 | **17** | 32,500 |
| `dsh-skin` | 26 | 0 | **1** |

平台级框架、awesome-list 合集会靠话题匹配大量混进来，把「小工具」挤下去。
所以 v0.5.0 加了一层**用模型做的策展**：

1. **零成本规则预筛**（不花模型调用）
   - 名字/简介命中合集关键词（`awesome` / `curated` / `导航` / `合集` …）→ 直接剔除
   - ★ ≥ `ranking.platformStars`（默认 10 万）→ 直接判为平台级
2. **模型逐条判定**：让它回答「这是本榜该收的**具体小工具**吗」，输出
   `{"verdict":"tool|platform|list|unrelated","relevance":0-100,"reason":"…"}`
3. **过滤**：`requireTool` 时只留 `tool`；`relevance < minRelevance`（默认 50）剔除
4. **综合打分**：`区间涨星 + relevance × relevanceWeight(0.05) + 新鲜度(0/1/2)`
   —— 相关性只是**边际修正**，不会盖过真实涨星，否则小榜单会被一堆"高相关但零增长"的项目占满。

几个设计细节：

- **判定按榜隔离**：同一仓库在 `mcp-server` 榜可能是工具、在 `dsh-skin` 榜就是无关，
  所以缓存键是「榜 + 仓库 + 内容指纹」。
- **异步、可缓存**：和中文简介一样后台串行判定，每轮最多 `classifyBatch` 条；
  判定结果**永久缓存**（官方简介/话题变了才重新判定）。
- **待判定的排在已判定之后**，并标「判定中」；此时结果是**临时**的（不冻结），
  判定完成后会自动重算并锁定。
- **关得掉**：`"classify": false` 时只做规则预筛。
- 成本：每个「仓库 × 榜单」一次极短调用（约 100 token 量级），结果长期复用。
  默认 `platformStars` 会挡掉最贵的那几个巨型项目，不必为它们花调用。

## 三个核心机制

### 1. 中文简介：官方简介往往不够用

GitHub 上的 description 多半是英文、且短到看不出「它到底解决什么问题」。
hotspot 用 **DSH 自己的模型**（`ctx.llm`，与你在对话里用的是同一套适配器与凭据）
为每个上榜项目生成 1–2 句中文简介：**它是什么 + 能解决什么问题**。

- **异步生成、落盘缓存**：`/rank` 先返回已经有的简介，缺的在后台排队生成，
  界面每 60 秒轮询一次，所以你会看到「简介生成中…」逐步变成中文简介，而不是干等。
- **按内容失效**：缓存里记着生成时的「官方简介 + 话题 + 语言」指纹，这些变了才重新生成。
- **失败有冷却**（默认 6 小时），不会反复拿同一个失败项目去撞模型。
- **可以关**：配置里 `"summarize": false`，或换用指定模型 `"summaryModel": {"provider": "...", "model": "..."}`
  （默认跟随当前对话的模型）。
- **降级**：模型服务不可用时，只有简介这一项消失（界面显示原文 + 标记），其余功能照常。
- **不依赖 `@deepseek-ai/dsh-llm` 能被 import**：实测该包在本地 `node_modules` 里
  **没有 package.json**、且是指向 npx 缓存的链接，裸 `import` 与绝对路径 `import` 都会失败。
  所以本插件**自带一份协议正确的实现**（消息带 `id`、认 `text-delta` 分片、读 `finish`），
  官方包只在能加载到时优先使用。
- **失败记录带插件版本**：升级后旧失败会被视为「可能已被修掉的 bug」而自动重试，
  不必等冷却过去（`POST /dsh-hotspot/summaries/reset` 也可手动清空）。

> ⚠️ 简介会**消耗你的模型额度**（每条一次很短的小请求，约 100 token 量级），且结果永久缓存。
> 不想要就把 `summarize` 设为 `false`。

### 2. 采样：一切「涨了多少」的前提

GitHub API **不提供历史星数**。`GET /search/repositories` 只给「此刻」的
`stargazers_count`，没有任何接口能告诉你某个仓库上周有多少星。所以任何日榜/周榜/月榜/飙升榜都只能是：

```
区间涨星 = 当前星数 − 区间起点星数
```

区间起点必须由插件自己存。hotspot 每次抓取都往当天的快照文件追加一个**带时间戳的样本**
（同一天内多次抓取 = 多个样本）：

```jsonc
// $DSH_HOME/hotspot/snapshots/2026-10-15.json
{ "date": "2026-10-15", "samples": [
  { "at": "2026-10-15T02:00:00.000Z", "stars": { "owner/repo": 1234 } },
  { "at": "2026-10-15T02:15:00.000Z", "stars": { "owner/repo": 1241 } }
] }
```

日内多采样的两个好处：区间基线能精确到「不晚于 cut-off 的最近一个样本」；
飙升榜可以算**每天涨多少星**的速度，而不是只能拿整天当最小粒度。

> ⚠️ 合并采样时**只更新星数、绝不推进 `at`**（并用 `lastAt` 记录星数的实际观测时刻）。
> 这一点是 v0.2.1 修的 bug：0.2.0 合并时把 `at` 推到当前时刻，导致一天下来永远只剩一个
> 「当前时刻」的采样，时间序列被自己抹掉 —— 飙升榜永远 `insufficient-history`，
> 区间涨星也永远算不出来。
（0.1.0 的旧格式 `{ date, savedAt, stars }` 仍能正确读取。）

于是存在一个**诚实的冷启动期**：

| 样本情况 | 排名依据 | 界面标识 |
|---|---|---|
| 只有 1 个样本 | 按**总星数**排 | `按总星数` |
| ≥ 2 个不同时刻的样本 | 按**区间涨星**排，附 `新上榜` 标记 | `按区间涨星` |
| 飙升榜样本不足 | 不编数据，明说还要等 | `样本积累中` |

这不是缺陷，是这类工具的物理限制 —— 与其假装能算，不如把依据摊开给你看。
抓数据的节奏见下文「更新日程」：默认**每天 0 点抓一次**，所以第二天起才会有区间涨星与飙升数据
（第一天只有一份采样，只能按总星数排；这是数据本身的限制，不是开关没生效）。

### 3. 飙升榜：跨榜单的全局速度榜

普通榜单是「某条 GitHub 查询里总星数靠前的 N 个仓库」，按各自基线算涨星。
**飙升榜不看任何查询**，而是在**全部被追踪过的仓库**（`repos.json` 注册表）里，
按窗口内的涨星量排序，并给出「星/天」速度 —— 所以它能捞到各个榜单之外的黑马。

- 飙升榜**固定按自己的日程**统计（默认每周一 0 点更新），页签对它不起作用（界面上会置灰）。
- 区间 = [上一个更新边界, 本边界]。「本月」天然等于上一个 1 号到本月 1 号，28/30/31 天都不用特判。
- 只统计**基线采样里已存在**的仓库。新出现的仓库不计入速度（否则「刚建的新库」会被误报成飙升）。

---

## 已知边界

- **抓的是「总星数靠前的一批仓库」，不是「涨星最快的一批」**。
  每榜每轮只取一次搜索结果（默认 50 条）。总星数很低但近期暴涨的黑马，
  可能还没进这 50 条 —— 除非它已经被收录进注册表（那样飙升榜能看到它）。
- **未认证的 GitHub 搜索接口只有 10 次/分钟**（实测；认证后 30 次/分钟）。
  但 v0.4.0 起改成按日程抓：默认**每天 7 次请求**，远低于 10 次/分钟，
  所以**不配 token 也完全够用**（除非你把 `sample` 改成高频心跳）。
- **限流不会清空你的榜**：403/429 会保留上一次成功的数据、标记 `stale`，
  并把 GitHub 给的重置时间透传到界面。

---

## 安装

### 官方桌面客户端（Electron）

```powershell
dsh plugin --profile desktop add '<hotspot 所在目录的绝对路径>'
```

装完**从系统托盘完全退出** DeepSeek Harness 再启动。

### CLI Web 版

```powershell
dsh plugin --profile web add '<hotspot 所在目录的绝对路径>'
```

> 路径要用**绝对路径**且指向含 `package.json` 的那一层，别多套一层同名目录。

---

## 配 token（强烈建议）

**v0.4.0 起基本不需要 token**：默认每天只抓 7 次请求，未认证额度绰绰有余。
只有当你把 `schedule.sample` 改成高频、或把 `refreshMinutes` 设成心跳时才有必要。

1. **环境变量**（推荐）：设 `GITHUB_TOKEN` 或 `GH_TOKEN`，然后重启 DSH。
   细粒度 token 只要 **Public Repositories (read-only)** 权限即可。
2. **配置文件**：`$DSH_HOME/hotspot/config.json` 里写 `"token": "ghp_xxx"`。

界面上会显示 token 是否生效。

---

## 配置

`$DSH_HOME/hotspot/config.json`（首次运行自动生成默认值；也可 `PUT /dsh-hotspot/config` 写）：

```jsonc
{
  "cacheMinutes": 2,          // 结果内存缓存；调小 = 更及时，代价是更多 GitHub 请求
  "refreshMinutes": 0,        // 额外心跳抓取（分钟）；0 = 关闭，只按 schedule.sample 抓
  "scheduleCheckMinutes": 5,  // 多久检查一次日程边界
  "sampleIntervalMinutes": 15,// 同一采样点内的合并窗口（间隔小于它就不新开采样点）
  "snapshotKeepDays": 60,     // 快照保留天数
  "perPage": 50,
  "registryLimit": 4000,      // 仓库注册表上限
  "token": "",
  "summarize": true,          // 是否用 DSH 的模型生成中文简介
  "summaryBatch": 8,          // 每次请求最多补生成几条
  "classify": true,           // 是否用模型判定「这是不是本榜该收的小工具」
  "classifyBatch": 10,        // 每次请求最多补判定几条
  "classifyCooldownMinutes": 720,
  "classifyModel": null,      // 判定用的模型；null = 跟随当前对话
  "ranking": {                // 过滤与排序
    "requireTool": true,      // 只留 verdict=tool
    "minRelevance": 50,       // 相关性低于它剔除
    "relevanceWeight": 0.05,  // 综合分里相关性的权重
    "platformStars": 100000,  // ★ 超过它直接判平台级（0 = 关闭，改由模型判）
    "listPattern": "awesome|curated|collection|导航|合集|清单|list of|cheat.?sheet"
  },
  "summaryCooldownMinutes": 360,
  "summaryModel": null,       // {"provider":"...","model":"..."}；null = 跟随当前对话
  "schedule": {               // 各榜单的更新日程（本地时区）；结果只在跨过边界时重算
    "day":    { "every": "day",   "hour": 0 },                 // 每天 0 点
    "week":   { "every": "week",  "weekday": 1, "hour": 0 },   // 每周一 0 点（= 周日晚 12 点）
    "month":  { "every": "month", "day": 1, "hour": 0 },       // 每月 1 号
    "all":    { "every": "month", "day": 1, "hour": 0 },       // 总榜按什么节奏重算
    "surge":  { "every": "week",  "weekday": 1, "hour": 0 },   // 飙升榜：每周一
    "sample": { "every": "day",   "hour": 0 }                  // 什么时候去 GitHub 抓数据
  },
  "boards": [
    { "id": "surge", "name": "飙升榜", "kind": "surge", "desc": "过去 24 小时涨星最快（跨全部榜单追踪的仓库）" },
    { "id": "my-fav", "name": "我关注的小工具", "query": "topic:cli-tool stars:>=50 stars:<=5000" }
  ]
}
```

- 普通榜的 `query` 就是 GitHub search 的 `q`，语法随意组合；`minStars` / `maxStars`
  （可选）会自动拼成 `stars:a..b`。
- 特殊榜用 `"kind": "surge"`，忽略 `query`。
- `boards` 是**整体替换**语义：你写了 `boards`，默认那些就不再出现。
  ⚠️ 通过 `PUT /config` 改榜单时也要带上想保留的其它榜单，否则它们会被删掉。

### 内置的 7 个查询榜

| id | 名称 | 查询 |
|---|---|---|
| `dsh-plugin` | DSH 插件 | `topic:dsh-plugin` |
| `dsh-skill` | DSH 技能包 | `topic:dsh-skill` |
| `agent-skills` | Agent Skill | `topic:agent-skills` |
| `mcp-server` | MCP 服务 | `topic:mcp-server` |
| `desktop-pet` | 桌宠 / 界面挂件 | `topic:desktop-pet` |
| `dsh-skin` | DSH 皮肤主题 | `topic:dsh-skin` |
| `llm-plugin` | 模型小插件 | `topic:llm-plugin` |

这些话题都是**实测有结果**的。外加默认的**飙升榜**，共 8 个榜单。

---

## HTTP 接口

宿主半侧挂在 `/dsh-hotspot` 前缀下：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-hotspot/status` | 榜单列表、缓存时间、样本数、注册表大小、简介进度、错误 |
| GET | `/dsh-hotspot/config` | 当前生效配置 + 元信息 |
| PUT | `/dsh-hotspot/config` | 局部更新配置（board 列表是整体替换，注意） |
| GET | `/dsh-hotspot/rank?board=<id>&period=day\|week\|month\|all&refresh=1` | 排名数据 |
| GET | `/dsh-hotspot/summaries` | 中文简介缓存、生成进度与**最近一次调用的诊断** |
| GET | `/dsh-hotspot/classify` | 相关性判定缓存（每条含 verdict / relevance / reason） |
| POST | `/dsh-hotspot/classify/reset` | 清空判定缓存（想用新模型/新提示重判时用） |
| POST | `/dsh-hotspot/summaries/reset` | 清空失败记录（想立刻重试时用；平时升级会自动重试） |
| POST | `/dsh-hotspot/refresh[?board=<id>]` | 立即刷新（全部或单个查询榜） |

`/rank` 的响应形状：

```jsonc
{
  "board": { "id": "dsh-plugin", "name": "DSH 插件", "query": "topic:dsh-plugin" },
  "period": "week",
  "basis": "star-delta",        // star-delta | total-stars | star-velocity | insufficient-history
  "windowStart": "2026-10-08T02:15:00.000Z",
  "sampleCount": 42,
  "stale": false,
  "summaryStats": { "cached": 18, "failed": 0, "queued": 3, "generating": true, "disabled": false },
  "notes": ["..."],
  "items": [
    { "rank": 1, "fullName": "owner/repo", "url": "https://github.com/...",
      "summary": "这是一个……解决……的中文简介", "summaryPending": false,
      "description": "official english description",
      "stars": 1234, "delta": 37, "isNew": false, "perDay": 37.0,
      "language": "TypeScript", "topics": ["..."], "pushedAt": "..." }
  ]
}
```

限流时返回 `429`，body 里有 `kind: "rate-limited"` 与 `resetAt`。

## 数据存在哪

```
$DSH_HOME/hotspot/
├── config.json        # 用户配置
├── repos.json         # 仓库注册表（飙升榜与简介用）
├── summaries.json     # 中文简介缓存 + 失败冷却记录
└── snapshots/
    ├── 2026-10-15.json   # 当天的多个采样
    └── 2026-10-16.json
```

**删掉 `snapshots/` 就等于重置历史**，下次运行会退回「按总星数」排名、飙升榜清空。
超过 `snapshotKeepDays` 的快照会自动清理。

## 开发与测试

无构建步骤：`lib/index.js`（宿主）与 `lib/client.js`（浏览器）**就是手写源码**，
纯 JS，不需要 TS/打包器。浏览器半侧受 DSH 契约限制，必须是顶层无
`import`/`export` 的普通副作用脚本。

```sh
npm test               # 三套一起跑
node test/smoke.mjs    # 宿主半侧：起真实 HTTP 服务打自己（会真实访问一次 GitHub）
node test/client.mjs   # 浏览器半侧：vm 模拟 __ModuleLoader__ 契约 + 渲染一次组件
node test/rank.mjs     # 核心算法：打桩 fetch + 手写历史采样，确定性验证
                       #   涨星 / 四个周期的基线 / 采样合并与追加 / 飙升榜 /
                       #   中文简介异步生成与冷却 / 限流两种情形 / 快照清理
```

- `test/smoke.mjs`、`test/rank.mjs` 都用临时目录当 `DSH_HOME`，不会污染真实数据。
- `test/smoke.mjs` 的那一次真实 GitHub 请求受 **10 次/分钟**额度限制：额度耗尽时它会
  把依赖网络数据的断言标成**跳过**（不是失败）——这类红是环境问题，不是代码缺陷。
- `test/rank.mjs` **全程打桩、不碰网络**，所以核心算法在任何情况下都有确定性覆盖。
- 浏览器半侧的假 React 必须提供组件用到的**每一个** hook（漏一个就是假失败，项目踩过 `useRef`）。

## 兼容性

未声明 `dsh.compatibility`。宿主半侧**静态 import 只有 node 内置模块**，运行期对官方包
零硬依赖：`@deepseek-ai/dsh-llm` 仅作「能加载就用」的优化，加载不到时用自带的等价实现
（见上文「中文简介」一节）。这也意味着本插件不会因为官方包改名、换布局而整体加载失败。

## 路线图

- [ ] 界面里直接编辑/新增榜单（目前要手改 config.json）
- [ ] 接入官方 `credentials` 服务取 token，不再依赖环境变量
- [ ] 给 agent 注册一个 `hotspot_rank` 工具："帮我看看这周有什么热门的 Skill"
- [ ] 按周期搜索（`pushed:>=`）模式，覆盖"总星数低但近期暴涨"的黑马
- [ ] 收藏/屏蔽某些仓库；简介支持更多语言

## License

MIT，见 [LICENSE](./LICENSE)。
