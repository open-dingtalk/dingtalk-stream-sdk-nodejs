<p align="left">
  <a target="_blank" href="https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs/actions/workflows/publish.yml">
    <img src="https://img.shields.io/github/actions/workflow/status/open-dingtalk/dingtalk-stream-sdk-nodejs/publish.yml" />
  </a>

  <a target="_blank" href="https://www.npmjs.com/package/dingtalk-stream">
    <img alt="NPM Version" src="https://img.shields.io/npm/v/dingtalk-stream">
  </a>

</p>

钉钉支持 Stream 模式接入事件推送、机器人收消息以及卡片回调，该 SDK 实现了 Stream 模式。相比 Webhook 模式，Stream 模式可以更简单的接入各类事件和回调。

## 开发教程

在 [教程文档](https://opensource.dingtalk.com/developerpedia/docs/explore/tutorials/stream/overview) 中，你可以找到钉钉 Stream 模式的教程文档和示例代码。

### 参考资料

* [Stream 模式说明](https://opensource.dingtalk.com/developerpedia/docs/learn/stream/overview)
* [教程文档](https://opensource.dingtalk.com/developerpedia/docs/explore/tutorials/stream/overview)
* [常见问题](https://opensource.dingtalk.com/developerpedia/docs/learn/stream/faq)
* [Stream 模式共创群](https://opensource.dingtalk.com/developerpedia/docs/explore/support/?via=moon-group)

### 调试方法

1、创建企业内部应用

进入钉钉开发者后台，创建企业内部应用，获取ClientID（即 AppKey）和ClientSecret（ 即AppSecret）。

2、开通Stream 模式的机器人

进入开发者后台新建的应用，点击应用能力 - 添加应用能力 - 机器人，完善机器人信息，选择stream模式并发布。

3、使用demo项目测试，启动服务：

a、获取demo项目

 git clone git@github.com:open-dingtalk/dingtalk-stream-sdk-nodejs.git
b、在example/config.json里配置应用信息。

c、启动测试case

cd dingtalk-stream-sdk-nodejs
yarn
npm run build
npm start


注意：示例通过 Node.js 的 `ts-node/esm` loader 启动；TypeScript 文件中的相对 import 仍需使用 `.js` 后缀，以匹配 ESM 运行时解析规则。

## 异步事件处理与背压

`maxPendingEventHandlers` 控制同时执行的 EVENT handler 数量，
`maxPendingCallbackHandlers` 控制同时执行的异步 CALLBACK handler 数量，
默认值均为 `100`。EVENT 达到上限后，SDK 会直接回复 `LATER`；CALLBACK
达到上限后不会调用新 handler，也不会 ACK，由服务端稍后重投，避免慢 handler
持续堆积并耗尽内存。连接断开时，SDK 会中止当前连接的 EVENT `AbortSignal`：

```ts
const client = new DWClient({
  clientId,
  clientSecret,
  maxPendingEventHandlers: 20,
  maxPendingCallbackHandlers: 20,
});

client.registerAllEventListener(async (event, signal) => {
  await processEvent(event, { signal });
  return { status: EventAck.SUCCESS };
});
```

业务 handler 应把 `signal` 继续传给支持取消的异步操作；忽略取消信号的
Promise 无法被 JavaScript 强制终止，但仍受全局并发上限保护。
