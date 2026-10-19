/**
 * hotspot —— 浏览器半侧（client half）  v0.3.0
 *
 * ## 契约（与 dsh-pet / 官方插件一致，改动前先读）
 *
 * 本文件由 DSH 当**普通副作用脚本**加载（页面里的 `/plugins/hotspot/client.js`），所以：
 *   · 顶层**不能有 import / export**（不是 ESM，也不是 CJS 模块）；
 *   · 必须调用 `window.__ModuleLoader__.load({ id, factory })` 自我注册；
 *   · react / react-dom 由 factory 的 `require` 参数取得（平台种子模块）。
 * factory 返回的 module 上要有 `{ name, inject, apply }`，name 必须与包名一致。
 *
 * ## 挂在两个地方（v0.3.0 的改动）
 *
 *   1. `shell.overlay` —— **独立可拖拽浮层**（主界面）：拖动标题栏移动、右下角拖拽改尺寸、
 *      可折叠成小药丸、可隐藏；位置/尺寸/模式存 localStorage，刷新后保持。
 *      和 dsh-pet 的宠物同一层，所以是页面级悬浮，不占用对话区。
 *   2. `settings.section` —— 设置页里的完整视图 + 浮层开关。
 * 两个位置共用同一个 `HotspotBoard` 组件，避免两套渲染逻辑各写一遍。
 *
 * ## 拖拽实现要点
 *
 *   · 用 Pointer Events（鼠标/触摸/笔统一），标题栏 `touch-action:none` 否则手机拖不动；
 *   · 位移超过 4px 才算拖拽，否则算点击（药丸点一下展开、标题栏点一下不误触）；
 *   · 位置与尺寸一律经 `clampRect` 限制在视口内，且保证至少 MIN_VISIBLE 像素留在屏内
 *     （窗口缩小、多显示器分辨率变化后不会飘到屏幕外找不回来）；
 *   · 窗口 resize 时重新夹取一次。
 *
 * ## 可测性
 *
 * 纯逻辑（状态解析、夹取、默认位置、模式切换）都做成模块级函数，并挂在
 * `module.exports.__internals` 上供 test/client.mjs 直接断言——拖拽数学不该只能靠肉眼验。
 */
