/**
 * hotspot 浏览器半侧测试 —— 用 vm 模拟 DSH 的模块加载契约。
 *
 * 浏览器半侧是**最难在本地验证**的部分（只有 DSH 页面能真跑），所以这里把它的
 * 契约与关键界面元素逐条钉住：
 *   · 顶层无 import / export，且会调用 window.__ModuleLoader__.load({id, factory})；
 *   · factory(require) 返回的 module 上有 { name, inject, apply }，name 与包名一致；
 *   · apply(ctx) 会往 settings.section 插槽注册一项，id/order/label 正确；
 *   · 注册的组件能被执行一次而不抛错（用假 hooks 顶替 react）。
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
const fakeDocument = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild: (el) => styles.push(el) },
};

/** 最小 React 替身：必须覆盖组件用到的每一个 hook。 */
const fakeReact = {
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (initial) => ({ current: initial }),
  createElement: (type, props, ...children) => ({ type, props, children }),
};

const sandbox = {
  window: {
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
  Date,
  Math,
  JSON,
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

console.log('\n[3] apply(ctx) 注册设置页分区');
const registered = [];
const fakeCtx = {
  slots: {
    inject: (slotName, generator) => {
      // DSH 的 inject 接受生成器，yield 出来的就是注册项
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
check('注册了 1 项', registered.length === 1, String(registered.length));
const entry = registered[0]?.value;
check('槽位是 settings.section', registered[0]?.slotName === 'settings.section', String(registered[0]?.slotName));
check('分区 id 是 hotspot', entry?.options?.id === 'hotspot', String(entry?.options?.id));
check('order 是数字', typeof entry?.options?.order === 'number');
check('label() 返回「GitHub 热榜」', typeof entry?.options?.label === 'function' && entry.options.label() === 'GitHub 热榜', String(entry?.options?.label?.()));
check('组件是函数', typeof entry?.component === 'function');
check('样式表已注入且带 data-plugin-css 标记', styles.length === 1 && styles[0].dataset.pluginCss === 'hotspot/styles');
check('样式里包含中文简介与涨星速度的类名', styles[0].textContent.includes('hotspot-summary') && styles[0].textContent.includes('hotspot-rate'));

console.log('\n[4] 渲染一次组件（假 hooks，抓明显错误）');
try {
  const tree = entry.component({});
  check('组件返回了元素树', tree !== undefined && tree !== null && tree.type === 'div');
  const text = JSON.stringify(tree);
  check('界面含标题「GitHub 热榜」', text.includes('GitHub 热榜'));
  check('界面含周期页签', text.includes('日榜') && text.includes('周榜') && text.includes('月榜') && text.includes('总榜'));
  check('说明文案提到中文简介', text.includes('中文简介'));
  // 初始 state 是 loading=true，所以按钮文案是「刷新中…」；这里断言按钮元素本身
  const hasButton = (function find(node) {
    if (node === null || typeof node !== 'object') return false;
    if (node.type === 'button' && node.props && node.props.className === 'hotspot-btn') return true;
    return (node.children || []).some(find);
  })(tree);
  check('界面含刷新按钮', hasButton);
  check('刷新按钮文案随加载状态变化', text.includes('刷新中') || text.includes('立即刷新'));
} catch (error) {
  check('组件渲染不抛错', false, error.message);
}

console.log('\n[5] 注册的组件带自动轮询（源码层面确认 60 秒定时器存在）');
check('源码里有 setInterval + POLL_MS', source.includes('setInterval') && source.includes('POLL_MS'));
check('POLL_MS 是 60000', /const POLL_MS = 60000/.test(source));
check('卸载时清理定时器', source.includes('clearInterval(timer)'));

console.log('\n================ 结果 ================');
console.log('断言 ' + checks + ' 项，失败 ' + failures.length + ' 项');
if (failures.length > 0) {
  for (const f of failures) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log('全部通过');
}
