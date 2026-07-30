import WebSocket from 'ws';
import axios from 'axios';
import EventEmitter from 'events';
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
  ua: '',
  subscriptions: [
    {
      type: 'EVENT',
      topic: '*',
    },
  ],
};

export interface DWClientConfig {
  clientId: string;
  clientSecret: string;
  keepAlive?: boolean;
  debug?: boolean;
  ua?: string;
  endpoint?: string;
  access_token?: string;
  autoReconnect?: boolean;
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
  (msg: DWClientDownStream): EventAckData | Promise<EventAckData>;
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
  private abortPendingConnect?: (reason: Error) => void;
  private readonly httpTimeout = 10000;

  private sslopts = { rejectUnauthorized: true };
  readonly config: DWClientConfig;
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
    access_token?: string;
    subscriptions?: DWClientConfig['subscriptions'];
  }) {
    super();
    const subscriptions = opts.subscriptions ?? defaultConfig.subscriptions;
    this.config = {
      ...defaultConfig,
      ...opts,
      subscriptions: subscriptions.map((subscription) => ({ ...subscription })),
    };

    if (!this.config.clientId || !this.config.clientSecret) {
      console.error('clientId or clientSecret is null');
      throw new Error('clientId or clientSecret is null');
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
    callback: (v: DWClientDownStream) => void
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

    this.on(eventId, callback);

    return this;
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
      void this.connectInternal(true);
    }, delay);
  }

  _connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.printDebug('Connecting to dingtalk websocket');
      let socket: WebSocket;
      try {
        socket = new WebSocket(this.dw_url!, this.sslopts);
        this.socket = socket;
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

  async connect() {
    return this.connectInternal(false);
  }

  private async connectInternal(reconnectAttempt: boolean) {
    if (reconnectAttempt && this.userDisconnect) {
      return;
    }
    if (this.isConnecting) {
      this.printDebug('connect() already in progress, skipping');
      return;
    }
    if (!reconnectAttempt) {
      this.userDisconnect = false;
      if (this.reconnectTimerId) {
        clearTimeout(this.reconnectTimerId);
        this.reconnectTimerId = undefined;
      }
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
          void this.onEvent(msg, socket);
          break;
        case 'CALLBACK':
          // 处理回调消息
          this.onCallback(msg);
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
    socket.send(JSON.stringify(payload), (err) => {
      if (err) {
        console.warn('Failed to send websocket response', err);
      }
      onSent?.();
    });
  }

  onSystem(downstream: DWClientDownStream, socket = this.socket) {
    switch (downstream.headers.topic) {
      case 'CONNECTED': {
        this.printDebug('CONNECTED');
        break;
      }
      case 'REGISTERED': {
        // this.printDebug('REGISTERED');
        this.registered = true;
        this.reconnecting = false;
        break;
      }
      case 'disconnect': {
        this.connected = false;
        this.registered = false;
        this.sendFrame(socket, {
          code: 200,
          headers: downstream.headers,
          message: 'OK',
          data: downstream.data,
        }, () => socket?.close());
        break;
      }
      case 'KEEPALIVE': {
        this.heartbeat();
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

  async onEvent(message: DWClientDownStream, socket = this.socket) {
    this.printDebug('received event, message=' + JSON.stringify(message));
    let ackData: EventAckData;
    try {
      ackData = await this.onEventReceived(message);
    } catch (err) {
      console.warn('Event listener failed', err);
      ackData = { status: EventAck.LATER };
    }
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

  onCallback(message: DWClientDownStream) {
    this.emit(message.headers.topic, message);
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
    this.sendFrame(this.socket, msg);
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
    this.sendFrame(this.socket, msg);
  }
}
