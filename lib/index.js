/**
 * hotspot —— 宿主半侧（host half）  v0.2.0
 *
 * 职责：把 GitHub 上的「小工具」按话题抓下来、按时间留样、算涨星、用 DSH 自己的模型
 * 写中文简介，对外提供 `/dsh-hotspot/` 前缀的只读数据接口。浏览器半侧只负责画。
 *
 * ============================ 三个核心机制 ============================
 *
 * 1) 采样（时效性 + 一切区间计算的基础）
 *    GitHub API **不提供历史星数**，任何「日/周/月涨星」「飙升」都只能是
 *    `当前星数 − 区间起点星数`，起点必须自己存。所以每次抓取都往当天的快照文件
 *    追加一个**带时间戳的样本**（同一天内多次抓取 = 多个样本）：
 *      snapshots/<YYYY-MM-DD>.json → { date, samples: [{ at, stars: {repo: n} }] }
 *    日内多采样有两个好处：区间基线能精确到「不晚于 cut-off 的最近一个样本」；
 *    飙升榜可以算「每天涨多少」而不是只能拿整天当最小粒度。
 *    （旧版只有 { stars } 单样本，读取时自动兼容。）
 *
 * 2) 飙升榜（跨榜单的全局速度榜）
 *    普通榜单是「某条查询里总星数靠前的 N 个仓库」，按各自基线算涨星；
 *    飙升榜**不看查询**，而是在全部被追踪过的仓库（repos.json 注册表）里，
 *    按 `surgeWindowHours` 窗口内的涨星量排序，并给出「星/天」速度。
 *
 * 3) 中文简介（用 DSH 自己的模型）
 *    官方 description 多半是英文且很短，不足以说明「这是干什么的、解决什么问题」。
 *    这里通过 ctx.llm（DSH 统一的 LLM 抽象层，自带适配器/凭据/模型解析）生成 1–2 句
 *    中文简介，落盘缓存；description 变了才重新生成。**生成是异步的**：/rank 先返回
 *    已有缓存，缺失的在后台排队生成，界面靠轮询逐步补上。
 *
 * ============================ 速率限制 ============================
 * GitHub 搜索接口未认证 10 次/分钟、认证后 30 次/分钟（实测）。所以抓取粒度是
 * 「每榜单一次」（四个周期共用同一批仓库，只是基线样本不同），结果进内存缓存，
 * 且 403/429 不算致命错误：保留上一次成功的数据、标记 stale、透传重置时间。
 *
 * ============================ 依赖策略 ============================
 * 宿主半侧**静态 import 只有 node 内置模块**，刻意不 import 任何 `@deepseek-ai/*`：
 * 这样即使官方包名/导出变化，本插件也不会整体加载失败。
 * 唯一需要的官方包 `@deepseek-ai/dsh-llm`（BlockAssembler / createUserMessage）
 * 用**惰性动态 import + try/catch**：拿不到就只关掉「中文简介」，其余功能照常。
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 插件名：必须与包名、cordis.patch.yml 的 id 一致。 */
export const name = 'hotspot';

/**
 * 只声明 webServer 这一个硬依赖。
 * `llm` / `agentDefaultModel` 故意不写进 inject：它们缺失时本插件仍应加载，
 * 只是没有中文简介（见 summarizeOne 的降级）。
 */
export const inject = ['webServer'];

/** 插件版本。失败记录会带它：升级后旧失败自动失效重试（见 enqueueSummaries）。 */
const VERSION = '0.6.0';

/** 路由前缀。加后缀式命名空间，避免与官方/其它插件的路径相撞。 */
const ROUTE_PREFIX = '/dsh-hotspot';

/** LLM 调用的调用身份（适配器据此生成服务商需要的载体，值只需稳定）。 */
const CALL_IDENTITY = 'hotspot';

// 注意：区间长度不再用固定毫秒数，而是「上一个日程边界 → 本边界」。
// 这样「本月」天然等于上一个 1 号到本月 1 号，28/30/31 天都不用特判。

/** 周期白名单（区间长度改由日程边界决定，见 schedule）。 */
const PERIODS = ['day', 'week', 'month', 'all'];

/** GitHub 搜索单次最多返回条数。 */
const MAX_PER_PAGE = 100;

/** 单个快照文件内最多保留的样本数（防止刷新过密把文件撑爆）。 */
const MAX_SAMPLES_PER_DAY = 200;

/** 快照读取的内存缓存 TTL：避免每次请求都把几十个文件读一遍。 */
const SAMPLES_TTL_MS = 30000;

/** 默认配置。用户配置覆盖同名字段（boards 整体替换）。 */
const DEFAULT_CONFIG = {
  /** 结果内存缓存时长（分钟）。调小 = 刷新更及时，代价是更多 GitHub 请求。 */
  cacheMinutes: 2,
  /**
   * 额外心跳抓取间隔（分钟）；0 = 关闭（默认）。
   * 注意区分两件事：这里管的是**抓数据**（采样），榜单**结果**什么时候变由 schedule 决定。
   */
  refreshMinutes: 0,
  /** 检测日程边界的轮询间隔（分钟）。 */
  scheduleCheckMinutes: 5,
  /** 采样间隔（分钟）：两次抓取相隔小于它时合并进同一个样本，不再新开一个。 */
  sampleIntervalMinutes: 15,
  /** 快照保留天数。 */
  snapshotKeepDays: 60,
  /** 每榜抓多少条。 */
  perPage: 50,
  /** 仓库注册表上限（超出按最后出现时间淘汰）。 */
  registryLimit: 4000,
  /** 可选：GitHub token 明文（更推荐 GITHUB_TOKEN 环境变量）。 */
  token: '',
  /** 是否用 DSH 的模型生成中文简介。 */
  summarize: true,
  /** 每轮请求最多补生成几条简介（控制模型开销）。 */
  summaryBatch: 8,
  /** 生成失败后的冷却时间（分钟），避免反复撞同一堵墙。 */
  summaryCooldownMinutes: 360,
  /** 简介用的模型 {provider, model}；null = 跟随当前对话的模型。 */
  summaryModel: null,
  /**
   * 是否用模型判定「这个仓库到底是不是本榜该收的小工具」。
   * 平台级框架、awesome-list 合集、与本榜无关的项目会被剔除，再按综合分排序。
   */
  classify: true,
  /** 每次请求最多补判定几条（控制模型开销）。 */
  classifyBatch: 10,
  /** 判定失败后的冷却时间（分钟）。 */
  classifyCooldownMinutes: 720,
  /** 判定用的模型 {provider, model}；null = 跟随当前对话。 */
  classifyModel: null,
  /**
   * 排序与过滤参数。
   *   requireTool   ：只保留 verdict=tool 的仓库（平台/合集/无关全部剔除）
   *   minRelevance  ：相关性低于它剔除（0–100）
   *   relevanceWeight：综合分里相关性的权重（delta + relevance*权重 + 新鲜度）
   *   platformStars ：★ 超过它的直接判为平台级（省一次模型调用）；0 = 关闭
   *   listPattern   ：名字/简介命中该正则就直接判为合集（零成本预筛）
   */
  ranking: {
    requireTool: true,
    minRelevance: 50,
    relevanceWeight: 0.05,
    platformStars: 100000,
    listPattern: 'awesome|curated|collection|导航|合集|清单|list of|cheat.?sheet',
  },
  /**
   * 各榜单的更新日程（本地时区）。`every` 支持 day / week / month：
   *   · day   → 每天 hour 点（默认 0 点）
   *   · week  → 每周 weekday 的 hour 点（weekday: 0=周日 … 6=周六，1=周一）
   *   · month → 每月 day 号的 hour 点（号数超出当月天数就按当月最后一天算）
   * 榜单结果只在跨过边界时重算，其余时间**冻结不变**。
   * sample = 什么时候去 GitHub 抓数据：默认每天 0 点抓一次即可，
   * 因为日/周/月三个边界都落在 0 点，每天一采就够算所有区间。
   */
  schedule: {
    day: { every: 'day', hour: 0 },
    week: { every: 'week', weekday: 1, hour: 0 },
    month: { every: 'month', day: 1, hour: 0 },
    all: { every: 'month', day: 1, hour: 0 },
    surge: { every: 'week', weekday: 1, hour: 0 },
    sample: { every: 'day', hour: 0 },
  },
  /**
   * 榜单定义。
   *   kind: 'surge' → 特殊榜：跨全部已追踪仓库按窗口涨星排序，忽略 query；
   *   其余为普通榜：query 是 GitHub search 的 q 片段，minStars/maxStars 会拼成 stars:a..b。
   */
  boards: [
    { id: 'surge', name: '飙升榜', kind: 'surge', desc: '过去 24 小时涨星最快（跨全部榜单追踪的仓库）' },
    { id: 'dsh-plugin', name: 'DSH 插件', desc: '带 dsh-plugin 话题的插件仓库', query: 'topic:dsh-plugin' },
    { id: 'dsh-skill', name: 'DSH 技能包', desc: '带 dsh-skill 话题的技能/能力包', query: 'topic:dsh-skill' },
    { id: 'agent-skills', name: 'Agent Skill', desc: '通用 agent skill 类小工具', query: 'topic:agent-skills' },
    { id: 'mcp-server', name: 'MCP 服务', desc: 'Model Context Protocol 服务', query: 'topic:mcp-server' },
    { id: 'desktop-pet', name: '桌宠 / 界面挂件', desc: '桌面宠物与界面小挂件', query: 'topic:desktop-pet' },
    { id: 'dsh-skin', name: 'DSH 皮肤主题', desc: '带 dsh-skin 话题的皮肤/主题', query: 'topic:dsh-skin' },
    { id: 'llm-plugin', name: '模型小插件', desc: '各家模型的周边小插件', query: 'topic:llm-plugin' },
  ],
};

/** 内存缓存：boardId → { at, repos }。 */
const cache = new Map();

/** 最近一次抓取错误（boardId → 文案），透传给界面。 */
const lastErrors = new Map();

