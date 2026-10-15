/**
 * hotspot —— 宿主半侧（host half）
 *
 * 职责：把 GitHub 上的「小工具」按话题抓下来，记快照，算区间涨星，对外提供
 * `/dsh-hotspot/` 前缀的只读数据接口。浏览器半侧（lib/client.js）只负责画。
 *
 * ## 为什么需要快照
 *
 * GitHub API **不提供历史星数**。任何「日榜 / 周榜 / 月榜」都只能是
 * `当前星数 − 区间起点星数`，所以起点必须由我们自己存：
 * 每次抓取都把当天的星数写进 `$DSH_HOME/hotspot/snapshots/<YYYY-MM-DD>.json`。
 *
 * 因此存在一个**诚实的冷启动期**：第一次运行时没有任何历史，涨星无从算起，
 * 此时降级为「按总星数排名」并在响应里用 `basis: 'total-stars'` + `notes` 明说。
 * 快照累积到第 2 天起，同一批榜单会自动切到 `basis: 'star-delta'`（按区间涨星排）。
 *
 * ## 速率限制（这是本插件最主要的工程约束）
 *
 * GitHub 搜索 API 未认证时只有 **10 次/分钟**（实测确认；认证后 30 次/分钟）。
 * 所以：
 *   1. 抓取粒度是「每榜单一次」而不是「每榜单 × 每周期一次」——
 *      四个周期共用同一份仓库集合，只是算涨星时的基线快照不同；
 *   2. 结果进内存缓存（默认 10 分钟）；
 *   3. 403/429 不当作致命错误：保留上一次成功的数据，标记 `stale`，
 *      并把 GitHub 给的重置时间透传给界面。
 *
 * ## 为什么不用 `@deepseek-ai/dsh-home-paths` / `dsh-credentials`
 *
 * 宿主半侧只用 node 内置模块，不 import 任何 `@deepseek-ai/*`：
 *   - home 目录：读 `DSH_HOME` 环境变量，回落到 `~/.dsh`；
 *   - token：读 `GITHUB_TOKEN` / `GH_TOKEN` 环境变量，或配置文件里的 `token`。
 * 这样即使某天官方包名/导出变化，本插件的宿主半侧也不会因此加载失败。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 插件名：必须与包名、cordis.patch.yml 的 id 一致。 */
export const name = 'hotspot';

/** 只依赖宿主提供的 webServer 服务（注册 HTTP 路由用）。 */
export const inject = ['webServer'];

/** 路由前缀。加后缀式命名空间，避免与官方/其它插件的路径相撞。 */
const ROUTE_PREFIX = '/dsh-hotspot';

/** 周期 → 天数（`all` 用最早那张快照，不是 0）。 */
const PERIOD_DAYS = { day: 1, week: 7, month: 30, all: null };

/** 周期白名单，用于校验入参。 */
const PERIODS = Object.keys(PERIOD_DAYS);

/** GitHub 搜索返回的最大条数。 */
const MAX_PER_PAGE = 100;

