import {DWClient, DWClientDownStream, EventAck, RobotMessage, TOPIC_ROBOT} from '../src/index.js';
import axios from 'axios';
import config from './config.json' assert {type: 'json'};

const client = new DWClient({
  clientId: config.clientId,
  clientSecret: config.clientSecret,
  debug: false
});
client.registerCallbackListener(TOPIC_ROBOT, async (res) => {
    // 注册机器人回调事件
    console.log("收到消息");
    // const {messageId} = res.headers;
    const { text, senderStaffId, sessionWebhook } = JSON.parse(res.data) as RobotMessage;
    const body = {
      at: {
        atUserIds: [senderStaffId],
        isAtAll: false,
      },
      text: {
        content: 'nodejs-getting-started say : 收到，' + text?.content || '钉钉,让进步发生',
      },
      msgtype: 'text',
    };

    const result = await axios({
      url: sessionWebhook,
      method: 'POST',
      responseType: 'json',
      data: body,
      headers: {
        'x-acs-dingtalk-access-token': client.getConfig().access_token,
      },
    });

    return result.data;
  })
  .registerAllEventListener((message: DWClientDownStream) => {
      return {status: EventAck.SUCCESS}
  })
  .connect();
