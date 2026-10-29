import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { SimpleA2UIReplyCard, SIMPLE_A2UI_CARD_TYPE } from './simple-a2ui-card.mjs';

const arg = (args, flag) => args[args.indexOf(flag) + 1];
const messages = call => JSON.parse(call.body).map(value => JSON.parse(value));
const component = call => messages(call).find(message => message.updateComponents).updateComponents.components[0];

function fixture(reply = () => ({ ok: true, data: { bizId: 'actual-card', accepted: true, verified: false } })) {
  const calls = [];
  const card = new SimpleA2UIReplyCard(async (args, body) => {
    calls.push({ args: [...args], body });
    return reply(args, calls.length);
  }, { cwd: '/workspace' });
  return { calls, card };
}

test('real DWS dry-run preserves forwarding and the exact group target', {
  skip: !process.env.DWS_A2UI_DRY_RUN_BIN,
}, async () => {
  let creates = 0;
  const card = new SimpleA2UIReplyCard(async (args, body) => {
    creates += 1;
    const result = spawnSync(process.env.DWS_A2UI_DRY_RUN_BIN,
      [...args.filter(value => value !== '--yes'), '--dry-run', '--format', 'json'],
      { input: body, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.executed, false, 'the regression must never send a card');
    assert.equal(receipt.tool, 'create_and_send_a2ui_card');
    assert.equal(receipt.arguments.openConversationId, 'offline-trusted-group');
    assert.equal(receipt.arguments.supportForward, true, 'new cards must retain the previously enabled forwarding capability');
    return { ok: true, data: { bizId: 'offline-card', accepted: true } };
  });
  await card.create({ conversationId: 'offline-trusted-group' });
  assert.equal(creates, 1);
  assert.equal(card.bizId, 'offline-card');
});

test('creates an initialized, readable single Markdown component under the exact trusted group', async () => {
  const { calls, card } = fixture();
  assert.equal(await card.create({ conversationId: 'trusted-group' }), 'actual-card');
  assert.equal(SIMPLE_A2UI_CARD_TYPE, 'a2ui-markdown-v1');
  const call = calls[0];
  assert.deepEqual(call.args, ['chat', 'message', 'send-a2ui-card', '--conversation-id', 'trusted-group',
    '--summary', '正在处理你的消息。', '--content', '-', '--support-forward', '--yes']);
  assert.equal(messages(call).length, 3);
  const [surface, model, layout] = messages(call);
  assert.equal(surface.createSurface.surfaceId, card.surfaceId);
  assert.equal(model.updateDataModel.path, '/');
  assert.deepEqual(model.updateDataModel.value, {});
  assert.equal(layout.updateComponents.surfaceId, card.surfaceId);
  assert.deepEqual(layout.updateComponents.components, [{ id: 'root', component: 'Markdown',
    content: '正在处理你的消息。', fallbackMarkdown: '正在处理你的消息。' }]);
  assert.equal(card.state, 'open');
  assert.equal(calls.length, 1, 'creation never hides an additional update before the host persists bizId');
});

test('uses only the provided direct target and refuses missing or conflicting targets before DWS', async () => {
  const direct = fixture();
  await direct.card.create({ receiverOpenId: 'trusted-person' });
  assert.equal(arg(direct.calls[0].args, '--open-dingtalk-id'), 'trusted-person');
  assert.ok(!direct.calls[0].args.includes('--conversation-id'));
  assert.ok(direct.calls[0].args.includes('--support-forward'));
  for (const target of [{}, { conversationId: '' }, { receiverOpenId: 1 },
    { conversationId: 'group', receiverOpenId: 'person' }]) {
    const { calls, card } = fixture();
    await assert.rejects(card.create(target));
    assert.equal(calls.length, 0);
  }
});

test('keeps the same component and surface through progress and a FINISH final response', async () => {
  const { calls, card } = fixture();
  await card.create({ conversationId: 'trusted-group' });
  await card.update('已读取代码。', { phase: 'processing' });
  await card.update('正在验证结果。');
  await card.update('正在验证结果。');
  await card.update('**修复完成**\n\n```js\nconsole.log("done");\n```', {
    phase: 'finished', execution: { model: 'gpt-6.1-sol', serviceTier: 'priority' },
  });
  assert.deepEqual(calls.slice(1).map(call => arg(call.args, '--flow-status')), ['PROCESSING', 'INPUTTING', 'INPUTTING', 'FINISH']);
  for (const call of calls.slice(1)) {
    assert.equal(call.args[2], 'update-a2ui-card');
    assert.equal(arg(call.args, '--biz-id'), 'actual-card');
    assert.equal(messages(call).length, 1);
    const message = messages(call)[0];
    assert.equal(message.updateComponents.surfaceId, card.surfaceId);
    assert.deepEqual(message.updateComponents.components.map(item => item.id), ['root']);
    assert.ok(!message.createSurface && !message.updateDataModel);
    const root = component(call);
    assert.equal(root.fallbackMarkdown, root.content);
    assert.doesNotMatch(JSON.stringify(message), /CollapsiblePanel|Image|Divider|textEffect|createSurface/);
  }
  assert.equal(component(calls[3]).content.split('正在验证结果。').length - 1, 1);
  assert.match(component(calls[4]).content, /模型：gpt-6\.1-sol · 速度：Fast/);
  assert.doesNotMatch(component(calls[4]).content, /待执行确认/);
  assert.equal(card.state, 'finished');
  await assert.rejects(card.update('late update'));
  await assert.rejects(card.create({ conversationId: 'trusted-group' }));
});

test('execution errors have visible explanation and FINISH closes output without implying business success', async () => {
  const { calls, card } = fixture();
  await card.create({ conversationId: 'trusted-group' });
  await card.update('会话暂时不可用。', { phase: 'failed' });
  assert.equal(arg(calls[1].args, '--flow-status'), 'FINISH');
  assert.match(component(calls[1]).content, /^\*\*任务未完成\*\*/);
  assert.match(component(calls[1]).content, /会话暂时不可用/);
  assert.match(component(calls[1]).content, /模型：未确认 · 速度：未确认/);
  assert.equal(card.state, 'failed');
});

test('unknown creation receipts preserve real IDs where present and never create twice', async () => {
  for (const receipt of [{ ok: true }, { data: { bizId: 'actual-card' }, partial: true },
    { a: { bizId: 'one' }, b: { bizId: 'two' } }]) {
    const { calls, card } = fixture(() => receipt);
    await assert.rejects(card.create({ conversationId: 'trusted-group' }));
    assert.equal(card.deliveryUnknown, true);
    if (receipt.data?.bizId) assert.equal(card.bizId, receipt.data.bizId);
    await assert.rejects(card.create({ conversationId: 'trusted-group' }));
    await assert.rejects(card.update('do not send'));
    assert.equal(calls.length, 1);
  }
});

test('unknown update receipts stop all writes without migrating or recreating the card', async () => {
  const failures = [
    () => { throw new Error('request timeout'); },
    () => ({ ok: true, partial: true }),
    () => ({ ok: true, data: { accepted: false } }),
    () => ({ ok: true, data: { bizId: 'other-card' } }),
    () => null,
  ];
  for (const failure of failures) {
    const { calls, card } = fixture((args, count) => count === 1 ? { bizId: 'actual-card' } : failure());
    await card.create({ conversationId: 'trusted-group' });
    await assert.rejects(card.update('progress'));
    assert.equal(card.deliveryUnknown, true);
    await assert.rejects(card.update('do not send', { phase: 'failed' }));
    await assert.rejects(card.create({ conversationId: 'trusted-group' }));
    assert.equal(calls.length, 2);
  }
});

test('local images remain compact descriptions and code examples stay literal inside Markdown', async () => {
  const { calls, card } = fixture();
  await card.create({ conversationId: 'trusted-group' });
  await card.update('![结果](/workspace/outputs/proof.png)\n\n`![literal](local.png)`', { phase: 'finished' });
  const content = component(calls[1]).content;
  assert.match(content, /本机图片/);
  assert.doesNotMatch(content, /!\[结果\]/);
  assert.match(content, /`!\[literal\]\(local.png\)`/);
});
