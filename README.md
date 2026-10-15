# hotspot · DSH GitHub 热榜

给 DeepSeek Harness 装一块**自己的热榜**：按**日 / 周 / 月**追踪 GitHub 上的
模型插件、Skill、MCP 服务、桌宠挂件等小工具，看谁在涨、谁是新面孔、谁正在**飙升**，
并且**为每个项目生成中文简介**说明它是干什么的、解决什么问题。

安装后在 **设置 → GitHub 热榜** 里看榜；数据由宿主半侧抓取、采样、排名，浏览器半侧只负责画。

---

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
（0.1.0 的旧格式 `{ date, savedAt, stars }` 仍能正确读取。）

于是存在一个**诚实的冷启动期**：

| 样本情况 | 排名依据 | 界面标识 |
|---|---|---|
| 只有 1 个样本 | 按**总星数**排 | `按总星数` |
| ≥ 2 个不同时刻的样本 | 按**区间涨星**排，附 `新上榜` 标记 | `按区间涨星` |
| 飙升榜样本不足 | 不编数据，明说还要等 | `样本积累中` |

这不是缺陷，是这类工具的物理限制 —— 与其假装能算，不如把依据摊开给你看。
默认每 5 分钟刷新、每 15 分钟合并成一个采样，所以**装好后约 15–20 分钟**飙升榜就会出数据。

### 3. 飙升榜：跨榜单的全局速度榜

普通榜单是「某条 GitHub 查询里总星数靠前的 N 个仓库」，按各自基线算涨星。
**飙升榜不看任何查询**，而是在**全部被追踪过的仓库**（`repos.json` 注册表）里，
按窗口内的涨星量排序，并给出「星/天」速度 —— 所以它能捞到各个榜单之外的黑马。

- 窗口跟着周期页签走：**日 = 24 小时**（可配 `surgeWindowHours`）、**周 = 7 天**、**月 = 30 天**、**总 = 最早样本**。
- 只统计**基线采样里已存在**的仓库。新出现的仓库不计入速度（否则「刚建的新库」会被误报成飙升）。

---

## 已知边界

- **抓的是「总星数靠前的一批仓库」，不是「涨星最快的一批」**。
  每榜每轮只取一次搜索结果（默认 50 条）。总星数很低但近期暴涨的黑马，
  可能还没进这 50 条 —— 除非它已经被收录进注册表（那样飙升榜能看到它）。
- **未认证的 GitHub 搜索接口只有 10 次/分钟**（实测；认证后 30 次/分钟）。
  默认 8 个榜单里 7 个需要抓取，一轮就是 7 次请求，所以**强烈建议配 token**。
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

不配也能用，只是搜索限 10 次/分钟，榜单一多就会间歇性 403。

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
  "refreshMinutes": 5,        // 后台刷新间隔；0 = 关闭，只在有人看时按需抓
  "sampleIntervalMinutes": 15,// 采样间隔；两次抓取间隔小于它时合并进同一个样本
  "snapshotKeepDays": 60,     // 快照保留天数
  "perPage": 50,
  "registryLimit": 4000,      // 仓库注册表上限
  "token": "",
  "summarize": true,          // 是否用 DSH 的模型生成中文简介
  "summaryBatch": 8,          // 每次请求最多补生成几条
  "summaryCooldownMinutes": 360,
  "summaryModel": null,       // {"provider":"...","model":"..."}；null = 跟随当前对话
  "surgeWindowHours": 24,
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
| GET | `/dsh-hotspot/summaries` | 中文简介缓存与生成进度 |
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

未声明 `dsh.compatibility` —— 本插件**尚未在真实 DSH 版本上实测**，不做没有证据的
兼容声明。宿主半侧静态 import 只有 node 内置模块；唯一需要的官方包
`@deepseek-ai/dsh-llm`（`BlockAssembler` / `createUserMessage`）用**惰性动态 import**，
拿不到就只关掉中文简介。

## 路线图

- [ ] 界面里直接编辑/新增榜单（目前要手改 config.json）
- [ ] 接入官方 `credentials` 服务取 token，不再依赖环境变量
- [ ] 给 agent 注册一个 `hotspot_rank` 工具："帮我看看这周有什么热门的 Skill"
- [ ] 按周期搜索（`pushed:>=`）模式，覆盖"总星数低但近期暴涨"的黑马
- [ ] 收藏/屏蔽某些仓库；简介支持更多语言

## License

MIT，见 [LICENSE](./LICENSE)。
