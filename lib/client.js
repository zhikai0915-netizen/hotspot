/**
 * hotspot —— 浏览器半侧（client half）  v0.2.0
 *
 * ## 契约（与 dsh-pet / 官方插件一致，改动前先读）
 *
 * 本文件由 DSH 当**普通副作用脚本**加载（页面里的 `/plugins/hotspot/client.js`），
 * 所以：
 *   · 顶层**不能有 import / export**（不是 ESM，也不是 CJS 模块）；
 *   · 必须调用 `window.__ModuleLoader__.load({ id, factory })` 自我注册；
 *   · react / react-dom 由 factory 的 `require` 参数取得（平台种子模块），
 *     不要试图 import，也不要把 react 打进产物。
 *
 * factory 返回的 module 上要有插件三件套 `{ name, inject, apply }`，
 * 其中 name 必须与包名、宿主半侧、cordis.patch.yml 的 id 一致。
 *
 * ## 界面放在哪
 *
 * 注册进 `settings.section` 插槽 → 出现在「设置」面板左侧导航里（与「皮肤管理」
 * 「桌宠配置」并列）。
 *
 * ## 时效性（v0.2.0 的改动之一）
 *
 * 挂载期间**每 60 秒自动重新拉一次**（宿主侧还有 5 分钟一轮的后台刷新 + 2 分钟缓存），
 * 所以这里不需要用户手动点「刷新」也能保持接近实时；页脚会显示「数据时间 X 分钟前」。
 * 自动轮询只在组件挂载时存在，卸载即清掉定时器。
 *
 * ## 中文简介（v0.2.0 的改动之二）
 *
 * 简介由宿主半侧用 DSH 的模型异步生成并缓存，接口先返回已有的、缺的排队生成。
 * 所以界面会先显示原始 description（多为英文）+「简介生成中…」，下一轮轮询自动替换成中文简介。
 *
 * ## 降级
 *
 * 任何一步取不到数据都只影响本区域：显示一行错误文案，绝不让整个插件加载失败。
 */
