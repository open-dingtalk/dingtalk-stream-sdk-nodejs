import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import nock from 'nock';
import { WebSocketServer } from 'ws';
import { DWClient, EventAck } from '../dist/client.mjs';

const gatewayHost = 'https://api.dingtalk.com';
const gatewayPath = '/v1.0/gateway/connections/open';

function mockGateway(endpoint) {
  return nock(gatewayHost)
    .post(gatewayPath)
    .reply(200, {
      endpoint,
      ticket: 'test-ticket',
    });
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  });
}

async function testSubscriptionsAreIsolated() {
  const first = new DWClient({ clientId: 'first', clientSecret: 'secret' });
  const second = new DWClient({ clientId: 'second', clientSecret: 'secret' });

  first.registerCallbackListener('callback-topic', () => undefined);
  assert.equal(first.getConfig().subscriptions.length, 2);
  assert.equal(second.getConfig().subscriptions.length, 1);

  const exportedConfig = first.getConfig();
  exportedConfig.subscriptions.push({ type: 'CALLBACK', topic: 'external-mutation' });
  assert.equal(first.getConfig().subscriptions.length, 2);
}

async function testDisconnectAbortsOpeningHandshake() {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  mockGateway(`ws://127.0.0.1:${port}`);
  const client = new DWClient({ clientId: 'test', clientSecret: 'secret' });
  const connectPromise = client.connect();
  while (sockets.size === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  client.disconnect();
  await Promise.race([
    connectPromise,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('connect() remained pending after disconnect()')),
      1000,
    )),
  ]);

  assert.equal(client.connected, false);
  assert.equal(client.isConnecting, false);
  assert.equal(nock.isDone(), true);

  for (const socket of sockets) socket.destroy();
  await closeServer(server);
  nock.cleanAll();
}

async function testAsyncEventListenerIsAwaited() {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, 'listening');
  const { port } = wss.address();

  mockGateway(`ws://127.0.0.1:${port}`);
  const client = new DWClient({ clientId: 'test', clientSecret: 'secret' });
  client.registerAllEventListener(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { status: EventAck.LATER, message: 'retry later' };
  });

  const serverSocketPromise = once(wss, 'connection');
  await client.connect();
  const [serverSocket] = await serverSocketPromise;
  const ackPromise = once(serverSocket, 'message');
  serverSocket.send(JSON.stringify({
    specVersion: '1.0',
    type: 'EVENT',
    headers: {
      messageId: 'message-id',
      topic: 'event-topic',
    },
    data: '{}',
  }));

  const [ackData] = await ackPromise;
  const ack = JSON.parse(ackData.toString());
  assert.equal(ack.headers.messageId, 'message-id');
  assert.deepEqual(JSON.parse(ack.data), {
    status: EventAck.LATER,
    message: 'retry later',
  });

  client.disconnect();
  await closeServer(wss);
  nock.cleanAll();
}

nock.disableNetConnect();
nock.enableNetConnect('127.0.0.1');

await testSubscriptionsAreIsolated();
await testDisconnectAbortsOpeningHandshake();
await testAsyncEventListenerIsAwaited();

console.log('Lifecycle regression tests passed.');
