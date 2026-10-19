/**
 * hotspot —— 浏览器半侧（client half）  v0.6.0
 *
 * ## 契约（与 dsh-pet / 官方插件一致，改动前先读）
 *
 * 本文件由 DSH 当**普通副作用脚本**加载（页面里的 `/plugins/hotspot/client.js`），所以：
 *   · 顶层**不能有 import / export**（不是 ESM，也不是 CJS 模块）；
 *   · 必须调用 `window.__ModuleLoader__.load({ id, factory })` 自我注册；
 *   · react / react-dom 由 factory 的 `require` 参数取得（平台种子模块）。
 * factory 返回的 module 上要有 `{ name, inject, apply }`，name 必须与包名一致。
 *
 * ## 视觉规范（v0.6.0 重做的核心）
 *
 * 界面**不再写死颜色**，而是全部走 DSH 自己的设计 token `--dsw-*`：
 *
 *   · 语义色   --dsw-alias-label-primary / -secondary / -tertiary、-link、
 *              --dsw-alias-bg-layer-1、--dsw-alias-border-l2、--dsw-alias-separator-primary、
 *              --dsw-alias-interactive-bg-hover、--dsw-alias-state-success/error/warn-*、
 *              --dsw-alias-button-primary-fill、--dsw-alias-label-primary-inverted
 *   · 形状     --dsw-radius-md / -panel、--dsw-elevation-panel / -soft
 *   · 字体     --dsw-font、--dsw-font-base-16（正文号）
 *   · 交互     --dsw-focus-ring-color / -width、--dsw-menu-backdrop-filter
 *   · 滚动条   --dsw-alias-scrollbar-bg-l2 / -hover-l2
 *
 * 每个变量都带**兜底值**（`var(--dsw-x, fallback)`）：token 被改名或缺失时界面仍可用。
 * 这样插件在明/暗主题、以及用户装了任何皮肤之后，都能自动长成"系统原生"的样子，
 * 而不是一块与周围割裂的灰色浮层。
 *
 * 图标同理：优先用官方 `@deepseek-ai/dsh-client-ui-primitives` 里的图标组件
 * （经 `require` 取得，dsh-pet 也是这么用的），取不到就退化成文本字形，绝不因图标失败而崩。
 *
 * ## 两个挂载点
 *   1. `shell.overlay` —— 独立可拖拽浮层（主界面）
 *   2. `settings.section` —— 设置页完整视图 + 浮层开关
 * 两者共用同一个 `HotspotBoard`。
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
  const DEFAULT_PANEL = { x: null, y: null, w: 460, h: 600, mode: 'panel' };
  const MIN_W = 320;
  const MIN_H = 240;
  const MIN_VISIBLE = 80;
  const DRAG_THRESHOLD = 4;

  /** 周期页签。 */
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

  /** 夹进视口：保证至少 MIN_VISIBLE 像素可见，否则浮层会"消失"在屏幕外。 */
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
    if (state.x === null || state.y === null) return clampRect(defaultRect(viewport, state), viewport);
    return clampRect(state, viewport);
  }

  /** 模式切换：药丸 ↔ 面板（hidden 只由显式按钮进入）。 */
  function nextMode(mode) {
    return mode === 'pill' ? 'panel' : 'pill';
  }

  // ------------------------------------------------------------ 样式（全量走 --dsw-* token）

  const CSS = [
    /* ---------- 容器与通用 ---------- */
    '.hotspot-root{display:flex;flex-direction:column;gap:10px;font:inherit;color:inherit}',
    '.hotspot-dim{color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:12px;line-height:1.55}',
    '.hotspot-err{color:var(--dsw-alias-state-error-primary,#d14343);font-size:12px;overflow-wrap:anywhere}',

    /* ---------- 悬浮面板外壳 ---------- */
    '.hotspot-panel{position:fixed;z-index:900;display:flex;flex-direction:column;box-sizing:border-box;',
    'background:var(--dsw-alias-bg-layer-1,Canvas);',
    'border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.34));',
    'border-radius:var(--dsw-radius-panel,14px);',
    'color:var(--dsw-alias-label-primary,CanvasText);',
    'box-shadow:var(--dsw-elevation-panel,0 12px 40px rgba(0,0,0,.28));',
    'font-family:var(--dsw-font,inherit);font-size:var(--dsw-font-base-16,13px);line-height:1.5;',
    'overflow:hidden}',
    '.hotspot-panel:focus-within{border-color:var(--dsw-alias-border-l3,rgba(128,128,128,.55))}',

    /* 标题栏：拖拽把手 + 标题 + 图标按钮 */
    '.hotspot-panel-head{display:flex;align-items:center;gap:8px;padding:10px 12px;flex:none;',
    'border-bottom:1px solid var(--dsw-alias-separator-primary,rgba(128,128,128,.2));',
    'cursor:grab;user-select:none;touch-action:none}',
    '.hotspot-panel-head:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08))}',
    '.hotspot-panel-head[data-dragging="1"]{cursor:grabbing}',
    '.hotspot-grip{display:inline-flex;align-items:center;color:var(--dsw-alias-label-quaternary,#9aa0a6);flex:none}',
    '.hotspot-panel-title{font-size:13px;font-weight:600;flex:1;min-width:0;overflow:hidden;',
    'text-overflow:ellipsis;white-space:nowrap;letter-spacing:.01em}',
    '.hotspot-panel-sub{font-weight:400;color:var(--dsw-alias-label-tertiary,#8a8f98);margin-left:6px}',

    /* 图标按钮 */
    '.hotspot-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;',
    'font:inherit;padding:0;border:none;border-radius:var(--dsw-radius-md,8px);cursor:pointer;',
    'background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);flex:none}',
    '.hotspot-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));',
    'color:var(--dsw-alias-label-primary,CanvasText)}',
    '.hotspot-icon-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,#4d6bfe);outline-offset:1px}',

    /* 内容区（可滚动 + 细滚动条） */
    '.hotspot-panel-body{flex:1;overflow:auto;padding:12px;min-height:0;overscroll-behavior:contain}',
    '.hotspot-panel-body::-webkit-scrollbar{width:8px;height:8px}',
    '.hotspot-panel-body::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2,rgba(128,128,128,.3));border-radius:999px}',
    '.hotspot-panel-body::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l2,rgba(128,128,128,.45))}',
    '.hotspot-panel-body::-webkit-scrollbar-track{background:transparent}',

    /* 缩放手柄 */
    '.hotspot-panel-resize{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;touch-action:none}',
    '.hotspot-panel-resize::after{content:"";position:absolute;right:3px;bottom:3px;width:8px;height:8px;',
    'border-right:2px solid var(--dsw-alias-label-quaternary,rgba(128,128,128,.5));',
    'border-bottom:2px solid var(--dsw-alias-label-quaternary,rgba(128,128,128,.5));border-radius:0 0 3px 0}',

    /* 药丸 */
    '.hotspot-pill{position:fixed;z-index:900;display:inline-flex;align-items:center;gap:7px;padding:7px 13px;',
    'border-radius:999px;cursor:pointer;font-family:var(--dsw-font,inherit);font-size:12px;',
    'background:var(--dsw-alias-bg-layer-1,Canvas);color:var(--dsw-alias-label-primary,CanvasText);',
    'border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.34));',
    'box-shadow:var(--dsw-elevation-soft,0 6px 18px rgba(0,0,0,.22));user-select:none;touch-action:none}',
    '.hotspot-pill:hover{border-color:var(--dsw-alias-border-l3,rgba(128,128,128,.55))}',
    '.hotspot-pill-count{color:var(--dsw-alias-label-tertiary,#8a8f98);font-variant-numeric:tabular-nums}',

    /* ---------- 工具栏 ---------- */
    '.hotspot-toolbar{display:flex;flex-direction:column;gap:8px;margin-bottom:10px}',

    /* 榜单 chips：横向滚动，避免 8 个榜把面板撑爆 */
    '.hotspot-boardbar{display:flex;gap:6px;overflow-x:auto;padding-bottom:2px;scrollbar-width:none}',
    '.hotspot-boardbar::-webkit-scrollbar{display:none}',
    '.hotspot-chip{display:inline-flex;align-items:center;gap:5px;flex:none;font:inherit;font-size:12px;',
    'padding:5px 11px;border-radius:999px;cursor:pointer;white-space:nowrap;',
    'border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.34));',
    'background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);transition:background .15s,color .15s}',
    '.hotspot-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));',
    'color:var(--dsw-alias-label-primary,CanvasText)}',
    '.hotspot-chip[data-on="1"]{background:var(--dsw-alias-button-primary-fill,#4d6bfe);',
    'border-color:transparent;color:var(--dsw-alias-label-primary-inverted,#fff);font-weight:600}',
    '.hotspot-chip:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,#4d6bfe);outline-offset:1px}',

    /* 周期：分段控件 */
    '.hotspot-segbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.hotspot-seg{display:inline-flex;padding:2px;gap:2px;border-radius:var(--dsw-radius-md,8px);',
    'background:var(--dsw-alias-fill-l1,rgba(128,128,128,.1))}',
    '.hotspot-seg button{font:inherit;font-size:12px;padding:3px 10px;border:none;border-radius:6px;cursor:pointer;',
    'background:transparent;color:var(--dsw-alias-label-secondary,#6b7280)}',
    '.hotspot-seg button[data-on="1"]{background:var(--dsw-alias-bg-layer-1,Canvas);',
    'color:var(--dsw-alias-label-primary,CanvasText);font-weight:600;',
    'box-shadow:var(--dsw-elevation-soft,0 1px 3px rgba(0,0,0,.16))}',
    '.hotspot-seg button:disabled{cursor:default;opacity:.5}',

    /* 裸按钮（设置页用） */
    '.hotspot-btn{display:inline-flex;align-items:center;gap:5px;font:inherit;font-size:12px;padding:5px 12px;',
    'border-radius:var(--dsw-radius-md,8px);cursor:pointer;',
    'border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.34));',
    'background:transparent;color:var(--dsw-alias-label-secondary,#6b7280)}',
    '.hotspot-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));',
    'color:var(--dsw-alias-label-primary,CanvasText)}',
    '.hotspot-btn:disabled{opacity:.5;cursor:default}',
    '.hotspot-btn[data-on="1"]{background:var(--dsw-alias-button-primary-fill,#4d6bfe);border-color:transparent;',
    'color:var(--dsw-alias-label-primary-inverted,#fff)}',
    '.hotspot-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,#4d6bfe);outline-offset:1px}',

    /* ---------- 状态行 ---------- */
    '.hotspot-status{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:8px}',
    '.hotspot-tag{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:2px 7px;border-radius:6px;',
    'background:var(--dsw-alias-fill-l1,rgba(128,128,128,.14));color:var(--dsw-alias-label-secondary,#6b7280)}',
    '.hotspot-tag-pending{background:var(--dsw-alias-state-warn-tertiary,rgba(210,153,34,.18));',
    'color:var(--dsw-alias-state-warn-label,#8a6100)}',
    '.hotspot-tag-ok{background:var(--dsw-alias-state-success-tertiary,rgba(46,160,67,.14));',
    'color:var(--dsw-alias-state-success-primary,#1a7f37)}',
    '.hotspot-linkbtn{font:inherit;font-size:11px;padding:2px 6px;border:none;border-radius:6px;cursor:pointer;',
    'background:transparent;color:var(--dsw-alias-label-tertiary,#8a8f98);text-decoration:underline}',
    '.hotspot-linkbtn:hover{color:var(--dsw-alias-link,#4d6bfe)}',

    /* ---------- 列表 ---------- */
    '.hotspot-list{display:flex;flex-direction:column}',
    '.hotspot-item{display:flex;gap:10px;padding:10px 8px;align-items:flex-start;border-radius:var(--dsw-radius-md,8px);',
    'border-bottom:1px solid var(--dsw-alias-separator-primary,rgba(128,128,128,.14))}',
    '.hotspot-item:last-child{border-bottom:none}',
    '.hotspot-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.07))}',
    '.hotspot-rank{width:22px;flex:none;text-align:right;font-size:12px;font-weight:600;',
    'color:var(--dsw-alias-label-quaternary,#9aa0a6);font-variant-numeric:tabular-nums;padding-top:1px}',
    '.hotspot-item[data-top="1"] .hotspot-rank{color:var(--dsw-alias-brand-primary,#4d6bfe)}',
    '.hotspot-body{flex:1;min-width:0}',
    '.hotspot-name{display:inline-flex;align-items:center;gap:4px;font-weight:600;font-size:13px;',
    'text-decoration:none;color:var(--dsw-alias-label-primary,CanvasText);overflow-wrap:anywhere}',
    '.hotspot-name:hover{color:var(--dsw-alias-link,#4d6bfe)}',
    '.hotspot-name svg{opacity:0;transition:opacity .15s}',
    '.hotspot-item:hover .hotspot-name svg{opacity:.55}',
    '.hotspot-summary{font-size:12.5px;line-height:1.6;margin-top:4px;color:var(--dsw-alias-label-primary,CanvasText);overflow-wrap:anywhere}',
    '.hotspot-rawdesc{color:var(--dsw-alias-label-quaternary,#9aa0a6);font-size:11.5px;margin-top:3px;overflow-wrap:anywhere}',
    '.hotspot-meta{display:flex;gap:8px;flex-wrap:wrap;font-size:11px;margin-top:5px;',
    'color:var(--dsw-alias-label-tertiary,#8a8f98)}',
    '.hotspot-meta span{display:inline-flex;align-items:center;gap:3px}',
    '.hotspot-right{flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:3px;',
    'font-size:11.5px;min-width:56px}',
    '.hotspot-stars{font-variant-numeric:tabular-nums;font-weight:600;color:var(--dsw-alias-label-primary,CanvasText)}',
    '.hotspot-delta{color:var(--dsw-alias-state-success-primary,#1a7f37);font-variant-numeric:tabular-nums;font-weight:600}',
    '.hotspot-rate{color:var(--dsw-alias-label-tertiary,#8a8f98);font-variant-numeric:tabular-nums}',

    /* 骨架屏与空状态 */
    '.hotspot-skeleton{display:flex;flex-direction:column;gap:10px;padding:6px 0}',
    '.hotspot-skeleton i{display:block;height:11px;border-radius:6px;',
    'background:var(--dsw-alias-bg-skeleton,rgba(128,128,128,.14));animation:hotspot-pulse 1.4s ease-in-out infinite}',
    '.hotspot-skeleton i:nth-child(2){width:72%}.hotspot-skeleton i:nth-child(3){width:48%}',
    '@keyframes hotspot-pulse{0%,100%{opacity:.55}50%{opacity:1}}',
    '.hotspot-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:26px 10px;text-align:center;',
    'color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:12px;line-height:1.6}',

    /* ---------- 页脚 ---------- */
    '.hotspot-foot{display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:11px;margin-top:10px;',
    'padding-top:8px;border-top:1px solid var(--dsw-alias-separator-primary,rgba(128,128,128,.16));',
    'color:var(--dsw-alias-label-tertiary,#8a8f98)}',
    '.hotspot-live{color:var(--dsw-alias-state-success-primary,#1a7f37)}',
    '.hotspot-sep{opacity:.4}',

    /* 设置页容器 */
    '.hotspot-section{display:flex;flex-direction:column;gap:14px}',
    '.hotspot-card{border:1px solid var(--dsw-alias-settings-card-stroke,rgba(128,128,128,.24));',
    'background:var(--dsw-alias-settings-card-fill,transparent);border-radius:var(--dsw-radius-lg,12px);padding:14px}',
    '.hotspot-h2{font-size:14px;font-weight:600;margin:0 0 2px 0}',

    /* 无障碍：尊重系统的"减少动态效果" */
    '@media (prefers-reduced-motion: reduce){.hotspot-skeleton i{animation:none}',
    '.hotspot-chip,.hotspot-icon-btn,.hotspot-item{transition:none}}',
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

      /** 官方图标集（平台种子模块）。取不到就让所有图标退化成文本字形。 */
      let icons;
      try {
        icons = require('@deepseek-ai/dsh-client-ui-primitives');
      } catch (error) {
        console.warn('[hotspot] 图标模块不可用，回退为文本字形：' + (error instanceof Error ? error.message : String(error)));
        icons = undefined;
      }

      /** 取一个图标组件；没有就渲染一个等宽字形占位。 */
      function icon(name, glyph, size) {
        const Comp = icons?.[name];
        if (typeof Comp === 'function') return e(Comp, { size: size ?? 14 });
        return e('span', { className: 'hotspot-glyph', 'aria-hidden': 'true' }, glyph);
      }

      // -------------------------------------------------------- 数据 hook

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

      // -------------------------------------------------------- 榜单主体

      /** 一条结果的排序徽标信息。 */
      function basisLabel(basis) {
        if (basis === 'star-velocity') return '按涨星速度';
        if (basis === 'star-delta') return '按区间涨星';
        if (basis === 'insufficient-history') return '样本积累中';
        return '按总星数';
      }

      function HotspotBoard(props) {
        const d = props.data;
        const items = (d && d.items) || [];
        const isSurge = d && d.basis === 'star-velocity';
        const insufficient = d && d.basis === 'insufficient-history';
        const stats = (d && d.summaryStats) || null;
        const rank = (d && d.ranking) || null;
        const compact = props.compact === true;
        const [showNotes, setShowNotes] = useState(false);
        const tabsLocked = Boolean(d && d.scheduled && d.scheduled.ignoresPeriodTabs);

        const droppedTotal = rank
          ? rank.dropped.list + rank.dropped.platform + rank.dropped.unrelated + rank.dropped.lowRelevance
          : 0;

        return e(
          'div',
          { className: 'hotspot-root' },

          // ---------- 工具栏：榜单 + 周期 + 刷新 ----------
          e(
            'div',
            { className: 'hotspot-toolbar' },
            props.boards.length > 0
              ? e(
                  'div',
                  { className: 'hotspot-boardbar', role: 'tablist', 'aria-label': '榜单' },
                  props.boards.map((b) =>
                    e(
                      'button',
                      {
                        key: b.id,
                        className: 'hotspot-chip',
                        role: 'tab',
                        'aria-selected': b.id === props.boardId,
                        'data-on': b.id === props.boardId ? '1' : '0',
                        title: (b.desc || '') + (b.kind === 'surge' ? '' : '\n查询：' + (b.query || '')),
                        onClick: () => props.setBoardId(b.id),
                      },
                      b.kind === 'surge' ? icon('IconGaugeOutlineMedium', '🚀', 13) : null,
                      b.name,
                    ),
                  ),
                )
              : null,

            e(
              'div',
              { className: 'hotspot-segbar' },
              e(
                'div',
                { className: 'hotspot-seg', role: 'group', 'aria-label': '统计周期' },
                PERIODS.map((p) =>
                  e(
                    'button',
                    {
                      key: p.id,
                      'data-on': p.id === props.period ? '1' : '0',
                      disabled: tabsLocked,
                      title: tabsLocked ? '飙升榜固定按周统计，与页签无关' : '切换统计区间',
                      onClick: () => props.setPeriod(p.id),
                    },
                    p.label,
                  ),
                ),
              ),
              d ? e('span', { className: 'hotspot-tag' }, basisLabel(d.basis)) : null,
              e(
                'button',
                {
                  className: 'hotspot-icon-btn',
                  title: '立即刷新（会重新抓取数据）',
                  'aria-label': '刷新',
                  onClick: props.onRefresh,
                  disabled: props.loading || props.busy,
                  style: { marginLeft: 'auto' },
                },
                icon('IconRefreshOutlineMedium', '↻', 15),
              ),
            ),
          ),

          // ---------- 状态行：窗口 / 筛选 / 判定 ----------
          d
            ? e(
                'div',
                { className: 'hotspot-status' },
                d.windowStart
                  ? e(
                      'span',
                      { className: 'hotspot-tag', title: '排名使用的区间' },
                      icon('IconClockOutlineMedium', '⏱', 12),
                      (d.windowHours !== null && d.windowHours !== undefined
                        ? d.windowHours >= 48
                          ? Math.round(d.windowHours / 24) + ' 天'
                          : Math.max(1, Math.round(d.windowHours)) + ' 小时'
                        : '区间') + '区间',
                    )
                  : null,
                rank && droppedTotal + rank.pending > 0
                  ? e(
                      'span',
                      { className: 'hotspot-tag hotspot-tag-ok', title: '模型相关性筛选结果' },
                      icon('IconEnhanceOutlineMedium', '✨', 12),
                      '剔除 ' + droppedTotal + (rank.pending > 0 ? ' · 判定中 ' + rank.pending : ''),
                    )
                  : null,
                d ? e('span', { className: 'hotspot-tag' }, '更新 ' + (d.scheduled ? d.scheduled.rule : '—')) : null,
                d && d.notes && d.notes.length > 0
                  ? e(
                      'button',
                      { className: 'hotspot-linkbtn', onClick: () => setShowNotes((v) => !v) },
                      showNotes ? '收起说明' : '说明',
                    )
                  : null,
              )
            : null,

          d && showNotes && d.notes && d.notes.length > 0
            ? e(
                'div',
                { className: 'hotspot-dim', style: { marginBottom: '8px' } },
                d.notes.map((n, i) => e('div', { key: i }, '· ' + n)),
              )
            : null,

          props.error !== ''
            ? e(
                'div',
                { className: 'hotspot-err' },
                icon('IconWarningTriangleOutlineMedium', '⚠', 13),
                ' 读取失败：' + props.error,
              )
            : null,

          props.tokenReady === false
            ? e('div', { className: 'hotspot-dim' }, '未配置 GITHUB_TOKEN：未认证搜索限 10 次/分钟（当前按日程抓取，通常够用）')
            : null,

          // ---------- 列表 ----------
          items.length > 0
            ? e(
                'div',
                { className: 'hotspot-list' },
                items.map((item) =>
                  e(
                    'div',
                    { className: 'hotspot-item', key: item.fullName, 'data-top': item.rank <= 3 ? '1' : '0' },
                    e('div', { className: 'hotspot-rank' }, item.rank),
                    e(
                      'div',
                      { className: 'hotspot-body' },
                      e(
                        'a',
                        { className: 'hotspot-name', href: item.url, target: '_blank', rel: 'noreferrer' },
                        item.fullName,
                        icon('IconLinkOutlineMedium', '↗', 11),
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
                          ? e(
                              'span',
                              {
                                className: 'hotspot-tag',
                                title: '模型判定的相关性' + (item.verdictReason ? '：' + item.verdictReason : ''),
                              },
                              '相关 ' + item.relevance,
                            )
                          : item.verdict === 'pending'
                            ? e('span', { className: 'hotspot-tag hotspot-tag-pending' }, '判定中')
                            : null,
                        item.pushedAt !== '' ? e('span', null, '更新于 ' + ago(item.pushedAt)) : null,
                        item.archived ? e('span', null, '已归档') : null,
                        !compact && item.forks > 0 ? e('span', null, item.forks + ' fork') : null,
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
              ? e(
                  'div',
                  { className: 'hotspot-skeleton', 'aria-hidden': 'true' },
                  e('i', null),
                  e('i', null),
                  e('i', null),
                  e('i', { style: { width: '86%' } }),
                )
              : props.error === '' && insufficient
                ? e(
                    'div',
                    { className: 'hotspot-empty' },
                    icon('IconClockOutlineMedium', '⏳', 20),
                    '飙升榜还没有数据：它靠两个不同时刻的采样算速度，跨过下一个更新边界后就会出现。',
                  )
                : props.error === ''
                  ? rank && rank.before > 0
                    ? e(
                        'div',
                        { className: 'hotspot-empty' },
                        icon('IconArchiveOffOutlineMedium', '🗂', 20),
                        '全部 ' + rank.before + ' 个候选都被相关性筛选剔除' +
                          '（合集 ' + rank.dropped.list + ' / 平台级 ' + rank.dropped.platform +
                          ' / 无关 ' + rank.dropped.unrelated + ' / 相关性不足 ' + rank.dropped.lowRelevance + '）。',
                        e(
                          'div',
                          { className: 'hotspot-dim' },
                          '可以调低 ranking.minRelevance，或把 classify 设为 false 关掉筛选。',
                        ),
                      )
                    : e(
                        'div',
                        { className: 'hotspot-empty' },
                        icon('IconFlatListOutlineMedium', '📋', 20),
                        '这个榜单还没有数据，点右上角刷新试试。',
                      )
                  : null,

          // ---------- 页脚 ----------
          d
            ? e(
                'div',
                { className: 'hotspot-foot' },
                e('span', null, '数据 ' + ago(d.fetchedAt)),
                e('span', { className: 'hotspot-sep' }, '·'),
                e('span', null, '样本 ' + d.sampleCount),
                d.scheduled
                  ? e(
                      'span',
                      null,
                      '· 下次更新 ' + humanDuration(d.scheduled.nextInMs) + (d.scheduled.frozen ? '（已冻结）' : ''),
                    )
                  : null,
                props.syncedAt > 0 ? e('span', { className: 'hotspot-live' }, '· ● 60 秒同步') : null,
                stats
                  ? e(
                      'span',
                      null,
                      '· 简介 ' + stats.cached + (stats.queued > 0 || stats.generating ? '（生成中）' : ''),
                    )
                  : null,
                d.stale ? e('span', null, '· 本次刷新失败，显示缓存') : null,
              )
            : null,
        );
      }

      // -------------------------------------------------------- 浮层

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

        const persist = useCallback((next) => {
          try {
            window.localStorage.setItem(PANEL_KEY, JSON.stringify(next));
          } catch {
            /* 隐私模式写不了，忽略 */
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

        useEffect(() => {
          const onResize = () => setRect((r) => clampRect(r, { w: window.innerWidth, h: window.innerHeight }));
          window.addEventListener('resize', onResize);
          return () => window.removeEventListener('resize', onResize);
        }, []);

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
              if (kind === 'move') setRect(clampRect({ ...origin, x: origin.x + dx, y: origin.y + dy }, viewport));
              else setRect(clampRect({ ...origin, w: origin.w + dx, h: origin.h + dy }, viewport));
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
              if (!moved && kind === 'move') applyState({ mode: nextMode(state.mode) });
            };
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
          },
          [rect.x, rect.y, rect.w, rect.h, state.mode, applyState],
        );

        if (state.mode === 'pill') {
          const pill = clampRect({ x: rect.x, y: rect.y, w: 150, h: 34 }, { w: window.innerWidth, h: window.innerHeight });
          return e(
            'div',
            {
              className: 'hotspot-pill',
              style: { left: pill.x + 'px', top: pill.y + 'px' },
              title: '点击展开 GitHub 热榜；拖动可移动',
              onPointerDown: (ev) => startDrag(ev, 'move'),
            },
            icon('IconChevronUpOutlineMedium', '▴', 13),
            '热榜',
            hd.data
              ? e(
                  'span',
                  { className: 'hotspot-pill-count' },
                  ((hd.data.board && hd.data.board.name) || '') + ' · ' + (hd.data.items || []).length,
                )
              : null,
          );
        }

        if (state.mode === 'hidden') return null;

        return e(
          'div',
          {
            className: 'hotspot-panel',
            style: { left: rect.x + 'px', top: rect.y + 'px', width: rect.w + 'px', height: rect.h + 'px' },
          },
          e(
            'div',
            {
              className: 'hotspot-panel-head',
              'data-dragging': dragging ? '1' : '0',
              onPointerDown: (ev) => startDrag(ev, 'move'),
              title: '拖动移动；点一下折叠成药丸',
            },
            e('span', { className: 'hotspot-grip' }, icon('IconCompactOutlineMedium', '⠿', 14)),
            e('span', { className: 'hotspot-panel-title' }, 'GitHub 热榜'),
            hd.data && hd.data.board
              ? e('span', { className: 'hotspot-panel-sub' }, hd.data.board.name)
              : null,
            e(
              'button',
              {
                className: 'hotspot-icon-btn',
                title: '折叠成药丸',
                'aria-label': '折叠',
                onPointerDown: (ev) => ev.stopPropagation(),
                onClick: () => applyState({ mode: 'pill' }),
              },
              icon('IconChevronDownOutlineMedium', '—', 15),
            ),
            e(
              'button',
              {
                className: 'hotspot-icon-btn',
                title: '隐藏（在 设置 → GitHub 热榜 里可重新打开）',
                'aria-label': '隐藏',
                onPointerDown: (ev) => ev.stopPropagation(),
                onClick: () => applyState({ mode: 'hidden' }),
              },
              icon('IconCloseOutlineMedium', '✕', 15),
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
          e('div', { className: 'hotspot-panel-resize', title: '拖动调整大小', onPointerDown: (ev) => startDrag(ev, 'resize') }),
        );
      }

      // -------------------------------------------------------- 设置页

      function HotspotSection() {
        const hd = useHotspotData();
        const [mode, setMode] = useState(() => {
          try {
            return parsePanelState(window.localStorage.getItem(PANEL_KEY)).mode;
          } catch {
            return DEFAULT_PANEL.mode;
          }
        });

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
          { className: 'hotspot-section' },
          e(
            'div',
            null,
            e('h3', { className: 'hotspot-h2' }, 'GitHub 热榜'),
            e(
              'div',
              { className: 'hotspot-dim' },
              '按日 / 周 / 月追踪模型插件、Skill、MCP 服务等小工具的 GitHub 热度，并用 DSH 的模型做相关性筛选与中文简介。',
            ),
            e(
              'div',
              { className: 'hotspot-dim' },
              '榜单以**独立可拖拽浮层**显示在页面上；这里可以开关它，或临时改成完整视图查看。',
            ),
          ),
          e(
            'div',
            { className: 'hotspot-card' },
            e(
              'div',
              { className: 'hotspot-segbar', style: { marginBottom: '8px' } },
              e(
                'button',
                { className: 'hotspot-btn', 'data-on': mode === 'panel' ? '1' : '0', onClick: () => setPanelMode('panel') },
                icon('IconFullscreenOutlineMedium', '⤢', 13),
                mode === 'panel' ? '浮层已显示' : '显示浮层',
              ),
              e(
                'button',
                { className: 'hotspot-btn', 'data-on': mode === 'pill' ? '1' : '0', onClick: () => setPanelMode('pill') },
                icon('IconCompactOutlineMedium', '⤡', 13),
                mode === 'pill' ? '已折叠' : '折叠成药丸',
              ),
              e(
                'button',
                { className: 'hotspot-btn', 'data-on': mode === 'hidden' ? '1' : '0', onClick: () => setPanelMode('hidden') },
                icon('IconCloseOutlineMedium', '✕', 13),
                mode === 'hidden' ? '已隐藏' : '隐藏浮层',
              ),
            ),
            e(
              'div',
              { className: 'hotspot-dim' },
              '拖标题栏移动、拖右下角改大小；位置与尺寸会自动记住。' +
                (mode === 'hidden' ? '（当前已隐藏：点「显示浮层」即可恢复到上次的位置）' : ''),
            ),
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
          console.warn('[hotspot] 样式注入失败：' + (err instanceof Error ? err.message : String(err)));
        }

        try {
          ctx.slots.inject('shell.overlay', function* () {
            yield ctx.slots.register({ name: 'shell.overlay', id: 'hotspot', order: 900 }, () => e(HotspotPanel, {}));
          });
        } catch (err) {
          console.warn('[hotspot] 浮层挂载失败（设置页仍可用）：' + (err instanceof Error ? err.message : String(err)));
        }

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