/** 后台刷新互斥标志。 */
let refreshing = false;

/** 快照扁平化后的内存缓存。 */
let samplesCache = { at: 0, data: [] };

/** 简介待生成队列（去重靠 queued 集合）。 */
const summaryQueue = [];
const summaryQueued = new Set();

/** 简介生成 worker 是否在跑。 */
let summaryWorkerRunning = false;

/** 惰性加载的 @deepseek-ai/dsh-llm（成功/失败都只算一次）。 */
let llmModulePromise;

/**
 * 最近一次模型调用的诊断信息。
 * 简介功能出问题时，这里能直接说清「模块有没有加载到、用的哪个模型、流为什么没有正文」——
 * 第一版就是缺了它，80 条失败全是一句没信息量的「模型没有返回可用文本」。
 */
let lastLlmDiag = null;

// ---------------------------------------------------------------- 基础工具

/** 解析 DSH home：环境变量优先，回落 ~/.dsh。 */
function resolveHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  return join(homedir(), '.dsh');
}

/** 插件数据目录。 */
function storeDir() {
  return join(resolveHome(), 'hotspot');
}
function snapshotDir() {
  return join(storeDir(), 'snapshots');
}
function configPath() {
  return join(storeDir(), 'config.json');
}
function summariesPath() {
  return join(storeDir(), 'summaries.json');
}
function registryPath() {
  return join(storeDir(), 'repos.json');
}

/** 异常 → 单行文案。 */
function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 安全取服务。
 * cordis 里 `ctx.get(name)` 是官方取值入口（dsh-pet 也用它），比直接读
 * `ctx.llm` 更稳：未声明的服务被直接属性访问时可能抛错，而这里失败一律返回
 * undefined，交给调用方降级——本插件不该因为「模型服务暂时不可用」而整体挂掉。
 */
function service(ctx, name) {
  try {
    if (typeof ctx?.get === 'function') {
      const viaGet = ctx.get(name);
      if (viaGet !== undefined && viaGet !== null) return viaGet;
    }
  } catch {
    /* 落回属性读取 */
  }
  try {
    return ctx?.[name];
  } catch {
    return undefined;
  }
}

/** 确保目录存在。 */
function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** 原子写文件。 */
function writeAtomic(file, text) {
  ensureDir(dirname(file));
  const tmp = file + '.tmp';
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}

/** 读 JSON 文件，坏了就返回 fallback（不让一个坏文件拖垮插件）。 */
function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed === null || typeof parsed !== 'object' ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/** 短哈希（用于判断简介是否需要重新生成）。 */
function shortHash(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 12);
}

/** 今天的日期键（本地时区）。 */
function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 把纪元毫秒转成 ISO 字符串。 */
function iso(ms) {
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------- 配置

/** 读取用户配置并与默认值合并。boards 为整体替换语义。 */
function loadConfig() {
  const user = readJson(configPath(), {});
  const merged = { ...DEFAULT_CONFIG, ...user };
  if (!Array.isArray(merged.boards) || merged.boards.length === 0) merged.boards = DEFAULT_CONFIG.boards;
  merged.boards = merged.boards
    .filter((b) => b !== null && typeof b === 'object' && typeof b.id === 'string' && b.id !== '')
    .map((b) => ({
      id: String(b.id),
      name: String(b.name ?? b.id),
      desc: String(b.desc ?? ''),
      kind: b.kind === 'surge' ? 'surge' : 'query',
      query: String(b.query ?? 'topic:' + b.id),
      minStars: Number.isFinite(Number(b.minStars)) && Number(b.minStars) > 0 ? Number(b.minStars) : 0,
      maxStars: Number.isFinite(Number(b.maxStars)) && Number(b.maxStars) > 0 ? Number(b.maxStars) : 0,
    }));
  if (merged.boards.length === 0) merged.boards = DEFAULT_CONFIG.boards;
  merged.perPage = Math.min(MAX_PER_PAGE, Math.max(1, Number(merged.perPage) || DEFAULT_CONFIG.perPage));
  merged.schedule = normalizeSchedule(merged.schedule);
  merged.ranking = normalizeRanking(merged.ranking);
  return merged;
}

/** 保存配置（整份覆盖写）。 */
function saveConfig(next) {
  ensureDir(storeDir());
  writeAtomic(configPath(), JSON.stringify(next, null, 2) + '\n');
}

/** 取 GitHub token：环境变量优先，其次配置文件。 */
function resolveToken(config) {
  const env = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';
  if (env.trim() !== '') return env.trim();
  return typeof config.token === 'string' ? config.token.trim() : '';
}

// ---------------------------------------------------------------- 快照（采样）

/** 把任意历史格式的当日文件归一成 { date, samples:[{at, stars}] }。 */
function normalizeSnapshotFile(raw, fileDate) {
  if (raw !== null && typeof raw === 'object' && Array.isArray(raw.samples)) {
    const samples = raw.samples
      .filter((s) => s !== null && typeof s === 'object' && typeof s.at === 'string' && s.stars !== null && typeof s.stars === 'object')
      .map((s) => ({ at: s.at, stars: s.stars, ...(typeof s.lastAt === 'string' ? { lastAt: s.lastAt } : {}) }))
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    return { date: String(raw.date ?? fileDate), samples };
  }
  // 旧格式：{ date, savedAt, stars } —— 当成「当天一个样本」
  if (raw !== null && typeof raw === 'object' && raw.stars !== null && typeof raw.stars === 'object') {
    const at = typeof raw.savedAt === 'string' ? raw.savedAt : fileDate + 'T00:00:00.000Z';
    return { date: String(raw.date ?? fileDate), samples: [{ at, stars: raw.stars }] };
  }
  return { date: fileDate, samples: [] };
}

/** 读某一天的快照文件（已归一）。 */
function readSnapshotFile(date) {
  return normalizeSnapshotFile(readJson(join(snapshotDir(), date + '.json'), null), date);
}

/**
 * 记录一次采样。
 * 与上一个样本间隔小于 sampleIntervalMinutes 时**合并进上一个样本**（更新其 at 与星数），
 * 否则追加一个新样本。既保留时间分辨率，又不会被高频刷新撑爆。
 */
function recordSnapshot(repos) {
  if (repos.length === 0) return;
  const config = loadConfig();
  const date = todayKey();
  const snap = readSnapshotFile(date);
  const now = Date.now();
  const gap = Math.max(1, Number(config.sampleIntervalMinutes) || 15) * 60000;

  const incoming = {};
  for (const r of repos) incoming[r.fullName] = r.stars;

  const last = snap.samples[snap.samples.length - 1];
  if (last !== undefined && now - Date.parse(last.at) < gap) {
    // ⚠️ 合并时**绝不能把 at 往前推**（v0.2.0 的第一个 bug 就在这）：
    // 那样一天下来永远只剩一个「当前时刻」的采样，时间序列被自己抹掉——
    // 飙升榜永远 insufficient-history，区间涨星也永远算不出来（只能退回总星数）。
    // 正确做法：采样点固定为这个时间区间的起点，只用区间内最后一次观测值更新星数，
    // 另外记 lastAt 说明「星数实际观测于何时」。
    last.stars = { ...last.stars, ...incoming };
    last.lastAt = iso(now);
  } else {
    snap.samples.push({ at: iso(now), stars: incoming });
  }
  if (snap.samples.length > MAX_SAMPLES_PER_DAY) {
    snap.samples = snap.samples.slice(snap.samples.length - MAX_SAMPLES_PER_DAY);
  }

  ensureDir(snapshotDir());
  writeAtomic(join(snapshotDir(), date + '.json'), JSON.stringify({ date, samples: snap.samples }));
  samplesCache = { at: 0, data: [] }; // 失效缓存
}

/** 删除超过保留期的快照文件。 */
function pruneSnapshots(keepDays) {
  const dir = snapshotDir();
  if (!existsSync(dir)) return;
  const cutoff = Date.now() - keepDays * 86400000;
  let removed = 0;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    const t = Date.parse(entry.replace(/\.json$/, '') + 'T00:00:00');
    if (Number.isFinite(t) && t < cutoff) {
      try {
        unlinkSync(join(dir, entry));
        removed += 1;
      } catch {
        /* 删不掉不影响使用 */
      }
    }
  }
  if (removed > 0) samplesCache = { at: 0, data: [] };
}

/**
 * 扁平化读取全部样本，按时间升序：[{ at: ms, stars }]。
 * 带 30 秒内存缓存：60 天 × 每天最多 200 个样本的文件不该被每个请求重读一遍。
 */
function readSamples() {
  if (Date.now() - samplesCache.at < SAMPLES_TTL_MS && samplesCache.data.length > 0) return samplesCache.data;
  const dir = snapshotDir();
  const out = [];
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.json')) continue;
      const snap = readSnapshotFile(entry.replace(/\.json$/, ''));
      for (const s of snap.samples) {
        const at = Date.parse(s.at);
        if (Number.isFinite(at)) out.push({ at, stars: s.stars });
      }
    }
  }
  out.sort((a, b) => a.at - b.at);
  samplesCache = { at: Date.now(), data: out };
  return out;
}

/** 取「不晚于 cutoff」的最近一个样本；一个都没有就退回最早那个；cutoff=null 用最早那个。 */
function pickBaseline(samples, cutoffMs) {
  if (samples.length === 0) return undefined;
  if (cutoffMs === null) return samples[0];
  let best;
  for (const s of samples) {
    if (s.at <= cutoffMs) best = s;
    else break;
  }
  return best ?? samples[0];
}

// ---------------------------------------------------------------- 仓库注册表