/** 默认配置。用户配置会覆盖这里的同名字段（boards 整体替换）。 */
const DEFAULT_CONFIG = {
  /** 结果内存缓存时长（分钟）。 */
  cacheMinutes: 10,
  /** 后台自动刷新间隔（分钟）；0 = 关闭自动刷新，只在请求时按需抓。 */
  refreshMinutes: 30,
  /** 每榜抓多少条。 */
  perPage: 50,
  /** 快照保留天数。 */
  snapshotKeepDays: 120,
  /** 可选：GitHub token 明文（更推荐用 GITHUB_TOKEN 环境变量）。 */
  token: '',
  /**
   * 榜单定义。query 是 GitHub search 的 q 参数片段，可自由改写：
   *   - `topic:dsh-plugin`      → 按仓库话题
   *   - `topic:dsh-plugin stars:>5` → 叠加限定
   *   - `dsh-pet in:name`       → 按名字搜
   * minStars / maxStars 会被自动拼成 `stars:a..b`，留空则不拼。
   */
  boards: [
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

/** 后台刷新状态，避免并发重复抓取。 */
let refreshing = false;

/** 最近一次抓取错误（boardId → 文案），透传给界面。 */
const lastErrors = new Map();

/** 解析 DSH home：环境变量优先，回落 ~/.dsh。 */
function resolveHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  return join(homedir(), '.dsh');
}

/** 插件的数据目录：`$DSH_HOME/hotspot/`。 */
function storeDir() {
  return join(resolveHome(), 'hotspot');
}

/** 快照目录。 */
function snapshotDir() {
  return join(storeDir(), 'snapshots');
}

/** 配置文件路径。 */
function configPath() {
  return join(storeDir(), 'config.json');
}

/** 异常 → 单行文案。 */
function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

/** 确保目录存在。 */
function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** 原子写文件（先写临时文件再 rename，避免半截文件）。 */
function writeAtomic(file, text) {
  ensureDir(dirname(file));
  const tmp = file + '.tmp';
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}

/**
 * 读取用户配置并与默认值合并。
 * boards 是「整体替换」语义：用户一旦自定义 boards，就不再和默认合并——
 * 这样才能真的删掉不想要的榜单。
 */
function loadConfig() {
  let user = {};
  const file = configPath();
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed !== null && typeof parsed === 'object') user = parsed;
    } catch (error) {
      // 配置坏了不能让插件整体挂掉：回落默认值，错误经 /status 暴露
      lastErrors.set('__config__', '配置文件解析失败，已回落默认值：' + describe(error));
    }
  }
  const merged = { ...DEFAULT_CONFIG, ...user };
  if (!Array.isArray(merged.boards) || merged.boards.length === 0) merged.boards = DEFAULT_CONFIG.boards;
  merged.boards = merged.boards
    .filter((b) => b !== null && typeof b === 'object' && typeof b.id === 'string' && b.id !== '')
    .map((b) => ({
      id: String(b.id),
      name: String(b.name ?? b.id),
      desc: String(b.desc ?? ''),
      query: String(b.query ?? 'topic:' + b.id),
      minStars: Number.isFinite(Number(b.minStars)) && Number(b.minStars) > 0 ? Number(b.minStars) : 0,
      maxStars: Number.isFinite(Number(b.maxStars)) && Number(b.maxStars) > 0 ? Number(b.maxStars) : 0,
    }));
  if (merged.boards.length === 0) merged.boards = DEFAULT_CONFIG.boards;
  merged.perPage = Math.min(MAX_PER_PAGE, Math.max(1, Number(merged.perPage) || DEFAULT_CONFIG.perPage));
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

/** 今天的快照文件名（本地日期，够用且直观）。 */
function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 把 GitHub 的仓库对象裁剪成我们需要的字段。 */
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

/** 把榜单定义拼成 GitHub search 的 q 参数。 */
function buildQuery(board) {
  const parts = [board.query];
  const min = board.minStars > 0 ? 'stars:>=' + board.minStars : '';
  const max = board.maxStars > 0 ? 'stars:<=' + board.maxStars : '';
  if (min !== '') parts.push(min);
  if (max !== '') parts.push(max);
  return parts.filter((p) => typeof p === 'string' && p.trim() !== '').join(' ').trim();
}

/** 抓一个榜单并写入内存缓存 + 当日快照。抛出的错误带 kind 字段以便路由分流。 */
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

  // 限流：不是致命错误，交给上层保留旧数据
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
  return repos;
}

/** 把当前星数并入当日快照（同一天多次抓取以最后一次为准）。 */
function recordSnapshot(repos) {
  if (repos.length === 0) return;
  const dir = snapshotDir();
  ensureDir(dir);
  const file = join(dir, todayKey() + '.json');
  let stars = {};
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && parsed.stars !== undefined) stars = parsed.stars;
    } catch {
      /* 坏快照直接重建 */
    }
  }
  for (const repo of repos) stars[repo.fullName] = repo.stars;
  writeAtomic(file, JSON.stringify({ date: todayKey(), savedAt: new Date().toISOString(), stars }));
}