(function () {
  /** 宿主半侧的路由前缀，必须与 lib/index.js 的 ROUTE_PREFIX 一致。 */
  const BASE = '/dsh-hotspot';

  /** 样式表去重标记（与生态里其它插件同一套 data-plugin-css 约定）。 */
  const STYLE_ID = 'hotspot/styles';

  /** 界面自动轮询间隔（毫秒）。 */
  const POLL_MS = 60000;

  /** 周期页签：值与宿主半侧的 PERIOD_MS 对应。 */
  const PERIODS = [
    { id: 'day', label: '日榜' },
    { id: 'week', label: '周榜' },
    { id: 'month', label: '月榜' },
    { id: 'all', label: '总榜' },
  ];

  const CSS = [
    '.hotspot-root{display:flex;flex-direction:column;gap:12px;font:inherit;color:inherit}',
    '.hotspot-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}',
    '.hotspot-title{font-size:15px;font-weight:600}',
    '.hotspot-dim{opacity:.62;font-size:12px;line-height:1.6}',
    '.hotspot-row-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}',
    '.hotspot-chip{font:inherit;font-size:12px;padding:4px 11px;border-radius:999px;cursor:pointer;',
    'border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;transition:background .15s}',
    '.hotspot-chip:hover{background:rgba(128,128,128,.14)}',
    '.hotspot-chip[data-on="1"]{background:rgba(128,128,128,.22);border-color:rgba(128,128,128,.7);font-weight:600}',
    '.hotspot-btn{font:inherit;font-size:12px;padding:4px 12px;border-radius:8px;cursor:pointer;',
    'border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit}',
    '.hotspot-btn:hover{background:rgba(128,128,128,.14)}',
    '.hotspot-btn:disabled{opacity:.5;cursor:default}',
    '.hotspot-list{display:flex;flex-direction:column}',
    '.hotspot-item{display:flex;gap:10px;padding:10px 0;border-bottom:1px solid rgba(128,128,128,.18);align-items:flex-start}',
    '.hotspot-item:last-child{border-bottom:none}',
    '.hotspot-rank{width:24px;flex:none;text-align:right;opacity:.55;font-variant-numeric:tabular-nums}',
    '.hotspot-body{flex:1;min-width:0}',
    '.hotspot-name{font-weight:600;text-decoration:none;color:inherit;border-bottom:1px dotted rgba(128,128,128,.6)}',
    '.hotspot-name:hover{border-bottom-style:solid}',
    '.hotspot-summary{font-size:13px;line-height:1.65;margin-top:4px;overflow-wrap:anywhere}',
    '.hotspot-rawdesc{opacity:.5;font-size:12px;margin-top:3px;overflow-wrap:anywhere}',
    '.hotspot-meta{display:flex;gap:10px;flex-wrap:wrap;font-size:12px;opacity:.6;margin-top:5px}',
    '.hotspot-right{flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:4px;font-size:12px}',
    '.hotspot-stars{font-variant-numeric:tabular-nums;font-weight:600}',
    '.hotspot-delta{color:#2ea043;background:rgba(46,160,67,.13);padding:1px 7px;border-radius:7px;font-weight:600}',
    '.hotspot-rate{opacity:.72;font-variant-numeric:tabular-nums}',
    '.hotspot-tag{font-size:11px;padding:1px 6px;border-radius:6px;background:rgba(128,128,128,.18)}',
    '.hotspot-tag-pending{background:rgba(210,153,34,.18)}',
    '.hotspot-err{color:#d14343;font-size:12px;overflow-wrap:anywhere}',
    '.hotspot-foot{display:flex;gap:12px;flex-wrap:wrap;align-items:center;opacity:.62;font-size:12px}',
    '.hotspot-live{color:#2ea043}',
  ].join('\n');

  /** 注入样式表（只注入一次）。 */
  function ensureCss(doc) {
    if (doc.querySelector('style[data-plugin-css="' + STYLE_ID + '"]') !== null) return;
    const tag = doc.createElement('style');
    tag.dataset.plugin = 'hotspot';
    tag.dataset.pluginCss = STYLE_ID;
    tag.textContent = CSS;
    doc.head.appendChild(tag);
  }

  /** 统一的 JSON 请求：非 2xx 也把宿主返回的 error 文案抛出来。 */
  async function api(path, options) {
    const res = await fetch(BASE + path, options);
    let json;
    try {
      json = await res.json();
    } catch {
      throw new Error('响应不是 JSON（HTTP ' + res.status + '）');
    }
    if (!res.ok) {
      const error = new Error(json && json.error ? json.error : 'HTTP ' + res.status);
      error.payload = json;
      throw error;
    }
    return json;
  }

  /** 相对时间：热榜里「几分钟前」比绝对时间更好读。 */
  function ago(iso) {
    if (typeof iso !== 'string' || iso === '') return '';
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const diff = Date.now() - t;
    const day = 86400000;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.round(diff / 60000) + ' 分钟前';
    if (diff < day) return Math.round(diff / 3600000) + ' 小时前';
    if (diff < 30 * day) return Math.round(diff / day) + ' 天前';
    return Math.round(diff / (30 * day)) + ' 个月前';
  }

  /**
   * 浏览器半侧的 factory：`(require) => module`。
   * 平台种子模块只有 react / react-dom / cordis 等少数几个，取不到就降级。
   */
  function makeFactory() {
    return function (require) {
      const module = { exports: {} };

      const React = require('react');
      const e = React.createElement;
      const { useState, useEffect, useCallback, useRef } = React;

      function HotspotSection() {
        const [boards, setBoards] = useState([]);
        const [boardId, setBoardId] = useState('');
        const [period, setPeriod] = useState('week');
        const [data, setData] = useState(null);
        const [error, setError] = useState('');
        const [loading, setLoading] = useState(true);
        const [busy, setBusy] = useState(false);
        // undefined = 还不知道；false = 确认没配 token（界面据此提示限流风险）
        const [tokenReady, setTokenReady] = useState(undefined);
        // 页脚显示的本地「最后一次拿到数据」时刻，让时效性可见
        const [syncedAt, setSyncedAt] = useState(0);
        const aliveRef = useRef(true);

        // 榜单清单：只在挂载时取一次
        useEffect(() => {
          aliveRef.current = true;
          api('/config')
            .then((cfg) => {
              if (!aliveRef.current) return;
              const list = (cfg && cfg.boards) || [];
              setBoards(list);
              setTokenReady(cfg && cfg.tokenConfigured === true);
              if (list.length > 0) setBoardId((current) => current || list[0].id);
              else setError('宿主没有返回任何榜单，请检查 hotspot 配置');
            })
            .catch((err) => {
              if (aliveRef.current) setError(err.message);
            });
          return () => {
            aliveRef.current = false;
          };
        }, []);

        /** 拉取排名。force=true 时让宿主先刷新再返回。 */
        const load = useCallback(
          (force) => {
            if (boardId === '') return;
            setLoading(true);
            const query = '?board=' + encodeURIComponent(boardId) + '&period=' + encodeURIComponent(period);
            const request = force
              ? api('/refresh?board=' + encodeURIComponent(boardId), { method: 'POST' })
                  .catch(() => undefined) // 刷新失败也让下面的 rank 走一次，拿缓存数据 + 错误提示
                  .then(() => api('/rank' + query))
              : api('/rank' + query);
            request
              .then((res) => {
                if (!aliveRef.current) return;
                setData(res);
                setError('');
                setSyncedAt(Date.now());
              })
              .catch((err) => {
                if (!aliveRef.current) return;
                setData(null);
                setError(err.message);
              })
              .finally(() => {
                if (aliveRef.current) setLoading(false);
              });
          },
          [boardId, period],
        );

        useEffect(() => {
          load(false);
        }, [load]);

        // 自动轮询：挂载期间每 60 秒重拉一次（宿主侧另有 5 分钟后台刷新 + 2 分钟缓存）
        useEffect(() => {
          if (boardId === '') return undefined;
          const timer = setInterval(() => load(false), POLL_MS);
          return () => clearInterval(timer);
        }, [load, boardId]);

        const onRefresh = () => {
          setBusy(true);
          load(true);
          setTimeout(() => setBusy(false), 1500);
        };

        const items = (data && data.items) || [];
        const isSurge = data && data.basis === 'star-velocity';
        const insufficient = data && data.basis === 'insufficient-history';
        const stats = (data && data.summaryStats) || null;

        return e(
          'div',
          { className: 'hotspot-root' },

          // ---------- 标题行 ----------
          e(
            'div',
            { className: 'hotspot-head' },
            e(
              'div',
              null,
              e('div', { className: 'hotspot-title' }, 'GitHub 热榜'),
              e(
                'div',
                { className: 'hotspot-dim' },
                '按日 / 周 / 月追踪模型插件、Skill、MCP 服务等小工具的 GitHub 热度，并为每个项目生成中文简介',
              ),
            ),
            e(
              'button',
              { className: 'hotspot-btn', onClick: onRefresh, disabled: loading || busy },
              loading || busy ? '刷新中…' : '立即刷新',
            ),
          ),

          // ---------- 榜单切换 ----------
          boards.length > 0
            ? e(
                'div',
                { className: 'hotspot-row-chips' },
                boards.map((b) =>
                  e(
                    'button',
                    {
                      key: b.id,
                      className: 'hotspot-chip',
                      'data-on': b.id === boardId ? '1' : '0',
                      title: (b.desc || '') + (b.kind === 'surge' ? '' : '\n查询：' + (b.query || '')),
                      onClick: () => setBoardId(b.id),
                    },
                    b.kind === 'surge' ? '🚀 ' + b.name : b.name,
                  ),
                ),
              )
            : null,

          // ---------- 周期切换 ----------
          e(
            'div',
            { className: 'hotspot-row-chips' },
            PERIODS.map((p) =>
              e(
                'button',
                {
                  key: p.id,
                  className: 'hotspot-chip',
                  'data-on': p.id === period ? '1' : '0',
                  onClick: () => setPeriod(p.id),
                },
                p.label,
              ),
            ),
            data
              ? e(
                  'span',
                  {
                    className: 'hotspot-tag',
                    title:
                      'star-velocity = 跨榜单按窗口涨星；star-delta = 按区间涨星；' +
                      'total-stars = 样本不足时按总星数；insufficient-history = 样本还太少',
                  },
                  data.basis === 'star-velocity'
                    ? '按涨星速度'
                    : data.basis === 'star-delta'
                      ? '按区间涨星'
                      : data.basis === 'insufficient-history'
                        ? '样本积累中'
                        : '按总星数',
                )
              : null,
          ),

          error !== '' ? e('div', { className: 'hotspot-err' }, '读取失败：' + error) : null,

          tokenReady === false
            ? e(
                'div',
                { className: 'hotspot-dim' },
                '未配置 GITHUB_TOKEN：GitHub 未认证搜索限 10 次/分钟，榜单较多时会间歇性刷新失败。' +
                  '设好环境变量 GITHUB_TOKEN 后重启 DSH 即可。',
              )
            : null,

          data && data.notes && data.notes.length > 0
            ? e(
                'div',
                { className: 'hotspot-dim' },
                data.notes.map((n, i) => e('div', { key: i }, n)),
              )
            : null,

          // ---------- 列表 ----------
          items.length > 0
            ? e(
                'div',
                { className: 'hotspot-list' },
                items.map((item) =>
                  e(
                    'div',
                    { className: 'hotspot-item', key: item.fullName },
                    e('div', { className: 'hotspot-rank' }, item.rank),
                    e(
                      'div',
                      { className: 'hotspot-body' },
                      e(
                        'a',
                        { className: 'hotspot-name', href: item.url, target: '_blank', rel: 'noreferrer' },
                        item.fullName,
                      ),
                      // 中文简介优先；还没有就显示原文 + 生成中标记
                      item.summary
                        ? e('div', { className: 'hotspot-summary' }, item.summary)
                        : e(
                            'div',
                            { className: 'hotspot-summary' },
                            item.description !== '' ? item.description : '（这个项目没有填官方简介）',
                            item.summaryPending
                              ? e(
                                  'span',
                                  { className: 'hotspot-tag hotspot-tag-pending', style: { marginLeft: '6px' } },
                                  '简介生成中…',
                                )
                              : null,
                          ),
                      // 已有中文简介时，把官方简介降为次要信息
                      item.summary && item.description !== ''
                        ? e('div', { className: 'hotspot-rawdesc' }, item.description)
                        : null,
                      e(
                        'div',
                        { className: 'hotspot-meta' },
                        item.language !== '' ? e('span', null, item.language) : null,
                        item.pushedAt !== '' ? e('span', null, '更新于 ' + ago(item.pushedAt)) : null,
                        item.archived ? e('span', null, '已归档') : null,
                        item.forks > 0 ? e('span', null, item.forks + ' fork') : null,
                      ),
                    ),
                    e(
                      'div',
                      { className: 'hotspot-right' },
                      e('div', { className: 'hotspot-stars' }, '★ ' + item.stars),
                      item.delta !== null && item.delta !== undefined
                        ? e('div', { className: 'hotspot-delta' }, (item.delta >= 0 ? '+' : '') + item.delta)
                        : null,
                      isSurge && item.perDay !== null && item.perDay !== undefined
                        ? e('div', { className: 'hotspot-rate' }, item.perDay + '/天')
                        : null,
                      item.isNew ? e('div', { className: 'hotspot-tag' }, '新上榜') : null,
                    ),
                  ),
                ),
              )
            : loading
              ? e('div', { className: 'hotspot-dim' }, '正在读取…')
              : error === '' && insufficient
                ? e(
                    'div',
                    { className: 'hotspot-dim' },
                    '飙升榜还没有数据：它靠「不同时刻的两次采样」算速度，插件刚装或刚重启时样本还不够，跑一会儿就有了。',
                  )
                : error === ''
                  ? e('div', { className: 'hotspot-dim' }, '这个榜单还没有数据，点「立即刷新」试试。')
                  : null,

          // ---------- 页脚：时效性 + 简介进度 ----------
          data
            ? e(
                'div',
                { className: 'hotspot-foot' },
                e('span', null, '数据时间：' + ago(data.fetchedAt) + '（' + new Date(data.fetchedAt).toLocaleTimeString() + '）'),
                e('span', null, '样本：' + data.sampleCount + ' 个'),
                data.windowStart ? e('span', null, '基线：' + ago(data.windowStart)) : null,
                syncedAt > 0 ? e('span', { className: 'hotspot-live' }, '● 每 60 秒自动刷新') : null,
                stats
                  ? e(
                      'span',
                      null,
                      '中文简介：' +
                        stats.cached +
                        ' 条' +
                        (stats.disabled
                          ? '（已关闭）'
                          : stats.queued > 0 || stats.generating
                            ? '，正在生成 ' + (stats.queued + (stats.generating ? 1 : 0)) + ' 条'
                            : ''),
                    )
                  : null,
                data.stale ? e('span', null, '（本次刷新失败，显示缓存）') : null,
              )
            : null,
        );
      }

      const name = 'hotspot';
      // slots 是注册界面所必需的服务；声明成依赖，服务就绪后才会 apply
      const inject = ['slots'];

      function apply(ctx) {
        try {
          ensureCss(document);
        } catch (err) {
          console.warn('[hotspot] 样式注入失败（界面仍可用，只是没样式）：' + (err instanceof Error ? err.message : String(err)));
        }

        ctx.slots.inject('settings.section', function* () {
          yield ctx.slots.register(
            {
              name: 'settings.section',
              id: 'hotspot',
              order: 45,
              label: () => 'GitHub 热榜',
            },
            HotspotSection,
          );
        });
      }

      module.exports = { apply, inject, name };
      return module.exports;
    };
  }

  window.__ModuleLoader__.load({ id: 'hotspot', factory: makeFactory() });
})();
