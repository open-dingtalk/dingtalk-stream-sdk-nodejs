/**
 * 真实生产环境复现测试
 *
 * 使用真实 clientId/clientSecret 请求真实 DingTalk getEndpoint()，
 * 然后把 WS 连接地址替换成本地拒绝连接的端口，触发真实的 error-before-open 路径。
 *
 * 这样可以验证：
 *   1. 真实鉴权流程是否正常
 *   2. WS 连接失败时重连行为是否符合预期（不爆炸）
 *
 * 用法：
 *   node test-reconnect-prod.mjs
 */

import { DWClient } from '../dist/client.mjs';
import config from '../example/config.json' assert { type: 'json' };

const C = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};
const log = (label, msg) => console.log(`[${new Date().toISOString()}] ${label} ${msg}`);

// ─── 关键：monkey-patch getEndpoint，让它用真实鉴权，但把 WS 地址替换成本地坏端口 ──
// 本地 19999 端口没有任何服务在监听，连接会立即被拒绝（ECONNREFUSED）
// 这比 DingTalk 服务器的真实故障更快触发、更可控
const BAD_PORT = 19999;

async function runTest() {
  console.log(C.bold('\n═══ 真实鉴权 + 连接失败 复现测试 ═══\n'));
  console.log(`clientId: ${config.clientId}`);
  console.log(`将使用真实 getEndpoint() 获取 ticket，但把 WS 地址替换为 ws://127.0.0.1:${BAD_PORT}（必然失败）\n`);

  let connectCallCount = 0;
  const connectTimestamps = [];

  const client = new DWClient({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    debug: false,
  });

  // patch getEndpoint：调真实接口，但覆盖 dw_url
  const originalGetEndpoint = client.getEndpoint.bind(client);
  client.getEndpoint = async function () {
    connectCallCount++;
    connectTimestamps.push(Date.now());
    log(C.yellow(`[getEndpoint #${connectCallCount}]`), '调用真实 DingTalk 接口...');

    await originalGetEndpoint(); // 真实 HTTP 请求

    // 覆盖 WS 地址为必然失败的端口
    client._dw_url_backup = client.dw_url;
    // 访问私有属性（测试用途）
    Object.defineProperty(client, 'dw_url', {
      value: `ws://127.0.0.1:${BAD_PORT}`,
      writable: true,
      configurable: true,
    });

    log(C.yellow(`[getEndpoint #${connectCallCount}]`), `真实 ticket 获取成功，WS 地址已替换为 ws://127.0.0.1:${BAD_PORT}`);
    return client;
  };

  log(C.bold('[START]'), '开始连接，观察 10 秒内的重连行为...\n');
  client.connect();

  await new Promise((r) => setTimeout(r, 10000));
  client.disconnect();

  // ─── 分析结果 ───────────────────────────────────────────────────────────────
  console.log('\n' + C.bold('─── 分析结果 ───'));
  log(C.yellow('[统计]'), `10 秒内 getEndpoint() 被调用了 ${connectCallCount} 次`);

  if (connectTimestamps.length >= 2) {
    const intervals = [];
    for (let i = 1; i < connectTimestamps.length; i++) {
      intervals.push(((connectTimestamps[i] - connectTimestamps[i - 1]) / 1000).toFixed(1) + 's');
    }
    log(C.yellow('[间隔]'), `每次重连间隔: ${intervals.join(' → ')}`);
  }

  // 判断结果
  const isStorm = connectCallCount > 8;
  const hasBackoff = connectTimestamps.length >= 3
    ? (connectTimestamps[2] - connectTimestamps[1]) > (connectTimestamps[1] - connectTimestamps[0])
    : true;

  console.log('\n' + C.bold('─── 判断 ───'));
  if (isStorm) {
    console.log(C.red(`✗ 重连风暴！10 秒内调用 ${connectCallCount} 次，存在 bug`));
  } else {
    console.log(C.green(`✓ 无重连风暴，10 秒内仅调用 ${connectCallCount} 次`));
  }

  if (hasBackoff) {
    console.log(C.green(`✓ 指数退避生效，重连间隔递增`));
  } else {
    console.log(C.red(`✗ 指数退避未生效，间隔相同`));
  }

  process.exit(isStorm ? 1 : 0);
}

runTest().catch((err) => {
  console.error(C.red('测试失败:'), err.message);
  console.error(C.yellow('提示：请确认 example/config.json 中的 clientId/clientSecret 有效'));
  process.exit(1);
});