/** 读取全部快照，按日期升序。 */
function readSnapshots() {
  const dir = snapshotDir();
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, entry), 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && parsed.stars !== undefined) {
        out.push({ date: String(parsed.date ?? entry.replace(/\.json$/, '')), stars: parsed.stars });
      }
    } catch {
      /* 跳过坏文件 */
    }
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

/** 删掉超过保留期的快照。 */
function pruneSnapshots(keepDays) {
  const dir = snapshotDir();
  if (!existsSync(dir)) return;
  const cutoff = Date.now() - keepDays * 86400000;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    const t = Date.parse(entry.replace(/\.json$/, '') + 'T00:00:00');
    if (Number.isFinite(t) && t < cutoff) {
      try {
        unlinkSync(join(dir, entry));
      } catch {
        /* 删不掉不影响使用 */
      }
    }
  }
}

/**
 * 为某个周期挑基线快照：
 * 取「不晚于 now − 周期天数」的**最新**那张；一张都没有就退回最早那张。
 * `all` 直接用最早那张。
 */
function pickBaseline(snapshots, days) {
  if (snapshots.length === 0) return undefined;
  if (days === null) return snapshots[0];
  const cutoff = Date.now() - days * 86400000;
  let best;
  for (const snap of snapshots) {
    const t = Date.parse(snap.date + 'T00:00:00');
    if (!Number.isFinite(t)) continue;
    if (t <= cutoff) best = snap;
    else break;
  }
  return best ?? snapshots[0];
}

/** 顺序抓取所有榜单（或指定榜单），带节流；返回每个榜单的结果。 */
async function refreshBoards(config, onlyBoardId) {
  const targets =
    typeof onlyBoardId === 'string' && onlyBoardId !== ''
      ? config.boards.filter((b) => b.id === onlyBoardId)
      : config.boards;
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
    // 未认证时 10 次/分钟：榜单一多就连着打必然 403，这里主动让路
    if (i < targets.length - 1) await new Promise((r) => setTimeout(r, 1500));
  }
  pruneSnapshots(config.snapshotKeepDays);
  return results;
}

/**
 * 生成某榜单 + 某周期的排名。
 *
 * 数据新鲜度策略：缓存过期才抓；抓失败时**保留上一次成功的数据**并标记 stale，
 * 绝不因为一次 403 就把榜单清空。
 */
async function rank(boardId, period, options = {}) {
  const config = loadConfig();
  const board = config.boards.find((b) => b.id === boardId) ?? config.boards[0];
  if (board === undefined) throw new Error('没有任何榜单：请在配置里定义 boards');

  const wanted = PERIODS.includes(period) ? period : 'week';
  const cached = cache.get(board.id);
  const needFetch = options.force === true || cached === undefined || Date.now() - cached.at > config.cacheMinutes * 60000;

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

  const snapshots = readSnapshots();
  const baseline = pickBaseline(snapshots, PERIOD_DAYS[wanted]);
  // 只有「至少两张快照」且「基线不是今天」时，涨星才算得出来
  const canDelta = baseline !== undefined && snapshots.length >= 2 && baseline.date !== todayKey();
  const basis = canDelta ? 'star-delta' : 'total-stars';

  const items = fresh.repos.map((repo) => {
    const base = canDelta ? baseline.stars[repo.fullName] : undefined;
    return {
      ...repo,
      delta: canDelta ? repo.stars - (base ?? repo.stars) : null,
      isNew: canDelta && base === undefined,
    };
  });
  items.sort(
    basis === 'star-delta'
      ? (a, b) => b.delta - a.delta || b.stars - a.stars
      : (a, b) => b.stars - a.stars,
  );

  const notes = [];
  if (basis === 'total-stars') {
    notes.push(
      '快照历史不足，当前按**总星数**排名。热榜的「日/周/月涨星」需要至少两天快照，' +
        '本插件每次抓取都会存一份，累积后自动切换为区间涨星排名。',
    );
    if (wanted !== 'all') notes.push('（区间涨星在快照就绪前对四个周期是同一份排名）');
  } else {
    notes.push('按「' + (wanted === 'all' ? '有记录以来' : '区间') + '涨星排名，基线快照：' + baseline.date);
  }
  if (fetchError !== undefined) notes.push('本次刷新失败，显示的是缓存数据：' + describe(fetchError));

  return {
    board: { id: board.id, name: board.name, desc: board.desc, query: board.query },
    period: wanted,
    basis,
    windowStart: basis === 'star-delta' ? baseline.date : null,
    snapshotCount: snapshots.length,
    fetchedAt: new Date(fresh.at).toISOString(),
    stale: fetchError !== undefined,
    rateLimited: fetchError?.kind === 'rate-limited',
    resetAt: fetchError?.resetAt ?? null,
    notes,
    items: items.slice(0, config.perPage).map((item, index) => ({ rank: index + 1, ...item })),
  };
}

