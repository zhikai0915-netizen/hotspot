# hotspot · DSH GitHub 热榜

给 DeepSeek Harness 装一块**自己的热榜**：按**日 / 周 / 月**追踪 GitHub 上的
模型插件、Skill、MCP 服务、桌宠挂件等小工具，看谁在涨、谁是新面孔。
榜单类型完全可配，改一个 JSON 就能加自己的榜。

安装后在 **设置 → GitHub 热榜** 里看榜；数据由宿主半侧抓取并缓存，浏览器半侧只负责画。

---

## 它到底怎么算「热」

这是本插件最需要说清楚的一点：**GitHub API 不提供历史星数**。
`GET /search/repositories` 只给你「此刻」的 `stargazers_count`，没有任何接口能告诉你
某个仓库上周有多少星。所以任何日榜/周榜/月榜都只能是：

```
区间涨星 = 当前星数 − 区间起点星数
```

区间起点必须由插件自己存下来。hotspot 的做法是：**每次抓取都把当天的星数写一份快照**
到 `$DSH_HOME/hotspot/snapshots/<YYYY-MM-DD>.json`。

于是存在一个**诚实的冷启动期**：

| 快照情况 | 排名依据 | 界面标识 |
|---|---|---|
| 只有 1 张（或基线就是今天） | 按**总星数**排 | `按总星数` |
| ≥ 2 张，且基线早于今天 | 按**区间涨星**排，同时给 `新上榜` 标记 | `按区间涨星` |

这不是缺陷，是这类工具的物理限制 —— 与其假装能算，不如把依据摊开给你看。
装好后放一两天，日/周/月榜就会自动变成真正的涨星榜。

## 已知边界

- **抓的是「总星数靠前的一批仓库」，不是「涨星最快的一批」**。
  每榜每轮只取一次搜索结果（按星数降序，默认 50 条）。总星数很低但近期暴涨的黑马，
  可能还没进这 50 条。要覆盖它们需要按周期分别搜索，会成倍消耗接口额度 —— 见下。
- **未认证的 GitHub 搜索接口只有 10 次/分钟**（实测确认；认证后 30 次/分钟）。
  所以：抓取粒度是「每榜一次」而非「每榜 × 每周期一次」，四个周期共用同一批仓库，
  只是算涨星时的基线快照不同；结果进 10 分钟内存缓存；榜单一多就主动让路（每次间隔 1.5 秒）。
  实际用起来**强烈建议配一个 token**。
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
> 发布到 npm 之后就可以直接 `add hotspot`。

---

## 配 token（强烈建议）

不配也能用，只是搜索限 10 次/分钟，榜单一多就会间歇性 403。

任选一种：

1. **环境变量**（推荐）：设 `GITHUB_TOKEN` 或 `GH_TOKEN`，然后重启 DSH。
   细粒度 token 只要 **Public Repositories (read-only)** 权限即可，不需要任何写权限。
2. **配置文件**：在 `$DSH_HOME/hotspot/config.json` 里写 `"token": "ghp_xxx"`。
   明文存在本机，仅在你不想动环境变量时用。

界面上 `配置状态` 会显示 token 是否生效。

---

## 自定义榜单

配置文件：`$DSH_HOME/hotspot/config.json`（首次运行自动生成默认值；也可以 `PUT /dsh-hotspot/config` 写）。

```json
{
  "cacheMinutes": 10,
  "refreshMinutes": 30,
  "perPage": 50,
  "snapshotKeepDays": 120,
  "boards": [
    { "id": "dsh-plugin",  "name": "DSH 插件",   "desc": "带 dsh-plugin 话题的插件仓库", "query": "topic:dsh-plugin" },
    { "id": "my-fav",      "name": "我关注的小工具", "query": "topic:cli-tool stars:>=50 stars:<=5000" }
  ]
}
```

- `query` 就是 GitHub search 的 `q`，语法随意组合：`topic:xxx`、`in:name`、`language:ts`、
  `pushed:>=2026-01-01`……
- `minStars` / `maxStars`（可选）会被自动拼成 `stars:a..b`，用来把平台级大项目挡在榜外。
- `boards` 是**整体替换**语义：你写了 `boards`，默认那七个就不再出现（这样才能真的删榜）。
- `refreshMinutes: 0` 关闭后台定时刷新，改为只在有人请求时按需抓。