/** 合并进仓库注册表（供飙升榜与简介使用）。 */
function mergeRegistry(repos) {
  if (repos.length === 0) return;
  const config = loadConfig();
  const store = readJson(registryPath(), { updatedAt: null, repos: {} });
  const map = store.repos !== null && typeof store.repos === 'object' ? store.repos : {};
  const now = iso(Date.now());
  for (const r of repos) {
    map[r.fullName] = {
      url: r.url,
      description: r.description,
      language: r.language,
      topics: r.topics,
      stars: r.stars,
      forks: r.forks,
      pushedAt: r.pushedAt,
      createdAt: r.createdAt,
      archived: r.archived,
      lastSeen: now,
    };
  }
  const names = Object.keys(map);
  const limit = Math.max(100, Number(config.registryLimit) || 4000);
  if (names.length > limit) {
    names
      .sort((a, b) => String(map[a].lastSeen ?? '').localeCompare(String(map[b].lastSeen ?? '')))
      .slice(0, names.length - limit)
      .forEach((n) => delete map[n]);
  }
  writeAtomic(registryPath(), JSON.stringify({ updatedAt: now, repos: map }));
}

/** 读仓库注册表。 */
function readRegistry() {
  const store = readJson(registryPath(), { repos: {} });
  return store.repos !== null && typeof store.repos === 'object' ? store.repos : {};
}

// ---------------------------------------------------------------- 中文简介

/**
 * 解析 DSH 提供的 `@deepseek-ai/dsh-llm` 的候选入口路径。
 *
 * 为什么不能只靠裸 import：DSH 把官方包摊在 `<DSH_HOME>/profiles/node_modules/@deepseek-ai/` 下，
 * 而 `dsh-llm` 那个目录**没有 package.json**（只有 lib/types/），所以：
 *   · 裸 `import('@deepseek-ai/dsh-llm')` 解析不到；
 *   · 本地路径安装（link:）时插件真实路径在工作区，Node 按真实路径向上找也找不到。
 * 于是这里按「裸 import → 各候选绝对路径」依次尝试，全都失败才走自带的兜底实现。
 */
function llmEntryCandidates() {
  const out = [];
  const roots = [];
  const profileDir = process.env.DSH_PROFILE_DIR;
  if (typeof profileDir === 'string' && profileDir.trim() !== '') {
    roots.push(join(dirname(profileDir.trim()), 'node_modules')); // <profiles>/node_modules
  }
  roots.push(join(resolveHome(), 'profiles', 'node_modules'));
  for (const root of roots) {
    out.push(join(root, '@deepseek-ai', 'dsh-llm', 'lib', 'types', 'index.js'));
  }
  return out;
}

/** 惰性加载官方 LLM 包；失败返回 null（只影响简介，自带的兜底实现仍可用）。 */
function loadLlmModule() {
  if (llmModulePromise === undefined) {
    llmModulePromise = (async () => {
      try {
        const mod = await import('@deepseek-ai/dsh-llm');
        if (typeof mod?.createUserMessage === 'function' || typeof mod?.BlockAssembler === 'function') {
          lastLlmDiag = { ...(lastLlmDiag ?? {}), moduleSource: 'bare-import' };
          return mod;
        }
      } catch {
        /* 继续试绝对路径 */
      }
      for (const candidate of llmEntryCandidates()) {
        if (!existsSync(candidate)) continue;
        try {
          const mod = await import(pathToFileURL(candidate).href);
          if (typeof mod?.createUserMessage === 'function' || typeof mod?.BlockAssembler === 'function') {
            lastLlmDiag = { ...(lastLlmDiag ?? {}), moduleSource: candidate };
            return mod;
          }
        } catch {
          /* 试下一个 */
        }
      }
      lastLlmDiag = { ...(lastLlmDiag ?? {}), moduleSource: 'none（用内置兜底实现）' };
      return null;
    })();
  }
  return llmModulePromise;
}

/**
 * 没有正文时，从 finish 里读出**真实**原因。
 * dsh-llm 会把适配器抛错折进终止块（不在流里抛出），所以不读 finish 就只能报
 * 一句没信息量的「模型没有返回可用文本」。
 */
function noTextReason(finish) {
  const { kind, failure } = finish ?? {};
  if (kind === 'aborted') return '生成已取消';
  if (kind === 'max-tokens') return '输出达到上限，未产出正文';
  if (kind !== 'error') return '模型未返回文本（finish=' + String(kind) + '）';
  const { message, code } = failure ?? {};
  if (typeof message === 'string' && message.trim() !== '') return message;
  if (typeof code === 'string' && code.trim() !== '') return code;
  return '模型报错但未提供原因';
}

/** 读简介缓存。 */
function readSummaries() {
  const store = readJson(summariesPath(), { texts: {}, failures: {} });
  return {
    texts: store.texts !== null && typeof store.texts === 'object' ? store.texts : {},
    failures: store.failures !== null && typeof store.failures === 'object' ? store.failures : {},
  };
}

/** 写简介缓存。 */
function writeSummaries(store) {
  writeAtomic(summariesPath(), JSON.stringify(store));
}

/**
 * 失败记录的统一形状。
 * `v` 是产生这条失败的插件版本：升级后旧失败会被视为「可能已被修掉的 bug」而重试，
 * 不必等 6 小时冷却过去（v0.2.1 修复简介解析后就是靠它自动重试的）。
 */
function failureRecord(reason, finish) {
  return { at: iso(Date.now()), v: VERSION, reason, ...(finish === undefined ? {} : { finish }) };
}

/** 简介的来源指纹：官方简介 / 话题 / 语言任一变化都要重新生成。 */
function summarySrc(repo) {
  return shortHash(
    String(repo.description ?? '') + '|' + (Array.isArray(repo.topics) ? repo.topics.join(',') : '') + '|' + String(repo.language ?? ''),
  );
}

/** 清洗模型输出：去掉 Markdown/引号/前后缀，压平空白，限长。 */
function cleanSummary(text) {
  let out = String(text ?? '').trim();
  out = out.replace(/^```[a-z]*\s*/i, '').replace(/```$/, '').trim();
  out = out.replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '');
  out = out.replace(/^(简介|介绍|说明|总结)\s*[:：]\s*/, '');
  out = out.replace(/\s+/g, ' ').trim();
  if (out.length > 160) out = out.slice(0, 159).trimEnd() + '…';
  return out;
}

/** 当前可用的生成模型：配置优先，其次当前对话的模型。 */
function resolveSummaryModel(ctx, config) {
  const configured = config.summaryModel;
  if (configured !== null && typeof configured === 'object') {
    const provider = String(configured.provider ?? '').trim();
    const model = String(configured.model ?? '').trim();
    if (provider !== '' && model !== '') return { provider, model };
  }
  try {
    const agentDefaultModel = service(ctx, 'agentDefaultModel');
    const sel = agentDefaultModel?.currentSelection?.();
    if (sel !== undefined && sel !== null && typeof sel.provider === 'string' && typeof sel.model === 'string') {
      return { provider: sel.provider, model: sel.model };
    }
  } catch {
    /* 服务不可用 → 没有模型 */
  }
  return undefined;
}

/** 该模型是否声明支持 reasoningEffort=off（不支持就绝不能传，否则整条请求被折叠成空流）。 */
async function supportsReasoningOff(ctx, provider, model) {
  const llm = service(ctx, 'llm');
  if (llm === undefined || typeof llm.resolveModelInfo !== 'function') return false;
  try {
    const info = await llm.resolveModelInfo(provider, model);
    return info?.reasoning?.efforts?.some((e) => e.id === 'off') ?? false;
  } catch {
    return false;
  }
}

/**
 * BlockAssembler 缺失时的兜底解析。
 *
 * 必须认 dsh-llm 的**真实分片协议**（见其 assembler.js 的 push）：
 *   block-start / text-delta{index,text} / reasoning-delta / tool-call-delta /
 *   block-end{index,block} / usage / finish{reason}
 * v0.2.0 第一版只找 {type:'text'}，于是模型明明返回了文本却被判成「没有正文」——
 * 80 条简介全部失败就是这么来的。
 */
function textFromChunks(chunks) {
  let text = '';
  let finish;
  for (const chunk of chunks) {
    if (chunk === null || typeof chunk !== 'object') continue;
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
    else if (chunk.type === 'finish') finish = chunk.reason;
    else if (chunk.type === 'block-end' && chunk.block !== null && typeof chunk.block === 'object') {
      // 只有整块、没有增量时才用块里的文本，避免与增量重复计数
      if (text === '' && chunk.block.type === 'text' && typeof chunk.block.text === 'string') text = chunk.block.text;
    } else if (chunk.type === 'text' && typeof chunk.text === 'string') text += chunk.text; // 兼容测试替身
  }
  return { text, finish };
}

/**
 * 为一个仓库生成中文简介。
 * 任何失败都只记录到 failures（带冷却），绝不影响其它功能。
 */
