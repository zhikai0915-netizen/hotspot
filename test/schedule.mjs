/**
 * hotspot 日程与冻结测试 —— 覆盖 v0.4.0 的核心行为。
 *
 * 用户要求：飙升榜每周一更新、其余时间不动；日榜每 24 小时更新；
 * 周榜周日晚 12 点（= 周一 00:00）更新；月榜每月 1 号更新。
 *
 * 这里分两层验证：
 *   1. **纯函数层**（确定性）：日程边界 lastBoundary / nextBoundary、
 *      归一化、文案。now 由测试显式传入，跨月/闰年/月末钳位都不靠运气。
 *   2. **接口层**（打桩，不碰网络）：跨过边界才重算、其余时间冻结不抓数据、
 *      手动刷新可绕过冻结、飙升榜忽略页签。
 *
 * 跑法：node test/schedule.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const home = mkdtempSync(join(tmpdir(), 'hotspot-sched-'));
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

// ---------------- 打桩 GitHub ----------------
const realFetch = globalThis.fetch;
let fetchCount = 0;
function repo(fullName, stars) {
  const [owner, name] = fullName.split('/');
  return {
    full_name: fullName,
    html_url: 'https://github.com/' + fullName,
    description: name,
    stargazers_count: stars,
    forks_count: 0,
    open_issues_count: 0,
    language: 'TypeScript',
    topics: ['t'],
    pushed_at: new Date().toISOString(),
    created_at: '2026-01-01T00:00:00Z',
    archived: false,
    owner: { login: owner },
  };
}
function fakeResponse(body, status = 200, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
globalThis.fetch = async (url, options) => {
  const target = String(url);
  if (target.startsWith('http://127.0.0.1')) return realFetch(url, options);
  fetchCount += 1;
  return fakeResponse({ total_count: 2, items: [repo('a/one', 140), repo('a/two', 55)] });
};

// ---------------- 造一份历史采样（好让涨星算得出来） ----------------

// 先加载模块：下面要用它的日程函数算出「今天 00:00 边界」在哪
const mod = await import('../lib/index.js');
const I = mod.__internals;
const snapDir = join(home, 'hotspot', 'snapshots');
mkdirSync(snapDir, { recursive: true });
function dayKeyOf(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
const pastAt = new Date(Date.now() - 40 * 3600000); // 40 小时前，确保跨过今天 0 点
writeFileSync(
  join(snapDir, dayKeyOf(pastAt.getTime()) + '.json'),
  JSON.stringify({ date: dayKeyOf(pastAt.getTime()), samples: [{ at: pastAt.toISOString(), stars: { 'a/one': 100, 'a/two': 50 } }] }),
);
// 再在「今天 00:00 边界」上放一份采样，日榜才有目标采样可用（as-of-boundary）
const dayBoundary = I.lastBoundary(I.DEFAULT_CONFIG.schedule.day, Date.now());
const boundaryIso = new Date(dayBoundary).toISOString();
const boundaryDate = dayKeyOf(dayBoundary);
const boundaryFile = join(snapDir, boundaryDate + '.json');
let boundarySamples = [];
if (existsSync(boundaryFile)) {
  try { boundarySamples = JSON.parse(readFileSync(boundaryFile, 'utf8')).samples ?? []; } catch { boundarySamples = []; }
}
boundarySamples = boundarySamples.filter((x) => x.at !== boundaryIso);
boundarySamples.push({ at: boundaryIso, stars: { 'a/one': 140, 'a/two': 58 } });
boundarySamples.sort((a, b) => (a.at < b.at ? -1 : 1));
writeFileSync(boundaryFile, JSON.stringify({ date: boundaryDate, samples: boundarySamples }));
writeFileSync(
  join(home, 'hotspot', 'config.json'),
  JSON.stringify({ cacheMinutes: 0, refreshMinutes: 0, scheduleCheckMinutes: 5, summarize: false, classify: false, boards: [{ id: 't', name: '测试榜', query: 'topic:t' }, { id: 'surge', name: '飙升榜', kind: 'surge' }] }),
);

// ---------------- 启动插件（假 ctx） ----------------
let route;
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  effect: (fn) => fn(),
  webServer: {
    register(options) {
      route = options;
      return () => {};
    },
  },
};
mod.apply(ctx);
const server = createServer((req, res) => Promise.resolve(route.handler(req, res)).catch((e) => res.writeHead(500).end(String(e))));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;
const call = async (path, options) => {
  const res = await realFetch(base + path, options);
  let body;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  return { status: res.status, body };
};

try {
  console.log('\n[1] 日程边界 · 天');
  const day = { every: 'day', hour: 0 };
  const day9 = { every: 'day', hour: 9 };
  const t = (y, mo, d, h, mi = 0) => new Date(y, mo, d, h, mi, 0, 0).getTime();
  check('0 点时 last 就是当下（边界含端点，不能退到昨天）', I.lastBoundary(day, t(2026, 9, 15, 0, 0)) === t(2026, 9, 15, 0, 0), new Date(I.lastBoundary(day, t(2026, 9, 15, 0, 0))).toString());
  check('08:30 → last=今天 00:00、next=明天 00:00', I.lastBoundary(day, t(2026, 9, 15, 8, 30)) === t(2026, 9, 15, 0, 0) && I.nextBoundary(day, t(2026, 9, 15, 8, 30)) === t(2026, 9, 16, 0, 0));
  check('09:00 自定义小时：08:30 → last=昨天 09:00', I.lastBoundary(day9, t(2026, 9, 15, 8, 30)) === t(2026, 9, 14, 9, 0), new Date(I.lastBoundary(day9, t(2026, 9, 15, 8, 30))).toString());
  check('09:00 自定义小时：09:30 → last=今天 09:00', I.lastBoundary(day9, t(2026, 9, 15, 9, 30)) === t(2026, 9, 15, 9, 0));

  console.log('\n[2] 日程边界 · 周（周一 00:00）');
  const week1 = { every: 'week', weekday: 1, hour: 0 };
  const probe = t(2026, 9, 15, 13, 0);
  const wl = I.lastBoundary(week1, probe);
  const wn = I.nextBoundary(week1, probe);
  check('last 落在周一、且 0 点', new Date(wl).getDay() === 1 && new Date(wl).getHours() === 0, new Date(wl).toString());
  check('last ≤ now < next', wl <= probe && probe < wn, new Date(wl).toString() + ' / ' + new Date(wn).toString());
  check('相邻边界正好差 7 天', wn - wl === 7 * 86400000, String((wn - wl) / 86400000));
  check('在 next 前一毫秒再算，last 仍是同一个', I.lastBoundary(week1, wn - 1) === wl);
  check('在 next 当刻再算，last 前进到 next', I.lastBoundary(week1, wn) === wn);

  console.log('\n[3] 日程边界 · 月（含月末钳位与跨年）');
  const month1 = { every: 'month', day: 1, hour: 0 };
  check('2/15 → last=2/1、next=3/1', I.lastBoundary(month1, t(2026, 1, 15, 12)) === t(2026, 1, 1, 0, 0) && I.nextBoundary(month1, t(2026, 1, 15, 12)) === t(2026, 2, 1, 0, 0));
  check('12/15 → next 跨年到 2027-01-01', I.nextBoundary(month1, t(2026, 11, 15, 12)) === t(2027, 0, 1, 0, 0), new Date(I.nextBoundary(month1, t(2026, 11, 15, 12))).toString());
  const month31 = { every: 'month', day: 31, hour: 0 };
  const feb = new Date(I.nextBoundary(month31, t(2026, 1, 15, 12)));
  check('31 号遇 2 月 → 钳到当月最后一天 2/28（2026 非闰年）', feb.getMonth() === 1 && feb.getDate() === 28, feb.toString());
  const jan = new Date(I.lastBoundary(month31, t(2026, 1, 15, 12)));
  check('31 号遇 2 月 → last=1/31', jan.getMonth() === 0 && jan.getDate() === 31, jan.toString());
  check('2/28 当天算 last 不早于 2/28（钳位日也算边界）', new Date(I.lastBoundary(month31, t(2026, 1, 28, 12))).getDate() === 28, new Date(I.lastBoundary(month31, t(2026, 1, 28, 12))).toString());

  console.log('\n[4] 日程归一化与文案');
  check('非法 every → day', I.normalizeScheduleSpec({ every: 'nonsense' }, day).every === 'day');
  check('hour 超界被夹取（25→23、-3→0）', I.normalizeScheduleSpec({ every: 'day', hour: 25 }, day).hour === 23 && I.normalizeScheduleSpec({ every: 'day', hour: -3 }, day).hour === 0);
  check('weekday 取模（8→1）', I.normalizeScheduleSpec({ every: 'week', weekday: 8 }, week1).weekday === 1);
  check('month day 夹取（0→1、40→31）', I.normalizeScheduleSpec({ every: 'month', day: 0 }, month1).day === 1 && I.normalizeScheduleSpec({ every: 'month', day: 40 }, month1).day === 31);
  check('整份归一化补齐所有键', Object.keys(I.normalizeSchedule({ day: { every: 'day' } })).sort().join(',') === 'all,day,month,sample,surge,week');
  check('文案：每天 00:00', I.describeSchedule(day) === '每天 00:00', I.describeSchedule(day));
  check('文案：每周一 00:00（周日晚 12 点 = 周一 0 点）', I.describeSchedule(week1) === '每周一 00:00', I.describeSchedule(week1));
  check('文案：每月 1 号 00:00', I.describeSchedule(month1) === '每月 1 号 00:00', I.describeSchedule(month1));

  console.log('\n[5] 默认日程符合用户要求');
  const def = I.DEFAULT_CONFIG.schedule;
  check('日榜 = 每天 0 点（每 24 小时）', I.describeSchedule(def.day) === '每天 00:00');
  check('周榜 = 每周一 0 点（周日晚 12 点）', I.describeSchedule(def.week) === '每周一 00:00');
  check('月榜 = 每月 1 号', I.describeSchedule(def.month) === '每月 1 号 00:00');
  check('飙升榜 = 每周一（其余时间不更新）', I.describeSchedule(def.surge) === '每周一 00:00');
  check('采样 = 每天 0 点（一次采样够所有区间用）', I.describeSchedule(def.sample) === '每天 00:00');

  console.log('\n[6] /status 暴露日程');
  const status = await call('/dsh-hotspot/status');
  // 直接读 package.json 比对，避免每次升版都要改测试
  const pkgVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  check('version 与 package.json 一致', status.body?.version === pkgVersion, String(status.body?.version) + ' vs ' + pkgVersion);
  check('schedule 含 6 条规则', Object.keys(status.body?.schedule ?? {}).length === 6, JSON.stringify(Object.keys(status.body?.schedule ?? {})));
  check('每条规则带 rule/lastBoundary/nextBoundary', ['day', 'week', 'month', 'surge'].every((k) => typeof status.body.schedule[k].rule === 'string' && typeof status.body.schedule[k].nextBoundary === 'string'));
  check('采样进度初始为 null', status.body?.sampledBoundary === null, String(status.body?.sampledBoundary));

  console.log('\n[7] 跨过边界才重算，其余时间冻结（且不抓数据）');
  const before = fetchCount;
  const first = await call('/dsh-hotspot/rank?board=t&period=day');
  check('首次：非冻结、并抓了一次数据', first.body?.scheduled?.frozen === false && fetchCount === before + 1, 'frozen=' + first.body?.scheduled?.frozen + ' fetch=' + (fetchCount - before));
  check('返回日榜日程文案', first.body?.scheduled?.rule === '每天 00:00', String(first.body?.scheduled?.rule));
  check('给出下次更新时间与倒计时', typeof first.body?.scheduled?.nextBoundary === 'string' && first.body?.scheduled?.nextInMs > 0, JSON.stringify(first.body?.scheduled ?? {}));
  check('区间涨星算出来了（有基线、有实际区间）', first.body?.basis === 'star-delta' && typeof first.body?.windowHours === 'number' && first.body.windowHours > 0, 'basis=' + first.body?.basis + ' h=' + first.body?.windowHours);
  const afterFirst = fetchCount;
  const second = await call('/dsh-hotspot/rank?board=t&period=day');
  check('再次请求：命中冻结、**没有再抓数据**', second.body?.scheduled?.frozen === true && fetchCount === afterFirst, 'frozen=' + second.body?.scheduled?.frozen + ' 新增请求=' + (fetchCount - afterFirst));
  check('冻结结果与首次一致（同一边界）', second.body?.scheduled?.boundary === first.body?.scheduled?.boundary, String(second.body?.scheduled?.boundary));
  const weekFirst = await call('/dsh-hotspot/rank?board=t&period=week');
  check('换周期是另一把冻结键 → 会重算', weekFirst.body?.scheduled?.frozen === false && weekFirst.body?.scheduled?.rule === '每周一 00:00', String(weekFirst.body?.scheduled?.rule));
  const forced = await call('/dsh-hotspot/rank?board=t&period=day&refresh=1');
  check('手动刷新绕过冻结', forced.body?.scheduled?.frozen === false, String(forced.body?.scheduled?.frozen));

  console.log('\n[8] 边界推进 / 版本变化都会重新计算');
  const frozenPath = join(home, 'hotspot', 'frozen.json');
  const frozen = JSON.parse(readFileSync(frozenPath, 'utf8'));
  frozen.items['t|day'].boundary -= 3 * 86400000; // 假装已经过去了三个边界
  writeFileSync(frozenPath, JSON.stringify(frozen));
  const afterAdvance = await call('/dsh-hotspot/rank?board=t&period=day');
  check('旧边界 → 判定为过期并重算', afterAdvance.body?.scheduled?.frozen === false, String(afterAdvance.body?.scheduled?.frozen));
  // 升级后旧版本算出的冻结结果必须失效，否则新算法要等一整个周期才生效
  await call('/dsh-hotspot/rank?board=t&period=day'); // 先让它重新冻结
  const frozenNow = JSON.parse(readFileSync(frozenPath, 'utf8'));
  frozenNow.items['t|day'].v = '0.0.0-old';
  writeFileSync(frozenPath, JSON.stringify(frozenNow));
  const afterVersionBump = await call('/dsh-hotspot/rank?board=t&period=day');
  check('冻结条目版本不匹配 → 重算', afterVersionBump.body?.scheduled?.frozen === false, String(afterVersionBump.body?.scheduled?.frozen));

  console.log('\n[9] 飙升榜固定按自己的日程，页签不影响');
  const surgeDay = await call('/dsh-hotspot/rank?board=surge&period=day');
  check('飙升榜用自己的日程（每周一），不是日榜日程', surgeDay.body?.scheduled?.rule === '每周一 00:00', String(surgeDay.body?.scheduled?.rule));
  check('标记 ignoresPeriodTabs', surgeDay.body?.scheduled?.ignoresPeriodTabs === true);
  check('notes 明说页签对它不起作用', JSON.stringify(surgeDay.body?.notes).includes('页签对它不起作用'), JSON.stringify(surgeDay.body?.notes));
  const surgeMonth = await call('/dsh-hotspot/rank?board=surge&period=month');
  check('换页签仍是同一条日程', surgeMonth.body?.scheduled?.rule === '每周一 00:00', String(surgeMonth.body?.scheduled?.rule));
  // v0.5.0：窗口不完整时结果是「临时」的、不冻结，所以这里验"同一把键 → 结果一致"
  check(
    '换页签后仍是同一份结果',
    surgeMonth.body?.windowStart === surgeDay.body?.windowStart && surgeMonth.body?.scheduled?.rule === surgeDay.body?.scheduled?.rule,
    JSON.stringify({ a: surgeDay.body?.windowStart, b: surgeMonth.body?.windowStart }),
  );

  console.log('\n[10] 日程可配置');
  await call('/dsh-hotspot/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ schedule: { day: { every: 'day', hour: 3 }, week: { every: 'week', weekday: 5, hour: 22 }, month: { every: 'month', day: 15, hour: 6 }, surge: { every: 'week', weekday: 0, hour: 1 }, all: { every: 'month', day: 1, hour: 0 }, sample: { every: 'week', weekday: 1, hour: 0 } } }),
  });
  const dayCfg = await call('/dsh-hotspot/rank?board=t&period=day');
  check('日榜改为每天 03:00', dayCfg.body?.scheduled?.rule === '每天 03:00', String(dayCfg.body?.scheduled?.rule));
  const weekCfg = await call('/dsh-hotspot/rank?board=t&period=week');
  check('周榜改为每周五 22:00', weekCfg.body?.scheduled?.rule === '每周五 22:00', String(weekCfg.body?.scheduled?.rule));
  const surgeCfg = await call('/dsh-hotspot/rank?board=surge&period=day');
  check('飙升榜改为每周日 01:00', surgeCfg.body?.scheduled?.rule === '每周日 01:00', String(surgeCfg.body?.scheduled?.rule));
  check('坏日程值被归一化而不是崩', (await call('/dsh-hotspot/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schedule: { day: { every: 'x', hour: 99 } } }) })).status === 200);
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
