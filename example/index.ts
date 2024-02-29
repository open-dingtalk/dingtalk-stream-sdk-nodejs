import {
  DWClient,
  DWClientDownStream,
  EventAck,
  RobotMessage,
  TOPIC_ROBOT,
  TOPIC_AI_GRAPH_API,
} from "../src/index.js";
import axios from "axios";
import config from "./config.json" assert { type: "json" };

console.log("开始启动");
const client = new DWClient({
  clientId: config.clientId,
  clientSecret: config.clientSecret,
  debug: true,
});
client.registerCallbackListener(TOPIC_ROBOT, async (res) => {
  // 注册机器人回调事件
  console.log("收到消息");
  debugger;
  // const {messageId} = res.headers;
  const { text, senderStaffId, sessionWebhook } = JSON.parse(
    res.data
  ) as RobotMessage;
  const body = {
    at: {
      atUserIds: [senderStaffId],
      isAtAll: false,
    },
    text: {
      content:
        "nodejs-getting-started say : 收到，" + text?.content ||
        "钉钉,让进步发生",
    },
    msgtype: "text",
  };

  const accessToken = await client.getAccessToken();
  const result = await axios({
    url: sessionWebhook,
    method: "POST",
    responseType: "json",
    data: body,
    headers: {
      "x-acs-dingtalk-access-token": accessToken,
    },
  });

  // stream模式下，服务端推送消息到client后，会监听client响应，如果消息长时间未响应会在一定时间内(60s)重试推消息，可以通过此方法返回消息响应，避免多次接收服务端消息。
  // 机器人topic，可以通过socketCallBackResponse方法返回消息响应
  if(result?.data){
    client.socketCallBackResponse(res.headers.messageId, result.data);
  }
});
client
  .registerCallbackListener(
    TOPIC_AI_GRAPH_API,
    async (res: DWClientDownStream) => {
      // 注册AI插件回调事件
      console.log("收到ai消息");
      const { messageId } = res.headers;

      // 添加业务逻辑
      console.log(res);
      console.log(JSON.parse(res.data));

      // 通过Stream返回数据
      client.sendGraphAPIResponse(messageId, {
        response: {
          statusLine: {
            code: 200,
            reasonPhrase: "OK",
          },
          headers: {},
          body: JSON.stringify({
            text: "你好",
          }),
        },
      });
    }
  )
  .registerAllEventListener((message: DWClientDownStream) => {
    return { status: EventAck.SUCCESS };
  })
  .connect();
