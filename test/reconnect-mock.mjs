/**
 * DWClient 重连逻辑 mock 测试
 *
 * 使用 nock 拦截 HTTP getEndpoint() 请求，本地 WebSocket server 控制连接行为，
 * 直接测试真实 DWClient 构建产物（dist/client.mjs）的重连逻辑。
 *
 * 用法：node test/reconnect-mock.mjs
 * 前提：先执行 pnpm build 生成 dist/
 */

import nock from 'nock';
import { WebSocketServer } from 'ws';
import { DWClient } from '../dist/client.mjs';

const C = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};
const log = (label, msg) => console.log(`[${new Date().toISOString()}] ${label} ${msg}`);

const GATEWAY_HOST = 'https://api.dingtalk.com';
const GATEWAY_PATH = '/v1.0/gateway/connections/open';

// ─── 工具：启动本地 WS server（端口 0 = OS 自动分配，避免端口冲突）────────────
function startWsServer(behavior) {
  /**
   * behavior:
   *   'reject'          - 握手完成后立即 terminate（触发 close after open）
   *   'accept_then_drop'- 接受后 2s 断开（模拟运行中断连）
   */
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 }, () => {
      const { port } = wss.address();
      wss.on('connection', (ws) => {
        if (behavior === 'reject') {
          ws.terminate();
        } else if (behavior === 'accept_then_drop') {
          log(C.yellow('[WS SERVER]'), `客户端连接 (port ${port})，2s 后断开`);
          setTimeout(() => ws.terminate(), 2000);
        }
      });
      resolve({ wss, port });
    });
  });
}

// ─── 工具：优雅关闭 WS server ─────────────────────────────────────────────────
function closeWsServer(wss) {
  return new Promise((resolve) => wss.close(resolve));
}

// ─── 工具：用 nock 拦截 getEndpoint HTTP 请求 ─────────────────────────────────
function mockGateway(wsPort, onCall) {
  nock(GATEWAY_HOST)
    .post(GATEWAY_PATH)
    .reply(() => {
      if (onCall) onCall();
      return [200, {
        endpoint: `ws://127.0.0.1:${wsPort}`,
        ticket: `ticket-${Date.now()}`,
      }];
    })
    .persist();
}

// ─── 断言工具 ──────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(C.green(`  ✓ ${message}`));
    passed++;
  } else {
    console.log(C.red(`  ✗ ${message}`));
    failed++;
  }
}

// ─── 测试 1：连接失败时不产生重连风暴，间隔指数递增 ──────────────────────────
async function test1_noReconnectStorm() {
  console.log('\n' + C.bold('测试 1：连接失败时，connect() 调用次数应线性增长，不爆炸'));

  const { wss, port } = await startWsServer('reject');
  nock.cleanAll();
  let callCount = 0;
  mockGateway(port, () => {
    callCount++;
    log(C.yellow('[NOCK]'), `getEndpoint() 第 ${callCount} 次`);
  });

  const client = new DWClient({ clientId: 'test', clientSecret: 'test' });
  client.connect();

  await new Promise((r) => setTimeout(r, 4000));
  client.disconnect();
  nock.cleanAll();
  await closeWsServer(wss);

  log(C.yellow('[结果]'), `4 秒内 getEndpoint() 调用 ${callCount} 次`);
  assert(callCount >= 2, `调用次数 ${callCount} ≥ 2（确认在重连）`);
  assert(callCount <= 5, `调用次数 ${callCount} ≤ 5（指数退避，无风暴）`);
}