/** /status 与 /config 共用的元信息。 */
function meta() {
  const config = loadConfig();
  const snapshots = readSnapshots();
  return {
    store: storeDir(),
    configPath: configPath(),
    snapshotDir: snapshotDir(),
    tokenConfigured: resolveToken(config) !== '',
    snapshotCount: snapshots.length,
    firstSnapshot: snapshots.length > 0 ? snapshots[0].date : null,
    lastSnapshot: snapshots.length > 0 ? snapshots[snapshots.length - 1].date : null,
    boards: config.boards.map((b) => ({
      id: b.id,
      name: b.name,
      desc: b.desc,
      query: buildQuery(b),
      cached: cache.has(b.id) ? new Date(cache.get(b.id).at).toISOString() : null,
      repos: cache.has(b.id) ? cache.get(b.id).repos.length : 0,
      error: lastErrors.get(b.id) ?? null,
    })),
    errors: Object.fromEntries(lastErrors),
  };
}

/** 读请求体（PUT/POST 用，带大小上限）。 */
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

/** 路由处理：纯函数式，便于将来给桌面管道复用。 */
async function handleRoute(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname.slice(ROUTE_PREFIX.length) || '/';
  const method = req.method ?? 'GET';

  try {
    if (method === 'GET' && (path === '/' || path === '/status')) {
      sendJson(res, 200, {
        name,
        version: '0.1.0',
        now: new Date().toISOString(),
        refreshing,
        ...meta(),
      });
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
      sendJson(res, 200, await rank(board, period, { force }));
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

/**
 * 插件入口。注册路由 + 可选的周期性后台刷新。
 *
 * 注意 `ctx.effect` 的返回值必须是 disposer：DSH 卸载插件时会调用它，
 * 定时器不在 disposer 里清掉就会泄漏。
 */
export function apply(ctx) {
  const logger = ctx.logger ?? console;
  const config = loadConfig();
  logger.info?.(
    '[hotspot] 已加载：' + config.boards.length + ' 个榜单，数据目录 ' + storeDir() +
      (resolveToken(config) === '' ? '（未配置 GITHUB_TOKEN，搜索限 10 次/分钟）' : '（已配置 token）'),
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: handleRoute,
      }),
    'hotspot: /dsh-hotspot routes',
  );

  // 后台预热 + 周期刷新：第一次延迟 8 秒，避开 DSH 启动高峰
  ctx.effect(() => {
    const minutes = loadConfig().refreshMinutes;
    if (!Number.isFinite(minutes) || minutes <= 0) return () => {};
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
    const kickoff = setTimeout(tick, 8000);
    kickoff.unref?.();
    const timer = setInterval(tick, minutes * 60000);
    timer.unref?.();
    return () => {
      clearTimeout(kickoff);
      clearInterval(timer);
    };
  }, 'hotspot: 周期刷新');
}
