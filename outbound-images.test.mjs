import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, symlink, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { prepareImageReply, deliverImageReply } from './outbound-images.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII=', 'base64');
const MiB = 1024 * 1024;

async function workspace(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'dws-outbound-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

async function image(cwd, path = 'outputs/result.png', bytes = png) {
  const full = join(cwd, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, bytes);
  return full;
}

async function planFor(t) {
  const cwd = await workspace(t);
  await image(cwd);
  return prepareImageReply('![执行结果](outputs/result.png)', { cwd });
}

const ack = { result: { openTaskId: 'task-1' } };
const complete = { result: { openTaskId: 'task-1', openMessageId: 'message-1',
  openConversationId: 'cid-target', status: 'SUCCESS' } };
const options = extra => ({ target: { conversationId: 'cid-target' }, idempotencyKey: 'unique-key',
  onReceipt: async () => {}, ...extra });

test('text, remote images and code examples do not read or create workspace directories', async () => {
  for (const text of ['只有文字', '![remote](https://example.com/image.png)',
    '`![example](outputs/private.png)`', '```md\n![example](outputs/private.png)\n```']) {
    assert.deepEqual(await prepareImageReply(text, { cwd: '/does-not-exist' }),
      { markdown: '', images: [], warnings: [] });
  }
});

test('workspace images are copied to private simple paths with safe captions and original bytes', async t => {
  const cwd = await workspace(t);
  const first = await image(cwd, 'outputs/a b(1).png');
  const second = await image(cwd, 'downloads/dingtalk-images/message-1/image-1');
  const plan = await prepareImageReply(`![a [click](https://evil.invalid)](<${first}>)\n![second](${pathToFileURL(second)})`, { cwd });
  assert.equal(plan.images.length, 2);
  assert.equal(plan.warnings.length, 0);
  assert.deepEqual(plan.images.map(item => item.relativePath),
    ['outputs/a b(1).png', 'downloads/dingtalk-images/message-1/image-1']);
  assert.equal(plan.images[0].source, first);
  assert.doesNotMatch(plan.markdown, /https:\/\/evil\.invalid\]\(/);
  assert.equal((plan.markdown.match(/!\[/g) || []).length, 2);
  for (const [index, item] of plan.images.entries()) {
    assert.match(item.stagedPath, /^outputs\/bridge-outbound-images\/message-[\w-]+\/image-\d\.png$/);
    assert.deepEqual(await readFile(join(cwd, item.stagedPath)), png);
    assert.equal((await stat(join(cwd, item.stagedPath))).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(join(cwd, item.stagedPath)))).mode & 0o777, 0o700);
    assert.equal(index + 1, Number(/image-(\d)/.exec(item.stagedPath)[1]));
  }
  await writeFile(first, 'changed after preparation');
  assert.deepEqual(await readFile(join(cwd, plan.images[0].stagedPath)), png);
  assert.throws(() => plan.images.push({}), TypeError);
});

test('local image aliases are canonicalized and duplicates are copied once', async t => {
  const cwd = await workspace(t);
  const file = await image(cwd);
  const plan = await prepareImageReply(`![one](outputs/result.png)\n![two](sandbox:${file})\n![three](${pathToFileURL(file)})`, { cwd });
  assert.equal(plan.images.length, 1);
  assert.equal(plan.warnings.length, 0);
});

test('external files, escaping symlinks, non-images and empty files never become upload inputs', async t => {
  const cwd = await workspace(t);
  const outside = await workspace(t);
  const external = await image(outside);
  await mkdir(join(cwd, 'outputs'));
  await symlink(external, join(cwd, 'outputs', 'escape.png'));
  await image(cwd, 'outputs/html.png', '<html>not an image</html>');
  await image(cwd, 'outputs/empty.png', Buffer.alloc(0));
  await image(cwd, 'private.png');
  const plan = await prepareImageReply(`![outside](${external})\n![link](outputs/escape.png)\n![html](outputs/html.png)\n![empty](outputs/empty.png)\n![private](private.png)`, { cwd });
  assert.equal(plan.images.length, 0);
  assert.equal(plan.markdown, '');
  assert.equal(plan.warnings.length, 1);
  assert.doesNotMatch(plan.warnings.join(''), new RegExp(cwd));
  assert.doesNotMatch(plan.warnings.join(''), /html\.png|private\.png|escape\.png/);
  await assert.rejects(access(join(cwd, 'outputs', 'bridge-outbound-images')));
});

