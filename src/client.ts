import WebSocket from 'ws';
import axios from 'axios';
import EventEmitter from 'events';
import { TOPIC_ROBOT,GET_TOKEN_URL, GATEWAY_URL,GraphAPIResponse } from './constants.js';

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
  (msg: DWClientDownStream): EventAckData
}

export class DWClient extends EventEmitter {
  debug = false;
  connected = false;
  registered = false;
  reconnecting = false;
  private userDisconnect = false;
  private reconnectInterval = 1000;
  private heartbeat_interval = 8000;
  private heartbeatIntervallId?: NodeJS.Timeout;

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
  }) {
    super();
    this.config = {
      ...defaultConfig,
      ...opts,
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
    return { ...this.config };
  }

  printDebug(msg: object | string) {
    if (this.debug) {
      const date = '[' + new Date().toISOString() + ']';
      console.info(date, msg);
    }
  }

  registerAllEventListener(
      onEventReceived: (v: DWClientDownStream) => EventAckData
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
      `${GET_TOKEN_URL}?appkey=${this.config.clientId}&appsecret=${this.config.clientSecret}`
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
    this.printDebug(this.config);
    const res = await axios({
      url: GATEWAY_URL,
      method: 'POST',
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

    this.printDebug('res.data ' + JSON.stringify(res.data));
    if (res.data) {
      this.config.endpoint = res.data;
      const { endpoint, ticket } = res.data;
      if (!endpoint || !ticket) {
        this.printDebug('endpoint or ticket is null');
        throw new Error('endpoint or ticket is null');
      }
      this.dw_url = `${endpoint}?ticket=${ticket}`;
      return this;
    } else {
      throw new Error('build: get endpoint failed');
    }
  }
  
  _connect() {
    return new Promise<void>((resolve, reject) => {
      this.userDisconnect = false;

      this.printDebug('Connecting to dingtalk websocket @ ' + this.dw_url);
      this.socket = new WebSocket(this.dw_url!, this.sslopts);

      // config dw connection when socket is open
      this.socket.on('open', () => {
        this.connected = true;
        console.info('[' + new Date().toISOString() + '] connect success');

        // check if keepalive (client-side heartbeat) is enabled
        // if enabled, start heartbeat for ping-pong
        if (this.config.keepAlive) {
          this.isAlive = true;
          this.heartbeatIntervallId = setInterval(() => {
            // if ping-pong need to much time, longer than heartbeat, terminate socket connection
            if (this.isAlive === false) {
              console.error(
                'TERMINATE SOCKET: Ping Pong does not transfer heartbeat within heartbeat intervall'
              );
              return this.socket?.terminate();
            }
            // if ping-pong ok, prepare next one
            this.isAlive = false;
            this.socket?.ping('', true);
          }, this.heartbeat_interval);
        }
      });

      // wait for ping-pong with server
      this.socket.on('pong', () => {
        this.heartbeat();
      });

      // on receiving messages from dingtalk websocket server
      this.socket.on('message', (data: string) => {
        this.onDownStream(data);
      });

      this.socket.on('close', (err) => {
        this.printDebug('Socket closed');
        this.connected = false;
        this.registered = false;
        // perorm reconnection (if not canceled by user)
        if (this.config.autoReconnect && !this.userDisconnect) {
          this.reconnecting = true;
          this.printDebug(
            'Reconnecting in ' + this.reconnectInterval / 1000 + ' seconds...'
          );
          setTimeout(this.connect.bind(this), this.reconnectInterval);
        }
      });

      // on socket errors
      this.socket.on('error', (err) => {
        this.printDebug('SOCKET ERROR');
        console.warn('ERROR', err);
      });

      resolve();
    });
  }

  async connect() {
    await this.getEndpoint();
    await this._connect();
  }

  disconnect() {
    console.info('Disconnecting.');
    this.userDisconnect = true;
    // if client-side heartbeat is active, cancel the heartbeat intervall
    if (this.config.keepAlive && this.heartbeatIntervallId !== undefined) {
      clearInterval(this.heartbeatIntervallId!);
    }
    this.socket?.close();
  }

  heartbeat() {
    this.isAlive = true;
    this.printDebug('CLIENT-SIDE HEARTBEAT');
  }

  onDownStream(data: string) {
    this.printDebug('Received message from dingtalk websocket server');
   
    const msg = JSON.parse(data) as DWClientDownStream;
    this.printDebug(msg);
    switch (msg.type) {
      case 'SYSTEM':
        this.onSystem(msg);
        break;
      case 'EVENT':
        this.onEvent(msg);
        break;
      case 'CALLBACK':
        // 处理回调消息
        this.onCallback(msg);
        break;
    }
  }

  onSystem(downstream: DWClientDownStream) {
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
        break;
      }
      case 'KEEPALIVE': {
        this.heartbeat();
        break;
      }
      case 'ping': {
        this.printDebug('PING');
        this.socket?.send(
          JSON.stringify({
            code: 200,
            headers: downstream.headers,
            message: 'OK',
            data: downstream.data,
          })
        );
        break;
      }
    }
  }

  onEvent(message: DWClientDownStream) {
    this.printDebug("received event, message=" + JSON.stringify(message))
    const ackData = this.onEventReceived(message)
    this.socket?.send(JSON.stringify({
      code: 200,
      headers: {
        contentType: "application/json",
        messageId: message.headers.messageId,
      },
      message: 'OK',
      data: JSON.stringify(ackData)
    }));
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
    this.socket?.send(JSON.stringify(msg));
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
    this.socket?.send(JSON.stringify(msg));
  }
}
