/**
 * hotspot 相关性判定（v0.5.0）测试。
 *
 * 要验的是「用模型优化榜单」这件事本身：
 *   · 规则预筛零成本生效（合集关键词 / 平台级星数阈值）——不该浪费模型调用；
 *   · 模型判定能剔除 platform / list / unrelated / 相关性不足；
 *   · 待判定的排在已判定之后（否则首屏又被巨型项目占满）；
 *   · 判定结果进缓存，不重复调用；
 *   · 判定没完成时不冻结（provisional），完成后才冻结；
 *   · 数据取「边界那次的采样」：★ 与 delta 同源，不能出现「★ 是现在、delta 是昨天」。
 *
 * 跑法：node test/classify.mjs
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const home = mkdtempSync(join(tmpdir(), 'hotspot-cls-'));
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
function repo(fullName, stars, description) {
  const [owner, name] = fullName.split('/');
  return {
    full_name: fullName,
    html_url: 'https://github.com/' + fullName,
    description,
    stargazers_count: stars,
    forks_count: 3,
    open_issues_count: 0,
    language: 'TypeScript',
    topics: ['t'],
    pushed_at: new Date(Date.now() - 5 * 86400000).toISOString(),
    created_at: '2026-01-01T00:00:00Z',
    archived: false,
    owner: { login: owner },
  };
}
const CANDIDATES = [
  // 平台级：靠规则（星数）直接剔除，不花模型调用
  repo('big/platform', 250000, 'A huge agent framework and runtime'),
  // 合集：靠规则（关键词）直接剔除
  repo('cool/awesome-list', 500, 'A curated awesome list of agent plugins'),
  // 正常的工具
  repo('good/tool-a', 1000, 'A tiny plugin that does one thing well'),
  repo('good/tool-b', 900, 'Another small plugin'),
  // 由模型判定为无关
  repo('meh/unrelated', 10000, 'A completely different kind of product'),
  // 判为工具但相关性太低
  repo('mid/lowrel', 5000, 'Loosely related toolbox'),
];
function fakeResponse(body, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
globalThis.fetch = async (url, options) => {
  const target = String(url);
  if (target.startsWith('http://127.0.0.1')) return realFetch(url, options);
  fetchCount += 1;
  return fakeResponse({ total_count: CANDIDATES.length, items: CANDIDATES });
};

// ---------------- 造假的历史采样（锚定日程边界） ----------------
const snapDir = join(home, 'hotspot', 'snapshots');
mkdirSync(snapDir, { recursive: true });
function dayKeyOf(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function writeSample(atMs, stars) {
  const date = dayKeyOf(atMs);
  const file = join(snapDir, date + '.json');
  let samples = [];
  if (existsSync(file)) {
    try {
      samples = JSON.parse(readFileSync(file, 'utf8')).samples ?? [];
    } catch {
      samples = [];
    }
  }
  samples = samples.filter((x) => x.at !== new Date(atMs).toISOString());
  samples.push({ at: new Date(atMs).toISOString(), stars });
  samples.sort((a, b) => (a.at < b.at ? -1 : 1));
  writeFileSync(file, JSON.stringify({ date, samples }));
}

const mod = await import('../lib/index.js');
const I = mod.__internals;
const S = I.DEFAULT_CONFIG.schedule;
const dayB = I.lastBoundary(S.day, Date.now());
const dayCut = I.lastBoundary(S.day, dayB - 1); // 昨天 00:00（日榜基线）
// 基线采样（昨天 00:00）
writeSample(dayCut, { 'good/tool-a': 500, 'good/tool-b': 950, 'meh/unrelated': 9000, 'mid/lowrel': 4000 });
// 目标采样（昨天中午，≤ 今天 00:00 边界）——★ 应取这里的值，而不是抓取时的值
writeSample(dayCut + 12 * 3600000, { 'good/tool-a': 900, 'good/tool-b': 960, 'meh/unrelated': 10000, 'mid/lowrel': 5000 });

// ---------------- 打桩模型 ----------------
const llmCalls = [];
const verdictFor = {
  'good/tool-a': { verdict: 'tool', relevance: 95, reason: '就是个插件' },
  'good/tool-b': { verdict: 'tool', relevance: 80, reason: '小型插件' },
  'meh/unrelated': { verdict: 'unrelated', relevance: 20, reason: '与本榜无关' },
  'mid/lowrel': { verdict: 'tool', relevance: 30, reason: '关系不大' },
};
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  effect: (fn) => fn(),
  agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  llm: {
    stream: async function* (options) {
      const text = JSON.stringify(options.messages?.[0]?.content ?? '');
      llmCalls.push(text);
      const hit = Object.keys(verdictFor).find((k) => text.includes(k));
      const v = hit !== undefined ? verdictFor[hit] : { verdict: 'tool', relevance: 70, reason: '默认' };
      yield { type: 'text', delta: undefined, text: '```json' };
      yield { type: 'text', text: '\n' + JSON.stringify(v) + '\n' };
      yield { type: 'text', text: '```' };
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
writeFileSync(
  join(home, 'hotspot', 'config.json'),
  JSON.stringify({
    cacheMinutes: 0,
    refreshMinutes: 0,
    summarize: false,
    classify: true,
    classifyBatch: 10,
    scheduleCheckMinutes: 0,
    ranking: { requireTool: true, minRelevance: 60, relevanceWeight: 0.05, platformStars: 100000 },
    boards: [
      { id: 't', name: '插件榜', desc: 'AI 编码助手的插件', query: 'topic:t' },
      { id: 'surge', name: '飙升榜', kind: 'surge' },
    ],
  }),
);
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
const names = (b) => (b.items || []).map((i) => i.fullName);
const find = (b, name) => (b.items || []).find((i) => i.fullName === name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  console.log('\n[1] 首次请求：规则预筛立即生效，模型判定排队中');
  const first = await call('/dsh-hotspot/rank?board=t&period=day&refresh=1');
  check('HTTP 200', first.status === 200, JSON.stringify(first.body).slice(0, 150));
  const r1 = first.body.ranking;
  check('平台级被规则剔除（★250k，未调模型）', r1.dropped.platform === 1, JSON.stringify(r1));
  check('合集关键词被规则剔除', r1.dropped.list === 1, JSON.stringify(r1));
  check('这两个都不在结果里', !names(first.body).includes('big/platform') && !names(first.body).includes('cool/awesome-list'));
  check('待判定数量 > 0', r1.pending > 0, String(r1.pending));
  check('待判定的排在已判定之后（此处全为待判定，按 delta 排）', names(first.body)[0] === 'meh/unrelated' || names(first.body)[0] === 'mid/lowrel', JSON.stringify(names(first.body)));
  check('此时是临时结果（不冻结）', first.body.scheduled.provisional === true, String(first.body.scheduled.provisional));

  console.log('\n[2] 数据取「边界那次的采样」（★ 与 delta 同源）');
  const toolA = find(first.body, 'good/tool-a');
  check('★ 用目标采样的 900，而不是抓取时的 1000', toolA?.stars === 900, String(toolA?.stars));
  check('delta = 900 − 500 = +400', toolA?.delta === 400, String(toolA?.delta));
  check('dataAsOf 指向目标采样', first.body.dataAsOf === new Date(dayCut + 12 * 3600000).toISOString(), String(first.body.dataAsOf));

  console.log('\n[3] 等模型判定完成，再取一次');
  for (let i = 0; i < 60 && llmCalls.length < 4; i++) await sleep(100);
  await sleep(800);
  const second = await call('/dsh-hotspot/rank?board=t&period=day');
  const r2 = second.body.ranking;
  check('无关的被剔除', r2.dropped.unrelated === 1, JSON.stringify(r2));
  check('相关性不足的被剔除', r2.dropped.lowRelevance === 1, JSON.stringify(r2));
  check('只剩两个真工具', String(names(second.body)) === 'good/tool-a,good/tool-b', String(names(second.body)));
  check('按综合分排序（tool-a 在前）', names(second.body)[0] === 'good/tool-a');
  check('条目带相关度与判定', find(second.body, 'good/tool-a')?.relevance === 95 && find(second.body, 'good/tool-a')?.verdict === 'tool', JSON.stringify(find(second.body, 'good/tool-a') ?? {}).slice(0, 120));
  check('判定完成后 pending=0', r2.pending === 0, String(r2.pending));
  check('此时不再是临时结果', second.body.scheduled.provisional === false, String(second.body.scheduled.provisional));

  console.log('\n[4] 判定结果缓存，不重复调用模型');
  const before = llmCalls.length;
  await call('/dsh-hotspot/rank?board=t&period=day&refresh=1');
  await sleep(600);
  check('没有新的模型调用', llmCalls.length === before, before + ' → ' + llmCalls.length);
  const cls = await call('/dsh-hotspot/classify');
  check('/classify 返回已判定条目', cls.status === 200 && Object.keys(cls.body.items ?? {}).length >= 4, String(Object.keys(cls.body.items ?? {}).length));
  check('判定条目含 verdict/relevance/reason', (() => {
    const any = Object.values(cls.body.items ?? {})[0];
    return any && typeof any.verdict === 'string' && typeof any.relevance === 'number' && typeof any.reason === 'string';
  })());

  console.log('\n[5] 冻结：判定完成且窗口完整后，结果才锁定');
  const frozenNow = await call('/dsh-hotspot/rank?board=t&period=day');
  check('第二次相同请求命中冻结', frozenNow.body.scheduled.frozen === true, String(frozenNow.body.scheduled.frozen));
  const beforeFetch = fetchCount;
  await call('/dsh-hotspot/rank?board=t&period=day');
  check('冻结期间确实没有再抓 GitHub', fetchCount === beforeFetch, beforeFetch + ' → ' + fetchCount);

  console.log('\n[6] 飙升榜也走同一套筛选');
  const surge = await call('/dsh-hotspot/rank?board=surge&period=day');
  check('飙升榜 HTTP 200', surge.status === 200, String(surge.status));
  // 分类是按「榜」隔离的（相关性相对榜单而言），飙升榜有自己的主题键 →
  // 它在首次请求时是「待判定」状态，必须等这一轮判定完成再看过滤结果。
  check('首次请求时飙升榜还在判定中', surge.body.scheduled.provisional === true, String(surge.body.scheduled.provisional));
  for (let i = 0; i < 80; i++) {
    const c = await call('/dsh-hotspot/classify');
    if (Object.keys(c.body?.items ?? {}).length >= 8) break;
    await sleep(100);
  }
  await sleep(400);
  const surge2 = await call('/dsh-hotspot/rank?board=surge&period=day');
  check('判定完成后无关/低相关被剔除', !names(surge2.body).includes('meh/unrelated') && !names(surge2.body).includes('mid/lowrel'), JSON.stringify(names(surge2.body)));
  check('飙升榜也带相关性分数', (surge2.body.items || []).every((i) => typeof i.relevance === 'number'), JSON.stringify((surge2.body.items || []).map((i) => [i.fullName, i.relevance])));

  console.log('\n[7] 重置判定缓存');
  const reset = await call('/dsh-hotspot/classify/reset', { method: 'POST' });
  check('reset 返回清理条数', reset.status === 200 && reset.body?.ok === true && typeof reset.body.cleared === 'number', JSON.stringify(reset.body).slice(0, 100));
  const afterReset = await call('/dsh-hotspot/classify');
  check('判定缓存已清空', Object.keys(afterReset.body?.items ?? {}).length === 0);

  console.log('\n[8] 关掉分类时只做规则预筛');
  await call('/dsh-hotspot/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ classify: false }) });
  const off = await call('/dsh-hotspot/rank?board=t&period=day&refresh=1');
  check('classify=false 时条目带 unjudged 标记', (off.body.items || []).every((i) => i.verdict === 'unjudged'), JSON.stringify((off.body.items || []).map((i) => i.verdict)));
  check('规则预筛仍然生效（合集/平台级仍被剔除）', !names(off.body).includes('cool/awesome-list') && !names(off.body).includes('big/platform'), JSON.stringify(names(off.body)));
  check('notes 说明判定已关闭', JSON.stringify(off.body.notes).includes('classify=false'), JSON.stringify(off.body.notes));
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
