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

async function waitFor(predicate, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('condition timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForPromise(promise, description, timeout = 2000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${description} timed out`)),
          timeout,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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

async function testCallbackCanBeRemovedByOriginalListener() {
  const client = new DWClient({ clientId: 'test', clientSecret: 'secret' });
  let callbackCalls = 0;
  const callback = () => {
    callbackCalls++;
  };
  client.registerCallbackListener('removable-topic', callback);

  assert.equal(client.listeners('removable-topic')[0], callback);
  client.off('removable-topic', callback);
  client.onCallback({
    specVersion: '1.0',
    type: 'CALLBACK',
    headers: {
      messageId: 'removed-callback',
      topic: 'removable-topic',
    },
    data: '{}',
  });

  assert.equal(callbackCalls, 0);
  assert.equal(client.listenerCount('removable-topic'), 0);
}

async function testAsyncCallbackRejectionIsHandled() {
  const client = new DWClient({ clientId: 'test', clientSecret: 'secret' });
  const callbackError = new Error('async callback failed');
  const warnings = [];
  let unhandledRejection;
  const originalWarn = console.warn;
  const onUnhandledRejection = (reason) => {
    unhandledRejection = reason;
  };

  console.warn = (...args) => warnings.push(args);
  process.on('unhandledRejection', onUnhandledRejection);
  try {
    client.registerCallbackListener('callback-topic', async () => {
      throw callbackError;
    });
    client.onCallback({
      specVersion: '1.0',
      type: 'CALLBACK',
      headers: {
        messageId: 'callback-message-id',
        topic: 'callback-topic',
      },
      data: '{}',
    });

    await waitFor(() => warnings.length === 1);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(warnings[0][0], 'Callback listener failed for topic callback-topic');
    assert.equal(warnings[0][1], callbackError);
    assert.equal(unhandledRejection, undefined);
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
    console.warn = originalWarn;
  }
}

async function testAsyncCallbackResponseUsesSourceSocket() {
  const client = new DWClient({ clientId: 'test', clientSecret: 'secret' });
  const sourceFrames = [];
  const replacementFrames = [];
  const sourceSocket = {
    readyState: 1,
    send: (data, callback) => {
      sourceFrames.push(JSON.parse(data));
      callback?.();
    },
  };
  const replacementSocket = {
    readyState: 1,
    send: (data, callback) => {
      replacementFrames.push(JSON.parse(data));
      callback?.();
    },
  };
  let releaseCallback;
  const callbackBlocked = new Promise((resolve) => {
    releaseCallback = resolve;
  });
  let callbackStarted;
  const started = new Promise((resolve) => {
    callbackStarted = resolve;
  });
  let callbackFinished;
  const finished = new Promise((resolve) => {
    callbackFinished = resolve;
  });

  client.registerCallbackListener('callback-topic', async (message) => {
    callbackStarted();
    await callbackBlocked;
    client.socketCallBackResponse(message.headers.messageId, { ok: true });
    callbackFinished();
  });

  client.onCallback({
    specVersion: '1.0',
    type: 'CALLBACK',
    headers: {
      messageId: 'callback-message-id',
      topic: 'callback-topic',
    },
    data: '{}',
  }, sourceSocket);
  await started;

  client.socket = replacementSocket;
  releaseCallback();
  await finished;

  assert.equal(sourceFrames.length, 1);
  assert.equal(sourceFrames[0].headers.messageId, 'callback-message-id');
  assert.equal(replacementFrames.length, 0);
}

async function testAsyncCallbackCapacityIsBounded() {
  const client = new DWClient({
    clientId: 'test',
    clientSecret: 'secret',
    maxPendingCallbackHandlers: 5,
  });
  let handlerCalls = 0;
  client.registerCallbackListener('callback-topic', async () => {
    handlerCalls++;
    await new Promise(() => undefined);
  });

  for (let index = 0; index < 20; index++) {
    client.onCallback({
      specVersion: '1.0',
      type: 'CALLBACK',
      headers: {
        messageId: `callback-message-${index}`,
        topic: 'callback-topic',
      },
      data: '{}',
    });
  }

  assert.equal(handlerCalls, 5);
}

async function testDuplicateAsyncCallbackIsNotReentered() {
  const client = new DWClient({ clientId: 'test', clientSecret: 'secret' });
  let handlerCalls = 0;
  let releaseHandler;
  const handlerBlocked = new Promise((resolve) => {
    releaseHandler = resolve;
  });
  let handlerFinished;
  const finished = new Promise((resolve) => {
    handlerFinished = resolve;
  });
  client.registerCallbackListener('callback-topic', async () => {
    handlerCalls++;
    await handlerBlocked;
    handlerFinished();
  });
  const message = {
    specVersion: '1.0',
    type: 'CALLBACK',
    headers: {
      messageId: 'duplicate-callback-id',
      topic: 'callback-topic',
    },
    data: '{}',
  };

  client.onCallback(message);
  client.onCallback(message);
  assert.equal(handlerCalls, 1);

  releaseHandler();
  await finished;
  await new Promise((resolve) => setImmediate(resolve));
  client.onCallback(message);
  assert.equal(handlerCalls, 2);
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

async function testReconnectRequestedDuringEndpointLookupIsNotLost() {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, 'listening');
  const { port } = wss.address();
  const client = new DWClient({
    clientId: 'test',
    clientSecret: 'secret',
    autoReconnect: false,
  });
  let releaseEndpoint;
  const endpointBlocked = new Promise((resolve) => {
    releaseEndpoint = resolve;
  });
  let endpointStarted;
  const started = new Promise((resolve) => {
    endpointStarted = resolve;
  });
  let endpointCalls = 0;
  client.getEndpoint = async () => {
    endpointCalls++;
    endpointStarted();
    await endpointBlocked;
    client.dw_url = `ws://127.0.0.1:${port}?ticket=test-ticket`;
    return client;
  };

  const firstConnect = client.connect();
  await started;
  client.disconnect();
  const resumedConnect = client.connect();
  releaseEndpoint();
  await resumedConnect;

  assert.equal(endpointCalls, 1);
  assert.equal(client.connected, true);
  await firstConnect;

  client.disconnect();
  await closeServer(wss);
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
  const [serverSocket] = await waitForPromise(
    serverSocketPromise,
    'event listener WebSocket connection',
  );
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

async function testDuplicateEventSharesHandlerAndReplaysAck() {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, 'listening');
  const { port } = wss.address();

  mockGateway(`ws://127.0.0.1:${port}`);
  const client = new DWClient({
    clientId: 'test',
    clientSecret: 'secret',
    autoReconnect: false,
  });
  let handlerCalls = 0;
  let releaseHandler;
  const handlerBlocked = new Promise((resolve) => {
    releaseHandler = resolve;
  });
  client.registerAllEventListener(async () => {
    handlerCalls++;
    await handlerBlocked;
    return { status: EventAck.SUCCESS };
  });

  const serverSocketPromise = once(wss, 'connection');
  await client.connect();
  const [serverSocket] = await waitForPromise(
    serverSocketPromise,
    'duplicate event WebSocket connection',
  );
  const acks = [];
  serverSocket.on('message', (data) => acks.push(JSON.parse(data.toString())));
  const message = JSON.stringify({
    specVersion: '1.0',
    type: 'EVENT',
    headers: {
      messageId: 'duplicate-event-id',
      topic: 'event-topic',
    },
    data: '{}',
  });

  serverSocket.send(message);
  serverSocket.send(message);
  await waitFor(() => handlerCalls === 1);
  releaseHandler();
  await waitFor(() => acks.length === 2);

  serverSocket.send(message);
  await waitFor(() => acks.length === 3);
  assert.equal(handlerCalls, 1);
  assert.equal(
    acks.every((ack) => JSON.parse(ack.data).status === EventAck.SUCCESS),
    true,
  );

  client.disconnect();
  await closeServer(wss);
  nock.cleanAll();
}

async function testLaterEventResultIsNotCached() {
  const client = new DWClient({ clientId: 'test', clientSecret: 'secret' });
  const frames = [];
  const socket = {
    readyState: 1,
    send: (data, callback) => {
      frames.push(JSON.parse(data));
      callback?.();
    },
  };
  let handlerCalls = 0;
  client.registerAllEventListener(async () => {
    handlerCalls++;
    return { status: EventAck.LATER };
  });
  const message = JSON.stringify({
    specVersion: '1.0',
    type: 'EVENT',
    headers: {
      messageId: 'later-event-id',
      topic: 'event-topic',
    },
    data: '{}',
  });

  client.onDownStream(message, socket);
  await waitFor(() => frames.length === 1);
  await new Promise((resolve) => setImmediate(resolve));
  client.onDownStream(message, socket);
  await waitFor(() => frames.length === 2);

  assert.equal(handlerCalls, 2);
  assert.equal(JSON.parse(frames[0].data).status, EventAck.LATER);
  assert.equal(JSON.parse(frames[1].data).status, EventAck.LATER);
}

async function testEventHandlerCapacityAndDisconnectAbort() {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, 'listening');
  const { port } = wss.address();

  mockGateway(`ws://127.0.0.1:${port}`);
  const client = new DWClient({
    clientId: 'test',
    clientSecret: 'secret',
    autoReconnect: false,
    maxPendingEventHandlers: 5,
  });
  let pendingHandlers = 0;
  let maxPendingHandlers = 0;
  let abortedHandlers = 0;
  client.registerAllEventListener((_, signal) => new Promise((resolve) => {
    pendingHandlers++;
    maxPendingHandlers = Math.max(maxPendingHandlers, pendingHandlers);
    const finish = () => {
      pendingHandlers--;
      abortedHandlers++;
      resolve({ status: EventAck.LATER, message: 'connection closed' });
    };
    if (signal?.aborted) {
      finish();
    } else {
      signal?.addEventListener('abort', finish, { once: true });
    }
  }));

  const serverSocketPromise = once(wss, 'connection');
  await client.connect();
  const [serverSocket] = await waitForPromise(
    serverSocketPromise,
    'capacity test WebSocket connection',
  );
  const acks = [];
  serverSocket.on('message', (data) => acks.push(JSON.parse(data.toString())));
  for (let index = 0; index < 20; index++) {
    serverSocket.send(JSON.stringify({
      specVersion: '1.0',
      type: 'EVENT',
      headers: {
        messageId: `message-${index}`,
        topic: 'event-topic',
      },
      data: '{}',
    }));
  }

  await waitFor(() => pendingHandlers === 5 && acks.length === 15);
  assert.equal(maxPendingHandlers, 5);
  assert.equal(
    acks.filter((ack) => JSON.parse(ack.data).status === EventAck.LATER).length,
    15,
  );

  client.disconnect();
  await waitFor(() => pendingHandlers === 0);
  assert.equal(abortedHandlers, 5);

  await closeServer(wss);
  nock.cleanAll();
}

async function testInvalidEventAckRequestsRetry() {
  const client = new DWClient({ clientId: 'test', clientSecret: 'secret' });
  const frames = [];
  const socket = {
    readyState: 1,
    send: (data, callback) => {
      frames.push(JSON.parse(data));
      callback?.();
    },
  };
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    client.registerAllEventListener(() => undefined);
    client.onDownStream(JSON.stringify({
      specVersion: '1.0',
      type: 'EVENT',
      headers: {
        messageId: 'invalid-ack-event',
        topic: 'event-topic',
      },
      data: '{}',
    }), socket);
    await waitFor(() => frames.length === 1);

    assert.equal(JSON.parse(frames[0].data).status, EventAck.LATER);
    assert.equal(warnings.length, 1);
    assert.equal(
      warnings[0][0],
      'Event listener returned an invalid acknowledgement',
    );
  } finally {
    console.warn = originalWarn;
  }
}