// ─── 测试 2：并发调用 connect() 时，isConnecting 互斥锁只允许一个执行 ─────────
async function test2_noParallelConnect() {
  console.log('\n' + C.bold('测试 2：并发调用 5 次 connect()，只有 1 次真正执行'));

  const { wss, port } = await startWsServer('reject');
  nock.cleanAll();
  let callCount = 0;
  nock(GATEWAY_HOST)
    .post(GATEWAY_PATH)
    .reply(() => {
      callCount++;
      return new Promise((r) =>
        setTimeout(() => r([200, {
          endpoint: `ws://127.0.0.1:${port}`,
          ticket: `ticket-${Date.now()}`,
        }]), 200)
      );
    })
    .persist();

  const client = new DWClient({ clientId: 'test', clientSecret: 'test' });
  await Promise.allSettled(Array.from({ length: 5 }, () => client.connect()));
  await new Promise((r) => setTimeout(r, 500));
  client.disconnect();
  nock.cleanAll();
  await closeWsServer(wss);

  log(C.yellow('[结果]'), `并发 5 次，getEndpoint() 实际执行 ${callCount} 次`);
  assert(callCount === 1, `实际执行次数 ${callCount} = 1（互斥锁生效）`);
}

// ─── 测试 3：连接成功后断开，能正常重连且不产生风暴 ──────────────────────────
async function test3_reconnectAfterDrop() {
  console.log('\n' + C.bold('测试 3：连接成功后服务端断开，应自动重连'));

  const { wss, port } = await startWsServer('accept_then_drop');
  nock.cleanAll();
  let endpointCallCount = 0;
  let wsConnectCount = 0;

  mockGateway(port, () => endpointCallCount++);

  wss.removeAllListeners('connection');
  wss.on('connection', (ws) => {
    wsConnectCount++;
    log(C.yellow('[WS SERVER]'), `第 ${wsConnectCount} 次连接，2s 后断开`);
    setTimeout(() => ws.terminate(), 2000);
  });

  const client = new DWClient({ clientId: 'test', clientSecret: 'test' });
  client.connect();

  await new Promise((r) => setTimeout(r, 7000));
  client.disconnect();
  nock.cleanAll();
  await closeWsServer(wss);

  log(C.yellow('[结果]'), `WS 连接 ${wsConnectCount} 次，getEndpoint() ${endpointCallCount} 次`);
  assert(wsConnectCount >= 2, `WS 连接次数 ${wsConnectCount} ≥ 2（确认重连了）`);
  assert(wsConnectCount <= 4, `WS 连接次数 ${wsConnectCount} ≤ 4（无连接风暴）`);
  assert(endpointCallCount === wsConnectCount, `getEndpoint()(${endpointCallCount}) = WS 次数(${wsConnectCount})`);
}

// ─── 测试 4：disconnect() 后不再触发任何重连 ─────────────────────────────────
async function test4_noReconnectAfterDisconnect() {
  console.log('\n' + C.bold('测试 4：调用 disconnect() 后，不再触发任何重连'));

  const { wss, port } = await startWsServer('reject');
  nock.cleanAll();
  let callCount = 0;
  mockGateway(port, () => {
    callCount++;
    log(C.yellow('[NOCK]'), `getEndpoint() 第 ${callCount} 次`);
  });

  const client = new DWClient({ clientId: 'test', clientSecret: 'test' });
  client.connect();

  await new Promise((r) => setTimeout(r, 500));
  const countAtDisconnect = callCount;
  log(C.yellow('[TEST]'), `disconnect() 前已调用 ${countAtDisconnect} 次`);
  client.disconnect();

  await new Promise((r) => setTimeout(r, 3000));
  nock.cleanAll();
  await closeWsServer(wss);

  log(C.yellow('[结果]'), `disconnect() 后再等 3s，总调用次数 ${callCount}`);
  assert(
    callCount === countAtDisconnect,
    `disconnect() 后无新调用（before=${countAtDisconnect}, after=${callCount}）`
  );
}

// ─── 主入口 ───────────────────────────────────────────────────────────────────
nock.enableNetConnect('127.0.0.1');

await test1_noReconnectStorm();
await test2_noParallelConnect();
await test3_reconnectAfterDrop();
await test4_noReconnectAfterDisconnect();

console.log('\n' + C.bold('─────────────────────────────'));
console.log(C.bold(`测试结果：${C.green(`${passed} 通过`)}，${failed > 0 ? C.red(`${failed} 失败`) : `${failed} 失败`}`));
console.log(C.bold('─────────────────────────────'));

process.exit(failed > 0 ? 1 : 0);
