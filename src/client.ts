import WebSocket from 'ws';
import axios from 'axios';
import EventEmitter from 'events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { GET_TOKEN_URL, GATEWAY_URL, GraphAPIResponse } from './constants.js';

export enum EventAck {
  SUCCESS = "SUCCESS",
  LATER = "LATER",
}

export interface EventAckData {
  status: EventAck;
  message?: string;
}

const defaultConfig = {
  autoReconnect: true,
  keepAlive: false,
  maxPendingEventHandlers: 100,
  maxPendingCallbackHandlers: 100,
  ua: '',
  subscriptions: [
    {
      type: 'EVENT',
      topic: '*',
    },
  ],
};

const maxCachedEventResults = 10000;
const eventResultTtlMs = 5 * 60 * 1000;

export interface DWClientConfig {
  clientId: string;
  clientSecret: string;
  keepAlive?: boolean;
  debug?: boolean;
  ua?: string;
  endpoint?: string;
  access_token?: string;
  autoReconnect?: boolean;
  maxPendingEventHandlers?: number;
  maxPendingCallbackHandlers?: number;
  subscriptions: Array<{
    type: string;
    topic: string;
  }>;
}

export interface DWClientDownStream {
  specVersion: string;
  type: string;
  headers: {
    appId: string;
    connectionId: string;
    contentType: string;
    messageId: string;
    time: string;
    topic: string;
    eventType?: string;
    eventBornTime?: string;
    eventId?: string;
    eventCorpId?: string;
    eventUnifiedAppId?: string;
  };
  data: string;
}

export interface OnEventReceived {
  (msg: DWClientDownStream, signal?: AbortSignal): EventAckData | Promise<EventAckData>;
}

export class DWClient extends EventEmitter {
  debug = false;
  connected = false;
  registered = false;
  reconnecting = false;
  private userDisconnect = false;
  private reconnectBaseInterval = 1000;
  private reconnectMaxInterval = 60000;
  private reconnectAttempts = 0;
  private heartbeat_interval = 8000;
  private heartbeatIntervallId?: NodeJS.Timeout;
  private reconnectTimerId?: NodeJS.Timeout;
  private isConnecting = false;
  private activeConnectPromise?: Promise<void>;
  private abortPendingConnect?: (reason: Error) => void;
  private readonly httpTimeout = 10000;
  private readonly eventTasks = new Set<Promise<EventAckData>>();
  private readonly inflightEvents = new Map<string, Promise<EventAckData>>();
  private readonly eventResults = new Map<string, {
    completedAt: number;
    ackData: EventAckData;
  }>();
  private readonly eventAbortControllers = new Map<WebSocket, AbortController>();
  private readonly callbackTasks = new Set<Promise<void>>();
  private readonly callbackSocketContext = new AsyncLocalStorage<WebSocket>();

  private sslopts = { rejectUnauthorized: true };
  readonly config: DWClientConfig & {
    maxPendingEventHandlers: number;
    maxPendingCallbackHandlers: number;
  };
  private socket?: WebSocket;
  private dw_url?: string;
  private isAlive = false;
  private onEventReceived: OnEventReceived = (msg: DWClientDownStream) => {return {status: EventAck.SUCCESS}};

