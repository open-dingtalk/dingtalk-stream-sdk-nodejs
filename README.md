# dingtalk-stream-sdk-nodejs
Nodejs SDK for DingTalk Stream Mode API, Compared with the webhook mode, it is easier to access the DingTalk chatbot
钉钉支持 Stream 模式接入事件推送、机器人收消息以及卡片回调，该 SDK 实现了 Stream 模式。相比 Webhook 模式，Stream 模式可以更简单的接入各类事件和回调。

## 快速开始

### 准备工作

* Nodejs 开发环境，https://midwayjs.org/docs/how_to_install_nodejs
* 需要Node version >= 18.17.1
* 钉钉开发者账号，具备创建企业内部应用的权限，详见[成为钉钉开发者](https://open.dingtalk.com/document/orgapp/become-a-dingtalk-developer)

### 快速开始指南

1、创建企业内部应用

进入[钉钉开发者后台](https://open-dev.dingtalk.com/)，创建企业内部应用，获取ClientID（即 AppKey）和ClientSecret（ 即AppSecret）。

发布应用：在开发者后台左侧导航中，点击“版本管理与发布”，点击“确认发布”，并在接下来的可见范围设置中，选择“全部员工”，或者按需选择部分员工。


2、Stream 模式的机器人（可选）

如果不需要使用机器人功能的话，可以不用创建。

在应用管理的左侧导航中，选择“消息推送”，打开机器人能力，设置机器人基本信息。

注意：消息接收模式中，选择 “Stream 模式”

![Stream 模式](https://img.alicdn.com/imgextra/i3/O1CN01XL4piO1lkYX2F6sW6_!!6000000004857-0-tps-896-522.jpg)

点击“点击调试”按钮，可以创建测试群进行测试。

3、使用demo项目测试，启动服务：

a、获取demo项目 
```Shell
 git clone git@github.com:open-dingtalk/dingtalk-stream-sdk-nodejs.git
```
b、在example/config.json里配置应用信息。

c、启动测试case
```Shell
cd dingtalk-stream-sdk-nodejs
yarn
npm run build
npm start
```

4、在项目中引用sdk，安装 dingtalk-stream-sdk-nodejs

```Shell
npm i dingtalk-stream-sdk-nodejs
```

代码中使用
```javascript
const DWClient = require("../index");
const config = require("./config.json");

const client = new DWClient({
  clientId: config.clientId,
  clientSecret: config.clientSecret,
});
client.registerRobotCallbackFunction('/v1.0/im/bot/messages/get', async (res) => {
    // 注册机器人回调事件
    console.log("收到消息");
    const {messageId} = res.headers;
    const { text, senderStaffId, sessionWebhook } = JSON.parse(res.data);
  })
  .connect();
```

### 事件订阅切换到 Stream 模式（可选）

进入钉钉开发者后台，选择企业内部应用，在应用管理的左侧导航中，选择“事件与回调”。
“订阅管理”中，“推送方式”选项中，选择 “Stream 模式”，并保存


### 技术支持

[点击链接，加入Stream模式共创群交流](https://open-dingtalk.github.io/developerpedia/docs/explore/support/?via=moon-group)
