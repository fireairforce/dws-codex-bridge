import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexClient } from './codex-client.mjs';

// Replace only the RPC boundary: these tests cannot launch Codex or use a network.
class OfflineCodex extends CodexClient {
  constructor({ advertisedTiers = ['priority'], appliedTier = 'priority', cwd = '/offline/codex-test',
    model = 'gpt-6.1-sol', effort = 'ultra', advertisedModel = model, advertisedEffort = effort } = {}) {
    super({ cwd, codex: '/offline/codex', model, effort, serviceTier: 'priority' });
    this.calls = [];
    this.advertisedTiers = advertisedTiers;
    this.appliedTier = appliedTier;
    this.advertisedModel = advertisedModel;
    this.advertisedEffort = advertisedEffort;
  }

  async _ensureInitialized() { this._assertOpen(); }

  async _request(method, params) {
    this.calls.push({ method, params: structuredClone(params) });
    switch (method) {
      case 'account/read':
        return { account: { type: 'chatgpt', planType: 'pro' }, requiresOpenaiAuth: true };
      case 'model/list':
        return { data: [{ id: this.advertisedModel, model: this.advertisedModel,
          supportedReasoningEfforts: [{ reasoningEffort: this.advertisedEffort }],
          serviceTiers: this.advertisedTiers.map(id => ({ id, name: 'Fast' })),
        }], nextCursor: null };
      case 'thread/start':
      case 'thread/resume':
        return { thread: { id: params.threadId || 'new-thread', status: { type: 'idle' } },
          model: this.model, serviceTier: this.appliedTier, cwd: this.cwd,
          approvalPolicy: 'never', sandbox: { type: 'workspaceWrite' } };
      case 'turn/start':
        return { turn: { id: `turn-${this.calls.length}`, status: 'completed', items: [
          { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'done' },
        ] } };
      default:
        throw new Error(`Unexpected RPC: ${method}`);
    }
  }
}

test('a configured model and effort from the account catalog reach the turn without changing sandbox policy', async (t) => {
  const client = new OfflineCodex({ model: 'another-supported-model', effort: 'high' });
  t.after(() => client.close());
  const result = await client.run({ text: 'analyze the code' });
  assert.equal(result.model, 'another-supported-model');
  assert.equal(result.effort, 'high');
  const thread = client.calls.find(call => call.method === 'thread/start').params;
  const turn = client.calls.find(call => call.method === 'turn/start').params;
  assert.equal(thread.model, 'another-supported-model');
  assert.equal(thread.sandbox, 'workspace-write');
  assert.equal(thread.approvalPolicy, 'never');
  assert.equal(turn.effort, 'high');
  assert.deepEqual(turn.sandboxPolicy, { type: 'workspaceWrite', writableRoots: [client.cwd], networkAccess: false });
});

test('a model or reasoning effort absent from the catalog cannot start a thread', async (t) => {
  for (const mismatch of [{ advertisedModel: 'different-model' }, { advertisedEffort: 'low' }]) {
    const client = new OfflineCodex({ model: 'configured-model', effort: 'high', ...mismatch });
    t.after(() => client.close());
    await assert.rejects(client.run({ text: 'analyze' }), { code: 'CODEX_MODEL_UNAVAILABLE' });
    assert.equal(client.calls.some(call => call.method === 'thread/start' || call.method === 'turn/start'), false);
  }
});

for (const threadId of [undefined, 'saved-thread']) {
  test(`images reach the ${threadId ? 'resumed' : 'new'} turn with text and the existing execution policy`, async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), 'dws-codex-image-'));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const root = join(cwd, 'downloads', 'dingtalk-images');
    await mkdir(root, { recursive: true });
    const path = join(root, 'screenshot.png');
    await writeFile(path, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII=', 'base64'));
    const client = new OfflineCodex({ cwd });
    t.after(() => client.close());
    await client.run({ threadId, text: '描述截图', imagePaths: [path] });
    const turn = client.calls.find(call => call.method === 'turn/start').params;
    assert.equal(turn.input[0].text, '描述截图');
    assert.equal(turn.input[1].type, 'localImage');
    assert.ok(turn.input[1].path.endsWith('/downloads/dingtalk-images/screenshot.png'));
    assert.equal(turn.model, 'gpt-6.1-sol');
    assert.equal(turn.effort, 'ultra');
    assert.equal(turn.serviceTier, 'priority');
    assert.equal(turn.approvalPolicy, 'never');
    assert.equal(turn.sandboxPolicy.type, 'workspaceWrite');
    assert.equal(turn.sandboxPolicy.networkAccess, false);
    await client.run({ threadId: threadId || 'new-thread', text: '继续' });
    assert.deepEqual(client.calls.filter(call => call.method === 'turn/start')[1].params.input,
      [{ type: 'text', text: '继续' }]);
  });
}