async function testStaleDisconnectDoesNotMutateReplacementState() {
  const client = new DWClient({ clientId: 'test', clientSecret: 'secret' });
  let sourceClosed = 0;
  const sourceFrames = [];
  const sourceSocket = {
    readyState: 1,
    send: (data, callback) => {
      sourceFrames.push(JSON.parse(data));
      callback?.();
    },
    close: () => {
      sourceClosed++;
    },
  };
  const replacementSocket = {
    readyState: 1,
    send: () => undefined,
  };
  client.socket = replacementSocket;
  client.connected = true;
  client.registered = true;

  client.onSystem({
    specVersion: '1.0',
    type: 'SYSTEM',
    headers: {
      messageId: 'stale-disconnect',
      topic: 'disconnect',
    },
    data: '{}',
  }, sourceSocket);

  assert.equal(sourceFrames.length, 1);
  assert.equal(sourceFrames[0].headers.messageId, 'stale-disconnect');
  assert.equal(sourceClosed, 1);
  assert.equal(client.connected, true);
  assert.equal(client.registered, true);
  assert.equal(client.socket, replacementSocket);
}

async function testEventResultCacheIsBoundedAndExpires() {
  const client = new DWClient({ clientId: 'test', clientSecret: 'secret' });
  const originalDateNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    for (let index = 0; index < 10_005; index++) {
      client.cacheEventResult(
        `cached-event-${index}`,
        { status: EventAck.SUCCESS },
      );
    }

    assert.equal(client.eventResults.size, 10_000);
    assert.equal(client.eventResults.has('cached-event-0'), false);
    assert.equal(client.eventResults.has('cached-event-4'), false);
    assert.equal(client.eventResults.has('cached-event-5'), true);
    assert.equal(client.eventResults.has('cached-event-10004'), true);

    now += 5 * 60 * 1000 + 1;
    assert.equal(client.getCachedEventResult('cached-event-10004'), undefined);
    assert.equal(client.eventResults.has('cached-event-10004'), false);
  } finally {
    Date.now = originalDateNow;
  }
}

