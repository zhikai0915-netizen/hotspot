/**
 * hotspot 冒烟测试 —— 在不启动 DSH 的前提下，真实地把宿主半侧跑一遍。
 *
 * 做法：伪造一个最小 ctx（logger / effect / webServer.register），把插件注册的
 * 路由处理器接到一个真实的 http 服务上，然后用 fetch 打自己。这样能验证：
 *   · 插件模块能加载、apply 不抛错；
 *   · webServer.register 的参数形状与处理器签名正确；
 *   · 配置读写、快照落盘、排名计算、错误分流（限流 → 429）都真的工作；
 *   · ctx.effect 返回的 disposer 能干净卸载（定时器不泄漏）。
 *
 * 用临时目录当 DSH_HOME，**不污染真实数据目录**。
 *
 * 跑法：node test/smoke.mjs
 * 说明：其中一次请求会真的访问 GitHub 搜索 API（未认证限 10 次/分钟）。
 */
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const home = mkdtempSync(join(tmpdir(), 'hotspot-test-'));
process.env.DSH_HOME = home;

const failures = [];
let checks = 0;

/** 极简断言：记录失败但不中断，最后统一汇总。 */
function check(label, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log('  ✓ ' + label);
  } else {
    failures.push(label + (detail ? ' — ' + detail : ''));
    console.log('  ✗ ' + label + (detail ? ' — ' + detail : ''));
  }
}

/** 收集插件注册的路由处理器与 effect 清理器。 */
const disposers = [];
let route;

const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  effect(fn, label) {
    const dispose = fn();
    if (typeof dispose === 'function') disposers.push({ dispose, label });
    return dispose;
  },
  webServer: {
    register(options) {
      route = options;
      return () => {
        route = undefined;
      };
    },
  },
};

const mod = await import('../lib/index.js');
const server = createServer((req, res) => {
  if (route === undefined) {
    res.writeHead(503).end('no route');
    return;
  }
  Promise.resolve(route.handler(req, res)).catch((error) => {
    res.writeHead(500).end(String(error));
  });
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

try {
  console.log('\n[1] 模块与注册契约');
  check('导出 name === "hotspot"', mod.name === 'hotspot', String(mod.name));
  check('inject 含 webServer', Array.isArray(mod.inject) && mod.inject.includes('webServer'));
  check('apply 是函数', typeof mod.apply === 'function');
  mod.apply(ctx);
  check('注册了前缀路由', route !== undefined && route.kind === 'prefix');
  check('路由前缀是 /dsh-hotspot', route !== undefined && route.path === '/dsh-hotspot', route && route.path);
  check('handler 是函数（req,res 签名）', typeof route?.handler === 'function');

  console.log('\n[2] GET /status（不访问 GitHub）');
  const status = await call('/dsh-hotspot/status');
  check('HTTP 200', status.status === 200, String(status.status));
  check('返回 7 个默认榜单', status.body?.boards?.length === 7, String(status.body?.boards?.length));
  check('未配置 token 时 tokenConfigured=false', status.body?.tokenConfigured === false);
  check('store 目录落在临时 DSH_HOME 下', String(status.body?.store).startsWith(home), String(status.body?.store));

  console.log('\n[3] GET /rank（真实访问 GitHub 搜索 API）');
  const rank = await call('/dsh-hotspot/rank?board=dsh-plugin&period=week&refresh=1');
  if (rank.status === 429) {
    console.log('  ! GitHub 限流（429），跳过数据断言（这本身也证明限流分流正确）');
    check('限流时返回结构化错误', typeof rank.body?.error === 'string' && rank.body?.kind === 'rate-limited');
  } else {
    check('HTTP 200', rank.status === 200, JSON.stringify(rank.body).slice(0, 200));
    check('拿到条目', (rank.body?.items?.length ?? 0) > 0, String(rank.body?.items?.length));
    const first = rank.body?.items?.[0];
    check('首条含 rank/fullName/stars/url', first && first.rank === 1 && typeof first.fullName === 'string' && typeof first.stars === 'number' && typeof first.url === 'string');
    check('首次运行 basis=total-stars（诚实降级）', rank.body?.basis === 'total-stars', String(rank.body?.basis));
    check('notes 明说历史不足', Array.isArray(rank.body?.notes) && rank.body.notes.length > 0);
    console.log('    榜首：' + first?.fullName + '（★' + first?.stars + '）');
  }

  console.log('\n[4] 快照落盘');
  const snapDir = join(home, 'hotspot', 'snapshots');
  const files = existsSync(snapDir) ? readdirSync(snapDir) : [];
  check('写了当日快照文件', files.length === 1 && files[0].endsWith('.json'), files.join(','));

  console.log('\n[5] 第二次 rank 走缓存');
  const cached = await call('/dsh-hotspot/rank?board=dsh-plugin&period=day');
  check('HTTP 200', cached.status === 200, String(cached.status));
  check('period 被接受', cached.body?.period === 'day', String(cached.body?.period));

  console.log('\n[6] 非法周期回落');
  const bogus = await call('/dsh-hotspot/rank?board=dsh-plugin&period=nonsense');
  check('非法 period 回落到 week', bogus.body?.period === 'week', String(bogus.body?.period));

  console.log('\n[7] 未知榜单回落第一个');
  const unknown = await call('/dsh-hotspot/rank?board=__nope__&period=week');
  check('回落成功且不报错', unknown.status === 200 && unknown.body?.board?.id === 'dsh-plugin', String(unknown.body?.board?.id));

  console.log('\n[8] GET /config 与 PUT /config');
  const cfg = await call('/dsh-hotspot/config');
  check('HTTP 200', cfg.status === 200, String(cfg.status));
  check('返回 config 对象', cfg.body?.config !== undefined && Array.isArray(cfg.body.config.boards));
  const put = await call('/dsh-hotspot/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ perPage: 12 }),
  });
  check('PUT 保存成功', put.status === 200 && put.body?.config?.perPage === 12, String(put.body?.config?.perPage));
  const reread = await call('/dsh-hotspot/config');
  check('改动已持久化', reread.body?.config?.perPage === 12, String(reread.body?.config?.perPage));
  const bad = await call('/dsh-hotspot/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{oops' });
  check('坏 JSON 返回 400', bad.status === 400, String(bad.status));

  console.log('\n[9] 未知路径');
  const notFound = await call('/dsh-hotspot/nope');
  check('返回 404', notFound.status === 404, String(notFound.status));

  console.log('\n[10] 卸载清理');
  let disposeOk = true;
  for (const item of disposers) {
    try {
      item.dispose();
    } catch (error) {
      disposeOk = false;
      console.log('    disposer 抛错（' + item.label + '）：' + error.message);
    }
  }
  check('全部 disposer 可安全调用', disposeOk);
  check('注册的 effect 数量合理（路由 + 刷新定时器）', disposers.length === 2, String(disposers.length));
} catch (error) {
  failures.push('未捕获异常：' + (error?.stack ?? error));
  console.log('\n未捕获异常：' + (error?.stack ?? error));
} finally {
  server.close();
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* 临时目录删不掉不影响结论 */
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
