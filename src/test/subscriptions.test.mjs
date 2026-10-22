import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSubscriptionEngine } from '../engine.mjs';
const uuid = '351c9981-04b6-4103-aa4b-864aa9c91469';
const config = { epd: 'no', epi: 'yes', egi: 'no', ena: 'no', ev: 'yes', et: 'yes', ex: 'yes', yx: '104.16.1.1:443#验证节点' };
async function subscription(target, overrides = {}) {
  const response = await createSubscriptionEngine({ ...config, ...overrides }, uuid).subscribe(new Request('https://worker.example/' + uuid + '/sub?target=' + target));
  assert.equal(response.status, 200);
  return response.text();
}
test('sing-box分流自包含，DNS直连不通过冗余direct出站', async () => {
  const data = JSON.parse(await subscription('singbox'));
  assert.ok(data.route.rule_set.length > 10, '保留完整服务分类');
  assert.ok(data.route.rule_set.every(rule => rule.type === 'inline'), '启动不依赖远端规则下载');
  assert.ok(data.dns.servers.every(server => server.detour !== 'direct'), '实际启动不能给空direct出站设置detour');
  assert.ok(data.dns.servers.some(server => server.tag === 'local'));
});
test('sing-box节点保留真实传输，分组引用完整且支持自动选择', async () => {
  const data = JSON.parse(await subscription('sing-box'));
  const tags = data.outbounds.map(outbound => outbound.tag);
  assert.equal(new Set(tags).size, tags.length);
  const nodes = data.outbounds.filter(outbound => ['vless', 'trojan'].includes(outbound.type));
  assert.ok(nodes.length > 0);
  for (const node of nodes) {
    assert.equal(Object.hasOwn(node, 'packet_encoding'), false);
    assert.equal(node.transport.type, 'ws');
    assert.equal(node.transport.headers.Host, 'worker.example');
  }
  const auto = data.outbounds.find(outbound => outbound.type === 'urltest');
  assert.ok(auto);
  assert.deepEqual(auto.outbounds, nodes.map(node => node.tag));
  for (const outbound of data.outbounds) for (const tag of outbound.outbounds || []) assert.ok(tags.includes(tag), '不能引用不存在的出站');
  for (const rule of data.route.rules) if (rule.outbound) assert.ok(tags.includes(rule.outbound));
});
test('Clash自动选择回到主选择组，手动节点继续保留', async () => {
  const yaml = await subscription('clash');
  assert.ok(/name: "♻️ 自动选择"\n\s+type: url-test/.test(yaml), '缺少url-test自动组');
  const main = yaml.match(/name: "🚀 节点选择"([\s\S]*?)(?=  - name:)/)?.[1];
  assert.ok(main?.includes('"♻️ 自动选择"'));
  assert.match(main, /CF|验证节点/);
});

test('节点名与分组撞名时保持唯一，IPv6和明文木马保留正确配置', async () => {
  const { buildSingboxConfig } = await import('../singbox.mjs');
  const nodes = [
    { proto: 'vless', name: 'select', server: '[2606:4700::1111]', port: 443, uuid, tls: true, network: 'ws', host: 'worker.example', sni: 'worker.example', path: '/entry', alpn: ['h2'] },
    { proto: 'vless', name: 'select', server: '104.16.1.1', port: 443, uuid, tls: true, network: 'ws', host: 'worker.example', sni: 'worker.example', path: '/entry', ech: '已开启' },
    { proto: 'trojan', name: '♻️ 自动选择', server: '104.16.1.1', port: 80, password: uuid, tls: true, security: 'none', network: 'ws', host: 'worker.example', path: '/entry' },
  ];
  const data = buildSingboxConfig(nodes, { dns: 'https://[2606:4700:4700::1111]/dns-query' });
  const leaves = data.outbounds.filter(node => ['vless', 'trojan'].includes(node.type));
  assert.equal(new Set(data.outbounds.map(node => node.tag)).size, data.outbounds.length);
  assert.equal(leaves[0].server, '2606:4700::1111');
  assert.deepEqual(leaves[0].tls.alpn, ['h2']);
  assert.deepEqual(leaves[1].tls.ech, { enabled: true });
  assert.equal(Object.hasOwn(leaves[2], 'tls'), false);
  assert.ok(data.dns.rules.some(rule => rule.domain?.includes('worker.example') && rule.server === 'local'));
});

