
/** 机器人消息回调 */
export const TOPIC_ROBOT = '/v1.0/im/bot/messages/get';

/** 卡片回调 */
export const TOPIC_CARD = '/v1.0/card/instances/callback';

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

export type RobotMessage = RobotTextMessage;