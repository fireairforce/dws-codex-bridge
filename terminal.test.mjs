import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTerminalArgs, tmuxPlan, startTmuxViewer, terminalText, formatEvent, followTerminal, TMUX_SOCKET } from './terminal.mjs';

const ID = '44b6e962-2bdd-4d22-9e4b-7df2f8f54ed4';

test('terminal arguments accept only task UUIDs and read-only viewer options', () => {
  assert.deepEqual(parseTerminalArgs(['--tmux', '--task', ID]), { tmux: true, once: false, help: false, taskId: ID });
  for (const args of [['--task'], ['--task', '../secret'], ['--task', 'x;touch /tmp/file'],
    ['--task', ID, '--task', ID], ['--directory', '/private'], ['--tmux', '--once'], ['--writable']]) {
    assert.throws(() => parseTerminalArgs(args));
  }
});

test('tmux starts a dedicated viewer using argv without a shell or bridge command', () => {
  const calls = [];
  const attach = startTmuxViewer({ taskId: ID }, { run: (file, args, options) => {
    calls.push({ file, args, options });
    return { status: calls.length === 1 ? 1 : 0 };
  } });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.file === 'tmux' && call.options.shell === false));
  assert.ok(calls.every(call => call.args[0] === '-L' && call.args[1] === TMUX_SOCKET));
  const start = calls[1].args;
  assert.equal(start[start.indexOf('--') + 1], process.execPath);
  assert.ok(start[start.indexOf('--') + 2].endsWith('/terminal.mjs'));
  assert.deepEqual(start.slice(-2), ['--task', ID]);
  assert.ok(!JSON.stringify(calls).includes('bridge.mjs'));
  assert.match(attach, /attach-session -r/);
  assert.match(attach, new RegExp(ID));
});

test('existing tmux views are reused and unavailable tmux never launches another command', () => {
  let calls = 0;
  assert.match(startTmuxViewer({}, { run: () => { calls += 1; return { status: 0 }; } }), /bridge-logs-latest$/);
  assert.equal(calls, 1);
  assert.throws(() => startTmuxViewer({}, { run: () => ({ error: { code: 'ENOENT' } }) }), { code: 'TMUX_NOT_INSTALLED' });
  assert.throws(() => startTmuxViewer({}, { run: () => ({ status: 2, stderr: 'private data' }) }), error => {
    assert.equal(error.code, 'TMUX_UNAVAILABLE');
    assert.ok(!error.message.includes('private data'));
    return true;
  });
  assert.throws(() => tmuxPlan({ taskId: ID + ';touch /tmp/file' }), { code: 'INVALID_TASK_ID' });
});

test('terminal display strips ANSI, OSC, controls, and directional overrides', () => {
  assert.equal(terminalText('hello\x1b]52;c;clipboard\x07\x1b[31m red\x1b[0m\r\u202e\x00\nnext\tline'), 'hello red\nnext\tline');
  assert.equal(formatEvent({ time: 'now', type: 'command.completed', text: 'done\x1b[2J' }), '[now] command.completed\ndone\n');
  assert.ok(!formatEvent({ time: 'now', type: 'tool', arguments: { password: 'never-render-this' } }).includes('never-render-this'));
});

test('one-shot terminal reads retained events without printing unknown object fields', async () => {
  const chunks = [];
  const seen = [];
  const task = { id: ID, createdAt: '2026-10-28', status: 'completed', title: 'test', model: 'model', serviceTier: 'priority', password: 'hidden' };
  await followTerminal({ once: true, taskId: ID }, { store: {
    async getTask(id) { assert.equal(id, ID); return task; },
    async readEvents(id, options) {
      seen.push(options.after);
      return [{ seq: 1, time: 'now', type: 'command.completed', text: 'output', raw: 'hidden' }];
    },
  }, write: chunk => chunks.push(chunk) });
  assert.deepEqual(seen, [0]);
  assert.match(chunks.join(''), /Fast/);
  assert.match(chunks.join(''), /output/);
  assert.ok(!chunks.join('').includes('hidden'));
});

test('following latest switches by creation time and never repeats the same event', async () => {
  const nextId = '44b6e962-2bdd-4d22-9e4b-7df2f8f54ed5';
  const abort = new AbortController();
  const chunks = [];
  let round = 0;
  const first = { id: ID, createdAt: '2026-10-28T00:00:00Z', status: 'running' };
  const second = { id: nextId, createdAt: '2026-10-28T00:01:00Z', status: 'running' };
  await followTerminal({}, { store: {
    async listTasks() { return round < 2 ? [first] : [first, second]; },
    async readEvents(id, { after }) { return after ? [] : [{ seq: 1, time: 'now', type: 'progress', text: id === ID ? 'first-output' : 'next-output' }]; },
  }, write: chunk => chunks.push(chunk), signal: abort.signal, wait: async () => {
    round += 1;
    if (round === 3) abort.abort();
  } });
  assert.equal(chunks.join('').split('first-output').length - 1, 1);
  assert.equal(chunks.join('').split('next-output').length - 1, 1);
});
