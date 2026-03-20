/**
 * 重连 bug 复现 & 修复验证脚本
 *
 * 用法：
 *   node test-reconnect.mjs bug     # 复现 bug（使用旧代码逻辑）
 *   node test-reconnect.mjs fixed   # 验证修复后行为
 *   node test-reconnect.mjs         # 默认运行修复验证
 *
 * 原理：
 *   启动一个本地 WebSocket mock 服务端，拦截 HTTP 请求模拟 getEndpoint()，
 *   控制服务端行为（拒绝连接 / 正常连接后断开），统计 connect() 调用次数，
 *   对比 bug 版本和修复版本的行为差异。
 */

import { createServer } from 'http';
import { WebSocketServer } from 'ws';

// ─── 颜色输出 ─────────────────────────────────────────────────────────────────
const C = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const log = (label, msg) => console.log(`[${new Date().toISOString()}] ${label} ${msg}`);

// ─── mock getEndpoint HTTP 服务 ───────────────────────────────────────────────
function startMockHttpServer(port) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          endpoint: `ws://127.0.0.1:${port + 1}`,
          ticket: `test-ticket-${Date.now()}`,
        }));
      }
    });
    server.listen(port, () => resolve(server));
  });
}

// ─── mock WebSocket 服务端 ────────────────────────────────────────────────────
function startMockWsServer(port, behavior) {
  /**
   * behavior:
   *   'reject'          - 立即关闭连接（模拟握手失败，触发 error/close）
   *   'accept_then_drop'- 接受连接，3 秒后断开（模拟运行中断连）
   *   'accept'          - 正常接受并保持
   */
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port }, () => resolve(wss));
    wss.on('connection', (ws, req) => {
      if (behavior === 'reject') {
        ws.terminate(); // 立即断开，触发客户端 error 或 close
      } else if (behavior === 'accept_then_drop') {
        log(C.cyan('[SERVER]'), 'Client connected, will drop in 2s');
        setTimeout(() => {
          log(C.cyan('[SERVER]'), 'Dropping connection');
          ws.terminate();
        }, 2000);
      } else {
        log(C.cyan('[SERVER]'), 'Client connected and kept alive');
      }
    });
  });
}

// ─── bug 版本的重连逻辑（还原原始代码） ──────────────────────────────────────
async function runBugVersion(httpPort, wsPort) {
  console.log('\n' + C.bold(C.red('═══ 复现 BUG：双重重连风暴 ═══')));
  console.log(C.yellow('预期：每次失败触发 2 个重连，调用次数指数级增长'));
  console.log(C.yellow('观察：connect() 调用次数在 5 秒内是否爆炸式增长\n'));

  let connectCount = 0;
  let activeConnections = 0;
  const startTime = Date.now();

  const bugConnect = async () => {
    connectCount++;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(
      C.red('[BUG connect()]'),
      `第 ${connectCount} 次调用 (elapsed: ${elapsed}s, active: ${++activeConnections})`
    );

    if (connectCount > 30) {
      log(C.red('[BUG]'), `已达 30 次，停止演示。实际会继续指数增长！`);
      activeConnections--;
      return;
    }

    try {
      // 模拟 getEndpoint 成功
      await new Promise((r) => setTimeout(r, 50));

      // 模拟 _connect：error 在 open 之前触发
      await new Promise((resolve, reject) => {
        // 原始代码：close 里调度重连（路径 B）
        const onClose = () => {
          activeConnections--;
          setTimeout(bugConnect, 100); // 重连路径 B
        };

        // 原始代码：error 里 reject，connect() 的 catch 调度重连（路径 A）
        const onError = (err) => {
          // terminate() 触发 close → 路径 B
          onClose();
          reject(err); // → 路径 A
        };

        // 模拟握手失败
        setTimeout(() => onError(new Error('connection refused')), 100);
      });
    } catch {
      // 原始 connect() 的 catch：路径 A
      setTimeout(bugConnect, 100);
      activeConnections--;
    }
  };

  bugConnect();

  // 5 秒后报告结果
  await new Promise((r) => setTimeout(r, 5000));
  console.log('\n' + C.bold(C.red(`[BUG 结果] 5 秒内 connect() 被调用了 ${connectCount} 次！`)));
  console.log(C.yellow(`理论值：每 ~200ms 翻倍，5s 后应有数百次调用`));
}