  constructor(opts: {
    clientId: string;
    clientSecret: string;
    ua?: string;
    keepAlive?: boolean;
    debug?: boolean;
    autoReconnect?: boolean;
    maxPendingEventHandlers?: number;
    maxPendingCallbackHandlers?: number;
    access_token?: string;
    subscriptions?: DWClientConfig['subscriptions'];
  }) {
    super({ captureRejections: true });
    const subscriptions = opts.subscriptions ?? defaultConfig.subscriptions;
    this.config = {
      ...defaultConfig,
      ...opts,
      maxPendingEventHandlers:
        opts.maxPendingEventHandlers ?? defaultConfig.maxPendingEventHandlers,
      maxPendingCallbackHandlers:
        opts.maxPendingCallbackHandlers ?? defaultConfig.maxPendingCallbackHandlers,
      subscriptions: subscriptions.map((subscription) => ({ ...subscription })),
    };

    if (!this.config.clientId || !this.config.clientSecret) {
      console.error('clientId or clientSecret is null');
      throw new Error('clientId or clientSecret is null');
    }
    if (!Number.isInteger(this.config.maxPendingEventHandlers)
        || this.config.maxPendingEventHandlers <= 0) {
      throw new Error('maxPendingEventHandlers must be a positive integer');
    }
    if (!Number.isInteger(this.config.maxPendingCallbackHandlers)
        || this.config.maxPendingCallbackHandlers <= 0) {
      throw new Error('maxPendingCallbackHandlers must be a positive integer');
    }
    if (this.config.debug !== undefined) {
      this.debug = this.config.debug;
    }
  }

  getConfig() {
    return {
      ...this.config,
      subscriptions: this.config.subscriptions.map((subscription) => ({ ...subscription })),
    };
  }

  printDebug(msg: object | string) {
    if (this.debug) {
      const date = '[' + new Date().toISOString() + ']';
      console.info(date, msg);
    }
  }

  registerAllEventListener(
      onEventReceived: OnEventReceived
  ) {
    this.onEventReceived = onEventReceived;
    return this;
  }

  registerCallbackListener(
    eventId: string,
    callback: (v: DWClientDownStream) => void | Promise<void>
  ) {
    if (!eventId || !callback) {
      console.error(
        'registerCallbackListener: eventId and callback must be defined'
      );
      throw new Error(
        'registerCallbackListener: eventId and callback must be defined'
      );
    }

    if (
      !this.config.subscriptions.find(
        (x) => x.topic === eventId && x.type === 'CALLBACK'
      )
    ) {
      this.config.subscriptions.push({
        type: 'CALLBACK',
        topic: eventId,
      });
    }

    const inflightMessageIds = new Set<string>();
    const wrappedCallback = (message: DWClientDownStream) => {
      this.invokeCallback(eventId, callback, message, inflightMessageIds);
    };
    // EventEmitter treats a wrapper's `listener` property as the original
    // listener (the same convention used by once()). Preserve that identity so
    // existing `off(topic, callback)` / `removeListener(topic, callback)` calls
    // continue to remove SDK-registered callbacks.
    Object.defineProperty(wrappedCallback, 'listener', {
      value: callback,
    });
    this.on(eventId, wrappedCallback);

    return this;
  }

  private invokeCallback(
    eventId: string,
    callback: (v: DWClientDownStream) => void | Promise<void>,
    message: DWClientDownStream,
    inflightMessageIds: Set<string>,
  ) {
    const messageId = message.headers.messageId;
    if (messageId && inflightMessageIds.has(messageId)) {
      this.printDebug(
        `Callback message ${messageId} is already being processed; waiting for server retry`,
      );
      return;
    }
    if (this.callbackTasks.size >= this.config.maxPendingCallbackHandlers) {
      this.printDebug(
        `Callback handler capacity reached (${this.config.maxPendingCallbackHandlers}); `
        + 'leaving the message unacknowledged for server retry',
      );
      return;
    }

    if (messageId) {
      inflightMessageIds.add(messageId);
    }
    let result: void | Promise<void>;
    try {
      result = callback(message);
    } catch (err) {
      if (messageId) {
        inflightMessageIds.delete(messageId);
      }
      console.warn(`Callback listener failed for topic ${eventId}`, err);
      return;
    }
    if (!result) {
      if (messageId) {
        inflightMessageIds.delete(messageId);
      }
      return;
    }

    const task = Promise.resolve(result)
      .catch((err) => console.warn(`Callback listener failed for topic ${eventId}`, err));
    this.callbackTasks.add(task);
    void task.finally(() => {
      this.callbackTasks.delete(task);
      if (messageId) {
        inflightMessageIds.delete(messageId);
      }
    });
  }

