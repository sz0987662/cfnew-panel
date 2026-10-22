import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// 落地页交互测试：用最小 DOM 桩执行 index.html 里的脚本。
// 目的不是模拟浏览器，而是锁住「一份清单 + 勾选 + 生成前检查」的流程。

const 元素模板 = () => ({
  tag: 'div', children: [], listeners: {}, classes: new Set(),
  hidden: false, disabled: false, checked: false, indeterminate: false,
  value: '', placeholder: '', type: '', textContent: '', href: '',
  spellcheck: true, autocomplete: '',
  setAttribute(name, value) { this[name] = value; },
  removeAttribute(name) { delete this[name]; },
  classList: null,
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } },
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); },
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); },
  focus() { this.focused = true; },
  querySelector(selector) { return 查找(this, selector); },
});
function 建元素(tag) {
  const element = 元素模板();
  element.tag = tag;
  element.classList = {
    toggle: (name, force) => { if (force === undefined ? !element.classes.has(name) : force) element.classes.add(name); else element.classes.delete(name); },
    add: name => element.classes.add(name),
    remove: name => element.classes.delete(name),
    contains: name => element.classes.has(name),
  };
  // 脚本直接给 className 赋值，桩需要把它映射到 class 集合，测试才能按类查找行。
  Object.defineProperty(element, 'className', {
    get: () => [...element.classes].join(' '),
    set: value => { element.classes = new Set(String(value || '').split(/\s+/).filter(Boolean)); },
  });
  return element;
}
function* 遍历(element) {
  for (const child of element.children || []) { yield child; yield* 遍历(child); }
}
function 匹配(element, part) {
  return part.startsWith('.') ? element.classes.has(part.slice(1)) : element.tag === part;
}
function 查找(root, selector) {
  const parts = selector.trim().split(/\s+/);
  const 最后一个 = parts.pop();
  for (const node of 遍历(root)) {
    if (!匹配(node, 最后一个)) continue;
    if (!parts.length) return node;
    const 祖先 = [];
    for (let parent = node.parent; parent; parent = parent.parent) 祖先.push(parent);
    if (parts.every(part => 祖先.some(item => 匹配(item, part)))) return node;
  }
  return null;
}
function 触发(element, type) {
  const handlers = element.listeners[type] || [];
  return Promise.all(handlers.map(handler => handler({ target: element, preventDefault() {} })));
}

async function 打开落地页({ storage = {}, fetchImpl } = {}) {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)][0][1];
  const ids = ['connectForm', 'host', 'uuid', 'remember', 'mergeList', 'mergeLinks', 'mergeStatus', 'mergeCheck', 'mergeCount', 'addMerge', 'clearMerge', 'generateSub', 'selectAll', 'panelVersion'];
  const byId = {};
  for (const id of ids) {
    byId[id] = 建元素(id === 'connectForm' ? 'form' : 'div');
    byId[id].id = id;
  }
  byId.connectForm.tag = 'form';
  byId.mergeStatus.hidden = true;
  byId.mergeCheck.hidden = true;
  byId.remember.type = 'checkbox';
  byId.selectAll.type = 'checkbox';
  const 挂载 = node => { for (const child of node.children || []) { child.parent = node; 挂载(child); } };
  const document = {
    getElementById: id => byId[id] || null,
    createElement: tag => 建元素(tag),
  };
  const store = new Map(Object.entries(storage));
  const localStorage = {
    getItem: key => store.has(key) ? store.get(key) : null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key),
  };
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    return { json: async () => fetchImpl ? fetchImpl(url, options) : { success: true, results: [] } };
  };
  const location = { origin: 'https://panel.example', href: 'https://panel.example/' };
  const navigator = { clipboard: { writeText: async () => {} } };
  new Function('document', 'localStorage', 'fetch', 'navigator', 'location', script)(document, localStorage, fetch, navigator, location);
  挂载(byId.mergeList);
  const 行 = () => byId.mergeList.children.filter(row => row.classes.has('merge-row'));
  return { byId, store, calls, location, 触发, 行 };
}

const uuid = '351c9981-04b6-4103-aa4b-864aa9c91469';
const otherUuid = '67f889ca-63fc-4aee-9454-6a33cf4c9466';

