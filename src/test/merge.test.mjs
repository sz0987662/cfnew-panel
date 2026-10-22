import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.CFNEW_ALLOW_PRIVATE = 'yes';
const { handlePanel } = await import('../server.mjs');
const { 解析合并清单, 编码合并清单, 生成合并订阅, 默认标签, 合并条目上限 } = await import('../merge.mjs');
const uuid = '351c9981-04b6-4103-aa4b-864aa9c91469';
const otherUuid = '67f889ca-63fc-4aee-9454-6a33cf4c9466';

const 基础配置 = { ev: 'yes', et: 'no', ex: 'no', epi: 'yes', epd: 'no', egi: 'no', ena: 'no' };

function 假加载(映射) {
  return async (workerBase, access) => {
    const 配置 = 映射[workerBase];
    if (!配置) throw new Error('读取配置失败，请确认 Worker 域名、UUID 或自定义路径和核心版本');
    return { ...基础配置, ...配置, uuid: access, kvEnabled: true };
  };
}

function 条目(host, access, prefix) {
  return { workerBase: host, access, prefix };
}

// 用仓库里的隔离内核起一个本地 Worker，活性检查需要真实的配置接口。
async function 起隔离Worker(配置) {
  const source = await readFile(process.env.CFNEW_TEST_CORE || new URL('../../test/core-fixture.mjs', import.meta.url), 'utf8');
  const worker = (await import('data:text/javascript;base64,' + Buffer.from(source.replace(/import\s*\{\s*connect as ([^}]+)\}\s*from\s*['"]cloudflare:sockets['"];/, () => 'const 连接 = () => { throw new Error("此测试不建立代理连接"); };')).toString('base64'))).default;
  const values = new Map([['c', JSON.stringify(配置)]]);
  const storage = { get: async (key, type) => type === 'json' ? JSON.parse(values.get(key) || 'null') : values.get(key), put: async (key, value) => values.set(key, value) };
  const server = createServer(async (incoming, outgoing) => {
    const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const response = await worker.fetch(new Request('http://127.0.0.1' + incoming.url, { method: incoming.method, ...(body.length ? { body } : {}) }), { u: uuid, C: storage });
    const text = await response.text();
    outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(text);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { host: 'http://127.0.0.1:' + server.address().port, close: () => new Promise(resolve => server.close(resolve)) };
}

async function 合并(target, 条目列表, 映射) {
  const request = new Request('https://panel.example/merge/sub?target=' + target);
  return await 生成合并订阅(request, 条目列表, 假加载(映射));
}

test('清单编码与解析互为逆运算，字段缺失时给出明确提示', () => {
  const 原始 = [{ host: 'a.example.com', uuid, name: '香港' }, { host: 'b.example.com', uuid: otherUuid }];
  const 编码 = 编码合并清单(原始);
  const 解析 = 解析合并清单(编码);
  assert.equal(解析.length, 2);
  assert.deepEqual(解析[0], { host: 'a.example.com', uuid, name: '香港', 序号: 0 });
  assert.equal(解析[1].name, '', '没填名字时留空，由域名补默认标签');
  assert.equal(编码合并清单(原始), 编码, '编码结果稳定');
});

test('清单为空、超限、超长或格式错误时拒绝', () => {
  assert.throws(() => 解析合并清单(''), /缺少 Worker 清单/);
  assert.throws(() => 解析合并清单('不是base64'), /格式无效/);
  assert.throws(() => 解析合并清单(编码合并清单([{ host: 'a.example.com' }])), /缺少域名或 UUID/);
  assert.throws(() => 解析合并清单(编码合并清单(Array.from({ length: 合并条目上限 + 1 }, () => ({ host: 'a.example.com', uuid })))), /最多/);
  assert.throws(() => 解析合并清单('x'.repeat(5000)), /过长/);
});

test('多个Worker的节点合并进一份订阅，各自带自己的域名与标签', async () => {
  const 映射 = {
    'https://a.example.com': { yx: '104.16.1.1:443#甲节点' },
    'https://b.example.com': { yx: '104.16.2.2:443#乙节点' }
  };
  const response = await 合并('base64', [
    条目('https://a.example.com', uuid, '[香港] '),
    条目('https://b.example.com', otherUuid, '[日本] ')
  ], 映射);
  assert.equal(response.status, 200);
  const 链接 = atob(await response.text()).trim().split('\n').map(line => new URL(line));
  assert.equal(链接.length, 2);
  assert.equal(链接[0].searchParams.get('host'), 'a.example.com');
  assert.equal(链接[0].username, uuid);
  assert.equal(链接[1].searchParams.get('host'), 'b.example.com');
  assert.equal(链接[1].username, otherUuid, '每个Worker用自己的UUID鉴权');
  const 名称 = 链接.map(link => decodeURIComponent(link.hash.slice(1)));
  assert.ok(名称[0].startsWith('[香港] '), 名称[0]);
  assert.ok(名称[1].startsWith('[日本] '), 名称[1]);
  assert.equal(new Set(名称).size, 2);
});

test('各Worker按自己的配置生成节点，互不串味', async () => {
  const 映射 = {
    'https://a.example.com': { yx: '104.16.1.1:443#甲', et: 'yes' },
    'https://b.example.com': { yx: '104.16.2.2:443#乙', et: 'no', ex: 'yes' }
  };
  const 链接 = atob(await (await 合并('base64', [
    条目('https://a.example.com', uuid, '[A] '),
    条目('https://b.example.com', otherUuid, '[B] ')
  ], 映射)).text()).trim().split('\n').map(line => new URL(line));
  assert.ok(链接.some(link => link.protocol === 'trojan:'), '第一个Worker开启了明文Trojan');
  assert.ok(链接.some(link => link.searchParams.get('type') === 'xhttp'), '第二个Worker开启了XHTTP');
  assert.ok(!链接.filter(link => link.protocol === 'trojan:').some(link => decodeURIComponent(link.hash.slice(1)).startsWith('[B] ')), 'B没开Trojan就不该有Trojan节点');
});

test('Clash只有一份配置，sing-box出站不重名', async () => {
  const 映射 = {
    'https://a.example.com': { yx: '104.16.1.1:443#甲' },
    'https://b.example.com': { yx: '104.16.2.2:443#乙' }
  };
  const 条目列表 = [条目('https://a.example.com', uuid, '[A] '), 条目('https://b.example.com', otherUuid, '[B] ')];
  const yaml = await (await 合并('clash', 条目列表, 映射)).text();
  const 行 = yaml.split('\n');
  assert.equal(行.filter(行值 => 行值 === 'proxies:').length, 1, '只能有一份顶层proxies');
  assert.equal(行.filter(行值 => 行值 === 'proxy-groups:').length, 1, '只能有一份分组');
  assert.equal(行.filter(行值 => 行值.startsWith('  - name: "🚀 节点选择"')).length, 1, '节点选择组只能有一个');
  assert.ok(yaml.includes('[A] 甲-01') && yaml.includes('[B] 乙-01'));
  const data = JSON.parse(await (await 合并('singbox', 条目列表, 映射)).text());
  const tags = data.outbounds.map(outbound => outbound.tag);
  assert.equal(new Set(tags).size, tags.length, '出站标签不能重名');
  const 节点 = data.outbounds.filter(outbound => ['vless', 'trojan'].includes(outbound.type));
  assert.equal(节点.length, 2);
  assert.ok(节点.some(node => node.transport.headers.Host === 'a.example.com'));
  assert.ok(节点.some(node => node.transport.headers.Host === 'b.example.com'));
  const 自动 = data.outbounds.find(outbound => outbound.type === 'urltest');
  assert.deepEqual(自动.outbounds, 节点.map(node => node.tag), '自动选择要覆盖全部节点');
});

test('单个Worker读不到配置时其余照常输出，全部失败才报错', async () => {
  const 映射 = { 'https://a.example.com': { yx: '104.16.1.1:443#甲' } };
  const response = await 合并('base64', [
    条目('https://a.example.com', uuid, '[A] '),
    条目('https://b.example.com', otherUuid, '[B] ')
  ], 映射);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-CFnew-Partial'), '1');
  assert.equal(atob(await response.text()).trim().split('\n').length, 1);
  await assert.rejects(() => 合并('base64', [条目('https://b.example.com', otherUuid, '[B] ')], 映射), /所有 Worker 都读不到配置/);
});

test('默认标签取域名首段，方便没填名字时分辨来源', () => {
  assert.equal(默认标签('https://hk.workers.dev'), 'hk');
  assert.equal(默认标签('https://worker.example.com'), 'worker');
});

test('面板的合并订阅路由按单Worker规则校验域名与UUID', async () => {
  const 带路径 = 编码合并清单([{ host: 'https://a.example.com/path', uuid }]);
  const response = await handlePanel(new Request('https://panel.example/merge/sub?workers=' + 带路径));
  assert.equal(response.status, 400);
  assert.match(await response.text(), /不要带路径/);
  const 缺清单 = await handlePanel(new Request('https://panel.example/merge/sub'));
  assert.equal(缺清单.status, 400);
  assert.match(await 缺清单.text(), /缺少 Worker 清单/);
  const 坏UUID = 编码合并清单([{ host: 'https://a.example.com', uuid: '../etc' }]);
  const 坏 = await handlePanel(new Request('https://panel.example/merge/sub?workers=' + 坏UUID));
  assert.equal(坏.status, 400);
  assert.match(await 坏.text(), /自定义路径格式无效/);
});

test('落地页脚本没有语法错误，前端编码与后端清单一致', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  for (const [, script] of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new Function(script);
  assert.ok(html.includes('mergeList') && html.includes('/merge/sub'), '落地页要有合并订阅入口');
  const 前端编码 = list => {
    const json = JSON.stringify(list.map(node => {
      const item = { host: node.host.trim(), uuid: node.uuid.trim() };
      const name = node.name ? node.name.trim() : '';
      if (name) item.name = name;
      return item;
    }));
    const bytes = new TextEncoder().encode(json);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const 清单 = [{ host: 'a.example.com', uuid, name: '香港' }, { host: 'b.example.com', uuid: otherUuid }];
  assert.equal(前端编码(清单), 编码合并清单(清单), '两端编码必须一致');
  const 解析 = 解析合并清单(前端编码(清单));
  assert.equal(解析[0].name, '香港');
  assert.equal(解析[1].name, '');
});

test('落地页生成的链接能直接被面板处理', async () => {
  const 前端编码 = list => {
    const json = JSON.stringify(list.map(node => ({ host: node.host.trim(), uuid: node.uuid.trim() })));
    const bytes = new TextEncoder().encode(json);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const 参数 = 前端编码([{ host: 'a.example.com', uuid }]);
  const response = await handlePanel(new Request('https://panel.example/merge/sub?workers=' + 参数));
  assert.equal(response.status, 503, '域名读不到配置时给出上游错误而不是崩溃');
  assert.match(await response.text(), /订阅更新失败/);
});

test('生成订阅前的活性检查按勾选顺序返回状态，失败项给出原因', async () => {
  const 甲 = await 起隔离Worker({ d: '/Admin/Panel', ev: 'yes', epi: 'yes', epd: 'no', egi: 'no', ena: 'no', yx: '104.16.1.1:443#甲' });
  try {
    const 检查 = await handlePanel(new Request('https://panel.example/api/merge/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workers: [{ host: 甲.host, uuid }, { host: 'http://127.0.0.1:1', uuid }] })
    }));
    assert.equal(检查.status, 200);
    const 结果 = await 检查.json();
    assert.equal(结果.success, true);
    assert.equal(结果.results.length, 2, '顺序与勾选一致');
    assert.equal(结果.results[0].ok, true);
    assert.ok(Number.isFinite(结果.results[0].ms), '在线项带上面板视角的耗时');
    assert.equal(结果.results[1].ok, false);
    assert.ok(结果.results[1].message, '失败项要给出原因');
  } finally {
    await 甲.close();
  }
});

test('活性检查拒绝空清单、超限和错误方法', async () => {
  const 空 = await handlePanel(new Request('https://panel.example/api/merge/check', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workers: [] })
  }));
  assert.equal(空.status, 400);
  assert.match(await 空.text(), /请先勾选/);
  const 超限 = await handlePanel(new Request('https://panel.example/api/merge/check', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workers: Array.from({ length: 合并条目上限 + 1 }, () => ({ host: 'a.example.com', uuid })) })
  }));
  assert.equal(超限.status, 400);
  assert.match(await 超限.text(), /最多检查/);
  const 方法 = await handlePanel(new Request('https://panel.example/api/merge/check'));
  assert.equal(方法.status, 405);
});

test('固定 w 的面板只允许检查自己的 Worker', async () => {
  process.env.w = 'https://a.example.com';
  try {
    const 响应 = await handlePanel(new Request('https://panel.example/api/merge/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workers: [{ host: 'https://b.example.com', uuid }] })
    }));
    assert.equal(响应.status, 200);
    const 结果 = await 响应.json();
    assert.equal(结果.results[0].ok, false);
    assert.match(结果.results[0].message, /仅允许接入指定的 Worker/);
  } finally {
    delete process.env.w;
  }
});

