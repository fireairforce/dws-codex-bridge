import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptEvent, eventKey, eventRejectionReason,
  singleBizId, EVENT_KEY, GROUP_EVENT_KEY } from './policy.mjs';

const config = { profile: 'corp:employee', supervisorOpenId: 'owner-open-id' };
const message = { type: EVENT_KEY, sender_open_dingtalk_id: 'owner-open-id',
  sender: '主管', conversation_id: 'conversation-a', message_id: 'message-a',
  event_id: 'event-a', content: '连接测试' };

test('only the exact owner and direct-message event can start a task', () => {
  assert.equal(eventKey(config), EVENT_KEY);
  assert.equal(eventKey({ ...config, groupConversationId: '' }), EVENT_KEY);
  assert.equal(acceptEvent(message, config).text, '连接测试');
  assert.equal(acceptEvent({ ...message, sender_open_dingtalk_id: 'impostor', sender: '主管' }, config), null);
  assert.equal(acceptEvent({ ...message, type: 'user_im_message_receive_user' }, config), null);
  assert.equal(acceptEvent({ ...message, type: 'user_im_message_receive_group' }, config), null);
});
test('group mode accepts only the configured group and exact owner', () => {
  const groupConfig = { ...config, groupConversationId: 'allowed-group' };
  const groupMessage = { ...message, type: GROUP_EVENT_KEY, conversation_id: 'allowed-group' };
  assert.equal(eventKey(groupConfig), GROUP_EVENT_KEY);
  assert.equal(acceptEvent(groupMessage, groupConfig).text, '连接测试');
  assert.equal(eventRejectionReason({ ...groupMessage, conversation_id: 'other-group' }, groupConfig), 'conversation_id');
  assert.equal(acceptEvent({ ...groupMessage, conversation_id: 'other-group' }, groupConfig), null);
  assert.equal(acceptEvent({ ...groupMessage, sender_open_dingtalk_id: 'impostor', sender: '主管' }, groupConfig), null);
  assert.equal(acceptEvent({ ...groupMessage, type: EVENT_KEY }, groupConfig), null);
  assert.equal(acceptEvent(groupMessage, config), null);
});
test('group mode cannot execute incomplete identities or empty tasks', () => {
  const groupConfig = { ...config, groupConversationId: 'allowed-group' };
  const groupMessage = { ...message, type: GROUP_EVENT_KEY, conversation_id: 'allowed-group' };
  for (const patch of [{ sender_open_dingtalk_id: '' }, { conversation_id: '' },
    { message_id: '' }, { content: '  ' }, { content: {} }, { content: 'x'.repeat(32001) }]) {
    assert.equal(acceptEvent({ ...groupMessage, ...patch }, groupConfig), null);
  }
});
test('group transport duplicates deduplicate while later messages keep thread continuity', () => {
  const groupConfig = { ...config, groupConversationId: 'allowed-group' };
  const groupMessage = { ...message, type: GROUP_EVENT_KEY, conversation_id: 'allowed-group' };
  const first = acceptEvent(groupMessage, groupConfig);
  const duplicate = acceptEvent({ ...groupMessage, event_id: 'retried-delivery' }, groupConfig);
  assert.equal(first.key, duplicate.key);
  const next = acceptEvent({ ...groupMessage, message_id: 'message-b' }, groupConfig);
  assert.equal(first.session, next.session);
  assert.notEqual(first.key, next.key);
});
test('ambiguous identity, target, or empty input cannot start a task', () => {
  for (const patch of [{ sender_open_dingtalk_id: '' }, { conversation_id: '' },
    { message_id: '' }, { content: '  ' }, { content: {} }, { content: 'x'.repeat(32001) }]) {
    assert.equal(acceptEvent({ ...message, ...patch }, config), null);
  }
});
test('transport duplicates deduplicate by stable message identity; sessions stay separate', () => {
  const first = acceptEvent(message, config);
  const duplicate = acceptEvent({ ...message, event_id: 'transport-retry-id' }, config);
  assert.equal(first.key, duplicate.key);
  const other = acceptEvent({ ...message, conversation_id: 'conversation-b' }, config);
  assert.notEqual(first.key, other.key);
  assert.notEqual(first.session, other.session);
  const next = acceptEvent({ ...message, message_id: 'message-b' }, config);
  assert.equal(first.session, next.session);
  assert.notEqual(first.key, next.key);
});
test('unknown or conflicting card creation receipts never yield a usable id', () => {
  assert.equal(singleBizId({ result: { bizId: 'real-id' } }), 'real-id');
  assert.throws(() => singleBizId({ openTaskId: 'not-a-biz-id' }));
  assert.throws(() => singleBizId({ a: { bizId: 'first' }, b: { bizId: 'second' } }));
});