test('invalid image input is rejected before opening a thread or starting a model turn', async (t) => {
  const client = new OfflineCodex();
  t.after(() => client.close());
  await assert.rejects(client.run({ text: '描述截图', imagePaths: 'not-an-array' }));
  assert.equal(client.calls.length, 0);
});

for (const existingThread of [undefined, 'saved-thread']) {
  test(`${existingThread ? 'resumed' : 'new'} thread and later turns keep ultra + Fast`, async (t) => {
    const client = new OfflineCodex();
    t.after(() => client.close());

    const checked = await client.check();
    assert.equal(checked.effortSupported, true);
    assert.equal(checked.serviceTierSupported, true);

    const first = await client.run({ threadId: existingThread, text: 'first task' });
    const second = await client.run({ threadId: first.threadId, text: 'follow-up' });
    assert.equal(first.threadId, existingThread || 'new-thread');
    for (const result of [first, second]) {
      assert.equal(result.text, 'done');
      assert.equal(result.model, 'gpt-6.1-sol');
      assert.equal(result.effort, 'ultra');
      assert.equal(result.serviceTier, 'priority');
    }

    const threadCalls = client.calls.filter(({ method }) => method.startsWith('thread/'));
    assert.equal(threadCalls.length, 1, 'later turns reuse the loaded thread');
    assert.equal(threadCalls[0].method, existingThread ? 'thread/resume' : 'thread/start');
    assert.equal(threadCalls[0].params.serviceTier, 'priority');
    assert.equal(threadCalls[0].params.model, 'gpt-6.1-sol');
    if (existingThread) assert.equal(threadCalls[0].params.threadId, existingThread);

    const turns = client.calls.filter(({ method }) => method === 'turn/start');
    assert.equal(turns.length, 2);
    for (const { params } of turns) {
      assert.equal(params.threadId, first.threadId);
      assert.equal(params.model, 'gpt-6.1-sol');
      assert.equal(params.effort, 'ultra');
      assert.equal(params.serviceTier, 'priority');
    }
  });
}

test('an account without Fast cannot start or resume a thread', async (t) => {
  for (const threadId of [undefined, 'saved-thread']) {
    const client = new OfflineCodex({ advertisedTiers: [] });
    t.after(() => client.close());
    await assert.rejects(client.run({ threadId, text: 'task' }), { code: 'CODEX_TIER_UNAVAILABLE' });
    assert.ok(client.calls.every(({ method }) => !method.startsWith('thread/') && method !== 'turn/start'));
  }
});

test('a mismatched applied tier prevents a model turn for new and saved threads', async (t) => {
  for (const threadId of [undefined, 'saved-thread']) {
    const client = new OfflineCodex({ appliedTier: 'default' });
    t.after(() => client.close());
    await assert.rejects(client.run({ threadId, text: 'task' }), { code: 'CODEX_TIER_MISMATCH' });
    assert.equal(client.calls.filter(({ method }) => method.startsWith('thread/')).length, 1);
    assert.ok(client.calls.every(({ method }) => method !== 'turn/start'));
  }
});

test('resumed history and early live notifications are correlated to the confirmed new turn', async (t) => {
  class EarlyNotificationCodex extends OfflineCodex {
    async _request(method, params) {
      if (method !== 'turn/start') return super._request(method, params);
      this.calls.push({ method, params: structuredClone(params) });
      const notify = (method, body) => this._handleLine(JSON.stringify({ method,
        params: { threadId: params.threadId, ...body } }));
      notify('turn/started', { turn: { id: 'previous-turn', status: 'completed' } });
      notify('item/completed', { turnId: 'previous-turn', item: {
        id: 'old-answer', type: 'agentMessage', phase: 'final_answer', text: 'old answer',
      } });
      notify('turn/completed', { turn: { id: 'previous-turn', status: 'completed' } });
      notify('item/completed', { turnId: 'current-turn', item: {
        id: 'new-answer', type: 'agentMessage', phase: 'final_answer', text: 'new answer',
      } });
      notify('turn/completed', { turn: { id: 'current-turn', status: 'completed' } });
      return { turn: { id: 'current-turn', status: 'inProgress' } };
    }
  }
  const client = new EarlyNotificationCodex();
  t.after(() => client.close());
  const result = await client.run({ threadId: 'saved-thread', text: 'task' });
  assert.equal(result.text, 'new answer');
  assert.equal(result.serviceTier, 'priority');
});

