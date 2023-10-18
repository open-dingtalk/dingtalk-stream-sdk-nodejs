export const GATEWAY_URL = 'https://api.dingtalk.com/v1.0/gateway/connections/open';
export const GET_TOKEN_URL = 'https://oapi.dingtalk.com/gettoken';


/** 机器人消息回调 */
export const TOPIC_ROBOT = '/v1.0/im/bot/messages/get';

/** 卡片回调 */
export const TOPIC_CARD = '/v1.0/card/instances/callback';

/** AI Graph API 插件消息回调 */
export const TOPIC_AI_GRAPH_API = '/v1.0/graph/api/invoke';

interface RobotMessageBase {
  conversationId: string;
  chatbotCorpId: string;
  chatbotUserId: string;
  msgId: string;
  senderNick: string;
  isAdmin: boolean;
  senderStaffId: string;
  sessionWebhookExpiredTime: number;
  createAt: number;
  senderCorpId: string;
  conversationType: string;
  senderId: string;
  sessionWebhook: string;
  robotCode: string;
  msgtype: string;
}

export interface RobotTextMessage extends RobotMessageBase {
  msgtype: 'text';
  text: {
    content: string;
  };
}

export interface GraphAPIResponse {
  response: {
    statusLine: {
      code?: number;
      reasonPhrase?: string;
    };
    headers: {
      [key: string]: string;
    };
    body: string;
  };
}

export type RobotMessage = RobotTextMessage;