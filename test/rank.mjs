/**
 * hotspot 核心算法测试 —— 确定性覆盖 smoke.mjs 碰不到的三条路径。
 *
 * smoke.mjs 用的是全新 DSH_HOME，所以它**永远走「快照不足 → 按总星数」的降级分支**，
 * 于是下面这些最关键的逻辑一直没被测过：
 *
 *   1. 区间涨星（star-delta）：基线快照怎么挑、delta 怎么算、isNew 怎么标、怎么排序；
 *   2. 四个周期是否真的用不同基线（日 / 周 / 月 / 总）；
 *   3. 限流的两种情形 —— 无缓存时 429、有缓存时保留旧数据并标 stale；
 *   4. 快照保留期清理。
 *
 * 做法：**打桩 globalThis.fetch**，喂进精心构造的星数，再手写历史快照，
 * 于是结果完全可预测、不依赖网络、不受 GitHub 限流影响。
 *
 * 跑法：node test/rank.mjs
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
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

/** 构造一个够用的 Response 替身（插件只用到 status/ok/headers.get/json/text）。 */
function fakeResponse(body, status = 200, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (key) => headers[String(key).toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** 当前这一轮「GitHub 会返回什么」，由各场景改写。 */
let githubPlan = () => fakeResponse({ items: [] });

globalThis.fetch = async (url, options) => {
  const target = String(url);
  // 打给自己本地服务端的请求要放行，否则会把自己的测试打死
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
    description: name + ' 的描述',
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

/** 当前星数：a/one 140、a/two 55、a/three 30（three 不在任何历史快照里 → 新上榜）。 */
const CURRENT = [repo('a/one', 140), repo('a/two', 55), repo('a/three', 30)];
githubPlan = () => fakeResponse({ total_count: 3, items: CURRENT });

// ---------- 伪造历史快照 ----------

const snapDir = join(home, 'hotspot', 'snapshots');
mkdirSync(snapDir, { recursive: true });

/** 相对今天偏移若干天的日期键，与宿主的 todayKey() 同格式。 */
function dayKey(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 写一份历史快照。 */
function writeSnapshot(offsetDays, stars) {
  const date = dayKey(offsetDays);
  writeFileSync(join(snapDir, date + '.json'), JSON.stringify({ date, savedAt: new Date().toISOString(), stars }));
  return date;
}

const ANCIENT = writeSnapshot(-200, { 'a/one': 10, 'a/two': 20 }); // 总榜基线
const WEEK = writeSnapshot(-10, { 'a/one': 100, 'a/two': 50 }); // 周榜基线
const RECENT = writeSnapshot(-2, { 'a/one': 130, 'a/two': 52 }); // 日榜基线

// ---------- 配置 ----------

writeFileSync(
  join(home, 'hotspot', 'config.json'),
  JSON.stringify({
    cacheMinutes: 0, // 每次都真抓，便于逐场景切换 GitHub 返回
    refreshMinutes: 0, // 关掉后台定时器，测试只测请求路径
    perPage: 50,
    snapshotKeepDays: 400,
    boards: [
      { id: 't', name: '测试榜', query: 'topic:t' },
      { id: 'rl', name: '限流榜', query: 'topic:rl' },
      { id: 'st', name: '缓存保留榜', query: 'topic:st' },
    ],
  }),
);

// ---------- 启动插件（复用 smoke.mjs 的假 ctx 方式） ----------

const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  effect(fn) {
    return fn();
  },
  webServer: {
    register(options) {
      route = options;
      return () => {};
    },
  },
};
let route;

const mod = await import('../lib/index.js');
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

const deltas = (body) => (body.items || []).map((i) => [i.fullName, i.delta, i.isNew]);
const names = (body) => (body.items || []).map((i) => i.fullName);

try {
  console.log('\n[1] 周榜：基线应取「不晚于 7 天前」的最新快照（' + WEEK + '，而不是 ' + RECENT + '）');
  const week = await call('/dsh-hotspot/rank?board=t&period=week&refresh=1');
  check('HTTP 200', week.status === 200, JSON.stringify(week.body).slice(0, 160));
  check('basis = star-delta（历史够，切到涨星榜）', week.body?.basis === 'star-delta', String(week.body?.basis));
  check('windowStart = 周基线', week.body?.windowStart === WEEK, String(week.body?.windowStart));
  check('delta 计算正确：one=+40、two=+5', week.body?.items?.[0]?.delta === 40 && week.body?.items?.[1]?.delta === 5, JSON.stringify(deltas(week.body)));
  check('按 delta 降序排列', String(names(week.body)) === 'a/one,a/two,a/three', String(names(week.body)));
  check('未在基线出现的仓库标 isNew', week.body?.items?.[2]?.isNew === true && week.body?.items?.[2]?.fullName === 'a/three');
  check('notes 说明基线日期', JSON.stringify(week.body?.notes).includes(WEEK), JSON.stringify(week.body?.notes));

  console.log('\n[2] 日榜：基线应换成 ' + RECENT + '（同一批仓库，不同基线 → 不同 delta）');
  const day = await call('/dsh-hotspot/rank?board=t&period=day&refresh=1');
  check('windowStart = 日基线', day.body?.windowStart === RECENT, String(day.body?.windowStart));
  check('delta 变成 one=+10、two=+3', day.body?.items?.[0]?.delta === 10 && day.body?.items?.[1]?.delta === 3, JSON.stringify(deltas(day.body)));

  console.log('\n[3] 月榜 / 总榜：基线应落到 ' + ANCIENT);
  const month = await call('/dsh-hotspot/rank?board=t&period=month&refresh=1');
  check('月榜 windowStart = 最早可用基线', month.body?.windowStart === ANCIENT, String(month.body?.windowStart));
  check('月榜 delta：one=+130、two=+35', month.body?.items?.[0]?.delta === 130 && month.body?.items?.[1]?.delta === 35, JSON.stringify(deltas(month.body)));
  const all = await call('/dsh-hotspot/rank?board=t&period=all&refresh=1');
  check('总榜 windowStart = 最早快照', all.body?.windowStart === ANCIENT, String(all.body?.windowStart));
  check('总榜 delta 与月榜一致（两者基线相同）', JSON.stringify(deltas(all.body)) === JSON.stringify(deltas(month.body)));
  check('今日快照已写入（快照数 ≥ 4）', (all.body?.snapshotCount ?? 0) >= 4, String(all.body?.snapshotCount));

  console.log('\n[4] 限流 · 无缓存时：应返回 429 且不返回空榜');
  githubPlan = () => fakeResponse({ message: 'rate limit exceeded' }, 403, { 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) });
  const limited = await call('/dsh-hotspot/rank?board=rl&period=week&refresh=1');
  check('HTTP 429', limited.status === 429, String(limited.status) + ' ' + JSON.stringify(limited.body).slice(0, 120));
  check('kind = rate-limited', limited.body?.kind === 'rate-limited', String(limited.body?.kind));
  check('透传 resetAt', typeof limited.body?.resetAt === 'number' && limited.body.resetAt > Date.now(), String(limited.body?.resetAt));
  check('错误文案提示未认证限 10 次/分钟', String(limited.body?.error).includes('10 次/分钟'), String(limited.body?.error));

  console.log('\n[5] 限流 · 有缓存时：保留旧数据、标 stale，绝不清空');
  githubPlan = () => fakeResponse({ total_count: 3, items: CURRENT });
  const before = await call('/dsh-hotspot/rank?board=st&period=week&refresh=1');
  check('先成功拿到数据', before.status === 200 && before.body?.items?.length === 3, String(before.status));
  githubPlan = () => fakeResponse({ message: 'rate limit exceeded' }, 403, { 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60) });
  const after = await call('/dsh-hotspot/rank?board=st&period=week&refresh=1');
  check('HTTP 仍为 200（不是 429）', after.status === 200, String(after.status));
  check('stale = true', after.body?.stale === true);
  check('条目数量未变（旧数据保住了）', after.body?.items?.length === 3, String(after.body?.items?.length));
  check('rateLimited = true', after.body?.rateLimited === true);
  check('notes 说明本次刷新失败', JSON.stringify(after.body?.notes).includes('刷新失败'), JSON.stringify(after.body?.notes));

  console.log('\n[6] 快照保留期清理');
  const before2 = readdirSync(snapDir).length;
  await call('/dsh-hotspot/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ snapshotKeepDays: 1 }),
  });
  githubPlan = () => fakeResponse({ total_count: 3, items: CURRENT });
  const refreshed = await call('/dsh-hotspot/refresh?board=t', { method: 'POST' });
  check('刷新成功', refreshed.status === 200 && refreshed.body?.ok === true, String(refreshed.status));
  const left = readdirSync(snapDir).sort();
  check('超期快照被删除（原有 ' + before2 + ' 份，现在 ' + left.length + ' 份）', left.length < before2, left.join(','));
  check('当日快照保留', left.includes(dayKey(0) + '.json'), left.join(','));
  check('200 天前的快照被清掉', !left.includes(ANCIENT + '.json'), left.join(','));

  console.log('\n[7] 快照目录是唯一的历史来源：删掉即退回总星数排名');
  const cfgNow = await call('/dsh-hotspot/config');
  check('配置可读回（keepDays=1 已生效）', cfgNow.body?.config?.snapshotKeepDays === 1, String(cfgNow.body?.config?.snapshotKeepDays));
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