test('旧的记住节点与合并清单迁移成一份清单，勾选状态保留', async () => {
  const page = await 打开落地页({
    storage: {
      'cfnew-panel-nodes': JSON.stringify([{ host: 'a.example.com', uuid }]),
      'cfnew-panel-merge': JSON.stringify([{ host: 'b.example.com', uuid: otherUuid, name: '日本' }]),
    },
  });
  assert.equal(page.行().length, 2, '两条旧记录都要出现在清单里');
  assert.equal(page.行()[0].classes.has('picked'), false, '旧记住节点默认不勾选');
  assert.equal(page.行()[1].classes.has('picked'), true, '旧合并清单继续参与合并');
  assert.equal(page.store.has('cfnew-panel-merge'), false, '迁移后清掉旧的合并 key');
  const saved = JSON.parse(page.store.get('cfnew-panel-nodes'));
  assert.deepEqual(saved.map(node => node.host), ['a.example.com', 'b.example.com']);
  assert.equal(saved[0].name, 'a', '没有标签的旧记录补上域名首段');
  assert.equal(saved[1].name, '日本', '已有的标签保持不变');
});

test('每行都能打开控制台，勾选只用于合并订阅', async () => {
  const nodes = Array.from({ length: 11 }, (_, index) => ({ host: 'w' + index + '.example.com', uuid, checked: index < 1 }));
  const page = await 打开落地页({ storage: { 'cfnew-panel-nodes': JSON.stringify(nodes) } });
  const 第一行 = page.行()[0];
  const openLink = 第一行.children[2].children[0];
  assert.equal(openLink.tag, 'a');
  assert.equal(openLink.target, '_blank');
  assert.equal(openLink.href, '/panel?' + new URLSearchParams({ host: 'w0.example.com', uuid }).toString(), '行内链接带上这一项的域名和 UUID');
  assert.equal(openLink.classes.has('disabled'), false);
  assert.equal(page.byId.generateSub.disabled, false, '勾选一项就能生成订阅');
  page.byId.selectAll.checked = true;
  await 触发(page.byId.selectAll, 'change');
  assert.equal(page.行().length, 11);
  assert.equal(page.byId.generateSub.disabled, true, '超过合并上限要停用生成');
  assert.ok(page.byId.mergeCount.classes.has('over'));
  assert.match(page.byId.mergeCount.textContent, /已选 11 \/ 最多 10/);
  assert.ok(page.行()[0].children[2].children[0].href.startsWith('/panel?'), '行内打开不受勾选影响');
});

test('没填好域名或 UUID 的行，打开按钮不可用', async () => {
  const page = await 打开落地页({ storage: { 'cfnew-panel-nodes': JSON.stringify([{ host: 'a.example.com', uuid: '', checked: true }]) } });
  const openLink = page.行()[0].children[2].children[0];
  assert.equal(openLink.href, undefined);
  assert.equal(openLink.classes.has('disabled'), true);
  assert.equal(openLink['aria-disabled'], 'true');
});

test('加入清单时给默认标签，改域名时跟随，手改后保留', async () => {
  const page = await 打开落地页({ storage: { 'cfnew-panel-nodes': JSON.stringify([{ host: 'a.example.com', uuid }]) } });
  assert.equal(JSON.parse(page.store.get('cfnew-panel-nodes'))[0].name, 'a', '加载时就补上默认标签');
  const row = page.行()[0];
  const hostInput = row.children[1].children[0];
  const nameInput = row.children[1].children[2];
  hostInput.value = 'b.workers.dev';
  await 触发(hostInput, 'input');
  assert.equal(nameInput.value, 'b', '标签跟随域名首段');
  nameInput.value = '香港';
  await 触发(nameInput, 'input');
  hostInput.value = 'c.workers.dev';
  await 触发(hostInput, 'input');
  assert.equal(nameInput.value, '香港', '手动改过的标签不被覆盖');
  const page2 = await 打开落地页();
  page2.byId.host.value = 'hk.workers.dev';
  page2.byId.uuid.value = uuid;
  page2.byId.remember.checked = true;
  await 触发(page2.byId.connectForm, 'submit');
  assert.deepEqual(JSON.parse(page2.store.get('cfnew-panel-nodes')), [{ host: 'hk.workers.dev', uuid, name: 'hk', checked: true }]);
});

