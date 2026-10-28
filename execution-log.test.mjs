import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod, stat, symlink, link, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionLogStore, redactLogText } from './execution-log.mjs';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-execution-log-'));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: new ExecutionLogStore({ directory, ...options }) };
}

test('task transcripts keep lifecycle, command results and confirmed model without raw protocol fields', async t => {
  const { store, directory } = await fixture(t);
  const task = await store.createTask({ title: '钉钉任务' });
  assert.equal((await store.getTask(task.id)).model, '');
  await task.record({ type: 'progress', text: '正在检查源码' });
  await task.record({ type: 'command', phase: 'started', itemId: 'command-1', command: 'node --test', cwd: '/workspace' });
  await task.record({ type: 'command', phase: 'output', itemId: 'command-1', delta: 'tests passed\n' });
  assert.equal((await store.readEvents(task.id)).some(event => event.output?.includes('tests passed')), false);
  await task.record({ type: 'command', phase: 'completed', itemId: 'command-1', status: 'completed', exitCode: 0, durationMs: 42 });
  await task.record({ type: 'tool', phase: 'completed', itemId: 'tool-1', server: 'web', tool: 'search', status: 'completed',
    arguments: { password: 'arguments-must-not-appear' }, result: 'result-must-not-appear' });
  await task.record({ type: 'fileChange', phase: 'completed', itemId: 'file-1', paths: ['src/example.js'], status: 'completed', diff: 'diff-must-not-appear' });
  await task.record({ type: 'reasoning', text: 'reasoning-must-not-appear' });
  await task.record({ type: 'rawRpc', text: 'rpc-must-not-appear' });
  await task.finish({ status: 'completed', answer: '检查完成', model: 'gpt-6.1-sol', effort: 'ultra', serviceTier: 'priority' });
  const events = await store.readEvents(task.id);
  assert.deepEqual(events.map(event => event.seq), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(events[3].command, 'node --test');
  assert.equal(events[3].output, 'tests passed\n');
  assert.equal(events[3].exitCode, 0);
  assert.equal(events.at(-1).answer, '检查完成');
  assert.deepEqual((await store.readEvents(task.id, { after: 3, limit: 1 })).map(event => event.seq), [4]);
  assert.equal((await store.getTask(task.id)).status, 'completed');
  assert.equal((await store.getTask(task.id)).model, 'gpt-6.1-sol');
  assert.equal((await store.listTasks())[0].id, task.id);
  const jsonl = await readFile(join(directory, `${task.id}.jsonl`), 'utf8');
  const transcript = await store.readText(task.id);
  for (const forbidden of ['arguments-must-not-appear', 'result-must-not-appear', 'diff-must-not-appear', 'reasoning-must-not-appear', 'rpc-must-not-appear']) {
    assert.equal(jsonl.includes(forbidden) || transcript.includes(forbidden), false);
  }
  assert.match(transcript, /tests passed/);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, `${task.id}.jsonl`))).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, `${task.id}.log`))).mode & 0o777, 0o600);
});

test('split secrets are buffered until completion and all visible text is redacted', async t => {
  const { store, directory } = await fixture(t);
  const task = await store.createTask();
  await task.record({ type: 'command', phase: 'started', itemId: 'c', command: 'TOKEN=env-secret cli --api-key flag-secret --password="quoted secret"', cwd: '/workspace' });
  for (const delta of ['Authorization: Bea', 'rer bearer-secret\n{"access_', 'token":"json-secret"}\nsk-', 'split-secret\nrefresh_token=refresh-secret\nid_token=id-secret\nhttps://user:password@example.com\n']) {
    await task.record({ type: 'command', phase: 'output', itemId: 'c', delta });
  }
  const before = await readFile(join(directory, `${task.id}.jsonl`), 'utf8');
  assert.equal(before.includes('bearer-secret'), false);
  assert.equal(before.includes('json-secret'), false);
  await task.record({ type: 'command', phase: 'completed', itemId: 'c', exitCode: 0 });
  await task.finish({ status: 'failed', error: 'password=error-secret' });
  const all = (await readFile(join(directory, `${task.id}.jsonl`), 'utf8')) + await store.readText(task.id);
  for (const forbidden of ['env-secret', 'flag-secret', 'quoted secret', 'bearer-secret', 'json-secret', 'split-secret', 'refresh-secret', 'id-secret', 'user:password', 'error-secret']) {
    assert.equal(all.includes(forbidden), false, `must redact ${forbidden}`);
  }
  assert.match(all, /\[redacted\]/);
});

