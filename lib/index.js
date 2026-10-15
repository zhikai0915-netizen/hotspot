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
const VERSION = '0.3.0';

/** 路由前缀。加后缀式命名空间，避免与官方/其它插件的路径相撞。 */
const ROUTE_PREFIX = '/dsh-hotspot';

/** LLM 调用的调用身份（适配器据此生成服务商需要的载体，值只需稳定）。 */
const CALL_IDENTITY = 'hotspot';

/** 周期 → 窗口毫秒；`all` 用最早那个样本。 */
const PERIOD_MS = { day: 86400000, week: 7 * 86400000, month: 30 * 86400000, all: null };

/** 周期白名单。 */
const PERIODS = Object.keys(PERIOD_MS);

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
  /** 后台自动刷新间隔（分钟）；0 = 关闭，只在请求时按需抓。 */
  refreshMinutes: 5,
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
  /** 飙升榜窗口（小时）。 */
  surgeWindowHours: 24,
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
  if (!Number.isFinite(Number(merged.surgeWindowHours)) || Number(merged.surgeWindowHours) <= 0) {
    merged.surgeWindowHours = DEFAULT_CONFIG.surgeWindowHours;
  }
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

/** 用样本给一组仓库算区间涨星（普通榜用）。 */
function rankWithSamples(repos, samples, windowMs) {
  const now = Date.now();
  const cutoff = windowMs === null ? null : now - windowMs;
  const baseline = pickBaseline(samples, cutoff);
  // 今天的样本不能当基线（否则涨星恒为 0）：以「今天 00:00」为界判断
  const todayStart = Date.parse(todayKey() + 'T00:00:00');
  const baselineIsToday = baseline !== undefined && baseline.at >= todayStart;
  const canDelta = baseline !== undefined && samples.length >= 2 && !baselineIsToday;

  const items = repos.map((repo) => {
    const base = canDelta ? baseline.stars[repo.fullName] : undefined;
    return { ...repo, delta: canDelta ? repo.stars - (base ?? repo.stars) : null, isNew: canDelta && base === undefined };
  });
  items.sort(canDelta ? (a, b) => b.delta - a.delta || b.stars - a.stars : (a, b) => b.stars - a.stars);
  return { items, canDelta, baseline, sampleCount: samples.length };
}

/**
 * 飙升榜：跨全部已追踪仓库，按窗口内的涨星量排序。
 * 数据来源是仓库注册表（不依赖某个查询），所以能看到各榜单之外的黑马。
 */