test('生成订阅先检查勾选的 Worker，只把在线项写进链接', async () => {
  const page = await 打开落地页({
    storage: {
      'cfnew-panel-nodes': JSON.stringify([
        { host: 'ok.example.com', uuid, name: '在线', checked: true },
        { host: 'bad.example.com', uuid: otherUuid, name: '离线', checked: true },
        { host: 'skip.example.com', uuid, name: '没勾', checked: false },
      ]),
    },
    fetchImpl: () => ({
      success: true,
      results: [
        { host: 'https://ok.example.com', ok: true, ms: 128 },
        { host: 'bad.example.com', ok: false, ms: 20, message: '读取配置失败' },
      ],
    }),
  });
  await 触发(page.byId.generateSub, 'click');
  assert.equal(page.calls.length, 1);
  assert.equal(page.calls[0].url, '/api/merge/check');
  assert.deepEqual(JSON.parse(page.calls[0].options.body), { workers: [{ host: 'ok.example.com', uuid }, { host: 'bad.example.com', uuid: otherUuid }] }, '只检查勾选项');
  assert.equal(page.byId.mergeCheck.hidden, false);
  assert.equal(page.byId.mergeCheck.children.length, 2, '检查结果逐行展示');
  assert.match(page.byId.mergeCheck.children[0].children[1].textContent, /在线 · 128ms/);
  assert.match(page.byId.mergeCheck.children[1].children[1].textContent, /不可用：读取配置失败/);
  const links = page.byId.mergeLinks.children.filter(row => row.classes.has('merge-link'));
  assert.equal(links.length, 6, '每种客户端一条链接');
  const url = new URL(links[1].children[0].href);
  assert.equal(url.pathname, '/merge/sub');
  assert.equal(url.searchParams.get('target'), 'clash');
  const 清单 = JSON.parse(Buffer.from(url.searchParams.get('workers'), 'base64url').toString('utf8'));
  assert.deepEqual(清单, [{ host: 'ok.example.com', uuid, name: '在线' }], '失败的 Worker 不写进链接');
  assert.match(page.byId.mergeStatus.textContent, /已用 1 个在线的 Worker 生成订阅/);
});

test('勾选全失败时不出链接，清单改动后旧链接立即撤掉', async () => {
  const page = await 打开落地页({
    storage: { 'cfnew-panel-nodes': JSON.stringify([{ host: 'bad.example.com', uuid, checked: true }]) },
    fetchImpl: () => ({ success: true, results: [{ host: 'bad.example.com', ok: false, ms: 5, message: '连接 Worker 超时' }] }),
  });
  await 触发(page.byId.generateSub, 'click');
  assert.equal(page.byId.mergeLinks.children.length, 0, '没有在线项就不生成链接');
  assert.match(page.byId.mergeStatus.textContent, /都连不上/);
  // 换成能成功的检查结果，生成链接后再改勾选，旧链接必须消失。
  const page2 = await 打开落地页({
    storage: { 'cfnew-panel-nodes': JSON.stringify([{ host: 'ok.example.com', uuid, checked: true }]) },
    fetchImpl: () => ({ success: true, results: [{ host: 'https://ok.example.com', ok: true, ms: 30 }] }),
  });
  await 触发(page2.byId.generateSub, 'click');
  assert.equal(page2.byId.mergeLinks.children.length, 7, '说明文字加六条链接');
  const row = page2.行()[0];
  const 勾选框 = row.children[0].children[0];
  勾选框.checked = false;
  await 触发(勾选框, 'change');
  assert.equal(page2.byId.mergeLinks.children.length, 0, '清单变化后旧链接不能留着');
  assert.match(page2.byId.mergeStatus.textContent, /重新生成订阅/);
  assert.equal(page2.byId.generateSub.disabled, true, '没有勾选项时不能生成');
});

test('添加 Worker 后焦点落在新加的那一行', async () => {
  const page = await 打开落地页({ storage: { 'cfnew-panel-nodes': JSON.stringify([{ host: 'a.example.com', uuid }]) } });
  await 触发(page.byId.addMerge, 'click');
  const rows = page.行();
  assert.equal(rows.length, 2);
  assert.equal(rows[1].children[1].children[0].focused, true, '焦点在新行的域名输入框');
  assert.notEqual(rows[0].children[1].children[0].focused, true, '不能抢到第一行的焦点');
});

test('删除 Worker 需要二次确认', async () => {
  const page = await 打开落地页({
    storage: { 'cfnew-panel-nodes': JSON.stringify([{ host: 'a.example.com', uuid }, { host: 'b.example.com', uuid: otherUuid }]) },
  });
  const remove = page.行()[0].children[2].children[1];
  await 触发(remove, 'click');
  assert.equal(page.行().length, 2, '第一次点击不删除');
  assert.equal(remove.textContent, '确认删除');
  assert.ok(remove.classes.has('confirming'));
  assert.match(page.byId.mergeStatus.textContent, /确认删除/);
  await 触发(remove, 'click');
  assert.equal(page.行().length, 1, '第二次点击才删除');
  assert.equal(page.行()[0].children[1].children[0].value, 'b.example.com', '删掉的是点中的那一行');
  assert.match(page.byId.mergeStatus.textContent, /已从清单移除/);
});