test('a staging directory symlink cannot write outside the workspace', async t => {
  const cwd = await workspace(t);
  const outside = await workspace(t);
  await image(cwd);
  await symlink(outside, join(cwd, 'outputs', 'bridge-outbound-images'));
  await assert.rejects(prepareImageReply('![result](outputs/result.png)', { cwd }), /不安全/);
});

test('file and total byte budgets and the four-image limit keep rejected files out of the plan', async t => {
  const cwd = await workspace(t);
  const sized = size => { const bytes = Buffer.alloc(size); png.copy(bytes); return bytes; };
  await image(cwd, 'outputs/too-big.png', sized(10 * MiB + 1));
  const tooBig = await prepareImageReply('![large](outputs/too-big.png)', { cwd });
  assert.equal(tooBig.images.length, 0);
  assert.equal(tooBig.warnings.length, 1);
  for (let index = 1; index <= 3; index++) await image(cwd, `outputs/large-${index}.png`, sized(8 * MiB));
  const total = await prepareImageReply([1, 2, 3].map(index => `![large](outputs/large-${index}.png)`).join('\n'), { cwd });
  assert.equal(total.images.length, 2);
  assert.equal(total.warnings.length, 1);
  for (let index = 1; index <= 5; index++) await image(cwd, `outputs/small-${index}.png`);
  const count = await prepareImageReply([1, 2, 3, 4, 5].map(index => `![small](outputs/small-${index}.png)`).join('\n'), { cwd });
  assert.equal(count.images.length, 4);
  assert.equal(count.warnings.length, 1);
});

test('supported image signatures determine output format instead of the filename', async t => {
  const cwd = await workspace(t);
  const formats = [['jpeg', Buffer.from('ffd8ffe00000', 'hex'), 'jpg'],
    ['gif', Buffer.from('GIF89a'), 'gif'], ['webp', Buffer.from('RIFF0000WEBP'), 'webp']];
  for (const [name, bytes] of formats) await image(cwd, `outputs/${name}.txt`, bytes);
  const plan = await prepareImageReply(formats.map(([name]) => `![${name}](outputs/${name}.txt)`).join('\n'), { cwd });
  assert.deepEqual(plan.images.map(item => item.stagedPath.split('.').at(-1)), ['jpg', 'gif', 'webp']);
});

test('send persists the unique task before one status query and never switches identity', async t => {
  const plan = await planFor(t);
  const events = [];
  const call = async args => {
    events.push(args);
    return args[1] === '+messages-send' ? ack : complete;
  };
  const result = await deliverImageReply(plan, options({ call,
    onReceipt: async value => { assert.deepEqual(value, { openTaskId: 'task-1' }); events.push('persist'); } }));
  assert.deepEqual(events, [
    ['chat', '+messages-send', '--group', 'cid-target', '--markdown', plan.markdown, '--uuid', 'unique-key', '--yes'],
    'persist', ['chat', '+messages-query-send-status', '--open-task-id', 'task-1'],
  ]);
  assert.deepEqual(result, { state: 'sent', openTaskId: 'task-1', openMessageId: 'message-1', conversationId: 'cid-target' });
  await assert.rejects(deliverImageReply(plan, options({ call })), /不能重复发送/);
  assert.equal(events.length, 3);
});

