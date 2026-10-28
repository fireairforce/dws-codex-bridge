import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateConfig, loadConfig, dwsEnvironment, backgroundEnvironment } from './config.mjs';

const configured = {
  dws: '/offline/dws', codex: '/offline/codex', cwd: '/offline/project',
  profile: 'employee', employeeUserId: 'employee-id', employeeName: '助手',
  supervisorOpenId: 'owner-open-id', groupConversationId: 'allowed-group',
  model: 'available-model', effort: 'high',
};

test('missing identity or group settings cannot enable a listener', () => {
  for (const field of ['employeeUserId', 'employeeName', 'supervisorOpenId', 'groupConversationId', 'profile']) {
    for (const value of [undefined, '', ' ', '<replace-me>', 'YOUR_ID']) {
      assert.throws(() => validateConfig({ ...configured, [field]: value }, '/config/config.json'), new RegExp(field));
    }
  }
});

test('configuration normalizes state location and ignores attempts to change execution policy', () => {
  const result = validateConfig({ ...configured, sandbox: 'danger-full-access', approvalPolicy: 'on-request' }, '/config/config.json');
  assert.equal(result.stateDir, '/config/.state');
  assert.equal(result.serviceTier, null);
  assert.equal(result.model, 'available-model');
  assert.equal(result.effort, 'high');
  assert.equal(Object.hasOwn(result, 'sandbox'), false);
  assert.equal(Object.hasOwn(result, 'approvalPolicy'), false);
  for (const field of ['dws', 'codex', 'cwd', 'stateDir', 'dwsConfigDir', 'dwsKeychainDir']) {
    assert.throws(() => validateConfig({ ...configured, [field]: './relative' }, '/config/config.json'), new RegExp(field));
  }
  assert.throws(() => validateConfig({ ...configured, serviceTier: 'unknown' }, '/config/config.json'), /serviceTier/);
  assert.throws(() => validateConfig({ ...configured, turnTimeoutMs: 0 }, '/config/config.json'), /turnTimeoutMs/);
});

test('external configuration wins over default and background startup preserves that exact file', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dws-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'custom.json');
  await writeFile(path, JSON.stringify(configured));
  const loaded = await loadConfig({ defaultPath: join(root, 'not-used.json'), env: { DWS_CODEX_CONFIG: path } });
  assert.equal(loaded.configPath, path);
  assert.equal(loaded.config.stateDir, join(root, '.state'));
  const childEnv = backgroundEnvironment(loaded.configPath, { PATH: '/offline/bin', DWS_CODEX_CONFIG: 'old.json' });
  assert.deepEqual(childEnv, { PATH: '/offline/bin', DWS_CODEX_CONFIG: path });
  const childLoaded = await loadConfig({ defaultPath: join(root, 'also-not-used.json'), env: childEnv });
  assert.deepEqual(childLoaded, loaded);
});

test('both DWS environment directories are explicit and existing environment is preserved', () => {
  assert.deepEqual(dwsEnvironment({ dwsConfigDir: '/profile/config', dwsKeychainDir: '/profile/keychain' },
    { PATH: '/offline/bin', DWS_CONFIG_DIR: '/old', KEEP: 'yes' }), {
    PATH: '/offline/bin', KEEP: 'yes', DWS_CONFIG_DIR: '/profile/config', DWS_KEYCHAIN_DIR: '/profile/keychain',
  });
});

test('missing or malformed config fails before any executable or state directory is touched', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dws-missing-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const missing = join(root, 'missing.json');
  await assert.rejects(loadConfig({ env: { DWS_CODEX_CONFIG: missing } }), /config.example.json/);
  const bridge = fileURLToPath(new URL('./bridge.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [bridge, 'start'], {
    encoding: 'utf8', env: { ...process.env, DWS_CODEX_CONFIG: missing },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(JSON.parse(result.stderr).error, /config.example.json/);
  const malformed = join(root, 'malformed.json');
  await writeFile(malformed, '{not json');
  await assert.rejects(loadConfig({ env: { DWS_CODEX_CONFIG: malformed } }), /有效的 JSON/);
});

test('check and run reject unavailable account, model, effort or tier before subscribing to IM', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dws-readiness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dws = join(root, 'fake-dws');
  const codex = join(root, 'fake-codex');
  const calls = join(root, 'calls.jsonl');
  await writeFile(dws, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FAKE_CALLS, JSON.stringify({ source: 'dws', method: process.argv[2] }) + '\\n');
if (process.argv[2] === 'contact') console.log(JSON.stringify({ ok: true, data: { userId: 'employee-id', name: '助手' } }));
else process.exitCode = 41;
`, { mode: 0o700 });
  await writeFile(codex, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const mode = process.env.FAKE_UNAVAILABLE;
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  appendFileSync(process.env.FAKE_CALLS, JSON.stringify({ source: 'codex', method: message.method }) + '\\n');
  if (!Object.hasOwn(message, 'id')) return;
  let result;
  if (message.method === 'initialize') result = {};
  else if (message.method === 'account/read') result = { account: mode === 'account' ? null : { type: 'chatgpt' } };
  else if (message.method === 'model/list') result = { data: mode === 'model' ? [] : [{
    model: 'available-model', supportedReasoningEfforts: [{ reasoningEffort: mode === 'effort' ? 'low' : 'high' }],
    serviceTiers: mode === 'tier' ? [] : [{ id: 'priority', name: 'Fast' }],
  }], nextCursor: null };
  else result = {};
  console.log(JSON.stringify({ id: message.id, result }));
});
`, { mode: 0o700 });
  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({ ...configured, dws, codex, cwd: root, serviceTier: 'priority' }));
  const bridge = fileURLToPath(new URL('./bridge.mjs', import.meta.url));
  for (const command of ['check', 'run']) {
    for (const unavailable of ['account', 'model', 'effort', 'tier']) {
      await writeFile(calls, '');
      const result = spawnSync(process.execPath, [bridge, command], {
        encoding: 'utf8', timeout: 5000,
        env: { ...process.env, DWS_CODEX_CONFIG: configPath, FAKE_CALLS: calls, FAKE_UNAVAILABLE: unavailable },
      });
      assert.equal(result.status, 1, `${command}/${unavailable}: ${result.stderr}`);
      const error = JSON.parse(result.stderr).error;
      assert.match(error, unavailable === 'account' ? /account is not available/ : unavailable === 'tier' ? /Fast tier/ : /not advertised/);
      const observed = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.equal(observed.some(call => call.source === 'dws' && call.method === 'event'), false, `${command}/${unavailable} subscribed to IM`);
      assert.equal(observed.some(call => call.source === 'codex' && /^(thread|turn)\//.test(call.method)), false);
    }
  }
});