(function () {
  /** 宿主半侧的路由前缀，必须与 lib/index.js 的 ROUTE_PREFIX 一致。 */
  const BASE = '/dsh-hotspot';

  /** 样式表去重标记。 */
  const STYLE_ID = 'hotspot/styles';

  /** 界面自动轮询间隔（毫秒）。 */
  const POLL_MS = 60000;

  /** 浮层状态在 localStorage 里的键。 */
  const PANEL_KEY = 'hotspot-panel';

  /** 浮层默认尺寸与限制。 */
  const DEFAULT_PANEL = { x: null, y: null, w: 420, h: 560, mode: 'panel' };
  const MIN_W = 300;
  const MIN_H = 220;
  const MIN_VISIBLE = 80; // 至少这么多像素必须留在视口内，否则就找不回来了
  const DRAG_THRESHOLD = 4; // 位移小于它算点击，不算拖拽

  /** 周期页签：值与宿主半侧的 PERIOD_MS 对应。 */
  const PERIODS = [
    { id: 'day', label: '日榜' },
    { id: 'week', label: '周榜' },
    { id: 'month', label: '月榜' },
    { id: 'all', label: '总榜' },
  ];

  // ------------------------------------------------------------ 纯逻辑（可测）

  /** 解析持久化的浮层状态；坏数据一律回落默认值。 */
  function parsePanelState(raw) {
    let obj = raw;
    if (typeof raw === 'string') {
      try {
        obj = JSON.parse(raw);
      } catch {
        obj = null;
      }
    }
    if (obj === null || typeof obj !== 'object') return { ...DEFAULT_PANEL };
    const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
    const mode = obj.mode === 'pill' || obj.mode === 'hidden' ? obj.mode : 'panel';
    return {
      x: obj.x === null || obj.x === undefined ? null : num(obj.x, null),
      y: obj.y === null || obj.y === undefined ? null : num(obj.y, null),
      w: Math.max(MIN_W, num(obj.w, DEFAULT_PANEL.w)),
      h: Math.max(MIN_H, num(obj.h, DEFAULT_PANEL.h)),
      mode,
    };
  }

  /**
   * 把矩形夹进视口。
   * 不只是「左上角不越界」：还要保证至少 MIN_VISIBLE 像素可见，
   * 否则把浮层拖到屏幕外或用高分辨率显示器拔掉后，用户就再也抓不到它了。
   */
  function clampRect(rect, viewport) {
    const vw = Math.max(200, Number(viewport?.w) || 0);
    const vh = Math.max(200, Number(viewport?.h) || 0);
    const w = Math.min(Math.max(MIN_W, Number(rect.w) || DEFAULT_PANEL.w), vw);
    const h = Math.min(Math.max(MIN_H, Number(rect.h) || DEFAULT_PANEL.h), vh);
    const minX = -(w - MIN_VISIBLE);
    const maxX = vw - MIN_VISIBLE;
    const minY = 0;
    const maxY = vh - MIN_VISIBLE;
    const x = Math.min(Math.max(minX, Number(rect.x) || 0), maxX);
    const y = Math.min(Math.max(minY, Number(rect.y) || 0), maxY);
    return { x, y, w, h };
  }

  /** 默认位置：右下角，留 20px 边距。 */
  function defaultRect(viewport, size) {
    const vw = Math.max(200, Number(viewport?.w) || 0);
    const vh = Math.max(200, Number(viewport?.h) || 0);
    const w = Math.min(Math.max(MIN_W, Number(size?.w) || DEFAULT_PANEL.w), vw);
    const h = Math.min(Math.max(MIN_H, Number(size?.h) || DEFAULT_PANEL.h), vh);
    return { x: Math.max(0, vw - w - 20), y: Math.max(0, vh - h - 20), w, h };
  }

  /** 指定矩形（x/y 为 null 时用默认右下角），并夹进视口。 */
  function resolveRect(state, viewport) {
    if (state.x === null || state.y === null) {
      const base = defaultRect(viewport, state);
      return clampRect(base, viewport);
    }
    return clampRect(state, viewport);
  }

  /** 模式切换：药丸 ↔ 面板（hidden 不参与循环，只由显式按钮进入）。 */
  function nextMode(mode) {
    return mode === 'pill' ? 'panel' : 'pill';
  }

  // ------------------------------------------------------------ 样式

  const CSS = [
    '.hotspot-root{display:flex;flex-direction:column;gap:12px;font:inherit;color:inherit}',
    '.hotspot-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}',
    '.hotspot-title{font-size:15px;font-weight:600}',
    '.hotspot-dim{opacity:.62;font-size:12px;line-height:1.6}',
    '.hotspot-row-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}',
    '.hotspot-tabs{display:inline-flex;flex-wrap:wrap;gap:6px;align-items:center}',
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

    // ---------- 独立可拖拽浮层 ----------
    // 用 CSS 系统颜色（Canvas/CanvasText）自动跟随明暗主题；color-mix 不支持时回落到纯 Canvas。
    '.hotspot-panel{position:fixed;z-index:900;display:flex;flex-direction:column;box-sizing:border-box;',
    'background:Canvas;border:1px solid rgba(128,128,128,.38);border-radius:14px;color:CanvasText;',
    'box-shadow:0 12px 40px rgba(0,0,0,.32);overflow:hidden;font:inherit}',
    '.hotspot-panel{background:color-mix(in srgb, Canvas 94%, transparent);backdrop-filter:blur(12px)}',
    '.hotspot-panel-head{display:flex;align-items:center;gap:8px;padding:9px 11px;flex:none;',
    'border-bottom:1px solid rgba(128,128,128,.22);cursor:grab;user-select:none;touch-action:none;',
    'background:rgba(128,128,128,.09)}',
    '.hotspot-panel-head[data-dragging="1"]{cursor:grabbing}',
    '.hotspot-panel-grip{opacity:.5;font-size:13px;letter-spacing:1px}',
    '.hotspot-panel-title{font-size:13px;font-weight:600;flex:1;min-width:0;overflow:hidden;',
    'text-overflow:ellipsis;white-space:nowrap}',
    '.hotspot-icon-btn{font:inherit;font-size:13px;line-height:1;padding:3px 7px;border-radius:7px;cursor:pointer;',
    'border:1px solid transparent;background:transparent;color:inherit;opacity:.75}',
    '.hotspot-icon-btn:hover{background:rgba(128,128,128,.2);opacity:1}',
    '.hotspot-panel-body{flex:1;overflow:auto;padding:11px;min-height:0}',
    '.hotspot-panel-resize{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;',
    'touch-action:none;background:linear-gradient(135deg,transparent 50%,rgba(128,128,128,.55) 50%)}',
    '.hotspot-pill{position:fixed;z-index:900;display:flex;align-items:center;gap:7px;padding:7px 13px;',
    'border-radius:999px;cursor:pointer;background:Canvas;color:CanvasText;font:inherit;font-size:12px;',
    'border:1px solid rgba(128,128,128,.38);box-shadow:0 6px 18px rgba(0,0,0,.26);',
    'user-select:none;touch-action:none}',
    '.hotspot-pill{background:color-mix(in srgb, Canvas 92%, transparent);backdrop-filter:blur(10px)}',
    '.hotspot-pill-count{opacity:.65;font-variant-numeric:tabular-nums}',
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

  // ------------------------------------------------------------ 数据访问

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

  /** 把「还有多久」说成人话。 */
  function humanDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '即将';
    const min = Math.round(ms / 60000);
    if (min < 60) return min + ' 分钟';
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (h < 48) return h + ' 小时' + (m > 0 ? ' ' + m + ' 分' : '');
    return Math.round(h / 24) + ' 天';
  }

  /** 相对时间。 */
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

  // ------------------------------------------------------------ factory

  function makeFactory() {
    return function (require) {
      const module = { exports: {} };

      const React = require('react');
      const e = React.createElement;
      const { useState, useEffect, useCallback, useRef } = React;

      // -------------------------------------------------------- 数据 hook

      /** 榜单数据（浮层与设置页各自挂一份；宿主侧有缓存，不会因此多打 GitHub）。 */
      function useHotspotData() {
        const [boards, setBoards] = useState([]);
        const [boardId, setBoardId] = useState('');
        const [period, setPeriod] = useState('week');
        const [data, setData] = useState(null);
        const [error, setError] = useState('');
        const [loading, setLoading] = useState(true);
        const [busy, setBusy] = useState(false);
        const [tokenReady, setTokenReady] = useState(undefined);
        const [syncedAt, setSyncedAt] = useState(0);
        const alive = useRef(true);

        useEffect(() => {
          alive.current = true;
          api('/config')
            .then((cfg) => {
              if (!alive.current) return;
              const list = (cfg && cfg.boards) || [];
              setBoards(list);
              setTokenReady(cfg && cfg.tokenConfigured === true);
              if (list.length > 0) setBoardId((cur) => cur || list[0].id);
              else setError('宿主没有返回任何榜单，请检查 hotspot 配置');
            })
            .catch((err) => {
              if (alive.current) setError(err.message);
            });
          return () => {
            alive.current = false;
          };
        }, []);

        const load = useCallback(
          (force) => {
            if (boardId === '') return;
            setLoading(true);
            const query = '?board=' + encodeURIComponent(boardId) + '&period=' + encodeURIComponent(period);
            const request = force
              ? api('/refresh?board=' + encodeURIComponent(boardId), { method: 'POST' })
                  .catch(() => undefined)
                  .then(() => api('/rank' + query))
              : api('/rank' + query);
            request
              .then((res) => {
                if (!alive.current) return;
                setData(res);
                setError('');
                setSyncedAt(Date.now());
              })
              .catch((err) => {
                if (!alive.current) return;
                setData(null);
                setError(err.message);
              })
              .finally(() => {
                if (alive.current) setLoading(false);
              });
          },
          [boardId, period],
        );

        useEffect(() => {
          load(false);
        }, [load]);

        useEffect(() => {
          if (boardId === '') return undefined;
          const timer = setInterval(() => load(false), POLL_MS);
          return () => clearInterval(timer);
        }, [load, boardId]);

        const refresh = () => {
          setBusy(true);
          load(true);
          setTimeout(() => setBusy(false), 1500);
        };

        return { boards, boardId, setBoardId, period, setPeriod, data, error, loading, busy, tokenReady, syncedAt, refresh };
      }

      // -------------------------------------------------------- 榜单主体（两处共用）

      function HotspotBoard(props) {
        const d = props.data;
        const items = (d && d.items) || [];
        const isSurge = d && d.basis === 'star-velocity';
        const insufficient = d && d.basis === 'insufficient-history';
        const stats = (d && d.summaryStats) || null;
        const compact = props.compact === true;

        // 标题与说明由各自的宿主提供（设置页有自己的标题区、浮层有标题栏），
        // 这里只渲染榜单本体，避免两处重复同一段文案。
        return e(
          'div',
          { className: 'hotspot-root' },

          props.boards.length > 0
            ? e(
                'div',
                { className: 'hotspot-row-chips' },
                props.boards.map((b) =>
                  e(
                    'button',
                    {
                      key: b.id,
                      className: 'hotspot-chip',
                      'data-on': b.id === props.boardId ? '1' : '0',
                      title: (b.desc || '') + (b.kind === 'surge' ? '' : '\n查询：' + (b.query || '')),
                      onClick: () => props.setBoardId(b.id),
                    },
                    b.kind === 'surge' ? '🚀 ' + b.name : b.name,
                  ),
                ),
              )
            : null,

          e(
            'div',
            { className: 'hotspot-row-chips' },
            // 飙升榜固定按自己的日程（每周一），页签对它没有意义 → 置灰且不可点
            e(
              'span',
              {
                className: 'hotspot-tabs',
                style: d && d.scheduled && d.scheduled.ignoresPeriodTabs ? { opacity: 0.4, pointerEvents: 'none' } : undefined,
                title: d && d.scheduled && d.scheduled.ignoresPeriodTabs ? '飙升榜固定按周统计，与页签无关' : '切换统计区间',
              },
              PERIODS.map((p) =>
                e(
                  'button',
                  {
                    key: p.id,
                    className: 'hotspot-chip',
                    'data-on': p.id === props.period ? '1' : '0',
                    onClick: () => props.setPeriod(p.id),
                  },
                  p.label,
                ),
              ),
            ),
            d
              ? e(
                  'span',
                  {
                    className: 'hotspot-tag',
                    title:
                      'star-velocity = 跨榜单按窗口涨星；star-delta = 按区间涨星；' +
                      'total-stars = 样本不足时按总星数；insufficient-history = 样本还太少',
                  },
                  d.basis === 'star-velocity'
                    ? '按涨星速度'
                    : d.basis === 'star-delta'
                      ? '按区间涨星'
                      : d.basis === 'insufficient-history'
                        ? '样本积累中'
                        : '按总星数',
                )
              : null,
            e(
              'button',
              { className: 'hotspot-btn', onClick: props.onRefresh, disabled: props.loading || props.busy },
              props.loading || props.busy ? '刷新中…' : '刷新',
            ),
          ),

          d && d.scheduled && d.scheduled.ignoresPeriodTabs
            ? e('div', { className: 'hotspot-dim' }, '飙升榜固定按周统计（每周一 0 点更新），上面的日/周/月页签对它不起作用。')
            : null,

          props.error !== '' ? e('div', { className: 'hotspot-err' }, '读取失败：' + props.error) : null,

          props.tokenReady === false
            ? e(
                'div',
                { className: 'hotspot-dim' },
                '未配置 GITHUB_TOKEN：未认证搜索限 10 次/分钟（当前节奏约用 15%，通常够用）',
              )
            : null,

          d && d.notes && d.notes.length > 0
            ? e(
                'div',
                { className: 'hotspot-dim' },
                d.notes.map((n, i) => e('div', { key: i }, n)),
              )
            : null,

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
                      item.summary && item.description !== ''
                        ? e('div', { className: 'hotspot-rawdesc' }, item.description)
                        : null,
                      e(
                        'div',
                        { className: 'hotspot-meta' },
                        item.language !== '' ? e('span', null, item.language) : null,
                        typeof item.relevance === 'number'
                          ? e('span', { title: item.verdictReason || '模型判定的相关性' }, '相关 ' + item.relevance)
                          : item.verdict === 'pending'
                            ? e('span', { className: 'hotspot-tag hotspot-tag-pending' }, '判定中')
                            : null,
                        item.pushedAt !== '' ? e('span', null, '更新于 ' + ago(item.pushedAt)) : null,
                        item.archived ? e('span', null, '已归档') : null,
                        compact ? null : item.forks > 0 ? e('span', null, item.forks + ' fork') : null,
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
            : props.loading
              ? e('div', { className: 'hotspot-dim' }, '正在读取…')
              : props.error === '' && insufficient
                ? e(
                    'div',
                    { className: 'hotspot-dim' },
                    '飙升榜还没有数据：它靠「不同时刻的两次采样」算速度，插件刚装或刚重启时样本还不够，跑一会儿就有了。',
                  )
                : props.error === ''
                  ? e('div', { className: 'hotspot-dim' }, '这个榜单还没有数据，点刷新试试。')
                  : null,

          d
            ? e(
                'div',
                { className: 'hotspot-foot' },
                e('span', null, '数据 ' + ago(d.fetchedAt)),
                e('span', null, '样本 ' + d.sampleCount),
                d.windowStart ? e('span', null, '基线 ' + ago(d.windowStart)) : null,
                d.scheduled ? e('span', { className: 'hotspot-tag' }, '更新：' + d.scheduled.rule) : null,
                d.scheduled
                  ? e(
                      'span',
                      null,
                      '下次更新：' + humanDuration(d.scheduled.nextInMs) + (d.scheduled.frozen ? '（当前为冻结结果）' : ''),
                    )
                  : null,
                props.syncedAt > 0 ? e('span', { className: 'hotspot-live' }, '● 60 秒同步显示') : null,
                d.ranking
                  ? e(
                      'span',
                      null,
                      '筛选 剔除 ' +
                        (d.ranking.dropped.list + d.ranking.dropped.platform + d.ranking.dropped.unrelated + d.ranking.dropped.lowRelevance) +
                        ' 个' +
                        (d.ranking.pending > 0 ? '，判定中 ' + d.ranking.pending : ''),
                    )
                  : null,
                d.dataAsOf ? e('span', { title: '排名用的数据观测时刻' }, '数据截至 ' + ago(d.dataAsOf)) : null,
                stats
                  ? e(
                      'span',
                      null,
                      '简介 ' +
                        stats.cached +
                        ' 条' +
                        (stats.disabled
                          ? '（已关）'
                          : stats.queued > 0 || stats.generating
                            ? '，生成中 ' + (stats.queued + (stats.generating ? 1 : 0))
                            : ''),
                    )
                  : null,
                d.stale ? e('span', null, '（本次刷新失败，显示缓存）') : null,
              )
            : null,
        );
      }

      // -------------------------------------------------------- 独立可拖拽浮层

      function HotspotPanel() {
        const hd = useHotspotData();
        const [state, setState] = useState(() => {
          try {
            return parsePanelState(window.localStorage.getItem(PANEL_KEY));
          } catch {
            return { ...DEFAULT_PANEL };
          }
        });
        const [rect, setRect] = useState(() => resolveRect(state, { w: window.innerWidth, h: window.innerHeight }));
        const [dragging, setDragging] = useState(false);
        const dragRef = useRef(null);

        /** 持久化状态（位置/尺寸/模式）。 */
        const persist = useCallback((next) => {
          try {
            window.localStorage.setItem(PANEL_KEY, JSON.stringify(next));
          } catch {
            /* 隐私模式下写不了，忽略即可 */
          }
        }, []);

        const applyState = useCallback(
          (patch) => {
            setState((prev) => {
              const next = { ...prev, ...patch };
              persist(next);
              return next;
            });
          },
          [persist],
        );

        // 视口变化时重新夹取，避免浮层跑到屏幕外
        useEffect(() => {
          const onResize = () => setRect((r) => clampRect(r, { w: window.innerWidth, h: window.innerHeight }));
          window.addEventListener('resize', onResize);
          return () => window.removeEventListener('resize', onResize);
        }, []);

        /** 通用拖拽：pointerdown 之后挂 window 监听，避免鼠标移出元素就断。 */
        const startDrag = useCallback(
          (event, kind) => {
            if (event.button !== undefined && event.button !== 0) return;
            const startX = event.clientX;
            const startY = event.clientY;
            const origin = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
            let moved = false;
            dragRef.current = { kind, startX, startY, origin };

            const onMove = (ev) => {
              const dx = ev.clientX - startX;
              const dy = ev.clientY - startY;
              if (!moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
              if (!moved) {
                moved = true;
                setDragging(true);
              }
              const viewport = { w: window.innerWidth, h: window.innerHeight };
              if (kind === 'move') {
                setRect(clampRect({ ...origin, x: origin.x + dx, y: origin.y + dy }, viewport));
              } else {
                setRect(clampRect({ ...origin, w: origin.w + dx, h: origin.h + dy }, viewport));
              }
            };
            const onUp = () => {
              window.removeEventListener('pointermove', onMove);
              window.removeEventListener('pointerup', onUp);
              dragRef.current = null;
              setDragging(false);
              setRect((r) => {
                if (kind === 'move') applyState({ x: r.x, y: r.y });
                else applyState({ w: r.w, h: r.h });
                return r;
              });
              // 没移动 = 点击
              if (!moved && kind === 'move') applyState({ mode: nextMode(state.mode) });
            };
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
          },
          [rect.x, rect.y, rect.w, rect.h, state.mode, applyState],
        );

        // 药丸模式：只显示一个小胶囊，点一下展开、也能拖
        if (state.mode === 'pill') {
          const pill = clampRect({ x: rect.x, y: rect.y, w: 120, h: 34 }, { w: window.innerWidth, h: window.innerHeight });
          return e(
            'div',
            {
              className: 'hotspot-pill',
              style: { left: pill.x + 'px', top: pill.y + 'px' },
              title: '点击展开 GitHub 热榜；拖动可移动',
              onPointerDown: (ev) => startDrag(ev, 'move'),
            },
            e('span', null, '🚀 热榜'),
            hd.data
              ? e('span', { className: 'hotspot-pill-count' }, ((hd.data.board && hd.data.board.name) || '') + ' · ' + (hd.data.items || []).length)
              : null,
          );
        }

        if (state.mode === 'hidden') return null;

        return e(
          'div',
          { className: 'hotspot-panel', style: { left: rect.x + 'px', top: rect.y + 'px', width: rect.w + 'px', height: rect.h + 'px' } },
          e(
            'div',
            {
              className: 'hotspot-panel-head',
              'data-dragging': dragging ? '1' : '0',
              onPointerDown: (ev) => startDrag(ev, 'move'),
              title: '拖动移动；点一下折叠成药丸',
            },
            e('span', { className: 'hotspot-panel-grip' }, '⠿'),
            e('span', { className: 'hotspot-panel-title' }, (hd.data && hd.data.board && hd.data.board.name) || 'GitHub 热榜'),
            e(
              'button',
              {
                className: 'hotspot-icon-btn',
                title: '折叠成药丸',
                onPointerDown: (ev) => ev.stopPropagation(),
                onClick: () => applyState({ mode: 'pill' }),
              },
              '—',
            ),
            e(
              'button',
              {
                className: 'hotspot-icon-btn',
                title: '隐藏（在 设置 → GitHub 热榜 里可重新打开）',
                onPointerDown: (ev) => ev.stopPropagation(),
                onClick: () => applyState({ mode: 'hidden' }),
              },
              '✕',
            ),
          ),
          e(
            'div',
            { className: 'hotspot-panel-body' },
            e(HotspotBoard, {
              boards: hd.boards,
              boardId: hd.boardId,
              setBoardId: hd.setBoardId,
              period: hd.period,
              setPeriod: hd.setPeriod,
              data: hd.data,
              error: hd.error,
              loading: hd.loading,
              busy: hd.busy,
              tokenReady: hd.tokenReady,
              syncedAt: hd.syncedAt,
              onRefresh: hd.refresh,
              compact: true,
            }),
          ),
          e('div', {
            className: 'hotspot-panel-resize',
            title: '拖动调整大小',
            onPointerDown: (ev) => startDrag(ev, 'resize'),
          }),
        );
      }

      // -------------------------------------------------------- 设置页（含浮层开关）

      function HotspotSection() {
        const hd = useHotspotData();
        const [mode, setMode] = useState(() => {
          try {
            return parsePanelState(window.localStorage.getItem(PANEL_KEY)).mode;
          } catch {
            return DEFAULT_PANEL.mode;
          }
        });

        /** 读当前持久化状态并改 mode，保持位置/尺寸不变。 */
        const setPanelMode = (next) => {
          try {
            const cur = parsePanelState(window.localStorage.getItem(PANEL_KEY));
            window.localStorage.setItem(PANEL_KEY, JSON.stringify({ ...cur, mode: next }));
            setMode(next);
          } catch {
            /* 写不了就只提示 */
          }
        };

        return e(
          'div',
          { className: 'hotspot-root' },
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
                '按日 / 周 / 月追踪模型插件、Skill、MCP 服务等小工具的 GitHub 热度，并为每个项目生成中文简介。',
              ),
              e(
                'div',
                { className: 'hotspot-dim' },
                '榜单以**独立可拖拽浮层**显示在页面上；这里可以开关它，或临时改成完整视图查看。',
              ),
            ),
            e(
              'div',
              { className: 'hotspot-row-chips' },
              e(
                'button',
                { className: 'hotspot-btn', onClick: () => setPanelMode('panel') },
                mode === 'panel' ? '✓ 浮层已显示' : '显示浮层',
              ),
              e('button', { className: 'hotspot-btn', onClick: () => setPanelMode('pill') }, mode === 'pill' ? '✓ 已折叠' : '折叠成药丸'),
              e('button', { className: 'hotspot-btn', onClick: () => setPanelMode('hidden') }, mode === 'hidden' ? '✓ 已隐藏' : '隐藏浮层'),
            ),
          ),
          e(
            'div',
            { className: 'hotspot-dim' },
            '想调整浮层内容就拖它的标题栏移动、拖右下角改大小；位置与尺寸会自动记住。' +
              (mode === 'hidden' ? '（当前已隐藏：点「显示浮层」即可恢复到上次的位置）' : ''),
          ),
          e(HotspotBoard, {
            boards: hd.boards,
            boardId: hd.boardId,
            setBoardId: hd.setBoardId,
            period: hd.period,
            setPeriod: hd.setPeriod,
            data: hd.data,
            error: hd.error,
            loading: hd.loading,
            busy: hd.busy,
            tokenReady: hd.tokenReady,
            syncedAt: hd.syncedAt,
            onRefresh: hd.refresh,
          }),
        );
      }

      // -------------------------------------------------------- 注册

      const name = 'hotspot';
      const inject = ['slots'];

      function apply(ctx) {
        try {
          ensureCss(document);
        } catch (err) {
          console.warn('[hotspot] 样式注入失败（界面仍可用，只是没样式）：' + (err instanceof Error ? err.message : String(err)));
        }

        // 独立可拖拽浮层（页面级，与桌宠同层；order 比桌宠小，浮在它下面）
        try {
          ctx.slots.inject('shell.overlay', function* () {
            yield ctx.slots.register({ name: 'shell.overlay', id: 'hotspot', order: 900 }, () => e(HotspotPanel, {}));
          });
        } catch (err) {
          console.warn('[hotspot] 浮层挂载失败（设置页仍可用）：' + (err instanceof Error ? err.message : String(err)));
        }

        // 设置页：完整视图 + 浮层开关
        ctx.slots.inject('settings.section', function* () {
          yield ctx.slots.register(
            { name: 'settings.section', id: 'hotspot', order: 45, label: () => 'GitHub 热榜' },
            HotspotSection,
          );
        });
      }

      module.exports = {
        apply,
        inject,
        name,
        // 仅供测试：拖拽/夹取的纯逻辑不该只能靠肉眼验（见 test/client.mjs）
        __internals: { parsePanelState, clampRect, defaultRect, resolveRect, nextMode, DEFAULT_PANEL, PANEL_KEY, MIN_VISIBLE },
      };
      return module.exports;
    };
  }

  window.__ModuleLoader__.load({ id: 'hotspot', factory: makeFactory() });
})();