test('direct message sends use exactly the existing receiver target', async t => {
  const plan = await planFor(t);
  const calls = [];
  const result = await deliverImageReply(plan, options({ target: { receiverOpenId: 'trusted-open-id' },
    call: async args => { calls.push(args); return args[1] === '+messages-send' ? ack : complete; } }));
  assert.equal(result.state, 'sent');
  assert.deepEqual(calls[0].slice(2, 4), ['--open-dingtalk-id', 'trusted-open-id']);
  assert(!calls.flat().some(value => ['--as', '--identity', '--bot', '--group'].includes(value)));
});

test('invalid targets and caller-built plans cannot invoke transport', async t => {
  const plan = await planFor(t);
  const call = () => assert.fail('must not send');
  for (const target of [{}, { conversationId: '' }, { receiverOpenId: 7 },
    { conversationId: 'cid-target', receiverOpenId: 'person' }, { conversationId: ' leading-space' }]) {
    await assert.rejects(deliverImageReply(plan, options({ target, call })), TypeError);
  }
  await assert.rejects(deliverImageReply({ markdown: plan.markdown, images: plan.images }, options({ call })), TypeError);
});

test('missing or contradictory send receipts do not query or retry', async t => {
  for (const receipt of [{}, { result: {} }, { result: { openTaskId: 'a', data: { openTaskId: 'b' } } },
    { result: { openTaskId: 'task-1', openConversationId: 'other-chat' } },
    { success: false, result: { openTaskId: 'task-1' } }]) {
    const plan = await planFor(t);
    let calls = 0;
    const result = await deliverImageReply(plan, options({ call: async () => { calls++; return receipt; },
      onReceipt: async () => assert.fail('untrusted receipt must not be persisted as accepted') }));
    assert.equal(result.state, 'delivery_unknown');
    assert.equal(calls, 1);
  }
});

test('send errors and persistence errors stop without retrying', async t => {
  for (const persistenceFailure of [false, true]) {
    const plan = await planFor(t);
    let calls = 0;
    const result = await deliverImageReply(plan, options({ call: async () => {
      calls++;
      if (!persistenceFailure) throw new Error('private transport diagnostic');
      return ack;
    }, onReceipt: async () => { throw new Error('private storage diagnostic'); } }));
    assert.equal(result.state, 'delivery_unknown');
    assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(result), /private/);
    if (persistenceFailure) assert.equal(result.openTaskId, 'task-1');
  }
});

test('pending, missing IDs, numeric and contradictory statuses cannot claim success', async t => {
  const statuses = [
    { result: { status: 'PENDING' } },
    { result: { status: 'SUCCESS' } },
    { result: { ...complete.result, status: 1 } },
    { result: { ...complete.result, status: 1 }, status: 'SUCCESS' },
    { result: { ...complete.result, openTaskId: 'another-task' } },
    { result: { ...complete.result, openConversationId: 'another-chat' } },
    { result: { ...complete.result, sendStatus: 'PENDING' } },
    { result: { ...complete.result }, success: false },
    { result: { ...complete.result, data: { openMessageId: 'another-message' } } },
  ];
  for (const status of statuses) {
    const plan = await planFor(t);
    let calls = 0;
    const result = await deliverImageReply(plan, options({ call: async () => ++calls === 1 ? ack : status }));
    assert.equal(result.state, 'delivery_unknown');
    assert.equal(result.openTaskId, 'task-1');
    assert.equal(calls, 2);
  }
});

test('status query timeout preserves the persisted task and does not send again', async t => {
  const plan = await planFor(t);
  const events = [];
  const result = await deliverImageReply(plan, options({ call: async args => {
    events.push(args[1]);
    if (events.length === 1) return ack;
    throw new Error('private timeout');
  }, onReceipt: async value => events.push(value.openTaskId) }));
  assert.equal(result.state, 'delivery_unknown');
  assert.equal(result.openTaskId, 'task-1');
  assert.deepEqual(events, ['+messages-send', 'task-1', '+messages-query-send-status']);
});

test('an empty prepared plan needs neither transport nor a target', async () => {
  const plan = await prepareImageReply('text');
  assert.deepEqual(await deliverImageReply(plan), { state: 'not_needed' });
});