### 内置的七个榜单

| id | 名称 | 查询 |
|---|---|---|
| `dsh-plugin` | DSH 插件 | `topic:dsh-plugin` |
| `dsh-skill` | DSH 技能包 | `topic:dsh-skill` |
| `agent-skills` | Agent Skill | `topic:agent-skills` |
| `mcp-server` | MCP 服务 | `topic:mcp-server` |
| `desktop-pet` | 桌宠 / 界面挂件 | `topic:desktop-pet` |
| `dsh-skin` | DSH 皮肤主题 | `topic:dsh-skin` |
| `llm-plugin` | 模型小插件 | `topic:llm-plugin` |

这些话题都是**实测有结果**的（写进默认值前用 GitHub 搜过，不是拍脑袋填的）。

---

## HTTP 接口

宿主半侧挂在 `/dsh-hotspot` 前缀下（只读为主）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-hotspot/status` | 运行状态：榜单列表、缓存时间、快照数量、错误 |
| GET | `/dsh-hotspot/config` | 当前生效配置 + 元信息 |
| PUT | `/dsh-hotspot/config` | 局部更新配置（JSON body） |
| GET | `/dsh-hotspot/rank?board=<id>&period=day\|week\|month\|all&refresh=1` | 排名数据 |
| POST | `/dsh-hotspot/refresh[?board=<id>]` | 立即刷新（全部或单个榜单） |

`/rank` 的响应形状：

```jsonc
{
  "board": { "id": "dsh-plugin", "name": "DSH 插件", "query": "topic:dsh-plugin" },
  "period": "week",
  "basis": "star-delta",        // 或 "total-stars"
  "windowStart": "2026-10-08",  // 基线快照日期（total-stars 时为 null）
  "snapshotCount": 3,
  "stale": false,               // 本次刷新失败、显示缓存时为 true
  "notes": ["..."],
  "items": [
    { "rank": 1, "fullName": "owner/repo", "url": "https://github.com/...",
      "description": "...", "stars": 1234, "delta": 37, "isNew": false,
      "language": "TypeScript", "topics": ["..."], "pushedAt": "..." }
  ]
}
```

限流时返回 `429`，body 里有 `kind: "rate-limited"` 与 `resetAt`。

## 数据存在哪

```
$DSH_HOME/hotspot/
├── config.json              # 用户配置
└── snapshots/
    ├── 2026-10-14.json      # 当天抓到的逐仓库星数
    └── 2026-10-15.json
```

超过 `snapshotKeepDays` 的快照会自动清理。**删掉 snapshots 就等于重置历史**，
下次运行会退回「按总星数」排名。

## 开发与测试

无构建步骤：`lib/index.js`（宿主）与 `lib/client.js`（浏览器）**就是手写源码**，
纯 JS，不需要 TS/打包器。浏览器半侧受 DSH 契约限制，必须是顶层无
`import`/`export` 的普通副作用脚本。

```sh
node test/smoke.mjs    # 宿主半侧：起真实 HTTP 服务打自己（会真实访问一次 GitHub）
node test/client.mjs   # 浏览器半侧：vm 模拟 __ModuleLoader__ 契约 + 渲染一次组件
```

`test/smoke.mjs` 用临时目录当 `DSH_HOME`，不会污染真实数据。

## 兼容性

未声明 `dsh.compatibility` —— 本插件**尚未在真实 DSH 版本上实测**，不做没有证据的
兼容声明。宿主半侧只依赖 node 内置模块（刻意不 import 任何 `@deepseek-ai/*`），
把加载失败的风险压到最低。

## 路线图

- [ ] 界面里直接编辑/新增榜单（目前要手改 config.json）
- [ ] 接入官方 `credentials` 服务取 token，不再依赖环境变量
- [ ] 给 agent 注册一个 `hotspot_rank` 工具："帮我看看这周有什么热门的 Skill"
- [ ] 可选的按周期搜索（`pushed:>=`）模式，覆盖"总星数低但近期暴涨"的黑马
- [ ] 收藏/屏蔽某些仓库，支持「只看自己关心的领域」

## License

MIT，见 [LICENSE](./LICENSE)。
