import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamingReplyCard } from './streaming-card.mjs';

function fixture(reply = () => ({ ok: true, data: { bizId: 'card-id', accepted: true, verified: false } })) {
  const calls = [];
  const card = new StreamingReplyCard(async args => {
    calls.push([...args]);
    return reply(args, calls.length);
  });
  return { calls, card };
}

const arg = (args, flag) => args[args.indexOf(flag) + 1];

test('group replies create once, then update the same native card through progress and final', async () => {
  const { card, calls } = fixture();
  assert.equal(await card.create({ conversationId: 'trusted-group' }), 'card-id');
  assert.deepEqual(calls[0], ['chat', '+messages-send-card', '--group', 'trusted-group', '--yes']);
  assert.ok(!calls[0].includes('--content'), 'persist the creation ID before writing any body');
  await card.update('正在处理你的消息。', { phase: 'processing' });
  await card.update('已读取代码。');
  await card.update('正在验证结果。');
  const answer = '**完整答案**\n\n```js\nconsole.log("done");\n```';
  await card.update(answer, { phase: 'finished', execution: { model: 'gpt-6.1-sol', serviceTier: 'priority' } });
  const updates = calls.slice(1);
  assert.deepEqual(updates.map(args => arg(args, '--flow-status')), ['1', '2', '2', '3']);
  for (const args of updates) {
    assert.equal(args[1], '+messages-update-card');
    assert.equal(arg(args, '--biz-id'), 'card-id');
    assert.equal(args.at(-1), '--yes');
    assert.ok(!args.some(value => /a2ui|annotations|surface/.test(value)));
  }
  const progress = arg(updates[2], '--content');
  assert.ok(progress.indexOf('已读取代码。') < progress.indexOf('正在验证结果。'));
  const final = arg(updates[3], '--content');
  assert.ok(final.startsWith(answer), 'the complete Markdown answer is preserved');
  assert.match(final, /模型：gpt-6\.1-sol · 速度：Fast/);
  assert.doesNotMatch(final, /查看详情|升级|待执行确认/);
  assert.equal(card.state, 'finished');
  await assert.rejects(card.create({ conversationId: 'trusted-group' }));
  await assert.rejects(card.update('late update'));
  assert.equal(calls.length, 5);
});

test('direct replies use the exact validated open ID without a second identity lookup', async () => {
  const { card, calls } = fixture();
  await card.create({ receiverOpenId: 'trusted-open-id' });
  assert.deepEqual(calls[0], ['chat', '+messages-send-card', '--receiver-open-dingtalk-id', 'trusted-open-id', '--yes']);
});

test('missing or conflicting targets never invoke DWS', async () => {
  for (const target of [{}, { conversationId: '' }, { receiverOpenId: 1 },
    { conversationId: 'group', receiverOpenId: 'person' }]) {
    const { card, calls } = fixture();
    await assert.rejects(card.create(target));
    assert.equal(calls.length, 0);
  }
});

test('missing or conflicting creation IDs never trigger retries or updates', async () => {
  for (const receipt of [{ ok: true }, { a: { bizId: 'one' }, b: { bizId: 'two' } }]) {
    const { card, calls } = fixture(() => receipt);
    await assert.rejects(card.create({ conversationId: 'trusted-group' }));
    assert.equal(card.deliveryUnknown, true);
    await assert.rejects(card.create({ conversationId: 'trusted-group' }));
    await assert.rejects(card.update('do not send'));
    assert.equal(calls.length, 1);
  }
});

test('timeouts, partial results, mismatched IDs and missing receipts stop all later card writes', async () => {
  const failures = [
    () => { throw new Error('request timeout'); },
    () => ({ ok: true, partial: true, data: { bizId: 'card-id' } }),
    () => ({ ok: true, data: { accepted: false } }),
    () => ({ ok: true, data: { failures: [{ message: 'failed' }] } }),
    () => ({ ok: true, data: { bizId: 'wrong-card' } }),
    () => null,
  ];
  for (const failure of failures) {
    const { card, calls } = fixture((args, count) => count === 1 ? { bizId: 'card-id' } : failure());
    await card.create({ conversationId: 'trusted-group' });
    await assert.rejects(card.update('progress'));
    await assert.rejects(card.update('do not send', { phase: 'failed' }));
    await assert.rejects(card.create({ conversationId: 'trusted-group' }));
    assert.equal(card.deliveryUnknown, true);
    assert.equal(calls.length, 2);
  }
});

test('a partial create preserves its known card ID but never attempts a body update', async () => {
  const { card, calls } = fixture(() => ({ ok: true, partial: true, data: { bizId: 'card-id' } }));
  await assert.rejects(card.create({ conversationId: 'trusted-group' }));
  assert.equal(card.bizId, 'card-id');
  await assert.rejects(card.update('do not send'));
  assert.equal(calls.length, 1);
});

test('execution failure uses status 5 and does not invent model or speed confirmation', async () => {
  const { card, calls } = fixture();
  await card.create({ conversationId: 'trusted-group' });
  await card.update('图片下载失败。', { phase: 'failed' });
  const update = calls[1];
  assert.equal(arg(update, '--flow-status'), '5');
  assert.match(arg(update, '--content'), /任务未完成/);
  assert.match(arg(update, '--content'), /模型：未确认 · 速度：未确认/);
  assert.equal(card.state, 'failed');
});

test('an unspecified or unknown speed never renders as Fast', async () => {
  for (const [serviceTier, label] of [[null, '默认'], ['unrecognized-tier', '未确认']]) {
    const { card, calls } = fixture();
    await card.create({ conversationId: 'trusted-group' });
    await card.update('完成。', { phase: 'finished', execution: { model: 'test-model', serviceTier } });
    assert.match(arg(calls[1], '--content'), new RegExp(`速度：${label}`));
    assert.doesNotMatch(arg(calls[1], '--content'), /Fast/);
  }
});
