# 测试说明

本目录包含针对 `DWClient` 重连逻辑的测试脚本，覆盖了历史上出现的重连风暴 bug 及其修复验证。

## 背景

`DWClient` 使用 WebSocket 长连接接收钉钉推送消息，因此断线后必须自动重连。历史代码中存在一个 bug：当 WebSocket 在握手阶段失败时（`error` 事件在 `open` 之前触发），`error` handler 同时走了两条重连路径，导致重连次数以 `2^n` 指数级增长，最终形成重连风暴，表现为大量不同 ticket 的连接疯狂刷出。

## 测试文件说明

| 文件 | 用途 |
|------|------|
| `reconnect-mock.mjs` | **主测试**，使用 nock + 本地 WS server 测试真实 `DWClient` 代码的重连行为 |
| `reconnect-prod.mjs` | **真实鉴权测试**，使用真实 `clientId/clientSecret` 调用 DingTalk 接口，验证真实网络错误场景 |
| `reconnect-storm-demo.mjs` | **Bug 演示**，通过还原旧逻辑直观展示重连风暴现象（不依赖构建产物） |

## 快速开始

```bash
# 安装依赖
pnpm install

# 运行主测试（自动构建 + 执行）
pnpm test

# 运行真实鉴权测试（需要有效的 clientId/clientSecret）
pnpm test:prod

# 演示重连风暴 bug（还原旧逻辑，直观展示指数级增长）
pnpm test:demo bug

# 演示修复后的正确行为
pnpm test:demo fixed
```

## reconnect-mock.mjs — 主测试详解

直接 import `dist/client.mjs`，测试真实代码路径。

### 测试环境搭建方式

- **HTTP 拦截**：使用 `nock` 在 Node.js 网络层拦截 axios 发出的 `POST https://api.dingtalk.com/v1.0/gateway/connections/open` 请求，返回指向本地 WS server 的 endpoint + ticket
- **WebSocket server**：每个测试用例启动独立的本地 WS server（端口由 OS 动态分配，避免端口冲突），由 server 行为控制连接成败

### 测试用例

**测试 1 — 连接失败时不产生重连风暴**

WS server 在握手完成后立即 `terminate()`，触发 `close after open`。
验证 4 秒内 `getEndpoint()` 调用次数在合理范围（2-5 次），间隔应指数递增。

**测试 2 — 并发 connect() 互斥**

同时发起 5 次 `connect()` 调用，`isConnecting` 互斥锁应确保只有 1 次真正执行。

**测试 3 — 断连后正常重连**

WS server 每次接受连接后 2 秒断开，验证 7 秒内发生多次断连→重连，且每次只建立 1 个连接，无风暴。

**测试 4 — disconnect() 后不再重连**

调用 `disconnect()` 后等待 3 秒，验证 `getEndpoint()` 调用次数不再增加。

## reconnect-prod.mjs — 真实鉴权测试详解

使用真实 `clientId/clientSecret` 请求 DingTalk 接口获取 ticket，但将 WS 连接地址替换为本地不存在的端口（`ECONNREFUSED`）。

这个测试覆盖了 mock 测试无法覆盖的代码路径：mock 测试中 WS server 在握手完成后才断开（client 先触发 `open`），而 `ECONNREFUSED` 是 TCP 层直接失败（完全走 `catch` 路径），两者触发的是不同的重连逻辑分支。

**运行前提**：需要将有效的 `clientId` / `clientSecret` 填写到 `example/config.json`。

```json
{
  "clientId": "your-client-id",
  "clientSecret": "your-client-secret"
}
```

**预期输出**：10 秒内 `getEndpoint()` 调用 3 次左右，且重连间隔逐渐递增（指数退避）。

## reconnect-storm-demo.mjs — Bug 演示

通过在脚本内部还原旧代码逻辑来直观展示两种行为的对比，不依赖构建产物，无需 `pnpm build`。

```bash
# 复现 bug：1.3 秒内触发 60+ 次 connect()
node test/reconnect-storm-demo.mjs bug

# 验证修复：线性增长 + 断连后正常重连
node test/reconnect-storm-demo.mjs fixed
```

## 重连策略说明

修复后的重连行为：

| 失败次数 | 等待时间（约） |
|---------|--------------|
| 第 1 次 | 1 ~ 2 秒 |
| 第 2 次 | 2 ~ 3 秒 |
| 第 3 次 | 4 ~ 5 秒 |
| 第 4 次 | 8 ~ 9 秒 |
| 第 5 次 | 16 ~ 17 秒 |
| 第 6 次起 | 最大 60 秒 |

等待时间 = `min(1000 × 2^n + random(0~1000ms), 60000ms)`，加随机抖动防止多客户端同时重连（惊群效应）。