test('空节点配置仍可启动，DNS地址错误有明确反馈', async () => {
  const { buildSingboxConfig } = await import('../singbox.mjs');
  const empty = buildSingboxConfig([]);
  assert.equal(empty.outbounds.find(node => node.tag === 'select').default, 'direct');
  assert.ok(empty.outbounds.every(node => node.type !== 'urltest'));
  assert.throws(() => buildSingboxConfig([], { dns: 'ftp://example.com' }), /DNS地址格式无效/);
  assert.equal(buildSingboxConfig([], { dns: '8.8.8.8' }).dns.servers[1].type, 'tcp');
  assert.equal(buildSingboxConfig([], { dns: 'h3://223.5.5.5/dns-query' }).dns.servers[1].type, 'https');
  assert.equal(buildSingboxConfig([], { dns: '2001:4860:4860::8888' }).dns.servers[1].server, '2001:4860:4860::8888');
  assert.equal(buildSingboxConfig([], { dns: 'https://resolver.example/dns-query?mode=normal' }).dns.servers[1].path, '/dns-query?mode=normal');
  assert.throws(() => buildSingboxConfig([], { dns: 'quic://example.com' }), /不能转发QUIC DNS/);
});

test('其它客户端生成结果保持原样', async () => {
  // 固定重写前的真实输出，保护其它客户端。
  const hashes = {"base64": "d3d5937fc19aba4cac7687915009441bae2830cc1292da198d1e7546ebaaad04", "v2ray": "d3d5937fc19aba4cac7687915009441bae2830cc1292da198d1e7546ebaaad04", "surge": "fbc1b103318b743145db4c446ece58ea5baaec8ef4a08bdb444c07e3e2697533", "loon": "12164d4e0bcead8288b5a7b898316d7277ce0bc919b687a26ddabbacfb799070", "quanx": "e336fe3da03494264cf3d3794b91732cd33d0809516265a459c7b8e734f1eb3b"};
  for (const [target, expected] of Object.entries(hashes)) {
    assert.equal(createHash("sha256").update(await subscription(target)).digest("hex"), expected, target);
  }
});

test('压缩与完整IPv6均保留自定义名称，跨协议重名自动编号', async () => {
  const yx = '[2606:4700::1111]:443#我的IPv6\n[2606:4700:0000:0000:0000:0000:0000:1001]:8443#我的IPv6';
  const text = Buffer.from(await subscription('base64', { yx }), 'base64').toString('utf8');
  const links = text.trim().split('\n').map(link => new URL(link));
  assert.equal(links.length, 6, '两条IPv6分别生成VLESS、Trojan和XHTTP');
  assert.ok(links.every(link => link.hostname.includes(':')));
  const names = links.map(link => decodeURIComponent(link.hash.slice(1)));
  assert.ok(names.every(name => name.startsWith('我的IPv6-')));
  assert.equal(new Set(names).size, names.length);
  for (const target of ['clash', 'singbox', 'surge', 'loon', 'quanx']) {
    const converted = await subscription(target, { yx });
    assert.match(converted, /我的IPv6-\d+/, target);
    assert.ok(!converted.includes('IPv6优选'), target);
  }
});

test('没有备注的压缩IPv6仍生成默认名称，裸地址不误拆端口', async () => {
  const text = Buffer.from(await subscription('base64', { yx: '2606:4700::1111', et: 'no', ex: 'no' }), 'base64').toString('utf8');
  const links = text.trim().split('\n').map(link => new URL(link));
  assert.equal(links.length, 2);
  assert.ok(links.every(link => link.hostname === '[2606:4700::1111]'));
  assert.ok(links.every(link => decodeURIComponent(link.hash.slice(1)).startsWith('IPv6优选-')));
});

test('域名节点沿用自定义名字，同名自动编号，未命名仍是优选域名', async () => {
  const 覆盖 = { yx: 'a.example.com:443#我的域名\nb.example.com:8443#我的域名\nc.example.com:443', et: 'no', ex: 'no', epd: 'yes', epi: 'yes' };
  const text = Buffer.from(await subscription('base64', 覆盖), 'base64').toString('utf8');
  const 名称列表 = text.trim().split('\n').map(link => decodeURIComponent(new URL(link).hash.slice(1)));
  assert.deepEqual(名称列表, ['我的域名-01', '我的域名-02', '优选域名-01'], '同名域名按编号区分，没填名字的保持原名');
  for (const target of ['clash', 'singbox', 'loon', 'quanx']) {
    const converted = await subscription(target, 覆盖);
    for (const 名称 of 名称列表) assert.ok(converted.includes(名称), target + ' 缺少 ' + 名称);
  }
  // Surge 只收 Trojan 节点，名字同样沿用自定义值。
  assert.match(await subscription('surge', { ...覆盖, et: 'yes' }), /我的域名-\d+/);
  const 内置 = Buffer.from(await subscription('base64', { et: 'no', ex: 'no', yx: '', epd: 'yes', epi: 'no', egi: 'no' }), 'base64').toString('utf8');
  const 内置名称 = 内置.trim().split('\n').map(link => decodeURIComponent(new URL(link).hash.slice(1)));
  assert.ok(内置名称.every(名称 => /^优选域名-\d+$/.test(名称)), '内置域名列表保持优选域名-NN');
});