test('output bound retains only the beginning and never logs later secret fragments', async t => {
  const { store } = await fixture(t, { maxTextChars: 128, maxTaskBytes: 4096 });
  const task = await store.createTask();
  await task.record({ type: 'command', phase: 'started', itemId: 'c', command: 'inspect' });
  await task.record({ type: 'command', phase: 'output', itemId: 'c', delta: `api_key=${'a'.repeat(200)}` });
  await task.record({ type: 'command', phase: 'output', itemId: 'c', delta: 'secret-tail-should-not-appear' });
  await task.record({ type: 'command', phase: 'completed', itemId: 'c', exitCode: 0 });
  await task.finish({ status: 'completed' });
  const transcript = await store.readText(task.id);
  assert.equal(transcript.includes('secret-tail-should-not-appear'), false);
  assert.equal(transcript.includes('a'.repeat(20)), false);
  assert.match(transcript, /output truncated/);
});

test('size cap preserves terminal state and rejects writes after finish', async t => {
  const { store, directory } = await fixture(t, { maxTaskBytes: 4096 });
  const task = await store.createTask();
  await task.record({ type: 'progress', text: 'x'.repeat(10000) });
  await task.record({ type: 'progress', text: 'must not be recorded after cap' });
  await task.finish({ status: 'delivery_unknown', error: 'x'.repeat(10000), model: 'confirmed-model' });
  await task.record({ type: 'progress', text: 'must not be recorded after finish' });
  assert.ok((await stat(join(directory, `${task.id}.jsonl`))).size <= 4096);
  assert.equal((await store.getTask(task.id)).status, 'delivery_unknown');
  assert.equal((await store.getTask(task.id)).model, 'confirmed-model');
  const transcript = await store.readText(task.id);
  assert.equal(transcript.includes('must not be recorded'), false);
  assert.match(transcript, /日志已达到大小上限/);
});

test('IDs, symlinks and hardlinks cannot redirect reads to other files', async t => {
  const { store, directory } = await fixture(t);
  for (const id of ['../config', '/etc/passwd', 'not-a-uuid', '00000000-0000-0000-0000-000000000000']) {
    await assert.rejects(store.readEvents(id), /Invalid execution log ID/);
    await assert.rejects(store.readText(id), /Invalid execution log ID/);
  }
  const task = await store.createTask();
  await task.finish({ status: 'completed' });
  const target = join(directory, 'unrelated-file');
  await writeFile(target, 'do not expose', { mode: 0o600 });
  const fakeId = '00000000-0000-4000-8000-000000000001';
  await symlink(target, join(directory, `${fakeId}.jsonl`));
  await assert.rejects(store.readEvents(fakeId), /could not be read safely/);
  const hardId = '00000000-0000-4000-8000-000000000002';
  await link(target, join(directory, `${hardId}.jsonl`));
  await assert.rejects(store.readEvents(hardId), /could not be read safely/);
  assert.deepEqual((await store.listTasks()).map(value => value.id), [task.id]);
  assert.equal(await store.getTask('00000000-0000-4000-8000-000000000003'), null);
});

test('unsafe directories are rejected, without changing their permissions', async t => {
  const { directory } = await fixture(t);
  const alias = `${directory}-alias`;
  await symlink(directory, alias);
  t.after(() => rm(alias, { force: true }));
  await assert.rejects(new ExecutionLogStore({ directory: alias }).createTask(), /private.*symlink/);
  await chmod(directory, 0o755);
  await assert.rejects(new ExecutionLogStore({ directory }).createTask(), /private.*symlink/);
  assert.equal((await stat(directory)).mode & 0o777, 0o755);
});

test('terminal escape and credential forms are stripped from displayed text', () => {
  const safe = redactLogText('\x1b[31merror\x1b[0m\x1b]52;c;clipboard-secret\x07\nclient_secret=client-secret\n--access-token access-secret\ngithub_pat_github-secret\neyJheader.payload.signature\nAuthorization: Basic basic-secret\nCookie: first=cookie-first; second=cookie-second\nSet-Cookie: session=cookie-session; Secure\nsession_token=session-secret\nAWS_SECRET_ACCESS_KEY=aws-secret\n-----BEGIN RSA PRIVATE KEY-----\nprivate-body\n-----END RSA PRIVATE KEY-----\n{"password":"escaped\\\"secret"}');
  assert.equal(safe.includes('\x1b'), false);
  for (const value of ['clipboard-secret', 'client-secret', 'access-secret', 'github-secret', 'eyJheader', 'basic-secret', 'cookie-first', 'cookie-second', 'cookie-session', 'session-secret', 'aws-secret', 'private-body', 'escaped']) assert.equal(safe.includes(value), false, `must redact ${value}`);
  assert.match(safe, /error/);
});

