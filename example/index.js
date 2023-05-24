const { makeHttpRequest } = require("@midwayjs/core");
const DWClient = require("../index");
const config = require("./config.json");

const client = new DWClient(config.appKey, config.appSecret);
client.registerRobotCallbackFunction(async (res) => {
    // 注册机器人回调事件
    console.log("收到消息");
    // const {messageId} = res.headers;
    const { text, senderStaffId, sessionWebhook } = JSON.parse(res.data);
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

    try {
      const result = await makeHttpRequest(sessionWebhook, {
        method: 'POST',
        dataType: 'json',
        contentType: 'json',
        data: body,
        headers: {
          'x-acs-dingtalk-access-token': client.getConfig().access_token,
        },
      });
      return result.data;
    } catch (error) {
      this.logger.error(error);
      throw error
    }

    //client.send(messageId, body);
    return { success: true, code: 200, message: "OK", data: body };
  })
  .connect();