function rankSurge(config, samples, period) {
  // 飙升榜的窗口跟着周期页签走：日榜 = surgeWindowHours（默认 24 小时，可配），
  // 周榜 = 7 天，月榜 = 30 天，总榜 = 用最早那个样本（不设窗口）。
  const windowMs =
    period === 'all' ? null : period === 'day' ? config.surgeWindowHours * 3600000 : PERIOD_MS[period];
  const registry = readRegistry();
  const names = Object.keys(registry);
  const latest = samples[samples.length - 1];
  const baseline = pickBaseline(samples, Date.now() - windowMs);
  const hours = baseline !== undefined ? Math.max(0.1, (Date.now() - baseline.at) / 3600000) : 0;

  if (latest === undefined || baseline === undefined || baseline.at === latest.at) {
    return {
      items: [],
      canDelta: false,
      baseline,
      sampleCount: samples.length,
      note:
        '样本还不足以计算速度：至少需要两个不同时刻的采样。本插件每 ' +
        config.sampleIntervalMinutes +
        ' 分钟合并一次采样、每 ' +
        config.refreshMinutes +
        ' 分钟刷新一轮，跑一会儿后飙升榜会自动出现数据。',
    };
  }

  const items = [];
  for (const fullName of names) {
    const meta = registry[fullName];
    const nowStars = latest.stars[fullName];
    if (typeof nowStars !== 'number') continue; // 最近一次采样里没出现 → 无法比较
    const baseStars = baseline.stars[fullName];
    if (typeof baseStars !== 'number') continue; // 基线里没有 → 新出现，不计入速度榜（避免误报）
    const delta = nowStars - baseStars;
    if (delta <= 0) continue;
    items.push({
      fullName,
      url: meta.url,
      description: meta.description ?? '',
      language: meta.language ?? '',
      topics: Array.isArray(meta.topics) ? meta.topics : [],
      stars: nowStars,
      forks: meta.forks ?? 0,
      pushedAt: meta.pushedAt ?? '',
      createdAt: meta.createdAt ?? '',
      archived: meta.archived === true,
      delta,
      isNew: false,
      perDay: Math.round((delta / hours) * 24 * 10) / 10,
    });
  }
  items.sort((a, b) => b.delta - a.delta || b.perDay - a.perDay || b.stars - a.stars);
  return {
    items,
    canDelta: true,
    baseline,
    sampleCount: samples.length,
    hours: Math.round(hours * 10) / 10,
    note:
      '窗口 ' + humanHours(hours) + '，跨 ' + names.length + ' 个已追踪仓库；' +
      '只统计窗口内涨星为正、且基线采样里已存在的仓库。' +
      (hours < 24 ? '（窗口短于一天是因为采样历史还不够长，攒够后会自动变长）' : ''),
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
async function rank(ctx, boardId, period, options = {}) {
  const config = loadConfig();
  const board = config.boards.find((b) => b.id === boardId) ?? config.boards[0];
  if (board === undefined) throw new Error('没有任何榜单：请在配置里定义 boards');

  const wanted = PERIODS.includes(period) ? period : 'week';
  const samples = readSamples();
  const store = readSummaries();

  // ---- 飙升榜：无需抓取，只看样本与注册表 ----
  if (board.kind === 'surge') {
    const surge = rankSurge(config, samples, wanted);
    const items = surge.items.slice(0, config.perPage).map((item, index) => ({ rank: index + 1, ...attachSummary(item) }));
    if (config.summarize === true) enqueueSummaries(ctx, items, config);
    return {
      board: { id: board.id, name: board.name, desc: board.desc, query: '(跨榜单)' },
      period: wanted,
      basis: surge.canDelta ? 'star-velocity' : 'insufficient-history',
      windowStart: surge.baseline !== undefined ? iso(surge.baseline.at) : null,
      windowHours: surge.hours ?? null,
      sampleCount: surge.sampleCount,
      fetchedAt: iso(Date.now()),
      stale: false,
      rateLimited: false,
      resetAt: null,
      registrySize: Object.keys(readRegistry()).length,
      summaryStats: summaryStats(store),
      notes: surge.note === undefined ? [] : [surge.note],
      items,
    };
  }

  // ---- 普通榜：按需抓取（缓存过期才抓） ----
  const cached = cache.get(board.id);
  const needFetch =
    options.force === true || cached === undefined || Date.now() - cached.at > config.cacheMinutes * 60000;
  let fetchError;
  if (needFetch) {
    try {
      await fetchBoard(board, config);
    } catch (error) {
      fetchError = error;
      lastErrors.set(board.id, describe(error));
    }
  }
  const fresh = cache.get(board.id);
  if (fresh === undefined) {
    // 一次都没成功过：明确报错，而不是返回空榜单
    const error = new Error(lastErrors.get(board.id) ?? '尚未取得任何数据');
    error.kind = fetchError?.kind ?? 'no-data';
    error.resetAt = fetchError?.resetAt;
    throw error;
  }

  const ranked = rankWithSamples(fresh.repos, samples, PERIOD_MS[wanted]);
  const notes = [];
  if (!ranked.canDelta) {
    notes.push(
      '样本历史不足，当前按**总星数**排名。区间涨星需要至少两个不同时刻的采样；' +
        '本插件每 ' + config.sampleIntervalMinutes + ' 分钟合并一次采样、每 ' + config.refreshMinutes +
        ' 分钟刷新一轮，累积后自动切换为区间涨星排名。',
    );
  } else if (ranked.baseline !== undefined) {
    notes.push('按区间涨星排名，基线采样：' + iso(ranked.baseline.at));
  }
  if (fetchError !== undefined) notes.push('本次刷新失败，显示的是缓存数据：' + describe(fetchError));

  const items = ranked.items.slice(0, config.perPage).map((item, index) => ({ rank: index + 1, ...attachSummary(item) }));
  if (config.summarize === true) enqueueSummaries(ctx, items, config);

  return {
    board: { id: board.id, name: board.name, desc: board.desc, query: board.query },
    period: wanted,
    basis: ranked.canDelta ? 'star-delta' : 'total-stars',
    windowStart: ranked.canDelta && ranked.baseline !== undefined ? iso(ranked.baseline.at) : null,
    sampleCount: ranked.sampleCount,
    fetchedAt: iso(fresh.at),
    stale: fetchError !== undefined,
    rateLimited: fetchError?.kind === 'rate-limited',
    resetAt: fetchError?.resetAt ?? null,
    summaryStats: summaryStats(store),
    notes,
    items,
  };
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
  return {
    store: storeDir(),
    configPath: configPath(),
    snapshotDir: snapshotDir(),
    tokenConfigured: resolveToken(config) !== '',
    snapshotCount: countSnapshotFiles(),
    sampleCount: samples.length,
    firstSample: samples.length > 0 ? iso(samples[0].at) : null,
    lastSample: samples.length > 0 ? iso(samples[samples.length - 1].at) : null,
    registrySize: Object.keys(readRegistry()).length,
    summaryStats: summaryStats(store),
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
      '，缓存 ' + config.cacheMinutes + ' 分钟 / 刷新 ' + config.refreshMinutes + ' 分钟' +
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

  // 周期刷新：启动 8 秒后先预热一轮，之后按 refreshMinutes 循环
  ctx.effect(() => {
    const tick = () => {
      if (refreshing) return;
      refreshing = true;
      refreshBoards(loadConfig())
        .then((results) => {
          const failed = results.filter((r) => !r.ok).length;
          if (failed > 0) logger.warn?.('[hotspot] 刷新完成，' + failed + ' 个榜单失败');
        })
        .catch((error) => logger.warn?.('[hotspot] 刷新异常：' + describe(error)))
        .finally(() => {
          refreshing = false;
        });
    };
    const minutes = config.refreshMinutes;
    const kickoff = setTimeout(tick, 8000);
    kickoff.unref?.();
    let timer;
    if (Number.isFinite(minutes) && minutes > 0) {
      timer = setInterval(tick, minutes * 60000);
      timer.unref?.();
    }
    return () => {
      clearTimeout(kickoff);
      if (timer !== undefined) clearInterval(timer);
    };
  }, 'hotspot: 周期刷新');
}