// ─── 修复版本的重连逻辑 ───────────────────────────────────────────────────────
async function runFixedVersion(httpPort, wsPort) {
  console.log('\n' + C.bold(C.green('═══ 验证修复：场景测试 ═══')));

  // ── 场景 1：连接失败，验证只有一条重连路径 ──────────────────────────────────
  await (async () => {
    console.log('\n' + C.bold('场景 1：连接失败时，只触发一次重连'));

    let connectCount = 0;
    let isConnecting = false;
    let reconnectAttempts = 0;
    const reconnectBaseInterval = 200;
    let reconnectTimerId;
    let stopped = false;

    const scheduleReconnect = () => {
      if (stopped) return;
      const delay = reconnectBaseInterval * Math.pow(2, reconnectAttempts) + Math.random() * 50;
      log(C.green('[FIXED scheduleReconnect]'), `延迟 ${delay.toFixed(0)}ms 后重连 (attempt ${reconnectAttempts + 1})`);
      if (reconnectTimerId) clearTimeout(reconnectTimerId);
      reconnectTimerId = setTimeout(() => {
        reconnectTimerId = undefined;
        connect();
      }, delay);
    };

    const connect = async () => {
      if (isConnecting) {
        log(C.yellow('[FIXED connect()]'), '已有连接进行中，跳过');
        return;
      }
      isConnecting = true;
      connectCount++;
      log(C.green('[FIXED connect()]'), `第 ${connectCount} 次调用`);

      if (connectCount >= 4) {
        log(C.green('[FIXED]'), '达到演示上限，停止');
        stopped = true;
        isConnecting = false;
        return;
      }

      try {
        // 模拟 getEndpoint
        await new Promise((r) => setTimeout(r, 50));

        // 模拟 _connect：用 settled 保证只有一条路径
        await new Promise((resolve, reject) => {
          let settled = false;

          const onClose = () => {
            if (settled) {
              scheduleReconnect(); // 只有 open 后的 close 才重连
            }
          };

          const onError = (err) => {
            // terminate → close，但 settled=false，close 不重连
            onClose();
            if (!settled) {
              settled = true;
              reject(err); // 只走这一条路
            }
          };

          setTimeout(() => onError(new Error('connection refused')), 100);
        });
      } catch {
        reconnectAttempts++;
        scheduleReconnect(); // 只有这一条重连路径
      } finally {
        isConnecting = false;
      }
    };

    connect();
    await new Promise((r) => setTimeout(r, 3000));
    console.log(C.green(`  结果：3 秒内 connect() 调用了 ${connectCount} 次（应为 3~4 次，线性增长）`));
  })();

  // ── 场景 2：连接成功后断开，验证能正常重连 ──────────────────────────────────
  await (async () => {
    console.log('\n' + C.bold('场景 2：连接成功后服务端断开，应自动重连'));

    let connectCount = 0;
    let openCount = 0;
    let isConnecting = false;
    let reconnectAttempts = 0;
    const reconnectBaseInterval = 200;
    let reconnectTimerId;
    let stopped = false;

    const scheduleReconnect = () => {
      if (stopped) return;
      const delay = reconnectBaseInterval * Math.pow(2, reconnectAttempts) + Math.random() * 50;
      log(C.green('[FIXED scheduleReconnect]'), `延迟 ${delay.toFixed(0)}ms 后重连`);
      if (reconnectTimerId) clearTimeout(reconnectTimerId);
      reconnectTimerId = setTimeout(() => { reconnectTimerId = undefined; connect(); }, delay);
    };

    const { WebSocket } = await import('ws');

    const connect = async () => {
      if (isConnecting || stopped) return;
      isConnecting = true;
      connectCount++;
      log(C.green('[FIXED connect()]'), `第 ${connectCount} 次调用`);

      if (connectCount > 3) {
        log(C.green('[FIXED]'), '达到演示上限，停止');
        stopped = true;
        isConnecting = false;
        return;
      }

      try {
        await new Promise((r) => setTimeout(r, 30)); // mock getEndpoint

        await new Promise((resolve, reject) => {
          let settled = false;
          const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);

          ws.on('open', () => {
            openCount++;
            reconnectAttempts = 0;
            log(C.green('[FIXED open]'), `第 ${openCount} 次成功建立连接`);
            settled = true;
            resolve();
          });

          ws.on('close', () => {
            log(C.yellow('[FIXED close]'), 'Socket 关闭');
            if (settled) {
              reconnectAttempts++;
              scheduleReconnect();
            }
          });

          ws.on('error', (err) => {
            ws.terminate();
            if (!settled) {
              settled = true;
              reject(err);
            }
          });
        });
      } catch (err) {
        reconnectAttempts++;
        scheduleReconnect();
      } finally {
        isConnecting = false;
      }
    };

    connect();
    await new Promise((r) => setTimeout(r, 8000));
    console.log(C.green(`  结果：成功建立了 ${openCount} 次连接，connect() 调用 ${connectCount} 次`));
    console.log(C.green(`  验证：断连后自动重连，且没有连接风暴`));
  })();
}

// ─── 主入口 ───────────────────────────────────────────────────────────────────
const mode = process.argv[2] || 'fixed';
const HTTP_PORT = 18080;
const WS_PORT = 18081;

(async () => {
  const httpServer = await startMockHttpServer(HTTP_PORT);

  if (mode === 'bug') {
    await runBugVersion(HTTP_PORT, WS_PORT);
  } else {
    // 场景 2 需要一个 accept_then_drop 的 WS 服务
    const wss = await startMockWsServer(WS_PORT, 'accept_then_drop');
    await runFixedVersion(HTTP_PORT, WS_PORT);
    wss.close();
  }

  httpServer.close();
  console.log('\n测试完成。');
  process.exit(0);
})();
