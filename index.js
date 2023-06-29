"use strict";

const { makeHttpRequest } = require("./httpclient");
const WebSocket = require("ws");
const ROBOT_TOPIC = "/v1.0/im/bot/messages/get";

let config = {
  clientId: "",
  clientSecret: "",
  subscriptions: [
    {
      type: "EVENT",
      topic: "*",
    },
  ],
  ua: "",
};

const DWClient = function (clientId, clientSecret, ua) {
  config.clientId = clientId;
  config.clientSecret = clientSecret;
  config.ua = ua;
  //this.emitter = new EventEmitter();

  if (!config.clientId || !config.clientSecret) {
    console.error("clientId or clientSecret is null");
    throw new Error("clientId or clientSecret is null");
  }

  let my = this;

  initSetting(my);

  function initSetting(my) {
    // debugging
    my.debug = true;
    my.dataFormatValidation = true;

    my.config = config;

    // connection params
    my.connected = false;
    my.registered = false;
    my.autoReconnect = true;
    my.reconnecting = false;
    my.userDisconnect = false;
    my.reconnectInterval = 1000;

    // client-side heartbeats
    my.keepAlive = false;
    my.heartbeat_interval = 8000;
    my.heartbeatIntervallId = undefined;

    // smart object definition
    my.callbackListeners = {};

    // socket
    my.sslopts = { rejectUnauthorized: true };
    my.socket = null;
  }

  function connect(my) {
    return new Promise(function (resolve, reject) {
      my.userDisconnect = false;

      printDebug(my, "Connecting to dingtalk websocket @ " + my.dw_url);
      my.socket = new WebSocket(my.dw_url, my.sslopts);

      // config dw connection when socket is open
      my.socket.on("open", function () {
        my.connected = true;
        printDebug(my, "Socket open");
        // check if keepalive (client-side heartbeat) is enabled
        // if enabled, start heartbeat for ping-pong
        if (my.keepAlive) {
          my.socket.isAlive = true;
          my.heartbeatIntervallId = setInterval(function ping() {
            // if ping-pong need to much time, longer than heartbeat, terminate socket connection
            if (my.socket.isAlive === false) {
              console.error(
                "TERMINATE SOCKET: Ping Pong does not transfer heartbeat within heartbeat intervall"
              );
              return my.socket.terminate();
            }
            // if ping-pong ok, prepare next one
            my.socket.isAlive = false;
            my.socket.ping("", true);
          }, my.heartbeat_interval);
        }
        // my.publish('SYSTEM', 'CONNECTED', 'true');
      });

      // wait for ping-pong with server
      my.socket.on("pong", function () {
        my.heartbeat();
      });

      // on receiving messages from dingtalk websocket server
      my.socket.on("message", function (data) {
        console.log(data);
        // {"specVersion":"1.0","type":"SYSTEM","headers":{"contentType":"application/json","messageId":"c0a800e9168327945646012d43","time":"1683279456460","topic":"disconnect"},"data":"{\"reason\":\"persistent connection is timeout\"}"}
        // {"specVersion":"1.0","type":"CALLBACK","headers":{"appId":"9256b875-17e5-46a8-890a-bf4246dc5349","connectionId":"c3faec14-ebe9-11ed-8943-0ec429f1b9a1","contentType":"application/json","messageId":"213f1d00_853_187b7df781f_225d","time":"1683362492940","topic":"bot_got_msg"},"data":"{\"conversationId\":\"cidFbEwwavwcAsXDZbYqSBLnA==\",\"atUsers\":[{\"dingtalkId\":\"$:LWCP_v1:$25jBd/IW606RTMrGnMs9AuLMeuAztDrv\"}],\"chatbotCorpId\":\"ding9f50b15bccd16741\",\"chatbotUserId\":\"$:LWCP_v1:$25jBd/IW606RTMrGnMs9AuLMeuAztDrv\",\"msgId\":\"msgqEufncv9gVqy7ia60LYs3w==\",\"senderNick\":\"骏隆（主用钉）\",\"isAdmin\":true,\"senderStaffId\":\"01426861-1254332033\",\"sessionWebhookExpiredTime\":1683363692884,\"createAt\":1683362491872,\"senderCorpId\":\"ding9f50b15bccd16741\",\"conversationType\":\"2\",\"senderId\":\"$:LWCP_v1:$+PxJZVhRkpC139mPH6L7aw==\",\"conversationTitle\":\"机器人长链接事件测试群\",\"isInAtList\":true,\"sessionWebhook\":\"https://oapi.dingtalk.com/robot/sendBySession?session=2664f1467475bd90fcba36234c735997\",\"text\":{\"content\":\" ss\"},\"robotCode\":\"dingphtembyvlbeq2y4d\",\"msgtype\":\"text\"}"}
        let msg = JSON.parse(data);
        switch (msg.type) {
          case "SYSTEM":
            if (msg.headers.topic === "CONNECTED") {
              my.register();
            } else if (msg.headers.topic === "REGISTERED") {
              my.registered = true;
              my.reconnecting = false;
              my.publish("SYSTEM", "REGISTERED", "true");
            } else if (msg.headers.topic === "disconnect") {
              my.connected = false;
              my.registered = false;
              my.publish("SYSTEM", "disconnect", msg);
            } else if (msg.headers.topic === "KEEPALIVE") {
              my.heartbeat();
            } else if (msg.headers.topic === "ping") {
                let data = {
                    code : 200,
                    headers: msg.headers,
                    message : "OK",
                    data : msg.data 
                  }
                my.socket.send(JSON.stringify(data));
            }
            break;
          case "EVENT":
            my.publish("EVENT", msg.headers.topic, msg.data);
            break;
          case "CALLBACK":
            // 处理机器人回调消息
            if (msg.headers.topic === ROBOT_TOPIC) {
              my.publish("CALLBACK", msg.headers.topic, msg);
            }
            break;
        }
      });

      my.socket.on("close", function (err) {
        my.connected = false;
        my.registered = false;
        console.warn("CLOSE", err);
        // perorm reconnection (if not canceled by user)
        if (my.autoReconnect & !my.userDisconnect) {
          my.reconnecting = true;
          printDebug(
            my,
            "Reconnecting in " + my.reconnectInterval / 1000 + " seconds..."
          );
          setTimeout(my.connect, my.reconnectInterval);
        }
      });

      // on socket errors
      my.socket.on("error", function (err) {
        console.warn("ERROR", err);
      });

      resolve();
    });
  }

  function publish(my, type, topic, value) {
    switch (type) {
      case "SYSTEM":
        break;
      case "EVENT":
        break;
      case "CALLBACK":
        if (my.callbackListeners[topic]) {
          my.callbackListeners[topic](value);
        }
        break;
    }
  }

  function disconnect(my) {
    console.info("Disconnecting.");
    my.userDisconnect = true;
    // if client-side heartbeat is active, cancel the heartbeat intervall
    if (my.keepAlive && my.heartbeatIntervallId !== undefined) {
      clearInterval(my.heartbeatIntervallId);
    }
    my.socket.close();
  }

  function printDebug(my, msg) {
    if (my.debug) {
      let date = "[" + new Date().toISOString() + "]";
      console.info(date, msg);
    }
  }

  /**
   * Register a callback function for robot.
   * @param {function} callback - The callback function to be called when the robot is evoked.
   */
  this.registerRobotCallbackFunction = function (callback) {
    if (!callback) {
      console.error("registerRobotCallbackFunction: callback must be defined");
      throw new Error(
        "registerRobotCallbackFunction: callback must be defined"
      );
    }

    my.config.subscriptions.push({
      type: "CALLBACK",
      topic: ROBOT_TOPIC,
    });

    my.callbackListeners[ROBOT_TOPIC] = callback;

    return my;
  };

  /**
   * Register a callback listener for a specific event.
   * @param {string} eventId - The event id to listen for.
   * @param {function} callback - The callback function to be called when the event is received.
   * @returns {object} - The client object.
   * @example
   * client.registerCallbackListener('myEvent', function (data) {
   *  console.log('myEvent received: ', data);
   * });
   */
  this.registerCallbackListener = function (eventId, callback) {
    if (!eventId || !callback) {
      console.error(
        "registerCallbackListener: eventId and callback must be defined"
      );
      throw new Error(
        "registerCallbackListener: eventId and callback must be defined"
      );
    }

    my.config.subscriptions.push({
      type: "CALLBACK",
      topic: eventId,
    });

    my.callbackListeners[eventId] = callback;

    return my;
  };

  async function getEndpoint(my) {
    try {
      printDebug(my, "get connect endpoint by config");
      console.log(my.config);
      const result = await makeHttpRequest(
        `https://oapi.dingtalk.com/gettoken?appkey=${my.config.clientId}&appsecret=${my.config.clientSecret}`,
        {
          dataType: "json",
        }
      );
      if (result.status === 200 && result.data.access_token) {
        my.config.access_token = result.data.access_token;
        try {
          const res = await makeHttpRequest(
            `https://api.dingtalk.com/v1.0/gateway/connections/open`,
            {
              method: "POST",
              dataType: "json",
              contentType: "json",
              data: my.config,
              headers: {
                "access-token": result.data.access_token, // 'd136e657-5998-4cc4-a055-2b7ceab0f212'
              },
            }
          );
          if (res.data) {
            my.config.endpoint = res.data;
            const { endpoint, ticket } = res.data;
            if (!endpoint || !ticket) {
              printDebug(my, "endpoint or ticket is null");
              throw new Error("endpoint or ticket is null");
            }
            my.dw_url = `${endpoint}?ticket=${ticket}`;
            return my;
          } else {
            throw new Error("build: get endpoint failed");
          }
        } catch (err) {
          throw err;
        }
      } else {
        throw new Error("build: get access_token failed");
      }
    } catch (err) {
      throw err;
    }
  }

  this.connect = function () {
    getEndpoint(my).then(() => {
      connect(my).catch(function (err) {
        console.error(err);
        process.exit(1);
      });
    });
  };

  this.disconnect = function () {
    disconnect(my);
  };

  /**
   * Called each time the callback for client-side heartbeat was received successfully.
   */
  this.heartbeat = function () {
    my.socket.isAlive = true;
    printDebug(my, "CLIENT-SIDE HEARTBEAT");
  };

  this.getConfig = function () {
    return config;
  };

  this.publish = function (type, topic, value) {
    publish(my, type, topic, value);
  };

  this.send = function (messageId, value) {
    if (!messageId) {
      console.error("send: messageId must be defined");
      throw new Error("send: messageId must be defined");
    }

    let msg = {
      code: 200,
      headers: {
        contentType: "application/json",
        messageId: messageId,
      },
      message : "OK",
      data: JSON.stringify(value),
    };
    my.socket.send(JSON.stringify(msg));
  }
};

module.exports = DWClient;