test('本地隔离Worker的合并订阅可正常生成', async () => {
  const 甲 = await 起隔离Worker({ d: '/Admin/Panel', ev: 'yes', epi: 'yes', epd: 'no', egi: 'no', ena: 'no', yx: '104.16.1.1:443#甲' });
  const 乙 = await 起隔离Worker({ d: '/Admin/Panel', ev: 'yes', epi: 'yes', epd: 'no', egi: 'no', ena: 'no', yx: '104.16.2.2:443#乙' });
  try {
    const 参数 = 编码合并清单([{ host: 甲.host, uuid, name: '甲' }, { host: 乙.host, uuid, name: '乙' }]);
    const response = await handlePanel(new Request('https://panel.example/merge/sub?workers=' + 参数 + '&target=base64'));
    const 内容 = await response.text();
    assert.equal(response.status, 200, 内容);
    const 链接 = atob(内容).trim().split('\n').map(line => new URL(line));
    assert.equal(链接.length, 2);
    assert.ok(链接.every(link => link.username === uuid));
    assert.ok(链接.some(link => decodeURIComponent(link.hash.slice(1)).startsWith('[甲] ')));
    assert.ok(链接.some(link => decodeURIComponent(link.hash.slice(1)).startsWith('[乙] ')));
  } finally {
    await 甲.close(); await 乙.close();
  }
});
