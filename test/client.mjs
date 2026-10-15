/**
 * hotspot 浏览器半侧测试 —— 用 vm 模拟 DSH 的模块加载契约。
 *
 * 浏览器半侧是**最难在本地验证**的部分（只有 DSH 页面能真跑），所以这里把它的
 * 契约、挂载点、界面元素、以及**浮层拖拽的纯逻辑**逐条钉住：
 *   · 顶层无 import / export，且会调用 window.__ModuleLoader__.load({id, factory})；
 *   · factory(require) 返回的 module 上有 { name, inject, apply }，name 与包名一致；
 *   · apply(ctx) 往 **shell.overlay**（独立可拖拽浮层）与 **settings.section** 各注册一项；
 *   · 两个组件都能被执行一次而不抛错；
 *   · __internals 里的夹取/默认位置/状态解析/模式切换数学正确。
 *
 * ⚠️ 假 React 必须提供组件用到的**全部** hook：漏一个就会得到
 * 「xxx is not a function」这种假失败（本项目就踩过 useRef）。新增 hook 时同步补上。
 *
 * 跑法：node test/client.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

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

// ---- 伪造 DSH 浏览器环境 ----
let loaded;
const styles = [];
const store = new Map();
const fakeDocument = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild: (el) => styles.push(el) },
};

/** 最小 React 替身：必须覆盖组件用到的每一个 hook。 */
const fakeReact = {
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (initial) => ({ current: initial }),
  createElement: (type, props, ...children) => ({ type, props, children }),
};