  [EventEmitter.captureRejectionSymbol](err: unknown, eventName: string | symbol) {
    console.warn(`Callback listener failed for topic ${String(eventName)}`, err);
  }

  async getAccessToken() {
    const result = await axios.get(
      `${GET_TOKEN_URL}?appkey=${this.config.clientId}&appsecret=${this.config.clientSecret}`,
      { timeout: this.httpTimeout },
    );
    if (result.status === 200 && result.data.access_token) {
      this.config.access_token = result.data.access_token;
      return result.data.access_token;
    } else {
      throw new Error('getAccessToken: get access_token failed');
    }
  }

  async getEndpoint() {
    this.printDebug('get connect endpoint by config');
    const res = await axios({
      url: GATEWAY_URL,
      method: 'POST',
      timeout: this.httpTimeout,
      responseType: 'json',
      data: {
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret,
        ua: this.config.ua,
        subscriptions: this.config.subscriptions,
      },
      headers: {
        // 这个接口得加个，否则默认返回的会是xml
        Accept: 'application/json'
      },
    });

    if (res.data) {
      const { endpoint, ticket } = res.data;
      if (!endpoint || !ticket) {
        this.printDebug('endpoint or ticket is null');
        throw new Error('endpoint or ticket is null');
      }
      this.config.endpoint = endpoint;
      this.dw_url = `${endpoint}?ticket=${ticket}`;
      this.printDebug('received websocket endpoint');
      return this;
    } else {
      throw new Error('build: get endpoint failed');
    }
  }
  
  private clearHeartbeat() {
    if (this.heartbeatIntervallId !== undefined) {
      clearInterval(this.heartbeatIntervallId);
      this.heartbeatIntervallId = undefined;
    }
  }

