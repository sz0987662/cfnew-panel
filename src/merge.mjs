// 合并多个 Worker 的节点到一个订阅。
// Worker 清单随订阅链接一起传，落地页负责生成，客户端直接订阅。
// 清单只带域名、UUID 和标签，不含任何面板配置，面板本身仍然不落库。

import { createSubscriptionEngine } from './engine.mjs';

export const 合并条目上限 = 10;
export const 合并参数上限 = 4096;
export const 合并标签上限 = 32;

// 解析订阅链接里的 Worker 清单。
// 这里只做结构与数量校验，域名和 UUID 的合法性由调用方按既有规则复核。
export function 解析合并清单(参数值) {
  const 原文 = String(参数值 || '').trim();
  if (!原文) throw new Error('缺少 Worker 清单');
  if (原文.length > 合并参数上限) throw new Error('Worker 清单过长');
  let 数据;
  try {
    数据 = JSON.parse(Buffer.from(原文, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Worker 清单格式无效');
  }
  if (!Array.isArray(数据)) throw new Error('Worker 清单格式无效');
  if (!数据.length) throw new Error('Worker 清单是空的');
  if (数据.length > 合并条目上限) throw new Error('Worker 最多 ' + 合并条目上限 + ' 个');
  return 数据.map((项, 序号) => {
    if (!项 || typeof 项 !== 'object' || Array.isArray(项)) throw new Error('Worker 清单格式无效');
    const host = String(项.host || '').trim();
    const uuid = String(项.uuid || '').trim();
    if (!host || !uuid) throw new Error('Worker 清单缺少域名或 UUID');
    const name = String(项.name || '').trim().slice(0, 合并标签上限);
    return { host, uuid, name, 序号 };
  });
}

// 清单编码，与解析互为逆运算。落地页用等价的浏览器实现生成链接。
export function 编码合并清单(条目列表) {
  const 精简 = 条目列表.map(项 => {
    const 条目 = { host: String(项.host || '').trim(), uuid: String(项.uuid || '').trim() };
    const name = String(项.name || '').trim().slice(0, 合并标签上限);
    if (name) 条目.name = name;
    return 条目;
  });
  return Buffer.from(JSON.stringify(精简), 'utf8').toString('base64url');
}

// 缺省标签取域名的第一段，落地页没填名字时也能分清来源。
export function 默认标签(workerBase) {
  let 主机 = String(workerBase || '');
  try { 主机 = new URL(workerBase).hostname; } catch {}
  const 段 = 主机.split('.').filter(Boolean);
  return (段.length > 1 ? 段[0] : 段[0] || '节点').slice(0, 合并标签上限);
}

// 生成合并订阅。加载配置由调用方注入，沿用面板既有的域名校验与公网校验。
// 单个 Worker 读不到配置时不影响其余 Worker，全部失败才报错。
export async function 生成合并订阅(request, 条目列表, 加载配置) {
  const 结果 = await Promise.allSettled(条目列表.map(async (条目) => {
    const config = await 加载配置(条目.workerBase, 条目.access);
    return { ...条目, config };
  }));
  const 成功 = [];
  const 失败 = [];
  结果.forEach((项, 序号) => {
    if (项.status === 'fulfilled') 成功.push(项.value);
    else {
      const 原因 = 项.reason && 项.reason.message ? 项.reason.message : '读取配置失败';
      失败.push(条目列表[序号].workerBase + '：' + 原因);
    }
  });
  if (!成功.length) throw new Error('所有 Worker 都读不到配置：' + 失败.join('；'));
  const engine = createSubscriptionEngine(成功[0].config, 成功[0].config.uuid || 成功[0].uuid);
  const response = await engine.subscribeMerged(request, 成功.map(项 => ({
    config: 项.config,
    // 自定义路径登录时真实 UUID 由 Worker 返回，这里用 Worker 给的值。
    uuid: 项.config.uuid || 项.uuid,
    workerBase: 项.workerBase,
    prefix: 项.prefix
  })));
  if (失败.length) {
    response.headers.set('X-CFnew-Partial', '1');
    response.headers.set('X-CFnew-Failed', String(失败.length));
  }
  return response;
}