const sandbox = {
  window: {
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    __ModuleLoader__: {
      load: (info) => {
        loaded = info;
      },
    },
  },
  document: fakeDocument,
  console,
  fetch: () => Promise.reject(new Error('测试里不发真实请求')),
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  encodeURIComponent,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

console.log('\n[1] 加载脚本并自我注册');
vm.runInContext(source, sandbox, { filename: 'lib/client.js' });
check('调用了 __ModuleLoader__.load', loaded !== undefined);
check('注册 id 与包名一致', loaded?.id === 'hotspot', String(loaded?.id));
check('factory 是函数', typeof loaded?.factory === 'function');

console.log('\n[2] factory(require) 返回插件三件套');
const require = (name) => {
  if (name === 'react') return fakeReact;
  throw new Error('测试未提供模块：' + name);
};
const mod = loaded.factory(require);
check('name === "hotspot"', mod?.name === 'hotspot', String(mod?.name));
check('inject 含 slots', Array.isArray(mod?.inject) && mod.inject.includes('slots'));
check('apply 是函数', typeof mod?.apply === 'function');
check('暴露 __internals 供测试', mod?.__internals !== undefined && typeof mod.__internals.clampRect === 'function');

console.log('\n[3] apply(ctx) 注册浮层 + 设置页两个挂载点');
const registered = [];
const fakeCtx = {
  slots: {
    inject: (slotName, generator) => {
      const iterator = generator();
      let step = iterator.next();
      while (!step.done) {
        registered.push({ slotName, value: step.value });
        step = iterator.next();
      }
    },
    register: (options, component) => ({ options, component }),
  },
};
mod.apply(fakeCtx);
check('注册了 2 项', registered.length === 2, String(registered.length));
const bySlot = new Map(registered.map((r) => [r.slotName, r.value]));
check('挂到 shell.overlay（页面级浮层）', bySlot.has('shell.overlay'), [...bySlot.keys()].join(','));
check('挂到 settings.section', bySlot.has('settings.section'), [...bySlot.keys()].join(','));
const overlay = bySlot.get('shell.overlay');
check('浮层 id=hotspot / order=900 / 组件是函数', overlay?.options?.id === 'hotspot' && overlay?.options?.order === 900 && typeof overlay?.component === 'function', JSON.stringify(overlay?.options ?? {}));
const section = bySlot.get('settings.section');
check('设置页 id=hotspot / order=45 / label 正确', section?.options?.id === 'hotspot' && section?.options?.order === 45 && section.options.label() === 'GitHub 热榜', JSON.stringify(section?.options ?? {}));
check('样式表只注入一次且带标记', styles.length === 1 && styles[0].dataset.pluginCss === 'hotspot/styles');
check('样式含浮层/药丸/缩放手柄类名', ['hotspot-panel', 'hotspot-pill', 'hotspot-panel-resize', 'hotspot-panel-head'].every((c) => styles[0].textContent.includes(c)));

console.log('\n[4] 两个组件都能渲染');
/**
 * 递归展开元素树里的**函数型子元素**，得到「真正渲染出来」的树。
 * 两个坑都在这里：
 *   · 注册项有两种形态：直接注册组件（settings.section）或注册渲染函数（dsh-pet 的
 *     shell.overlay 就是后者）→ 返回值可能是「元素」而不是渲染结果，要再调一次 type；
 *   · 组件内部还会把子组件当元素写（e(HotspotBoard, {...})）——不递归展开就看不到
 *     榜单内部的页签和按钮，于是断言会误判成「界面里没有这些东西」。
 */
function renderDeep(node, depth = 0) {
  if (node === null || typeof node !== 'object' || depth > 20) return node;
  if (typeof node.type === 'function') {
    return renderDeep(node.type({ ...(node.props ?? {}) }), depth + 1);
  }
  return { ...node, children: (node.children || []).map((c) => renderDeep(c, depth + 1)) };
}

/** 注册项 → 完整渲染树。 */
function renderRegistered(entry, props) {
  return renderDeep(entry.component(props));
}
try {
  const panel = renderRegistered(overlay, {});
  check('浮层渲染出面板根节点', panel?.type === 'div' && panel.props.className === 'hotspot-panel', String(panel?.props?.className));
  const panelText = JSON.stringify(panel);
  check('浮层含拖动标题栏', panelText.includes('hotspot-panel-head'));
  check('浮层含缩放手柄', panelText.includes('hotspot-panel-resize'));
  check('浮层含折叠/隐藏按钮', panelText.includes('折叠成药丸') && panelText.includes('隐藏'));
  check('浮层内嵌榜单主体（紧凑模式，无大标题）', panelText.includes('hotspot-panel-body') && !panelText.includes('按日 / 周 / 月追踪'));

  const sect = renderRegistered(section, {});
  const sectText = JSON.stringify(sect);
  // 注意：按钮文案随当前模式变化（panel 模式下是「✓ 浮层已显示」而不是「显示浮层」），
  // 所以这里用正则匹配两种形态，别把模式相关文案写死。
  check(
    '设置页含产品描述与浮层开关',
    sectText.includes('按日 / 周 / 月追踪') && sectText.includes('独立可拖拽浮层') && /浮层已显示|显示浮层/.test(sectText),
  );
  check(
    '设置页三个模式按钮都在',
    /浮层已显示|显示浮层/.test(sectText) && sectText.includes('折叠成药丸') && sectText.includes('隐藏浮层'),
  );
  check('两者都含周期页签与刷新按钮', panelText.includes('日榜') && sectText.includes('日榜') && panelText.includes('hotspot-btn'));
  check('浮层不重复渲染产品描述（说明只在设置页）', !panelText.includes('按日 / 周 / 月追踪'));
} catch (error) {
  check('组件渲染不抛错', false, error.message);
}

console.log('\n[5] 浮层拖拽的纯逻辑（不靠肉眼验）');
const I = mod.__internals;
const viewport = { w: 1000, h: 800 };

// 状态解析
check('坏 JSON → 回落默认', JSON.stringify(I.parsePanelState('{oops')) === JSON.stringify(I.DEFAULT_PANEL));
check('null → 回落默认', I.parsePanelState(null).mode === 'panel' && I.parsePanelState(null).w === I.DEFAULT_PANEL.w);
check('未知 mode → 回落 panel', I.parsePanelState({ mode: 'nonsense' }).mode === 'panel');
check('pill 被保留', I.parsePanelState({ mode: 'pill' }).mode === 'pill');
check('hidden 被保留', I.parsePanelState({ mode: 'hidden' }).mode === 'hidden');
const dirty = I.parsePanelState({ x: 'abc', y: 5, w: 10, h: 10, mode: 'panel' });
check('非数字 x → null（回到默认位置）', dirty.x === null, String(dirty.x));
check('过小的尺寸被抬到下限', dirty.w === 300 && dirty.h === 220, dirty.w + 'x' + dirty.h);

// 夹取：往右下角拖出屏幕
const br = I.clampRect({ x: 9999, y: 9999, w: 400, h: 500 }, viewport);
check('右下越界 → 至少留 ' + I.MIN_VISIBLE + 'px 可见', br.x === viewport.w - I.MIN_VISIBLE && br.y === viewport.h - I.MIN_VISIBLE, br.x + ',' + br.y);
// 夹取：往左上角拖出屏幕
const tl = I.clampRect({ x: -9999, y: -9999, w: 400, h: 500 }, viewport);
check('左上越界 → x 允许为负但保留可见宽度、y 不小于 0', tl.x === -(400 - I.MIN_VISIBLE) && tl.y === 0, tl.x + ',' + tl.y);
// 尺寸不超过视口
const big = I.clampRect({ x: 0, y: 0, w: 5000, h: 5000 }, viewport);
check('尺寸被限制在视口内', big.w === 1000 && big.h === 800, big.w + 'x' + big.h);
// 默认位置：右下角留 20px 边距
const def = I.defaultRect(viewport, { w: 400, h: 500 });
check('默认位置在右下角', def.x === 580 && def.y === 280, def.x + ',' + def.y);
check('x/y 为 null 时解析为默认位置', JSON.stringify(I.resolveRect({ x: null, y: null, w: 400, h: 500 }, viewport)) === JSON.stringify({ x: 580, y: 280, w: 400, h: 500 }));
check('已有坐标时沿用（并夹取）', I.resolveRect({ x: 100, y: 120, w: 400, h: 500 }, viewport).x === 100);
// 模式切换
check('药丸 ↔ 面板 互切', I.nextMode('pill') === 'panel' && I.nextMode('panel') === 'pill' && I.nextMode('hidden') === 'pill');

console.log('\n[6] 源码层面的关键实现');
check('用 Pointer Events 拖拽', source.includes('pointermove') && source.includes('pointerdown'));
check('标题栏 touch-action:none（否则手机拖不动）', source.includes('touch-action:none'));
check('有拖拽判定阈值（区分点击与拖动）', /DRAG_THRESHOLD = \d+/.test(source));
check('位置/尺寸/模式持久化到 localStorage', source.includes('PANEL_KEY') && source.includes('localStorage.setItem'));
check('窗口 resize 时重新夹取', source.includes("addEventListener('resize'"));
check('自动轮询 60 秒且卸载时清理', /POLL_MS = 60000/.test(source) && source.includes('clearInterval(timer)'));

console.log('\n================ 结果 ================');
console.log('断言 ' + checks + ' 项，失败 ' + failures.length + ' 项');
if (failures.length > 0) {
  for (const f of failures) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log('全部通过');
}