  private disposeSocket(socket: WebSocket) {
    this.abortEventHandlers(socket);
    socket.removeAllListeners();
    // ws emits an asynchronous error when terminate() aborts an opening handshake.
    socket.on('error', () => undefined);
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.terminate();
    }
  }

  private cleanup(reason = new Error('WebSocket connection was replaced')) {
    this.clearHeartbeat();
    this.connected = false;
    this.registered = false;
    const abortPendingConnect = this.abortPendingConnect;
    this.abortPendingConnect = undefined;
    abortPendingConnect?.(reason);

    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      this.disposeSocket(socket);
    }
  }

  private scheduleReconnect() {
    if (!this.config.autoReconnect || this.userDisconnect || this.reconnectTimerId) {
      return;
    }
    const delay = Math.min(
      this.reconnectBaseInterval * Math.pow(2, this.reconnectAttempts) + Math.random() * 1000,
      this.reconnectMaxInterval,
    );
    this.reconnecting = true;
    this.printDebug('Reconnecting in ' + (delay / 1000).toFixed(1) + ' seconds... (attempt ' + (this.reconnectAttempts + 1) + ')');
    this.reconnectTimerId = setTimeout(() => {
      this.reconnectTimerId = undefined;
      void this.runConnect(true);
    }, delay);
  }

  _connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.printDebug('Connecting to dingtalk websocket');
      let socket: WebSocket;
      try {
        socket = new WebSocket(this.dw_url!, this.sslopts);
        this.socket = socket;
        this.eventAbortControllers.set(socket, new AbortController());
      } catch (err) {
        this.printDebug('WebSocket constructor error');
        console.warn('ERROR', err);
        reject(err);
        return;
      }

      let settled = false;
      let opened = false;

      const clearAbortHandler = () => {
        if (this.abortPendingConnect === abortConnect) {
          this.abortPendingConnect = undefined;
        }
      };
      const resolveOnce = () => {
        if (settled) return;
        settled = true;
        clearAbortHandler();
        resolve();
      };
      const rejectOnce = (reason: Error) => {
        if (settled) return;
        settled = true;
        clearAbortHandler();
        reject(reason);
      };
      const abortConnect = (reason: Error) => rejectOnce(reason);
      this.abortPendingConnect = abortConnect;

      socket.on('open', () => {
        if (this.socket !== socket || this.userDisconnect) {
          this.disposeSocket(socket);
          rejectOnce(new Error('WebSocket connection was cancelled'));
          return;
        }
        opened = true;
        this.connected = true;
        this.reconnectAttempts = 0;
        console.info('[' + new Date().toISOString() + '] connect success');

        if (this.config.keepAlive) {
          this.isAlive = true;
          this.heartbeatIntervallId = setInterval(() => {
            if (this.socket !== socket) return;
            if (this.isAlive === false) {
              console.error(
                'TERMINATE SOCKET: Ping Pong does not transfer heartbeat within heartbeat intervall'
              );
              return socket.terminate();
            }
            this.isAlive = false;
            socket.ping('', true);
          }, this.heartbeat_interval);
        }
        resolveOnce();
      });

      socket.on('pong', () => {
        this.heartbeat();
      });

      socket.on('message', (data) => {
        this.onDownStream(data.toString(), socket);
      });

      socket.on('close', () => {
        if (this.socket !== socket) return;
        this.abortEventHandlers(socket);
        this.socket = undefined;
        this.printDebug('Socket closed');
        this.connected = false;
        this.registered = false;
        this.clearHeartbeat();
        if (!opened) {
          rejectOnce(new Error('WebSocket closed before the connection was established'));
        } else {
          this.scheduleReconnect();
        }
      });

      socket.on('error', (err: Error) => {
        if (this.socket !== socket) return;
        this.printDebug('SOCKET ERROR');
        console.warn('ERROR', err);
        rejectOnce(err);
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.terminate();
        }
      });
    });
  }

  connect() {
    this.userDisconnect = false;
    if (this.reconnectTimerId) {
      clearTimeout(this.reconnectTimerId);
      this.reconnectTimerId = undefined;
    }
    return this.runConnect(false);
  }

  private runConnect(reconnectAttempt: boolean) {
    if (this.activeConnectPromise) {
      return this.activeConnectPromise;
    }
    const promise = this.connectInternal(reconnectAttempt);
    this.activeConnectPromise = promise;
    void promise.finally(() => {
      if (this.activeConnectPromise === promise) {
        this.activeConnectPromise = undefined;
      }
    });
    return promise;
  }

  private async connectInternal(reconnectAttempt: boolean) {
    if (reconnectAttempt && this.userDisconnect) {
      return;
    }
    if (this.isConnecting) {
      this.printDebug('connect() already in progress, skipping');
      return;
    }
    this.isConnecting = true;
    try {
      this.cleanup();
      await this.getEndpoint();
      // bail if disconnect() was called during the async getEndpoint()
      if (this.userDisconnect) return;
      await this._connect();
    } catch (err) {
      this.printDebug('Connect failed: ' + (err instanceof Error ? err.message : String(err)));
      if (!this.userDisconnect) {
        this.reconnectAttempts++;
        this.scheduleReconnect();
      }
      return;
    } finally {
      this.isConnecting = false;
    }
  }

  disconnect() {
    console.info('Disconnecting.');
    this.userDisconnect = true;
    if (this.reconnectTimerId) {
      clearTimeout(this.reconnectTimerId);
      this.reconnectTimerId = undefined;
    }
    this.reconnecting = false;
    this.reconnectAttempts = 0;
    this.cleanup(new Error('WebSocket connection was cancelled by disconnect()'));
    this.connected = false;
    this.registered = false;
  }

  heartbeat() {
    this.isAlive = true;
    this.printDebug('CLIENT-SIDE HEARTBEAT');
  }

  onDownStream(data: string, socket = this.socket) {
    this.printDebug('Received message from dingtalk websocket server');

    try {
      const msg = JSON.parse(data) as DWClientDownStream;
      this.printDebug(msg);
      switch (msg.type) {
        case 'SYSTEM':
          this.onSystem(msg, socket);
          break;
        case 'EVENT':
          this.queueEvent(msg, socket);
          break;
        case 'CALLBACK':
          // 处理回调消息
          this.onCallback(msg, socket);
          break;
      }
    } catch (err) {
      console.warn('Failed to process downstream message', err);
    }
  }

  private sendFrame(socket: WebSocket | undefined, payload: object, onSent?: () => void) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      onSent?.();
      return;
    }
    try {
      socket.send(JSON.stringify(payload), (err) => {
        if (err) {
          console.warn('Failed to send websocket response', err);
        }
        onSent?.();
      });
    } catch (err) {
      console.warn('Failed to send websocket response', err);
      onSent?.();
    }
  }

  private abortEventHandlers(socket: WebSocket) {
    const controller = this.eventAbortControllers.get(socket);
    this.eventAbortControllers.delete(socket);
    controller?.abort();
  }

  private queueEvent(message: DWClientDownStream, socket = this.socket) {
    if (!socket) {
      return;
    }
    const messageId = message.headers.messageId;
    const signal = this.eventAbortControllers.get(socket)?.signal;
    if (messageId) {
      const cached = this.getCachedEventResult(messageId);
      if (cached) {
        this.sendEventAck(message, cached, socket);
        return;
      }
      const inflight = this.inflightEvents.get(messageId);
      if (inflight) {
        this.sendEventResultWhenReady(inflight, message, socket, signal);
        return;
      }
    }
    if (this.eventTasks.size >= this.config.maxPendingEventHandlers) {
      this.printDebug(
        `Event handler capacity reached (${this.config.maxPendingEventHandlers}), returning LATER`,
      );
      this.sendEventAck(message, { status: EventAck.LATER }, socket);
      return;
    }

    const task = this.processEvent(message, signal);
    this.eventTasks.add(task);
    if (messageId) {
      this.inflightEvents.set(messageId, task);
    }
    this.sendEventResultWhenReady(task, message, socket, signal);
    void task.then((ackData) => {
      if (messageId && ackData.status === EventAck.SUCCESS) {
        this.cacheEventResult(messageId, ackData);
      }
    }).catch((err) => {
      console.warn('Failed to cache event result', err);
    }).finally(() => {
      this.eventTasks.delete(task);
      if (messageId && this.inflightEvents.get(messageId) === task) {
        this.inflightEvents.delete(messageId);
      }
    });
  }

  private sendEventResultWhenReady(
    task: Promise<EventAckData>,
    message: DWClientDownStream,
    socket: WebSocket,
    signal?: AbortSignal,
  ) {
    void task
      .then((ackData) => {
        if (!signal?.aborted) {
          this.sendEventAck(message, ackData, socket);
        }
      })
      .catch((err) => console.warn('Failed to process event', err));
  }

  private getCachedEventResult(messageId: string) {
    const cached = this.eventResults.get(messageId);
    if (!cached) {
      return undefined;
    }
    if (Date.now() - cached.completedAt > eventResultTtlMs) {
      this.eventResults.delete(messageId);
      return undefined;
    }
    this.eventResults.delete(messageId);
    this.eventResults.set(messageId, cached);
    return cached.ackData;
  }

  private cacheEventResult(messageId: string, ackData: EventAckData) {
    this.eventResults.delete(messageId);
    this.eventResults.set(messageId, {
      completedAt: Date.now(),
      ackData,
    });
    while (this.eventResults.size > maxCachedEventResults) {
      const oldest = this.eventResults.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.eventResults.delete(oldest);
    }
  }

  private sendEventAck(
    message: DWClientDownStream,
    ackData: EventAckData,
    socket = this.socket,
  ) {
    this.sendFrame(socket, {
      code: 200,
      headers: {
        contentType: 'application/json',
        messageId: message.headers.messageId,
      },
      message: 'OK',
      data: JSON.stringify(ackData)
    });
  }

  onSystem(downstream: DWClientDownStream, socket = this.socket) {
    const ownsCurrentState = socket === undefined || socket === this.socket;
    switch (downstream.headers.topic) {
      case 'CONNECTED': {
        this.printDebug('CONNECTED');
        break;
      }
      case 'REGISTERED': {
        if (ownsCurrentState) {
          this.registered = true;
          this.reconnecting = false;
        }
        break;
      }
      case 'disconnect': {
        if (ownsCurrentState) {
          this.connected = false;
          this.registered = false;
        }
        this.sendFrame(socket, {
          code: 200,
          headers: downstream.headers,
          message: 'OK',
          data: downstream.data,
        }, () => socket?.close());
        break;
      }
      case 'KEEPALIVE': {
        if (ownsCurrentState) {
          this.heartbeat();
        }
        break;
      }
      case 'ping': {
        this.printDebug('PING');
        this.sendFrame(socket, {
          code: 200,
          headers: downstream.headers,
          message: 'OK',
          data: downstream.data,
        });
        break;
      }
    }
  }

  async onEvent(
    message: DWClientDownStream,
    socket = this.socket,
    signal?: AbortSignal,
  ) {
    const ackData = await this.processEvent(message, signal);
    if (!signal?.aborted) {
      this.sendEventAck(message, ackData, socket);
    }
  }

  private async processEvent(
    message: DWClientDownStream,
    signal?: AbortSignal,
  ) {
    this.printDebug('received event, message=' + JSON.stringify(message));
    let ackData: EventAckData;
    try {
      ackData = await this.onEventReceived(message, signal);
      if (!ackData
          || (ackData.status !== EventAck.SUCCESS && ackData.status !== EventAck.LATER)) {
        console.warn('Event listener returned an invalid acknowledgement');
        ackData = { status: EventAck.LATER };
      }
    } catch (err) {
      console.warn('Event listener failed', err);
      ackData = { status: EventAck.LATER };
    }
    return ackData;
  }

  onCallback(message: DWClientDownStream, socket = this.socket) {
    if (socket) {
      this.callbackSocketContext.run(
        socket,
        () => this.emit(message.headers.topic, message),
      );
    } else {
      this.emit(message.headers.topic, message);
    }
  }

  send(messageId: string, value: any) {
    if (!messageId) {
      console.error('send: messageId must be defined');
      throw new Error('send: messageId must be defined');
    }

    const msg = {
      code: 200,
      headers: {
        contentType: 'application/json',
        messageId: messageId,
      },
      message: 'OK',
      data: JSON.stringify(value),
    };
    this.sendFrame(this.callbackSocketContext.getStore() ?? this.socket, msg);
  }

  /**
   * 消息响应，避免服务端重试. 
   * stream模式下，服务端推送消息到client后，会监听client响应，如果消息长时间未响应会在一定时间内(60s)重试推消息，可以通过此方法返回消息响应，避免多次接收服务端消息。
   * @param messageId
   * @param result
   * @returns
   * @memberof DWClient
   * @example
   * ```javascript
   * client.socketResponse(res.headers.messageId, result.data);
   * ```
   */
  socketCallBackResponse(messageId: string, result: any) {
    this.send(messageId, {response : result});
  }

  sendGraphAPIResponse(messageId: string, value: GraphAPIResponse) {
    if (!messageId) {
      console.error('send: messageId must be defined');
      throw new Error('send: messageId must be defined');
    }

    const msg = {
      code: 200,
      headers: {
        contentType: 'application/json',
        messageId: messageId,
      },
      message: 'OK',
      data: JSON.stringify(value),
    };
    this.sendFrame(this.callbackSocketContext.getStore() ?? this.socket, msg);
  }
}