async function summarizeOne(ctx, repo, config) {
  const store = readSummaries();
  const model = resolveSummaryModel(ctx, config);
  if (model === undefined) {
    store.failures[repo.fullName] = failureRecord('当前没有可用模型（未配置对话模型）');
    writeSummaries(store);
    return false;
  }

  const llm = service(ctx, 'llm');
  if (llm === undefined || typeof llm.stream !== 'function') {
    store.failures[repo.fullName] = failureRecord('LLM 服务不可用');
    writeSummaries(store);
    return false;
  }

  const llmMod = await loadLlmModule();
  const system =
    '你是中文技术编辑。请用一到两句话介绍给定的 GitHub 项目：它是什么、能解决什么问题。' +
    '要求：直接输出简介本身；不要任何前后缀、不要 Markdown、不要引号、不要重复项目名；' +
    '面向中文开发者，不超过 80 个汉字。';
  const userText = [
    '项目：' + repo.fullName,
    '官方简介：' + (repo.description === '' ? '（无）' : repo.description),
    '话题：' + (Array.isArray(repo.topics) && repo.topics.length > 0 ? repo.topics.join(', ') : '（无）'),
    '主要语言：' + (repo.language === '' ? '未知' : repo.language),
    '星标数：' + repo.stars,
  ].join('\n');

  const useOff = await supportsReasoningOff(ctx, model.provider, model.model);
  let message;
  if (typeof llmMod?.createUserMessage === 'function') {
    message = llmMod.createUserMessage({ content: [{ type: 'text', text: userText }], source: { kind: 'user' } });
  } else {
    // 兜底结构必须带 id：官方 createMessage 会补一个 uuid，缺了适配器可能直接判为非法消息。
    message = { id: randomUUID(), role: 'user', content: [{ type: 'text', text: userText }], source: { kind: 'user' } };
  }

  const options = {
    provider: model.provider,
    model: model.model,
    sessionId: CALL_IDENTITY,
    messages: [message],
    system,
    temperature: 0.4,
    ...(useOff ? { reasoningEffort: 'off' } : {}),
    signal: AbortSignal.timeout(60000),
  };

  const moduleSource = llmMod === null ? '内置兜底实现' : 'dsh-llm 官方实现';
  let text = '';
  let finish;
  try {
    if (typeof llmMod?.BlockAssembler === 'function') {
      const assembler = new llmMod.BlockAssembler();
      for await (const chunk of llm.stream(options)) assembler.push(chunk);
      finish = assembler.finish;
      text = assembler
        .blocks()
        .filter((b) => b.type === 'text')
        .map((b) => ('text' in b ? b.text : ''))
        .join('');
    } else {
      const chunks = [];
      for await (const chunk of llm.stream(options)) chunks.push(chunk);
      const parsed = textFromChunks(chunks);
      text = parsed.text;
      finish = parsed.finish;
    }
  } catch (error) {
    const reason = describe(error);
    lastLlmDiag = { at: iso(Date.now()), repo: repo.fullName, model: model.provider + '/' + model.model, moduleSource, stage: 'stream-throw', reason };
    store.failures[repo.fullName] = failureRecord(reason);
    writeSummaries(store);
    return false;
  }

  const cleaned = cleanSummary(text);
  if (cleaned === '') {
    // 关键：从 finish 里读出真实原因，别只报一句「没有正文」
    const reason = noTextReason(finish);
    lastLlmDiag = { at: iso(Date.now()), repo: repo.fullName, model: model.provider + '/' + model.model, moduleSource, stage: 'no-text', reason, finish: finish ?? null, rawTextLength: text.length };
    store.failures[repo.fullName] = failureRecord(reason, finish);
    writeSummaries(store);
    return false;
  }
  lastLlmDiag = { at: iso(Date.now()), repo: repo.fullName, model: model.provider + '/' + model.model, moduleSource, stage: 'ok', textLength: cleaned.length };

  const fresh = readSummaries(); // 重新读：worker 串行，但避免覆盖别人刚写的
  fresh.texts[repo.fullName] = {
    text: cleaned,
    at: iso(Date.now()),
    src: summarySrc(repo),
    model: model.provider + '/' + model.model,
  };
  delete fresh.failures[repo.fullName];
  writeSummaries(fresh);
  return true;
}

/** 串行 worker：一次只跑一个模型调用，避免并发打爆凭据/限流。 */
async function runSummaryWorker(ctx) {
  if (summaryWorkerRunning) return;
  summaryWorkerRunning = true;
  try {
    while (summaryQueue.length > 0) {
      const repo = summaryQueue.shift();
      summaryQueued.delete(repo.fullName);
      try {
        await summarizeOne(ctx, repo, loadConfig());
      } catch {
        /* summarizeOne 内部已收口，这里只是最后一道保险 */
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  } finally {
    summaryWorkerRunning = false;
  }
}

/**
 * 把「缺简介」的条目排进后台队列（最多 batch 条）。
 * 冷却期内的失败条目会被跳过，避免反复重试。
 */
function enqueueSummaries(ctx, items, config) {
  if (config.summarize !== true) return;
  const store = readSummaries();
  const cooldown = Math.max(1, Number(config.summaryCooldownMinutes) || 360) * 60000;
  const batch = Math.max(1, Number(config.summaryBatch) || 8);
  let queued = 0;
  for (const item of items) {
    if (queued >= batch) break;
    const src = summarySrc(item);
    const hit = store.texts[item.fullName];
    if (hit !== undefined && hit.src === src) continue; // 已有且未过期
    const failure = store.failures[item.fullName];
    // 冷却只在**同一插件版本**内生效：升级后旧失败很可能是已修 bug 造成的，应当重试
    const sameVersion = failure !== undefined && failure.v === VERSION;
    if (sameVersion && Date.now() - Date.parse(failure.at) < cooldown) continue; // 冷却中
    if (summaryQueued.has(item.fullName)) continue;
    summaryQueued.add(item.fullName);
    summaryQueue.push(item);
    queued += 1;
  }
  if (summaryQueue.length > 0) void runSummaryWorker(ctx);
}

/** 把简介挂到条目上；没有就标记 pending，让界面显示占位。 */
function attachSummary(item) {
  const store = readSummaries();
  const hit = store.texts[item.fullName];
  const src = summarySrc(item);
  if (hit !== undefined && hit.src === src) {
    return { ...item, summary: hit.text, summaryPending: false };
  }
  return { ...item, summary: null, summaryPending: true };
}

// ---------------------------------------------------------------- GitHub 抓取

/** 把 GitHub 仓库对象裁剪成我们需要的字段。 */
function mapRepo(item) {
  return {
    fullName: String(item.full_name ?? ''),
    url: String(item.html_url ?? ''),
    description: String(item.description ?? ''),
    stars: Number(item.stargazers_count ?? 0),
    forks: Number(item.forks_count ?? 0),
    issues: Number(item.open_issues_count ?? 0),
    language: String(item.language ?? ''),
    topics: Array.isArray(item.topics) ? item.topics.slice(0, 8) : [],
    pushedAt: String(item.pushed_at ?? ''),
    createdAt: String(item.created_at ?? ''),
    archived: item.archived === true,
  };
}

/** 拼 GitHub search 的 q 参数。 */
function buildQuery(board) {
  const parts = [board.query];
  if (board.minStars > 0) parts.push('stars:>=' + board.minStars);
  if (board.maxStars > 0) parts.push('stars:<=' + board.maxStars);
  return parts.filter((p) => typeof p === 'string' && p.trim() !== '').join(' ').trim();
}

/** 抓一个普通榜单：进内存缓存 + 当日采样 + 仓库注册表。 */
async function fetchBoard(board, config) {
  const token = resolveToken(config);
  const url =
    'https://api.github.com/search/repositories?q=' +
    encodeURIComponent(buildQuery(board)) +
    '&sort=stars&order=desc&per_page=' +
    config.perPage;
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-hotspot' };
  if (token !== '') headers.Authorization = 'Bearer ' + token;

  const res = await fetch(url, { headers });

  if (res.status === 403 || res.status === 429) {
    const resetHeader = res.headers.get('x-ratelimit-reset');
    const resetAt = resetHeader !== null ? Number(resetHeader) * 1000 : undefined;
    const error = new Error(
      'GitHub 速率限制' +
        (resetAt !== undefined ? '，' + new Date(resetAt).toLocaleTimeString() + ' 后重置' : '') +
        (token === '' ? '（未配置 token：未认证的搜索接口只有 10 次/分钟）' : ''),
    );
    error.kind = 'rate-limited';
    error.resetAt = resetAt;
    throw error;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const error = new Error('GitHub ' + res.status + '：' + body.slice(0, 200));
    error.kind = 'http';
    throw error;
  }

  const json = await res.json();
  const repos = Array.isArray(json.items) ? json.items.map(mapRepo).filter((r) => r.fullName !== '') : [];
  cache.set(board.id, { at: Date.now(), repos });
  lastErrors.delete(board.id);
  recordSnapshot(repos);
  mergeRegistry(repos);
  return repos;
}

/** 顺序抓取全部（或指定）普通榜单，带节流。飙升榜不需要抓取。 */
async function refreshBoards(config, onlyBoardId) {
  const targets = config.boards.filter(
    (b) => b.kind !== 'surge' && (typeof onlyBoardId !== 'string' || onlyBoardId === '' || b.id === onlyBoardId),
  );
  const results = [];
  for (let i = 0; i < targets.length; i++) {
    const board = targets[i];
    try {
      const repos = await fetchBoard(board, config);
      results.push({ board: board.id, ok: true, count: repos.length });
    } catch (error) {
      lastErrors.set(board.id, describe(error));
      results.push({ board: board.id, ok: false, error: describe(error), kind: error?.kind });
    }
    // 未认证 10 次/分钟：榜单一多就连着打必然 403，主动让路
    if (i < targets.length - 1) await new Promise((r) => setTimeout(r, 1500));
  }
  pruneSnapshots(config.snapshotKeepDays);
  return results;
}

// ---------------------------------------------------------------- 排名

// ---------------------------------------------------------------- 更新日程

/** 星期名（0=周日）。 */
const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 把日程说成人话。 */
function describeSchedule(spec) {
  const hh = String(spec.hour).padStart(2, '0') + ':00';
  if (spec.every === 'day') return '每天 ' + hh;
  if (spec.every === 'week') return '每' + WEEKDAY_NAMES[spec.weekday] + ' ' + hh;
  return '每月 ' + spec.day + ' 号 ' + hh;
}

/** 单条日程规格归一化：坏值一律回落默认。 */
function normalizeScheduleSpec(raw, fallback) {
  const spec = raw !== null && typeof raw === 'object' ? raw : {};
  const every = spec.every === 'week' || spec.every === 'month' ? spec.every : 'day';
  const hour = Number.isFinite(Number(spec.hour)) ? Math.min(23, Math.max(0, Math.trunc(Number(spec.hour)))) : 0;
  if (every === 'week') {
    const weekday = Number.isFinite(Number(spec.weekday)) ? ((Math.trunc(Number(spec.weekday)) % 7) + 7) % 7 : fallback.weekday ?? 1;
    return { every, weekday, hour };
  }
  if (every === 'month') {
    const day = Number.isFinite(Number(spec.day)) ? Math.min(31, Math.max(1, Math.trunc(Number(spec.day)))) : fallback.day ?? 1;
    return { every, day, hour };
  }
  return { every, hour };
}

/** 整份日程归一化（缺项用默认）。 */
function normalizeSchedule(raw) {
  const src = raw !== null && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const key of Object.keys(DEFAULT_CONFIG.schedule)) {
    out[key] = normalizeScheduleSpec(src[key], DEFAULT_CONFIG.schedule[key]);
  }
  return out;
}

/** 某年某月的天数。 */
function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/** 把 date 设成「year 年 monthIndex 月 spec.day 号 spec.hour 点」，号数超长取当月最后一天。 */
function setMonthlyPoint(date, spec, year, monthIndex) {
  date.setFullYear(year, monthIndex, Math.min(spec.day, daysInMonth(year, monthIndex)));
  date.setHours(spec.hour, 0, 0, 0);
  return date.getTime();
}

/**
 * 日程中**不晚于 now** 的最近一个边界（本地时区）。
 * 纯函数：now 由调用方显式传入，测试能钉死任意时刻（跨月/跨年/闰年都不靠运气）。
 */
function lastBoundary(spec, now) {
  const d = new Date(now);
  if (spec.every === 'day') {
    d.setHours(spec.hour, 0, 0, 0);
    if (d.getTime() > now) d.setDate(d.getDate() - 1);
    return d.getTime();
  }
  if (spec.every === 'week') {
    d.setHours(spec.hour, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() - spec.weekday + 7) % 7));
    if (d.getTime() > now) d.setDate(d.getDate() - 7);
    return d.getTime();
  }
  const current = setMonthlyPoint(d, spec, d.getFullYear(), d.getMonth());
  if (current > now) return setMonthlyPoint(d, spec, d.getFullYear(), d.getMonth() - 1);
  return current;
}