test('execution monitoring observes the confirmed live turn without reasoning or raw tool data', async (t) => {
  class ObservedCodex extends OfflineCodex {
    async _request(method, params) {
      if (method !== 'turn/start') return super._request(method, params);
      const notify = (method, body) => this._handleNotification({ method, params: {
        threadId: params.threadId, ...body,
      } });
      notify('item/started', { turnId: 'old', item: { id: 'stale', type: 'commandExecution', command: 'stale command' } });
      notify('item/started', { item: { id: 'unscoped', type: 'commandExecution', command: 'unscoped command' } });
      notify('item/completed', { turnId: 'live', item: { id: 'reason', type: 'reasoning', content: ['PRIVATE_REASONING'] } });
      notify('item/started', { turnId: 'live', item: { id: 'cmd', type: 'commandExecution', command: 'node --version', cwd: this.cwd } });
      notify('item/commandExecution/outputDelta', { turnId: 'live', itemId: 'cmd', delta: 'v22\n' });
      const command = { id: 'cmd', type: 'commandExecution', command: 'node --version', cwd: this.cwd,
        status: 'completed', aggregatedOutput: 'v22\n', exitCode: 0, durationMs: 20 };
      notify('item/completed', { turnId: 'live', item: command });
      notify('item/completed', { turnId: 'live', item: { id: 'tool', type: 'mcpToolCall', tool: 'public_lookup', server: 'docs',
        status: 'completed', arguments: { secret: 'PRIVATE_ARGUMENT' }, result: { secret: 'PRIVATE_RESULT' } } });
      notify('item/completed', { turnId: 'live', item: { id: 'files', type: 'fileChange', status: 'completed',
        changes: [{ path: 'app.mjs', kind: 'update', diff: 'PRIVATE_DIFF' }] } });
      notify('item/completed', { turnId: 'live', item: { id: 'progress', type: 'agentMessage', phase: 'commentary', text: 'Checking command output.' } });
      return { turn: { id: 'live', status: 'completed', items: [command,
        { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'done' }] } };
    }
  }
  const events = [];
  const client = new ObservedCodex();
  t.after(() => client.close());
  const answer = await client.run({ text: 'task', onExecutionEvent: event => events.push(event) });
  assert.equal(answer.text, 'done');
  assert.deepEqual(events.filter(event => event.type === 'command').map(event => event.phase), ['started', 'output', 'completed']);
  assert.equal(events.find(event => event.phase === 'completed' && event.type === 'command').exitCode, 0);
  assert.deepEqual(events.find(event => event.type === 'fileChange').paths, ['app.mjs']);
  assert.ok(events.some(event => event.type === 'progress' && event.text === 'Checking command output.'));
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_|stale command|unscoped command/);
});

test('a failed optional log observer cannot interrupt or repeat a Codex turn', async (t) => {
  class LoggedCodex extends OfflineCodex {
    async _request(method, params) {
      const result = await super._request(method, params);
      if (method === 'turn/start') result.turn.items.unshift({ id: 'cmd', type: 'commandExecution',
        command: 'node --version', status: 'completed', exitCode: 0 });
      return result;
    }
  }
  const client = new LoggedCodex();
  t.after(() => client.close());
  let observations = 0;
  const answer = await client.run({ text: 'task', onExecutionEvent() { observations += 1; throw new Error('disk unavailable'); } });
  assert.equal(answer.text, 'done');
  assert.equal(observations, 1);
  assert.equal(client.calls.filter(call => call.method === 'turn/start').length, 1);
});

test('a stalled optional log observer has a bounded drain after model completion', { timeout: 2000 }, async (t) => {
  class StalledLogCodex extends OfflineCodex {
    async _request(method, params) {
      const result = await super._request(method, params);
      if (method === 'turn/start') result.turn.items.unshift({ id: 'cmd', type: 'commandExecution',
        command: 'node --version', status: 'completed', exitCode: 0 });
      return result;
    }
  }
  const client = new StalledLogCodex();
  t.after(() => client.close());
  const answer = await client.run({ text: 'task', onExecutionEvent: () => new Promise(() => {}) });
  assert.equal(answer.text, 'done');
  assert.equal(client.calls.filter(call => call.method === 'turn/start').length, 1);
});
