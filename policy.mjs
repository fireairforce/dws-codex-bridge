import { createHash } from 'node:crypto';

export const EVENT_KEY = 'user_im_message_receive_o2o';
export const GROUP_EVENT_KEY = 'user_im_message_receive_group';

export function eventKey(config) {
  return typeof config.groupConversationId === 'string' && config.groupConversationId.length > 0
    ? GROUP_EVENT_KEY : EVENT_KEY;
}

export function eventRejectionReason(event, config) {
  const expectedType = eventKey(config);
  if (!event || event.type !== expectedType) return 'event_type';
  if (event.sender_open_dingtalk_id !== config.supervisorOpenId) return 'sender';
  if (typeof event.conversation_id !== 'string' || !event.conversation_id) return 'conversation_id';
  if (expectedType === GROUP_EVENT_KEY && event.conversation_id !== config.groupConversationId) return 'conversation_id';
  if (typeof event.message_id !== 'string' || !event.message_id) return 'message_id';
  if (typeof event.content !== 'string' || !event.content.trim()) return 'content';
  if (event.content.length > 32000) return 'content_length';
  return null;
}

export function acceptEvent(event, config) {
  if (eventRejectionReason(event, config)) return null;
  const key = createHash('sha256').update(JSON.stringify([
    config.profile, event.conversation_id, event.message_id,
  ])).digest('hex');
  const session = createHash('sha256').update(JSON.stringify([
    config.profile, event.conversation_id, event.sender_open_dingtalk_id,
  ])).digest('hex');
  return { key, session, text: event.content.trim(), event };
}

export function singleBizId(value) {
  const ids = new Set();
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      if (key === 'bizId' && typeof child === 'string' && child) ids.add(child);
      else if (child && typeof child === 'object') visit(child);
    }
  }
  visit(value);
  if (ids.size !== 1) throw new Error('创建回执缺少唯一 bizId；投递结果未知，停止后续发送。');
  return [...ids][0];
}
