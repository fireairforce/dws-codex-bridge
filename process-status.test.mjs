import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { join } from 'node:path';

const source = await readFile(new URL('./bridge.mjs', import.meta.url), 'utf8');
let processStatus;
try { processStatus = await import('./process-status.mjs'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

// Exercise the real command dispatch and run-lock guard with offline boundaries.
// The legacy helper is loaded directly to capture the original permission-denied bug.
const helperStart = source.indexOf('function inspectOwnProcess(') >= 0
  ? source.indexOf('function inspectOwnProcess(') : source.indexOf('function isOwnProcess(');
const helpers = source.slice(helperStart, source.indexOf('function log('));
const runStart = source.indexOf('async function run() {') + 'async function run() {'.length;
const runGuard = source.slice(runStart, source.indexOf('  let state = await load(statePath', runStart));
const dispatch = source.slice(source.indexOf("const command = process.argv[2] || 'status';"));

async function invoke(command, { psError, psOutput = '', runtime = { pid: 42, state: 'ready' } } = {}) {
  const actions = [], output = [], errors = [];
  const runPs = () => { if (psError) throw psError; return psOutput; };
  const fakeProcess = { argv: ['node', '/workspace/bridge.mjs', command], execPath: '/node', pid: 100,
    kill: (...args) => actions.push(['kill', ...args]) };
  const context = {
    entry: '/workspace/bridge.mjs', runtimePath: '/runtime.json', statePath: '/state.json', lockPath: '/run.lock',
    config: { stateDir: '/state', cwd: '/workspace' }, process: fakeProcess, join,
    console: { log: value => output.push(JSON.parse(value)), error: value => errors.push(JSON.parse(value)) },
    execFileSync: runPs,
    inspectBridgeProcess: (pid, options) => processStatus.inspectBridgeProcess(pid, { ...options, runPs }),
    requireKnownProcessStatus: value => processStatus.requireKnownProcessStatus(value),
    load: async () => runtime,
    unlink: async path => actions.push(['unlink', path]),
    open: async path => {
      actions.push(['open', path]);
      return { fd: 10, writeFile: async () => actions.push(['write']), close: async () => {} };
    },
    spawn: (...args) => {
      actions.push(['spawn', ...args]);
      return { once: (event, callback) => { if (event === 'spawn') queueMicrotask(callback); }, unref() {} };
    },
  };
  await vm.runInNewContext(`(async () => { ${helpers}\nasync function run() {${runGuard}}\n${dispatch}\n})()`, context);
  return { actions, output, errors, exitCode: fakeProcess.exitCode };
}

test('status reports an unavailable process inspection rather than claiming the host is stopped', async () => {
  const result = await invoke('status', { psError: Object.assign(new Error('denied'), { code: 'EPERM' }) });
  assert.equal(result.output[0].state, 'ready');
  assert.equal(result.output[0].running, null);
  assert.equal(result.output[0].processCheck.reason, 'inspection_denied');
  assert.match(result.output[0].processCheck.message, /无法核验/);
  assert.deepEqual(result.actions, []);
});

for (const command of ['start', 'stop', 'run']) {
  test(`${command} stops before lifecycle side effects if process inspection is denied`, async () => {
    const result = await invoke(command, { psError: Object.assign(new Error('denied'), { code: 'EPERM' }) });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.actions, []);
    assert.deepEqual(result.output, []);
    assert.match(result.errors[0].error, /无法核验/);
  });
}

test('a confirmed absent PID can be reported stopped', async () => {
  const result = await invoke('stop', { psError: Object.assign(new Error('not found'), { status: 1, stdout: '', stderr: '' }) });
  assert.deepEqual(result.output, [{ stopped: true, running: false }]);
  assert.deepEqual(result.actions, []);
});

test('invalid PIDs never invoke a process inspection', () => {
  for (const pid of [undefined, null, 0, 1, -1, NaN, '42', 2 ** 60]) {
    const inspection = processStatus.inspectBridgeProcess(pid, { entry: '/workspace/bridge.mjs',
      runPs: () => { throw new Error('must not inspect'); } });
    assert.equal(inspection.running, false);
    assert.equal(inspection.reason, 'invalid_pid');
  }
});

test('only the recorded bridge script in run mode is recognized and argv stays private', () => {
  const entry = '/workspace/bridge.mjs';
  const accepted = processStatus.inspectBridgeProcess(42, { entry, runPs: (file, args, options) => {
    assert.equal(file, '/bin/ps');
    assert.deepEqual(args, ['-p', '42', '-o', 'command=']);
    assert.equal(options.encoding, 'utf8');
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    return `node ${entry} run PRIVATE_ARGUMENT`;
  } });
  assert.equal(accepted.running, true);
  assert.doesNotMatch(JSON.stringify(accepted), /PRIVATE_ARGUMENT|node |\/workspace/);
  for (const command of ['node /other/bridge.mjs run PRIVATE_ARGUMENT', `node ${entry} check PRIVATE_ARGUMENT`]) {
    const rejected = processStatus.inspectBridgeProcess(42, { entry, runPs: () => command });
    assert.equal(rejected.running, false);
    assert.equal(rejected.reason, 'different_process');
    assert.doesNotMatch(JSON.stringify(rejected), /PRIVATE_ARGUMENT/);
  }
});

for (const [code, reason] of [
  ['EPERM', 'inspection_denied'], ['EACCES', 'inspection_denied'],
  ['ENOENT', 'inspection_unavailable'], ['EIO', 'inspection_failed'],
]) {
  test(`${code} reports unknown without exposing process diagnostics`, () => {
    const inspection = processStatus.inspectBridgeProcess(42, { entry: '/workspace/bridge.mjs', runPs: () => {
      throw Object.assign(new Error('PRIVATE_DIAGNOSTIC'), { code, stderr: 'PRIVATE_STDERR' });
    } });
    assert.equal(inspection.running, null);
    assert.equal(inspection.reason, reason);
    assert.doesNotMatch(JSON.stringify(inspection), /PRIVATE_/);
    assert.throws(() => processStatus.requireKnownProcessStatus(inspection), /无法核验/);
  });
}

test('only a clean ps exit 1 proves absence; other abnormal results remain unknown', () => {
  const entry = '/workspace/bridge.mjs';
  const absent = processStatus.inspectBridgeProcess(42, { entry, runPs: () => {
    throw Object.assign(new Error('not found'), { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  } });
  assert.equal(absent.running, false);
  assert.equal(absent.reason, 'not_found');
  for (const details of [
    { status: 1, stdout: '', stderr: 'access denied' },
    { status: 1, stdout: 'unexpected output', stderr: '' },
    { status: 1, signal: 'SIGTERM', stdout: '', stderr: '' },
    { status: 127, stdout: '', stderr: '' },
  ]) {
    const result = processStatus.inspectBridgeProcess(42, { entry, runPs: () => { throw Object.assign(new Error('failed'), details); } });
    assert.equal(result.running, null);
  }
  for (const command of ['', Buffer.alloc(0), null]) {
    assert.equal(processStatus.inspectBridgeProcess(42, { entry, runPs: () => command }).running, null);
  }
});

test('a verified running host is not duplicated and stop targets only its recorded PID', async () => {
  const psOutput = 'node /workspace/bridge.mjs run';
  const start = await invoke('start', { psOutput });
  assert.equal(start.exitCode, 1);
  assert.deepEqual(start.actions, []);
  assert.match(start.errors[0].error, /已在运行/);
  const stop = await invoke('stop', { psOutput });
  assert.deepEqual(stop.actions, [['kill', 42, 'SIGTERM']]);
});