test('commands referencing authentication files hide the entire command and output', async t => {
  const { store, directory } = await fixture(t);
  const task = await store.createTask();
  const commands = ['cat /home/user/.codex/auth.json', 'sed -n 1p /home/user/.aws/credentials', 'cat .npmrc', 'cat .env.local', 'cat /home/user/.dws-example-auth/keychain', 'cat /home/user/.dws-auth/session', 'security find-generic-password -w'];
  for (const [index, command] of commands.entries()) {
    await task.record({ type: 'command', phase: 'started', itemId: `secret-${index}`, command, cwd: '/secret-directory' });
    await task.record({ type: 'command', phase: 'output', itemId: `secret-${index}`, delta: 'unrecognizable-credential-material' });
    await task.record({ type: 'command', phase: 'completed', itemId: `secret-${index}`, aggregatedOutput: 'different-unrecognizable-credential-material', exitCode: 0 });
  }
  await task.finish({ status: 'completed' });
  const jsonl = await readFile(join(directory, `${task.id}.jsonl`), 'utf8');
  const transcript = await store.readText(task.id);
  assert.equal(jsonl.includes('unrecognizable-credential-material') || transcript.includes('unrecognizable-credential-material'), false);
  assert.equal(jsonl.includes('/secret-directory') || transcript.includes('/secret-directory'), false);
  for (const command of commands) assert.equal(transcript.includes(command), false);
  assert.match(transcript, /认证相关输出已隐藏/);
});

test('confirmed default service tier stays null and is not replaced by an earlier tier', async t => {
  const { store } = await fixture(t);
  const task = await store.createTask({ serviceTier: 'priority' });
  await task.finish({ status: 'completed', serviceTier: null, model: 'confirmed-model' });
  assert.equal((await store.getTask(task.id)).serviceTier, null);
  assert.equal((await store.readEvents(task.id)).at(-1).serviceTier, null);
});

test('task listing reads only the newest 200 safe candidates and caches unchanged metadata', async t => {
  const { directory } = await fixture(t);
  const reads = [];
  class CountingStore extends ExecutionLogStore {
    async _read(id, extension) { reads.push(id); return super._read(id, extension); }
  }
  const store = new CountingStore({ directory });
  const ids = Array.from({ length: 202 }, (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`);
  await Promise.all(ids.map(async (id, i) => {
    const time = new Date(1700000000000 + i * 1000);
    const path = join(directory, `${id}.jsonl`);
    await writeFile(path, JSON.stringify({ seq: 1, time: time.toISOString(), type: 'task_started', title: `task ${i}` }) + '\n', { mode: 0o600 });
    await utimes(path, time, time);
  }));
  const tasks = await store.listTasks();
  assert.equal(tasks.length, 200);
  assert.equal(reads.length, 200);
  assert.equal(reads.includes(ids[0]), false);
  assert.equal(reads.includes(ids[1]), false);
  assert.equal(tasks[0].id, ids.at(-1));
  await store.listTasks();
  assert.equal(reads.length, 200, 'unchanged tasks must not reread their transcripts each poll');
});

test('large task metadata uses one bounded read and refreshes after an external write', async t => {
  const { directory } = await fixture(t);
  let reads = 0;
  class CountingStore extends ExecutionLogStore {
    async _read(id, extension) { reads += 1; return super._read(id, extension); }
  }
  const store = new CountingStore({ directory });
  const id = '00000000-0000-4000-8000-000000000001';
  const path = join(directory, `${id}.jsonl`);
  const time = '2026-10-28T00:00:00.000Z';
  const events = [
    { seq: 1, time, type: 'task_started', title: 'many events' },
    ...Array.from({ length: 4000 }, (_, i) => ({ seq: i + 2, time, type: 'progress', text: 'progress' })),
    { seq: 4002, time, type: 'task_finished', status: 'completed' },
  ];
  await writeFile(path, events.map(event => JSON.stringify(event)).join('\n') + '\n', { mode: 0o600 });
  assert.equal((await store.getTask(id)).eventCount, 4002);
  assert.equal(reads, 1);
  assert.equal((await store.getTask(id)).status, 'completed');
  assert.equal(reads, 1);
  events.at(-1).status = 'failed';
  await writeFile(path, events.map(event => JSON.stringify(event)).join('\n') + '\n', { mode: 0o600 });
  assert.equal((await store.getTask(id)).status, 'failed');
  assert.equal(reads, 2);
});