/** 日程中**晚于 now** 的最近一个边界。 */
function nextBoundary(spec, now) {
  const d = new Date(now);
  if (spec.every === 'day') {
    d.setHours(spec.hour, 0, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  if (spec.every === 'week') {
    d.setHours(spec.hour, 0, 0, 0);
    d.setDate(d.getDate() + ((spec.weekday - d.getDay() + 7) % 7));
    if (d.getTime() <= now) d.setDate(d.getDate() + 7);
    return d.getTime();
  }
  const current = setMonthlyPoint(d, spec, d.getFullYear(), d.getMonth());
  if (current > now) return current;
  return setMonthlyPoint(d, spec, d.getFullYear(), d.getMonth() + 1);
}

// ---------------------------------------------------------------- 榜单冻结（按日程）

/** 冻结库路径：每个「榜单 × 周期」存一份上次边界算出的结果。 */
function frozenPath() {
  return join(storeDir(), 'frozen.json');
}

/** 读冻结库 + 采样进度。 */
function readFrozen() {
  const store = readJson(frozenPath(), { sampledBoundary: null, items: {} });
  // 注意：必须**先**判 null/undefined。Number(null) === 0 且 Number.isFinite(0) === true，
  // 直接 Number.isFinite(Number(x)) 会把 null 哨兵误判成「采样于 1970-01-01」。
  const raw = store.sampledBoundary;
  const sampled =
    raw === null || raw === undefined || !Number.isFinite(Number(raw)) ? null : Number(raw);
  return {
    sampledBoundary: sampled,
    items: store.items !== null && typeof store.items === 'object' ? store.items : {},
  };
}

/** 写冻结库。 */
function writeFrozen(store) {
  writeAtomic(frozenPath(), JSON.stringify(store));
}

/**
 * 把冻结条目组装成响应。
 * 简介与 summaryStats **每次重新挂**：新生成的中文简介不该被「榜单冻结」挡住。
 */
function presentEntry(ctx, entry, opts) {
  const config = opts.config;
  const items = entry.items.slice(0, config.perPage).map((item, index) => ({ rank: index + 1, ...attachSummary(item) }));
  if (config.summarize === true) enqueueSummaries(ctx, items, config);
  const isSurge = entry.surge === true;
  const notes = [...(entry.notes ?? [])];
  notes.push(
    '更新日程：' + describeSchedule(opts.spec) +
      '；本榜下次更新 ' + iso(opts.next) +
      (opts.frozenHit === true ? '（当前显示的是上次边界冻结的结果）' : ''),
  );
  if (isSurge) notes.push('飙升榜固定按自己的日程更新，上面的日/周/月页签对它不起作用。');
  return {
    board: { id: opts.board.id, name: opts.board.name, desc: opts.board.desc, query: isSurge ? '(跨榜单)' : opts.board.query },
    period: entry.period,
    basis: entry.basis,
    windowStart: entry.windowStart ?? null,
    windowHours: entry.windowHours ?? null,
    sampleCount: entry.sampleCount,
    fetchedAt: entry.fetchedAt,
    stale: entry.stale === true,
    rateLimited: entry.rateLimited === true,
    resetAt: entry.resetAt ?? null,
    registrySize: entry.registrySize,
    dataAsOf: iso(entry.targetAt ?? entry.computedAt),
    ranking: entry.ranking ?? null,
    summaryStats: summaryStats(readSummaries()),
    classifyStats: classifyStats(readClassify()),
    scheduled: {
      rule: describeSchedule(opts.spec),
      spec: opts.spec,
      boundary: iso(opts.boundary),
      nextBoundary: iso(opts.next),
      nextInMs: Math.max(0, opts.next - Date.now()),
      computedAt: iso(entry.computedAt),
      frozen: opts.frozenHit === true,
      provisional: entry.provisional === true,
      ignoresPeriodTabs: isSurge,
    },
    notes,
    items,
  };
}

/**
 * 用样本给一组仓库算「[cutoff, boundary] 区间内」的涨星。
 *
 * 关键点：**区间的两端都取采样**，而不是拿「最新采样」当终点。
 * v0.4.0 拿最新采样当终点，于是 10 月 19 日算的月榜其实覆盖
 * 「9 月 1 日 → 现在」，标签和实际区间对不上；而且首次运行时那点微弱历史
 * 会被冻结一整个月。现在两端都锚在边界上，标签即事实。
 */
function rankWithWindow(repos, samples, cutoffMs, boundaryMs) {
  const baseline = pickBaseline(samples, cutoffMs);
  const target = pickBaseline(samples, boundaryMs);
  const canDelta =
    baseline !== undefined && target !== undefined && samples.length >= 2 && baseline.at !== target.at;
  const hours = canDelta ? Math.max(0.1, (target.at - baseline.at) / 3600000) : 0;
  const shortWindow = canDelta && cutoffMs !== null && baseline.at > cutoffMs;
  const lateTarget = target !== undefined && boundaryMs !== null && target.at > boundaryMs;

  const items = repos.map((repo) => {
    if (!canDelta) return { ...repo, delta: null, isNew: false, afterBoundary: false };
    const tStars = target.stars[repo.fullName];
    const bStars = baseline.stars[repo.fullName];
    // 边界那次采样里还没有它（边界后才冒出来）→ 算不了区间涨星，但保留在列表里
    if (typeof tStars !== 'number') return { ...repo, delta: null, isNew: false, afterBoundary: true };
    // 基线里没有 → 新上榜
    if (typeof bStars !== 'number') return { ...repo, stars: tStars, delta: 0, isNew: true, afterBoundary: false };
    // 星数也用边界那次的观测值，保证 ★ 与 delta 同源、不会出现「★ 是现在、delta 是当时」的错位
    return { ...repo, stars: tStars, delta: tStars - bStars, isNew: false, afterBoundary: false };
  });

  return {
    items,
    canDelta,
    baseline,
    target,
    sampleCount: samples.length,
    hours: Math.round(hours * 10) / 10,
    shortWindow,
    lateTarget,
  };
}

/**
 * 飙升榜：跨全部已追踪仓库，按 [上一个日程边界, 本边界] 区间内的涨星量排序。
 * 数据来自仓库注册表（不依赖任何查询），所以能看到各榜单之外的黑马。
 */
function rankSurge(samples, cutoffMs, boundaryMs) {
  const registry = readRegistry();
  const names = Object.keys(registry);
  const baseline = pickBaseline(samples, cutoffMs);
  const target = pickBaseline(samples, boundaryMs);
  const canDelta =
    baseline !== undefined && target !== undefined && samples.length >= 2 && baseline.at !== target.at;
  const hours = canDelta ? Math.max(0.1, (target.at - baseline.at) / 3600000) : 0;
  const shortWindow = canDelta && baseline.at > cutoffMs;

  if (!canDelta) {
    return {
      items: [],
      canDelta: false,
      baseline,
      target,
      hours: 0,
      sampleCount: samples.length,
      shortWindow: false,
      note: '样本还不够算速度：需要两个不同时刻的采样（默认每天 0 点抓一次），跨过下一个更新边界后才有数据。',
    };
  }

  const items = [];
  for (const fullName of names) {
    const meta = registry[fullName];
    const tStars = target.stars[fullName];
    if (typeof tStars !== 'number') continue; // 边界采样里没有 → 无法比较
    const bStars = baseline.stars[fullName];
    if (typeof bStars !== 'number') continue; // 基线里没有 → 新出现，不计入速度榜（避免误报）
    const delta = tStars - bStars;
    if (delta <= 0) continue;
    items.push({
      fullName,
      url: meta.url,
      description: meta.description ?? '',
      language: meta.language ?? '',
      topics: Array.isArray(meta.topics) ? meta.topics : [],
      stars: tStars,
      forks: meta.forks ?? 0,
      pushedAt: meta.pushedAt ?? '',
      createdAt: meta.createdAt ?? '',
      archived: meta.archived === true,
      delta,
      isNew: false,
      afterBoundary: false,
      perDay: Math.round((delta / hours) * 24 * 10) / 10,
    });
  }
  return {
    items,
    canDelta: true,
    baseline,
    target,
    hours: Math.round(hours * 10) / 10,
    shortWindow,
    sampleCount: samples.length,
    note:
      '区间 ' + humanHours(hours) + '（上一个更新边界 → 本边界' + (shortWindow ? '，实际短于一个完整周期，因为采样历史还不够长' : '') + '），跨 ' +
      names.length + ' 个已追踪仓库；只统计区间内涨星为正、且基线采样里已存在的仓库。',
  };
}

// ---------------------------------------------------------------- 相关性判定（模型）

/** 分类库路径。 */
function classifyPath() {
  return join(storeDir(), 'classify.json');
}

/** 排序/过滤参数归一化。 */
function normalizeRanking(raw) {
  const src = raw !== null && typeof raw === 'object' ? raw : {};
  const def = DEFAULT_CONFIG.ranking;
  return {
    requireTool: src.requireTool === false ? false : def.requireTool,
    minRelevance: Number.isFinite(Number(src.minRelevance)) ? Math.min(100, Math.max(0, Math.trunc(Number(src.minRelevance)))) : def.minRelevance,
    relevanceWeight: Number.isFinite(Number(src.relevanceWeight)) ? Math.max(0, Number(src.relevanceWeight)) : def.relevanceWeight,
    platformStars: Number.isFinite(Number(src.platformStars)) ? Math.max(0, Math.trunc(Number(src.platformStars))) : def.platformStars,
    listPattern: typeof src.listPattern === 'string' ? src.listPattern : def.listPattern,
  };
}

/** 读分类库。 */
function readClassify() {
  const store = readJson(classifyPath(), { items: {}, failures: {} });
  return {
    items: store.items !== null && typeof store.items === 'object' ? store.items : {},
    failures: store.failures !== null && typeof store.failures === 'object' ? store.failures : {},
  };
}

/** 写分类库。 */
function writeClassify(store) {
  writeAtomic(classifyPath(), JSON.stringify(store));
}

/**
 * 分类缓存键：**榜 + 仓库 + 内容指纹**。
 * 相关性是相对榜单而言的（同一个仓库在 mcp-server 榜是工具、在 dsh-skin 榜就是无关），
 * 所以键里必须带榜；内容指纹变了就要重新判定。
 */
function classifyKey(themeId, repo) {
  const src = shortHash(String(repo.description ?? '') + '|' + (Array.isArray(repo.topics) ? repo.topics.join(',') : ''));
  return themeId + '|' + repo.fullName + '|' + src;
}

/** 榜单的「主题」：普通榜用榜单自己的名字/描述；飙升榜跨榜，用一条通用主题。 */
function themeOf(board) {
  if (board.kind === 'surge') {
    return {
      id: 'surge',
      name: 'AI 编码助手生态的小工具',
      desc: 'DSH / Codex / Claude Code 等 agent 生态里的插件、技能包、桌宠、MCP 服务、皮肤等**具体**小工具',
      query: '(跨榜单)',
    };
  }
  return { id: board.id, name: board.name, desc: board.desc, query: board.query };
}

/** 从模型输出里解析判定结果（容忍代码块与前后废话）。 */
function parseVerdict(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  let obj;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (obj === null || typeof obj !== 'object') return undefined;
  const verdicts = ['tool', 'platform', 'list', 'unrelated'];
  const verdict = verdicts.includes(obj.verdict) ? obj.verdict : undefined;
  const relevance = Number(obj.relevance);
  if (verdict === undefined || !Number.isFinite(relevance)) return undefined;
  return {
    verdict,
    relevance: Math.min(100, Math.max(0, Math.round(relevance))),
    reason: String(obj.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
  };
}

/** 新鲜度加分：近期还在更新的项目给一点边际优势。 */
function freshnessBonus(pushedAt) {
  const t = Date.parse(String(pushedAt ?? ''));
  if (!Number.isFinite(t)) return 0;
  const days = (Date.now() - t) / 86400000;
  if (days <= 30) return 2;
  if (days <= 90) return 1;
  return 0;
}

/**
 * 综合分 = 区间涨星 + 相关性 × 权重 + 新鲜度。
 * 相关性只是「边际修正」，不该盖过真实涨星——否则小榜单会被一堆 100 分但零增长的项目占满。
 */
function scoreOf(item, config) {
  const delta = typeof item.delta === 'number' ? item.delta : 0;
  const relevance = typeof item.relevance === 'number' ? item.relevance : 0;
  return delta + relevance * config.ranking.relevanceWeight + freshnessBonus(item.pushedAt);
}

/**
 * 过滤 + 打分 + 排序。返回 { items, stats, pending }。
 *   pending > 0 表示还有仓库没判定完 → 结果只能是「临时」的，不能冻结。
 */
function scoreAndFilter(items, board, config) {
  const theme = themeOf(board);
  const rank = config.ranking;
  const store = readClassify();
  const stats = {
    before: items.length,
    kept: 0,
    pending: 0,
    dropped: { list: 0, platform: 0, unrelated: 0, lowRelevance: 0 },
  };
  const kept = [];
  const pending = [];

  for (const item of items) {
    // 1) 零成本规则预筛：合集/清单类直接剔除
    if (rank.listPattern !== '') {
      let probe = '';
      try {
        probe = new RegExp(rank.listPattern, 'i').test(item.fullName + ' ' + (item.description ?? '')) ? 'hit' : '';
      } catch {
        probe = '';
      }
      if (probe === 'hit') {
        stats.dropped.list += 1;
        continue;
      }
    }

    // 2) 星数异常高 → 判为平台级（省一次模型调用）
    if (rank.platformStars > 0 && item.stars >= rank.platformStars) {
      stats.dropped.platform += 1;
      continue;
    }

    // 3) 没开模型判定：规则过了就收
    if (config.classify !== true) {
      kept.push({ ...item, relevance: null, verdict: 'unjudged', verdictReason: '' });
      continue;
    }

    // 4) 查模型判定缓存
    const rec = store.items[classifyKey(theme.id, item)];
    if (rec === undefined) {
      stats.pending += 1;
      pending.push(item);
      kept.push({ ...item, relevance: null, verdict: 'pending', verdictReason: '' });
      continue;
    }
    if (rank.requireTool && rec.verdict !== 'tool') {
      const k = rec.verdict === 'list' || rec.verdict === 'platform' || rec.verdict === 'unrelated' ? rec.verdict : 'unrelated';
      stats.dropped[k] += 1;
      continue;
    }
    if (rec.relevance < rank.minRelevance) {
      stats.dropped.lowRelevance += 1;
      continue;
    }
    kept.push({ ...item, relevance: rec.relevance, verdict: rec.verdict, verdictReason: rec.reason ?? '' });
  }

  // 已判定的排在待判定之前：否则首屏会被「还没判定的巨型项目」占满（正是要修的问题）
  kept.sort((a, b) => {
    const ap = a.verdict === 'pending' ? 1 : 0;
    const bp = b.verdict === 'pending' ? 1 : 0;
    if (ap !== bp) return ap - bp;
    return scoreOf(b, config) - scoreOf(a, config) || b.stars - a.stars;
  });

  stats.kept = kept.length;
  return { items: kept, stats, pending };
}

/** 串行判定 worker 状态。 */
const classifyQueue = [];
const classifyQueued = new Set();
let classifyWorkerRunning = false;
let lastClassifyDiag = null;

/** 一次判定：让模型回答「这是不是本榜该收的具体小工具」。 */
async function classifyOne(ctx, board, repo, config) {
  const theme = themeOf(board);
  const store = readClassify();
  const key = classifyKey(theme.id, repo);
  const model = resolveSummaryModel(ctx, {
    ...config,
    summaryModel: config.classifyModel ?? config.summaryModel,
  });
  if (model === undefined) {
    store.failures[key] = { at: iso(Date.now()), v: VERSION, reason: '当前没有可用模型（未配置对话模型）' };
    writeClassify(store);
    return false;
  }
  const llm = service(ctx, 'llm');
  if (llm === undefined || typeof llm.stream !== 'function') {
    store.failures[key] = { at: iso(Date.now()), v: VERSION, reason: 'LLM 服务不可用' };
    writeClassify(store);
    return false;
  }

  const llmMod = await loadLlmModule();
  const system =
    '你是严格的技术策展人。判断给定 GitHub 仓库是否属于指定主题下的**一个具体小工具**。\n' +
    'verdict 取值：\n' +
    '  tool      = 可以直接拿来用的具体插件 / 工具 / 技能包 / 小挂件；\n' +
    '  platform  = 平台级框架、SDK、整套运行时或大型应用（即使话题匹配，也不是这个榜要的小工具）；\n' +
    '  list      = 合集、清单、导航、awesome-list、资料汇总；\n' +
    '  unrelated = 与该主题没有实质关系。\n' +
    'relevance = 0–100，表示它作为该主题「小工具」的相关程度。\n' +
    '只输出一行 JSON，不要代码块、不要解释：{"verdict":"...","relevance":0,"reason":"不超过20字的中文理由"}';
  const userText = [
    '主题：' + theme.name + ' —— ' + theme.desc,
    '主题对应的 GitHub 检索：' + theme.query,
    '仓库：' + repo.fullName,
    '官方简介：' + (repo.description === '' ? '（无）' : repo.description),
    '话题：' + (Array.isArray(repo.topics) && repo.topics.length > 0 ? repo.topics.join(', ') : '（无）'),
    '语言：' + (repo.language === '' ? '未知' : repo.language),
    '星标数：' + repo.stars,
  ].join('\n');

  const useOff = await supportsReasoningOff(ctx, model.provider, model.model);
  const message =
    typeof llmMod?.createUserMessage === 'function'
      ? llmMod.createUserMessage({ content: [{ type: 'text', text: userText }], source: { kind: 'user' } })
      : { id: randomUUID(), role: 'user', content: [{ type: 'text', text: userText }], source: { kind: 'user' } };
  const options = {
    provider: model.provider,
    model: model.model,
    sessionId: CALL_IDENTITY,
    messages: [message],
    system,
    temperature: 0,
    ...(useOff ? { reasoningEffort: 'off' } : {}),
    signal: AbortSignal.timeout(60000),
  };

  let text = '';
  let finish;
  try {
    if (typeof llmMod?.BlockAssembler === 'function') {
      const assembler = new llmMod.BlockAssembler();
      for await (const chunk of llm.stream(options)) assembler.push(chunk);
      finish = assembler.finish;
      text = assembler.blocks().filter((b) => b.type === 'text').map((b) => ('text' in b ? b.text : '')).join('');
    } else {
      const chunks = [];
      for await (const chunk of llm.stream(options)) chunks.push(chunk);
      const parsed = textFromChunks(chunks);
      text = parsed.text;
      finish = parsed.finish;
    }
  } catch (error) {
    store.failures[key] = { at: iso(Date.now()), v: VERSION, reason: describe(error) };
    writeClassify(store);
    return false;
  }

  const verdict = parseVerdict(text);
  if (verdict === undefined) {
    lastClassifyDiag = { at: iso(Date.now()), repo: repo.fullName, theme: theme.id, stage: 'parse-failed', reason: noTextReason(finish), raw: text.slice(0, 120) };
    store.failures[key] = { at: iso(Date.now()), v: VERSION, reason: '判定结果无法解析：' + noTextReason(finish) };
    writeClassify(store);
    return false;
  }

  const freshStore = readClassify();
  freshStore.items[key] = { ...verdict, at: iso(Date.now()), model: model.provider + '/' + model.model };
  delete freshStore.failures[key];
  writeClassify(freshStore);
  lastClassifyDiag = { at: iso(Date.now()), repo: repo.fullName, theme: theme.id, stage: 'ok', verdict: verdict.verdict, relevance: verdict.relevance };
  return true;
}

/** 串行 worker：一次一个模型调用，避免打爆凭据与并发限流。 */
async function runClassifyWorker(ctx) {
  if (classifyWorkerRunning) return;
  classifyWorkerRunning = true;
  try {
    while (classifyQueue.length > 0) {
      const job = classifyQueue.shift();
      classifyQueued.delete(classifyKey(themeOf(job.board).id, job.repo));
      try {
        await classifyOne(ctx, job.board, job.repo, loadConfig());
      } catch {
        /* classifyOne 内部已收口 */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  } finally {
    classifyWorkerRunning = false;
  }
}

/** 把「还没判定」的仓库排队（每轮最多 batch 条，失败进冷却）。 */
function enqueueClassify(ctx, board, repos, config) {
  if (config.classify !== true) return 0;
  const theme = themeOf(board);
  const store = readClassify();
  const cooldown = Math.max(1, Number(config.classifyCooldownMinutes) || 720) * 60000;
  const batch = Math.max(1, Number(config.classifyBatch) || 10);
  let queued = 0;
  for (const repo of repos) {
    if (queued >= batch) break;
    const key = classifyKey(theme.id, repo);
    if (store.items[key] !== undefined) continue; // 已判定
    const failure = store.failures[key];
    if (failure !== undefined && failure.v === VERSION && Date.now() - Date.parse(failure.at) < cooldown) continue;
    if (classifyQueued.has(key)) continue;
    classifyQueued.add(key);
    classifyQueue.push({ board, repo });
    queued += 1;
  }
  if (classifyQueue.length > 0) void runClassifyWorker(ctx);
  return queued;
}

/** 判定进度统计。 */
function classifyStats(store) {
  return {
    version: VERSION,
    cached: Object.keys(store.items).length,
    failed: Object.keys(store.failures).length,
    queued: classifyQueue.length,
    classifying: classifyWorkerRunning,
    disabled: loadConfig().classify !== true,
    lastDiag: lastClassifyDiag,
  };
}

/** 简介进度统计（界面显示用）。 */
function summaryStats(store) {
  return {
    version: VERSION,
    cached: Object.keys(store.texts).length,
    failed: Object.keys(store.failures).length,
    queued: summaryQueue.length,
    generating: summaryWorkerRunning,
    disabled: loadConfig().summarize !== true,
    lastDiag: lastLlmDiag,
  };
}

/** 生成某榜单 + 某周期的排名数据。 */
/**
 * 生成某榜单（× 周期，或飙升榜）的排名。
 *
 * 日程语义：每个「榜单 × 周期」组合有自己的更新边界，**跨过边界才重算**，
 * 其余时间直接返回上次冻结的结果（连 GitHub 都不碰）。options.force 是手动刷新，绕过冻结。
 */
/**
 * 生成某榜单（× 周期，或飙升榜）的排名。
 *
 * 日程语义：每个「榜单 × 周期」组合有自己的更新边界，跨过边界才重算，其余时间返回冻结结果。
 * v0.5.0 起多了两层：
 *   · **as-of-boundary**：区间两端都取采样，标签即事实；
 *   · **模型相关性判定 + 综合打分**：平台级/合集/无关的仓库被剔除，剩下的按
 *     「涨星 + 相关性×权重 + 新鲜度」排序。
 * 还没判定完（pending）或窗口不完整时，结果是「临时」的，不会冻结。
 */
async function rank(ctx, boardId, period, options = {}) {
  const config = loadConfig();
  const board = config.boards.find((b) => b.id === boardId) ?? config.boards[0];
  if (board === undefined) throw new Error('没有任何榜单：请在配置里定义 boards');

  const wanted = PERIODS.includes(period) ? period : 'week';
  const isSurge = board.kind === 'surge';
  const spec = isSurge ? config.schedule.surge : config.schedule[wanted] ?? config.schedule.day;
  const now = Date.now();
  const boundary = lastBoundary(spec, now);
  const next = nextBoundary(spec, now);
  const cutoff = !isSurge && wanted === 'all' ? null : lastBoundary(spec, boundary - 1);
  const key = board.id + '|' + (isSurge ? 'surge' : wanted);

  const samples = readSamples();
  const latestSampleAt = samples.length > 0 ? samples[samples.length - 1].at : 0;
  const classifyCount = Object.keys(readClassify().items).length;

  const frozenStore = readFrozen();
  const hit = frozenStore.items[key];
  // 冻结有效的前提：边界没推进；且若上次是「临时结果」，还必须没有新的采样或新的判定
  const hitValid =
    hit !== undefined &&
    hit.v === VERSION &&
    Number(hit.boundary) >= boundary &&
    (hit.provisional !== true ||
      (Number(hit.targetAt ?? 0) >= latestSampleAt && Number(hit.classifyCount ?? 0) >= classifyCount));
  if (options.force !== true && hitValid) {
    return presentEntry(ctx, hit, { config, board, wanted, spec, boundary, next, frozenHit: true });
  }

  let entry;
  let fetchError;
  let ranked;

  if (isSurge) {
    ranked = rankSurge(samples, cutoff, boundary);
  } else {
    const cached = cache.get(board.id);
    if (options.force === true || cached === undefined || cached.at < boundary) {
      try {
        await fetchBoard(board, config);
      } catch (error) {
        fetchError = error;
        lastErrors.set(board.id, describe(error));
      }
    }
    const fresh = cache.get(board.id);
    if (fresh === undefined) {
      if (hit !== undefined) {
        return presentEntry(ctx, hit, { config, board, wanted, spec, boundary, next, frozenHit: true, stale: true });
      }
      const error = new Error(lastErrors.get(board.id) ?? '尚未取得任何数据');
      error.kind = fetchError?.kind ?? 'no-data';
      error.resetAt = fetchError?.resetAt;
      throw error;
    }
    ranked = rankWithWindow(fresh.repos, samples, cutoff, boundary);
    ranked.fetchedAt = iso(fresh.at);
  }

  // 模型相关性判定（缓存命中则零调用；缺失的排后台队列）
  const filtered = scoreAndFilter(ranked.items, board, config);
  enqueueClassify(ctx, board, filtered.pending, config);

  const notes = [];
  if (!ranked.canDelta) {
    notes.push('还没有两个不同时刻的采样，暂时按**总星数**排名；跨过下一个更新边界后自动切换为区间涨星。');
  } else {
    notes.push(
      '区间涨星：' + humanHours(ranked.hours) + '（' + iso(ranked.baseline.at) + ' → ' + iso(ranked.target.at) + '）' +
        (ranked.shortWindow ? '；实际区间短于一个完整周期，因为采样历史还不够长' : '') +
        (ranked.lateTarget ? '；边界之后才有采样，目标数据略滞后于边界' : ''),
    );
  }
  if (ranked.note !== undefined) notes.push(ranked.note);
  if (config.classify === true) {
    const d = filtered.stats.dropped;
    notes.push(
      '模型相关性筛选：剔除 ' + (d.list + d.platform + d.unrelated + d.lowRelevance) + ' 个' +
        '（合集 ' + d.list + ' / 平台级 ' + d.platform + ' / 无关 ' + d.unrelated + ' / 相关性不足 ' + d.lowRelevance + '）' +
        (filtered.stats.pending > 0 ? '；还有 ' + filtered.stats.pending + ' 个正在判定，暂时排在已判定的之后' : ''),
    );
  } else {
    notes.push('模型相关性判定已关闭（classify=false），仅做了合集关键词预筛。');
  }
  if (fetchError !== undefined) notes.push('本次抓取失败，显示的是缓存数据：' + describe(fetchError));

  entry = {
    // 版本号进冻结条目：升级后旧结果自动失效，否则新算法要等一个完整周期才生效
    v: VERSION,
    boundary,
    computedAt: now,
    period: wanted,
    surge: isSurge,
    basis: isSurge
      ? ranked.canDelta
        ? 'star-velocity'
        : 'insufficient-history'
      : ranked.canDelta
        ? 'star-delta'
        : 'total-stars',
    windowStart: ranked.canDelta && ranked.baseline !== undefined ? iso(ranked.baseline.at) : null,
    windowHours: ranked.canDelta ? ranked.hours : null,
    targetAt: ranked.target !== undefined ? ranked.target.at : now,
    sampleCount: ranked.sampleCount,
    registrySize: isSurge ? Object.keys(readRegistry()).length : undefined,
    stale: fetchError !== undefined,
    rateLimited: fetchError?.kind === 'rate-limited',
    resetAt: fetchError?.resetAt ?? null,
    fetchedAt: isSurge ? iso(now) : ranked.fetchedAt,
    notes,
    items: filtered.items,
    ranking: filtered.stats,
    // 临时结果：还有待判定，或窗口不完整 → 不冻结
    provisional: filtered.stats.pending > 0 || ranked.shortWindow === true,
    classifyCount,
  };

  frozenStore.items[key] = entry;
  writeFrozen(frozenStore);
  return presentEntry(ctx, entry, { config, board, wanted, spec, boundary, next, frozenHit: false });
}

// ---------------------------------------------------------------- 路由

/** 读请求体（带上限）。 */
function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 把小时数说成人话（刚装上时窗口可能只有十几分钟，别显示成「0 小时」）。 */
function humanHours(hours) {
  if (hours < 1) return Math.max(1, Math.round(hours * 60)) + ' 分钟';
  if (hours < 48) return Math.round(hours * 10) / 10 + ' 小时';
  return Math.round(hours / 24) + ' 天';
}

/** 发 JSON 响应。 */
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 快照文件个数。 */
function countSnapshotFiles() {
  const dir = snapshotDir();
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).length : 0;
}

/** 元信息（/status 与 /config 共用）。 */
function meta() {
  const config = loadConfig();
  const samples = readSamples();
  const store = readSummaries();
  const frozen = readFrozen();
  const stamp = Date.now();
  return {
    store: storeDir(),
    configPath: configPath(),
    snapshotDir: snapshotDir(),
    tokenConfigured: resolveToken(config) !== '',
    schedule: Object.fromEntries(
      Object.entries(config.schedule).map(([key, spec]) => [
        key,
        {
          ...spec,
          rule: describeSchedule(spec),
          lastBoundary: iso(lastBoundary(spec, stamp)),
          nextBoundary: iso(nextBoundary(spec, stamp)),
        },
      ]),
    ),
    sampledBoundary: frozen.sampledBoundary === null ? null : iso(frozen.sampledBoundary),
    frozen: Object.fromEntries(
      Object.entries(frozen.items).map(([key, entry]) => [
        key,
        { boundary: iso(entry.boundary), computedAt: iso(entry.computedAt), basis: entry.basis, items: entry.items.length },
      ]),
    ),
    snapshotCount: countSnapshotFiles(),
    sampleCount: samples.length,
    firstSample: samples.length > 0 ? iso(samples[0].at) : null,
    lastSample: samples.length > 0 ? iso(samples[samples.length - 1].at) : null,
    registrySize: Object.keys(readRegistry()).length,
    summaryStats: summaryStats(store),
    classifyStats: classifyStats(readClassify()),
    refreshing,
    boards: config.boards.map((b) => ({
      id: b.id,
      name: b.name,
      desc: b.desc,
      kind: b.kind,
      query: b.kind === 'surge' ? '(跨榜单)' : buildQuery(b),
      cached: cache.has(b.id) ? iso(cache.get(b.id).at) : null,
      repos: cache.has(b.id) ? cache.get(b.id).repos.length : 0,
      error: lastErrors.get(b.id) ?? null,
    })),
    errors: Object.fromEntries(lastErrors),
  };
}

/** 路由处理（纯函数式，便于复用/测试）。 */
async function handleRoute(ctx, req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname.slice(ROUTE_PREFIX.length) || '/';
  const method = req.method ?? 'GET';

  try {
    if (method === 'GET' && (path === '/' || path === '/status')) {
      sendJson(res, 200, { name, version: VERSION, now: iso(Date.now()), ...meta() });
      return;
    }

    if (method === 'GET' && path === '/config') {
      sendJson(res, 200, { config: loadConfig(), ...meta() });
      return;
    }

    if (method === 'PUT' && path === '/config') {
      const body = await readBody(req);
      let patch;
      try {
        patch = JSON.parse(body === '' ? '{}' : body);
      } catch (error) {
        sendJson(res, 400, { error: '配置不是合法 JSON：' + describe(error) });
        return;
      }
      const next = { ...loadConfig(), ...(patch !== null && typeof patch === 'object' ? patch : {}) };
      saveConfig(next);
      sendJson(res, 200, { config: loadConfig(), ...meta() });
      return;
    }

    if (method === 'GET' && path === '/rank') {
      const board = url.searchParams.get('board') ?? '';
      const period = url.searchParams.get('period') ?? 'week';
      const force = url.searchParams.get('refresh') === '1';
      sendJson(res, 200, await rank(ctx, board, period, { force }));
      return;
    }

    if (method === 'GET' && path === '/summaries') {
      const store = readSummaries();
      sendJson(res, 200, { stats: summaryStats(store), texts: store.texts, failures: store.failures });
      return;
    }

    if (method === 'GET' && path === '/classify') {
      const store = readClassify();
      sendJson(res, 200, { stats: classifyStats(store), items: store.items, failures: store.failures });
      return;
    }

    if (method === 'POST' && path === '/classify/reset') {
      const store = readClassify();
      const cleared = Object.keys(store.items).length + Object.keys(store.failures).length;
      writeClassify({ items: {}, failures: {} });
      lastClassifyDiag = null;
      sendJson(res, 200, { ok: true, cleared, stats: classifyStats(readClassify()) });
      return;
    }

    if (method === 'POST' && path === '/summaries/reset') {
      const store = readSummaries();
      const cleared = Object.keys(store.failures).length;
      store.failures = {};
      writeSummaries(store);
      lastLlmDiag = null;
      sendJson(res, 200, { ok: true, cleared, stats: summaryStats(readSummaries()) });
      return;
    }

    if (method === 'POST' && path === '/refresh') {
      const only = url.searchParams.get('board') ?? '';
      if (refreshing) {
        sendJson(res, 409, { error: '已有刷新在进行中', refreshing: true });
        return;
      }
      refreshing = true;
      try {
        const results = await refreshBoards(loadConfig(), only);
        sendJson(res, 200, { ok: true, results, ...meta() });
      } finally {
        refreshing = false;
      }
      return;
    }

    sendJson(res, 404, { error: '未知路径：' + path });
  } catch (error) {
    sendJson(res, error?.kind === 'rate-limited' ? 429 : 500, {
      error: describe(error),
      kind: error?.kind ?? 'unknown',
      resetAt: error?.resetAt ?? null,
    });
  }
}

// ---------------------------------------------------------------- 入口

/**
 * 插件入口：注册路由 + 周期刷新。
 * 所有副作用的清理都通过 ctx.effect 的 disposer 完成，插件卸载时不留定时器。
 */
export function apply(ctx) {
  const logger = service(ctx, 'logger') ?? console;
  const config = loadConfig();
  logger.info?.(
    '[hotspot] 已加载：' + config.boards.length + ' 个榜单（含飙升榜），数据目录 ' + storeDir() +
      '，采样 ' + describeSchedule(config.schedule.sample) +
      '；更新日程 日=' + describeSchedule(config.schedule.day) +
      ' 周=' + describeSchedule(config.schedule.week) +
      ' 月=' + describeSchedule(config.schedule.month) +
      ' 飙升=' + describeSchedule(config.schedule.surge) +
      (resolveToken(config) === '' ? '，未配置 GITHUB_TOKEN（搜索限 10 次/分钟）' : '，已配置 token'),
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => handleRoute(ctx, req, res),
      }),
    'hotspot: /dsh-hotspot routes',
  );

  // 日程驱动采样：每 scheduleCheckMinutes 检查一次边界，**到点才去 GitHub 抓一次数据**。
  // 榜单"结果"的更新是惰性的：有人请求且跨过边界时才重算（见 rank()），
  // 所以没人在看的榜单不会白白消耗额度。
  ctx.effect(() => {
    let lastHeartbeatAt = 0;
    const tick = async () => {
      if (refreshing) return;
      const live = loadConfig();
      const now = Date.now();
      const store = readFrozen();
      const sampleBoundary = lastBoundary(live.schedule.sample, now);
      const boundaryDue = store.sampledBoundary === null || store.sampledBoundary < sampleBoundary;
      const minutes = Number(live.refreshMinutes);
      const heartbeatDue = minutes > 0 && now - lastHeartbeatAt >= minutes * 60000;
      if (!boundaryDue && !heartbeatDue) return; // 没到点：什么都不做（这就是"其余时间不更新"）
      refreshing = true;
      try {
        const results = await refreshBoards(live);
        const failed = results.filter((r) => !r.ok).length;
        if (failed > 0) logger.warn?.('[hotspot] 采样完成，' + failed + ' 个榜单失败');
        const after = readFrozen();
        after.sampledBoundary = sampleBoundary;
        writeFrozen(after);
        lastHeartbeatAt = now;
        logger.info?.('[hotspot] 已按日程采样 ' + results.length + ' 个榜单（' + describeSchedule(live.schedule.sample) + '）');
      } catch (error) {
        logger.warn?.('[hotspot] 采样异常：' + describe(error));
      } finally {
        refreshing = false;
      }
    };
    const kickoff = setTimeout(() => void tick(), 8000);
    kickoff.unref?.();
    const every = Math.max(1, Number(config.scheduleCheckMinutes) || 5);
    const timer = setInterval(() => void tick(), every * 60000);
    timer.unref?.();
    return () => {
      clearTimeout(kickoff);
      clearInterval(timer);
    };
  }, 'hotspot: 日程采样');
}

/**
 * 仅供测试：日程边界 / 归一化 / 文案都是纯函数，值得直接钉住
 * （见 test/schedule.mjs —— 跨月、闰年、月末钳位这些不该靠运气）。
 */
export const __internals = {
  lastBoundary,
  nextBoundary,
  normalizeSchedule,
  normalizeScheduleSpec,
  describeSchedule,
  daysInMonth,
  DEFAULT_CONFIG,
};