async function testRepeatedConnectDisconnectDoesNotLeakSockets() {
  const cycles = 25;
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, 'listening');
  const { port } = wss.address();
  nock(gatewayHost)
    .post(gatewayPath)
    .times(cycles)
    .reply(200, {
      endpoint: `ws://127.0.0.1:${port}`,
      ticket: 'test-ticket',
    });

  const client = new DWClient({
    clientId: 'test',
    clientSecret: 'secret',
    autoReconnect: false,
    keepAlive: true,
  });
  const originalInfo = console.info;
  console.info = () => undefined;
  try {
    for (let index = 0; index < cycles; index++) {
      const serverSocketPromise = once(wss, 'connection');
      await client.connect();
      await waitForPromise(
        serverSocketPromise,
        `repeated connection ${index + 1}`,
      );
      client.disconnect();
      await waitFor(() => wss.clients.size === 0);

      assert.equal(client.connected, false);
      assert.equal(client.socket, undefined);
      assert.equal(client.heartbeatIntervallId, undefined);
      assert.equal(client.reconnectTimerId, undefined);
      assert.equal(client.eventAbortControllers.size, 0);
    }
  } finally {
    console.info = originalInfo;
    client.disconnect();
    for (const socket of wss.clients) socket.terminate();
    await closeServer(wss);
    nock.cleanAll();
  }
}

nock.disableNetConnect();
nock.enableNetConnect('127.0.0.1');

await testSubscriptionsAreIsolated();
await testCallbackCanBeRemovedByOriginalListener();
await testAsyncCallbackRejectionIsHandled();
await testAsyncCallbackResponseUsesSourceSocket();
await testAsyncCallbackCapacityIsBounded();
await testDuplicateAsyncCallbackIsNotReentered();
await testDisconnectAbortsOpeningHandshake();
await testReconnectRequestedDuringEndpointLookupIsNotLost();
await testAsyncEventListenerIsAwaited();
await testDuplicateEventSharesHandlerAndReplaysAck();
await testLaterEventResultIsNotCached();
await testEventHandlerCapacityAndDisconnectAbort();
await testInvalidEventAckRequestsRetry();
await testStaleDisconnectDoesNotMutateReplacementState();
await testEventResultCacheIsBoundedAndExpires();
await testRepeatedConnectDisconnectDoesNotLeakSockets();

console.log('Lifecycle regression tests passed.');
