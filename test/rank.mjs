/**
 * hotspot 核心算法测试 —— 确定性覆盖 smoke.mjs 碰不到的路径。
 *
 * smoke.mjs 用的是全新 DSH_HOME，所以它**永远走「样本不足 → 按总星数」的降级分支**，
 * 于是真正关键的东西一直没被测过。本文件用**打桩 fetch + 手写历史采样**把它们全钉住：
 *
 *   1. 区间涨星：基线怎么挑、delta 怎么算、isNew 怎么标、怎么排序
 *   2. 四个周期是否真的用不同基线（日 / 周 / 月 / 总）
 *   3. 采样格式：旧格式（单样本）兼容读、以及「合并 vs 追加」两条分支
 *   4. 飙升榜：跨榜单按窗口涨星、给出星/天、基线里没有的仓库要排除
 *   5. 限流两种情形：无缓存 429；有缓存保留旧数据并标 stale
 *   6. 快照保留期清理
 *
 * 全程打桩、不碰网络、不受 GitHub 限流影响。
 *
 * 跑法：node test/rank.mjs
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const home = mkdtempSync(join(tmpdir(), 'hotspot-rank-'));
process.env.DSH_HOME = home;

const failures = [];
let checks = 0;
function check(label, condition, detail = '') {
  checks += 1;
  if (condition) console.log('  ✓ ' + label);
  else {
    failures.push(label + (detail ? ' — ' + detail : ''));
    console.log('  ✗ ' + label + (detail ? ' — ' + detail : ''));
  }
}

// ---------- 打桩 GitHub ----------

const realFetch = globalThis.fetch;

/** 构造 Response 替身（插件只用到 status/ok/headers.get/json/text）。 */
function fakeResponse(body, status = 200, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (key) => headers[String(key).toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

let githubPlan = () => fakeResponse({ items: [] });

globalThis.fetch = async (url, options) => {
  const target = String(url);
  if (target.startsWith('http://127.0.0.1')) return realFetch(url, options);
  if (!target.startsWith('https://api.github.com/')) throw new Error('测试里出现了意外的外部请求：' + target);
  return githubPlan(target, options);
};

/** 造一条 GitHub 仓库条目（只填插件会读的字段）。 */
function repo(fullName, stars) {
  const [owner, name] = fullName.split('/');
  return {
    full_name: fullName,
    html_url: 'https://github.com/' + fullName,
    description: name + ' 的官方英文简介',
    stargazers_count: stars,
    forks_count: 1,
    open_issues_count: 0,
    language: 'TypeScript',
    topics: ['t'],
    pushed_at: new Date().toISOString(),
    created_at: '2026-01-01T00:00:00Z',
    archived: false,
    owner: { login: owner },
  };
}

/** 当前星数：one 140、two 55、three 30 */
const CURRENT = [repo('a/one', 140), repo('a/two', 55), repo('a/three', 30)];
githubPlan = (url) => {
  const decoded = decodeURIComponent(String(url));
  if (decoded.includes('topic:n')) return fakeResponse({ total_count: 1, items: [repo('c/new', 9)] });
  return fakeResponse({ total_count: 3, items: CURRENT });
};

// ---------- 伪造历史采样 ----------

const snapDir = join(home, 'hotspot', 'snapshots');
mkdirSync(snapDir, { recursive: true });

/** 本地日期键（与宿主 todayKey() 同格式）。 */
function dayKeyOf(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 记录「距今 N 小时」对应的 ISO 时刻，供断言精确比对。 */
const SAMPLE_AT = new Map();

/**
 * 按「距今多少小时」写入采样。
 * 同一本地日期下的多个采样会合并进同一个文件的 samples 数组——
 * 这样测试不依赖运行时的具体时刻（跨零点也不会飘）。
 */
function writeSamples(entries) {
  const byDate = new Map();
  for (const [hoursAgo, stars] of entries) {
    const at = new Date(Date.now() - hoursAgo * 3600000);
    SAMPLE_AT.set(hoursAgo, at.toISOString());
    const date = dayKeyOf(at.getTime());
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push({ at: at.toISOString(), stars });
  }
  for (const [date, samples] of byDate) {
    samples.sort((a, b) => (a.at < b.at ? -1 : 1));
    writeFileSync(join(snapDir, date + '.json'), JSON.stringify({ date, samples }));
  }
}

/** 写一份**旧格式**快照（单样本），用于验证向后兼容读取。 */
function writeLegacy(offsetDays, stars) {
  const at = new Date(Date.now() - offsetDays * 86400000);
  const date = dayKeyOf(at.getTime());
  writeFileSync(join(snapDir, date + '.json'), JSON.stringify({ date, savedAt: at.toISOString(), stars, stars_: undefined }));
  return date;
}

// 采样点必须**锚定日程边界**，不能再用「现在减 N 小时」——
// v0.4.0 起区间是 [上一个日程边界, 本边界]，与流水时间无关。
// 先把模块 import 进来，用它的日程函数算出三个边界各自在哪。
const mod = await import('../lib/index.js');
const I = mod.__internals;
const S = I.DEFAULT_CONFIG.schedule;
const dayB = I.lastBoundary(S.day, Date.now());
const weekB = I.lastBoundary(S.week, Date.now());
const monthB = I.lastBoundary(S.month, Date.now());
const dayCut = I.lastBoundary(S.day, dayB - 1);   // 日榜基线 = 昨天 00:00
const weekCut = I.lastBoundary(S.week, weekB - 1); // 周榜基线 = 上一个周一
const monthCut = I.lastBoundary(S.month, monthB - 1); // 月榜基线 = 上个月 1 号
const isoOf = (ms) => new Date(ms).toISOString();

/**
 * 写一个采样点。同一天可能有多个采样点（monthCut/weekCut/dayCut 可能落在同一天），
 * 所以按日期读-改-写，保持 samples 数组有序。
 */
function writeSample(atMs, stars) {
  const date = dayKeyOf(atMs);
  const file = join(snapDir, date + '.json');
  let samples = [];
  if (existsSync(file)) {
    try { samples = JSON.parse(readFileSync(file, 'utf8')).samples ?? []; } catch { samples = []; }
  }
  samples = samples.filter((x) => x.at !== new Date(atMs).toISOString());
  samples.push({ at: new Date(atMs).toISOString(), stars });
  samples.sort((a, b) => (a.at < b.at ? -1 : 1));
  writeFileSync(file, JSON.stringify({ date, samples }));
}

writeSample(monthCut, { 'a/one': 10, 'a/two': 20 });        // 月榜/总榜基线
writeSample(weekCut, { 'a/one': 100, 'a/two': 50 });       // 周榜 + 飙升榜基线
writeSample(dayCut, { 'a/one': 130, 'a/two': 52, 'a/three': 25 }); // 日榜基线

// ---------- 配置 ----------

writeFileSync(
  join(home, 'hotspot', 'config.json'),
  JSON.stringify({
    cacheMinutes: 0, // 每次都真抓，便于逐场景切换 GitHub 返回
    refreshMinutes: 0, // 关掉后台定时器，测试只测请求路径
    sampleIntervalMinutes: 15,
    perPage: 50,
    snapshotKeepDays: 400,
    summarize: true,
    summaryBatch: 50,
    boards: [
      { id: 't', name: '测试榜', query: 'topic:t' },
      { id: 'surge', name: '飙升榜', kind: 'surge' },
      { id: 'n', name: '简介测试榜', query: 'topic:n' },
      { id: 'rl', name: '限流榜', query: 'topic:rl' },
      { id: 'st', name: '缓存保留榜', query: 'topic:st' },
    ],
  }),
);

// ---------- 启动插件（假 ctx） ----------

/** 收集模型调用，供简介相关断言使用。 */
const llmCalls = [];
let llmMode = 'ok';

const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  effect(fn) {
    return fn();
  },
  agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
  llm: {
    stream: async function* (options) {
      llmCalls.push(options);
      if (llmMode === 'throw') throw new Error('模拟模型调用失败');
      if (llmMode === 'empty') return;
      if (llmMode === 'protocol') {
        // dsh-llm 的**真实**分片协议（见其 assembler.js 的 push）
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: '这是中文简介：把 A 变成 B' };
        yield { type: 'text-delta', index: 0, text: '，解决 C 问题。' };
        // 块里的完整文本与增量拼接结果相同：正确的解析器不能重复计数
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '这是中文简介：把 A 变成 B，解决 C 问题。' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      if (llmMode === 'errorfinish') {
        // 适配器错误被 dsh-llm 折进终止块，不在流里抛出
        yield { type: 'finish', reason: { kind: 'error', failure: { message: '模型不存在', code: 'MODEL_NOT_FOUND' } } };
        return;
      }
      yield { type: 'text', text: '这是中文简介：把 A 变成 B，解决 C 问题。' };
    },
  },
  webServer: {
    register(options) {
      route = options;
      return () => {};
    },
  },
};
let route;

mod.apply(ctx);

const server = createServer((req, res) => {
  Promise.resolve(route.handler(req, res)).catch((error) => res.writeHead(500).end(String(error)));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const call = async (path, options) => {
  const res = await fetch(base + path, options);
  let body;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  return { status: res.status, body };
};

const names = (body) => (body.items || []).map((i) => i.fullName);
const deltas = (body) => (body.items || []).map((i) => [i.fullName, i.delta]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  console.log('\n[1] 周榜：基线应取「不晚于 7 天前」的最近采样（10 天前，而不是 2 天前）');
  const week = await call('/dsh-hotspot/rank?board=t&period=week&refresh=1');
  check('HTTP 200', week.status === 200, JSON.stringify(week.body).slice(0, 160));
  check('basis = star-delta', week.body?.basis === 'star-delta', String(week.body?.basis));
  check('周榜基线 = 上一个周一 00:00', week.body?.windowStart === isoOf(weekCut), String(week.body?.windowStart) + ' vs ' + isoOf(weekCut));
  check('delta 正确：one=+40、two=+5', week.body?.items?.[0]?.delta === 40 && week.body?.items?.[1]?.delta === 5, JSON.stringify(deltas(week.body)));
  check('按 delta 降序', String(names(week.body)) === 'a/one,a/two,a/three', String(names(week.body)));
  check('基线里没有的仓库标 isNew', week.body?.items?.[2]?.isNew === true && week.body?.items?.[2]?.fullName === 'a/three');

  console.log('\n[2] 日榜：基线应换成昨天 00:00 的采样');
  const day = await call('/dsh-hotspot/rank?board=t&period=day&refresh=1');
  check('日榜基线 = 昨天 00:00', day.body?.windowStart === isoOf(dayCut), String(day.body?.windowStart) + ' vs ' + isoOf(dayCut));
  check(
    'delta 变成 one=+10、three=+5、two=+3（2 天前的采样里三个都在）',
    JSON.stringify(deltas(day.body)) === JSON.stringify([['a/one', 10], ['a/three', 5], ['a/two', 3]]),
    JSON.stringify(deltas(day.body)),
  );

  console.log('\n[3] 月榜 / 总榜：基线落到上个月 1 号');
  const month = await call('/dsh-hotspot/rank?board=t&period=month&refresh=1');
  check('月榜基线 = 上个月 1 号', month.body?.windowStart === isoOf(monthCut), String(month.body?.windowStart) + ' vs ' + isoOf(monthCut));
  check('月榜 delta：one=+130、two=+35', month.body?.items?.[0]?.delta === 130 && month.body?.items?.[1]?.delta === 35, JSON.stringify(deltas(month.body)));
  const all = await call('/dsh-hotspot/rank?board=t&period=all&refresh=1');
  check('总榜 delta 与月榜一致', JSON.stringify(deltas(all.body)) === JSON.stringify(deltas(month.body)));
  check('样本数 ≥ 4', (all.body?.sampleCount ?? 0) >= 4, String(all.body?.sampleCount));

  console.log('\n[4] 飙升榜：固定按周统计（忽略页签），基线 = 上一个周一');
  const surgeDay = await call('/dsh-hotspot/rank?board=surge&period=day');
  check('HTTP 200 且无需抓取', surgeDay.status === 200, String(surgeDay.status));
  check('basis = star-velocity', surgeDay.body?.basis === 'star-velocity', String(surgeDay.body?.basis));
  check('忽略页签且日程为每周一', surgeDay.body?.scheduled?.ignoresPeriodTabs === true && surgeDay.body?.scheduled?.rule === '每周一 00:00', String(surgeDay.body?.scheduled?.rule));
  check('基线 = 上一个周一（与周榜同一采样）', surgeDay.body?.windowStart === isoOf(weekCut), String(surgeDay.body?.windowStart) + ' vs ' + isoOf(weekCut));
  check('只有基线里存在的仓库进榜（three 被排除）', String(names(surgeDay.body)) === 'a/one,a/two', String(names(surgeDay.body)));
  check('按涨星排序：one(+40) > two(+5)', surgeDay.body?.items?.[0]?.delta === 40 && surgeDay.body?.items?.[1]?.delta === 5, JSON.stringify(surgeDay.body?.items?.map((i) => [i.fullName, i.delta])));
  check('给出星/天速度', typeof surgeDay.body?.items?.[0]?.perDay === 'number' && surgeDay.body.items[0].perDay > 0, String(surgeDay.body?.items?.[0]?.perDay));

  console.log('\n[5] 飙升榜：换页签拿到的是同一份冻结结果');
  const surgeWeek = await call('/dsh-hotspot/rank?board=surge&period=week');
  check('换页签仍是每周一日程', surgeWeek.body?.scheduled?.rule === '每周一 00:00', String(surgeWeek.body?.scheduled?.rule));
  check('命中同一把冻结键', surgeWeek.body?.scheduled?.frozen === true, String(surgeWeek.body?.scheduled?.frozen));
  check('条目与 windowStart 完全一致', JSON.stringify(names(surgeWeek.body)) === JSON.stringify(names(surgeDay.body)) && surgeWeek.body?.windowStart === surgeDay.body?.windowStart);

  console.log('\n[6] 采样：追加 vs 合并');
  const todayFile = join(snapDir, dayKeyOf(Date.now()) + '.json');
  const sampleCount = () => {
    const raw = JSON.parse(readFileSync(todayFile, 'utf8'));
    return raw.samples.length;
  };
  // 把今天的最后一个采样人为挪到 120 分钟前 → 下一次抓取应当「追加」而不是合并
  const rawToday = JSON.parse(readFileSync(todayFile, 'utf8'));
  rawToday.samples[rawToday.samples.length - 1].at = new Date(Date.now() - 120 * 60000).toISOString();
  writeFileSync(todayFile, JSON.stringify(rawToday));
  const before = sampleCount();
  await call('/dsh-hotspot/rank?board=t&period=week&refresh=1');
  const afterAppend = sampleCount();
  check('间隔足够 → 追加新采样（' + before + ' → ' + afterAppend + '）', afterAppend === before + 1, String(afterAppend));
  const atBeforeMerge = JSON.parse(readFileSync(todayFile, 'utf8')).samples.slice(-1)[0].at;
  await call('/dsh-hotspot/rank?board=t&period=week&refresh=1');
  const afterMerge = sampleCount();
  check('间隔不足 → 合并进上一个采样，不再新增', afterMerge === afterAppend, afterAppend + ' → ' + afterMerge);
  // 回归：v0.2.0 第一个 bug —— 合并时把 at 往前推，导致一天只剩一个采样、
  // 时间序列被自己抹掉（飙升榜永远 insufficient-history）
  const lastAfterMerge = JSON.parse(readFileSync(todayFile, 'utf8')).samples.slice(-1)[0];
  check('合并时**不得**推进采样时间 at', lastAfterMerge.at === atBeforeMerge, atBeforeMerge + ' → ' + lastAfterMerge.at);
  check('合并会更新 lastAt（该采样内星数的实际观测时刻）', typeof lastAfterMerge.lastAt === 'string' && lastAfterMerge.lastAt !== lastAfterMerge.at, JSON.stringify(lastAfterMerge).slice(0, 120));

  console.log('\n[7] 中文简介：异步生成 + 落盘缓存');
  // 用「简介测试榜」里那个从未生成过的新仓库，才能观察到 pending → 填充 的完整过程
  const firstRank = await call('/dsh-hotspot/rank?board=n&period=week&refresh=1');
  check(
    '新仓库首次返回时简介为空并标记 pending',
    firstRank.body?.items?.[0]?.fullName === 'c/new' &&
      firstRank.body?.items?.[0]?.summary === null &&
      firstRank.body?.items?.[0]?.summaryPending === true,
    JSON.stringify(firstRank.body?.items?.[0] ?? {}).slice(0, 140),
  );
  check('response 带 summaryStats', firstRank.body?.summaryStats !== undefined && typeof firstRank.body.summaryStats.cached === 'number');
  // 等后台 worker 跑完（每条之间有 300ms 间隔）
  for (let i = 0; i < 50 && llmCalls.length < 4; i++) await sleep(100);
  await sleep(700);
  const summaries = await call('/dsh-hotspot/summaries');
  check('新仓库的简介已生成', typeof summaries.body?.texts?.['c/new']?.text === 'string', JSON.stringify(Object.keys(summaries.body?.texts ?? {})));
  check('简介内容已清洗（无引号/前后缀）', String(summaries.body.texts['c/new'].text).startsWith('这是中文简介'), String(summaries.body.texts['c/new'].text));
  check('先前榜单的仓库也各自有简介（累计 ≥ 4 条）', Object.keys(summaries.body?.texts ?? {}).length >= 4, String(Object.keys(summaries.body?.texts ?? {}).length));
  check('调用参数带 provider/model/sessionId/system', llmCalls.length > 0 && llmCalls[0].provider === 'test-provider' && llmCalls[0].model === 'test-model' && llmCalls[0].sessionId === 'hotspot' && typeof llmCalls[0].system === 'string', JSON.stringify(llmCalls[0] ?? {}).slice(0, 160));
  check('调用参数带 messages 数组', Array.isArray(llmCalls[0]?.messages) && llmCalls[0].messages.length === 1);
  const secondRank = await call('/dsh-hotspot/rank?board=n&period=week');
  check('再次请求直接命中缓存（summary 有值、pending=false）', typeof secondRank.body?.items?.[0]?.summary === 'string' && secondRank.body.items[0].summaryPending === false, String(secondRank.body?.items?.[0]?.summary));

  console.log('\n[7b] 认 dsh-llm 的真实分片协议（text-delta），且不重复计数');
  llmMode = 'protocol';
  const callsBeforeProto = llmCalls.length;
  // 改掉官方简介 → 指纹变化 → 应视为过期并重新生成（顺带验证缓存失效）
  githubPlan = (url) => {
    const decoded = decodeURIComponent(String(url));
    if (decoded.includes('topic:n')) {
      return fakeResponse({ total_count: 1, items: [{ ...repo('c/new', 9), description: '改写过的官方简介 v2' }] });
    }
    return fakeResponse({ total_count: 3, items: CURRENT });
  };
  const protoRank = await call('/dsh-hotspot/rank?board=n&period=week&refresh=1');
  check('官方简介变化 → 指纹失效 → 重新排队', protoRank.body?.items?.[0]?.summaryPending === true, String(protoRank.body?.items?.[0]?.summaryPending));
  for (let i = 0; i < 50 && llmCalls.length === callsBeforeProto; i++) await sleep(100);
  await sleep(700);
  const protoSummaries = await call('/dsh-hotspot/summaries');
  check(
    'text-delta 分片被拼成正确文本（block-end 的整块文本不重复计数）',
    protoSummaries.body?.texts?.['c/new']?.text === '这是中文简介：把 A 变成 B，解决 C 问题。',
    String(protoSummaries.body?.texts?.['c/new']?.text),
  );
  check(
    '诊断显示用的是内置兜底实现（dsh-llm 在本地装不成）',
    String(protoSummaries.body?.stats?.lastDiag?.moduleSource ?? '').includes('兜底'),
    JSON.stringify(protoSummaries.body?.stats?.lastDiag ?? {}),
  );
  check('诊断记录 stage=ok 与模型名', protoSummaries.body?.stats?.lastDiag?.stage === 'ok' && String(protoSummaries.body.stats.lastDiag.model).includes('/'), JSON.stringify(protoSummaries.body?.stats?.lastDiag ?? {}));

  console.log('\n[7c] 没有正文时，必须报出 finish 里的真实原因（而不是一句没信息量的话）');
  llmMode = 'errorfinish';
  const callsBeforeErr = llmCalls.length;
  githubPlan = (url) => {
    const decoded = decodeURIComponent(String(url));
    if (decoded.includes('topic:n')) {
      return fakeResponse({ total_count: 1, items: [{ ...repo('c/new', 9), description: '改写过的官方简介 v3' }] });
    }
    return fakeResponse({ total_count: 3, items: CURRENT });
  };
  await call('/dsh-hotspot/rank?board=n&period=week&refresh=1');
  for (let i = 0; i < 50 && llmCalls.length === callsBeforeErr; i++) await sleep(100);
  await sleep(700);
  const errSummaries = await call('/dsh-hotspot/summaries');
  check('失败原因取自 finish.failure.message', errSummaries.body?.failures?.['c/new']?.reason === '模型不存在', String(errSummaries.body?.failures?.['c/new']?.reason));
  check('失败记录带上插件版本（便于升级后自动重试）', typeof errSummaries.body?.failures?.['c/new']?.v === 'string', JSON.stringify(errSummaries.body?.failures?.['c/new'] ?? {}));
  check('诊断记录了 finish 原文', errSummaries.body?.stats?.lastDiag?.finish?.kind === 'error', JSON.stringify(errSummaries.body?.stats?.lastDiag?.finish ?? {}));

  console.log('\n[7d] /summaries/reset 可清掉失败冷却');
  const reset = await call('/dsh-hotspot/summaries/reset', { method: 'POST' });
  check('reset 返回清理条数', reset.status === 200 && reset.body?.ok === true && typeof reset.body.cleared === 'number', JSON.stringify(reset.body).slice(0, 120));
  const afterReset = await call('/dsh-hotspot/summaries');
  check('失败记录已清空（简介文本保留）', Object.keys(afterReset.body?.failures ?? {}).length === 0 && Object.keys(afterReset.body?.texts ?? {}).length > 0, JSON.stringify({ f: Object.keys(afterReset.body?.failures ?? {}).length, t: Object.keys(afterReset.body?.texts ?? {}).length }));
  llmMode = 'ok';

  console.log('\n[8] 简介失败进冷却，不再反复重试');
  const callsBefore = llmCalls.length;
  llmMode = 'throw';
  // 注意：PUT /config 的 boards 是**整体替换**语义，所以必须带上已有榜单，
  // 否则后面的「限流榜 / 缓存保留榜」都不存在了（第一版测试就是这么翻车的）。
  const cfgBefore = await call('/dsh-hotspot/config');
  const boardsWithX = cfgBefore.body.config.boards
    .filter((b) => b.id !== 'x')
    .concat([{ id: 'x', name: '新榜', query: 'topic:x' }]);
  await call('/dsh-hotspot/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ boards: boardsWithX, cacheMinutes: 0, refreshMinutes: 0 }),
  });
  githubPlan = () => fakeResponse({ total_count: 1, items: [repo('b/fresh', 9)] });
  await call('/dsh-hotspot/rank?board=x&period=week&refresh=1');
  for (let i = 0; i < 20 && llmCalls.length === callsBefore; i++) await sleep(100);
  await sleep(500);
  const afterFail = await call('/dsh-hotspot/summaries');
  check('失败被记录', afterFail.body?.failures?.['b/fresh'] !== undefined, JSON.stringify(afterFail.body?.failures ?? {}));
  const callsAfterFail = llmCalls.length;
  await call('/dsh-hotspot/rank?board=x&period=week');
  await sleep(700);
  check('冷却期内不再重试', llmCalls.length === callsAfterFail, callsAfterFail + ' → ' + llmCalls.length);
  llmMode = 'ok';

  console.log('\n[9] 限流 · 无缓存 → 429；有缓存 → 保留旧数据并标 stale');
  githubPlan = () => fakeResponse({ message: 'rate limit exceeded' }, 403, { 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) });
  const limited = await call('/dsh-hotspot/rank?board=rl&period=week&refresh=1');
  check('HTTP 429', limited.status === 429, String(limited.status));
  check('kind = rate-limited 且透传 resetAt', limited.body?.kind === 'rate-limited' && typeof limited.body.resetAt === 'number', JSON.stringify(limited.body).slice(0, 140));
  check('文案提示未认证限 10 次/分钟', String(limited.body?.error).includes('10 次/分钟'), String(limited.body?.error));

  githubPlan = () => fakeResponse({ total_count: 3, items: CURRENT });
  const okFirst = await call('/dsh-hotspot/rank?board=st&period=week&refresh=1');
  check('先成功拿到数据', okFirst.status === 200 && okFirst.body?.items?.length === 3, String(okFirst.status));
  githubPlan = () => fakeResponse({ message: 'rate limit exceeded' }, 403, { 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60) });
  const stale = await call('/dsh-hotspot/rank?board=st&period=week&refresh=1');
  check('HTTP 仍为 200（不清空）', stale.status === 200, String(stale.status));
  check('stale = true 且条目数不变', stale.body?.stale === true && stale.body?.items?.length === 3, String(stale.body?.items?.length));
  check('notes 说明本次抓取失败', JSON.stringify(stale.body?.notes).includes('抓取失败'), JSON.stringify(stale.body?.notes));

  console.log('\n[10] 快照保留期清理');
  const filesBefore = readdirSync(snapDir).length;
  const refreshed = await call('/dsh-hotspot/refresh?board=st', { method: 'POST' });
  check('刷新接口正常（飙升榜不参与抓取）', refreshed.status === 200 && refreshed.body?.ok === true, String(refreshed.status));
  check('刷新结果里不含 surge', !(refreshed.body?.results ?? []).some((r) => r.board === 'surge'), JSON.stringify(refreshed.body?.results));
  check('快照文件未被误删（保留期 400 天）', readdirSync(snapDir).length === filesBefore, filesBefore + ' → ' + readdirSync(snapDir).length);

  console.log('\n[11] /status 暴露新指标');
  const status = await call('/dsh-hotspot/status');
  check('sampleCount / registrySize / summaryStats 都在', typeof status.body?.sampleCount === 'number' && typeof status.body?.registrySize === 'number' && status.body?.summaryStats !== undefined);
  check('榜单数 ≥ 4 且含飙升榜', (status.body?.boards?.length ?? 0) >= 4 && status.body.boards.some((b) => b.id === 'surge'), String(status.body?.boards?.length));
  check('飙升榜被标记 kind=surge 且 query 显示为跨榜单', status.body.boards.find((b) => b.id === 'surge')?.kind === 'surge');
} catch (error) {
  failures.push('未捕获异常：' + (error?.stack ?? error));
  console.log('\n未捕获异常：' + (error?.stack ?? error));
} finally {
  globalThis.fetch = realFetch;
  server.close();
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
}

console.log('\n================ 结果 ================');
console.log('断言 ' + checks + ' 项，失败 ' + failures.length + ' 项');
if (failures.length > 0) {
  for (const f of failures) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log('全部通过');
}
