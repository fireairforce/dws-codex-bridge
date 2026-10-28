import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createMonitorHandler, parseMonitorArgs, startMonitor } from './monitor.mjs';

const id = '9a57be52-8f0b-4a3d-b254-e8f8c98dd422';
const task = { id, status: 'running', createdAt: '2026-10-28T07:00:00.000Z', model: 'example' };
function fakeStore() {
  return {
    calls: [],
    async listTasks() { this.calls.push(['list']); return [task]; },
    async getTask(value) { this.calls.push(['get', value]); return value === id ? task : null; },
    async readEvents(value, options) { this.calls.push(['events', value, options]); return [{ seq: 2, type: 'progress', text: '<script>inert</script>' }]; },
  };
}
async function request(handler, url, options = {}) {
  const result = { status: null, headers: null, body: '' };
  await handler({ url, method: options.method || 'GET', headers: { host: '127.0.0.1:8777', ...options.headers } }, {
    writeHead(status, headers) { result.status = status; result.headers = headers; },
    end(body) { result.body = body || ''; },
  });
  return result;
}

test('monitor serves only a fixed page and bounded cursor-based log reads', async () => {
  const store = fakeStore(); const handler = createMonitorHandler({ store });
  const page = await request(handler, '/');
  assert.equal(page.status, 200); assert.match(page.body, /Bridge/);
  assert.equal(page.headers['Cache-Control'], 'no-store');
  assert.equal(page.headers['X-Frame-Options'], 'DENY');
  assert.equal(page.headers['Access-Control-Allow-Origin'], undefined);
  assert.equal((await request(handler, '/', { method: 'HEAD' })).body, '');
  const list = await request(handler, '/api/tasks');
  assert.deepEqual(JSON.parse(list.body), { tasks: [task] });
  const detail = await request(handler, `/api/tasks/${id}?after=1&limit=50`);
  assert.equal(detail.status, 200); assert.equal(JSON.parse(detail.body).events[0].text, '<script>inert</script>');
  assert.deepEqual(store.calls.at(-1), ['events', id, { after: 1, limit: 50 }]);
});

test('monitor rejects cross-origin, rebinding hosts, writes, arbitrary paths, and invalid cursors before reading logs', async () => {
  const store = fakeStore(); const handler = createMonitorHandler({ store });
  const rejected = [
    ['/', { headers: { host: 'attacker.example:8777' } }, 403],
    ['/', { headers: { host: '127.0.0.1.evil:8777' } }, 403],
    ['/', { headers: { host: '127.0.0.1:8888' } }, 403],
    ['/', { headers: { origin: 'http://evil.example' } }, 403],
    ['/', { headers: { origin: 'null' } }, 403],
    ['/', { headers: { 'sec-fetch-site': 'cross-site' } }, 403],
    ['/', { method: 'POST' }, 405],
    ['/api/tasks', { method: 'DELETE' }, 405],
    ['/api/tasks/../../config.json', {}, 404],
    ['/api/tasks/%2e%2e%2fconfig.json', {}, 400],
    ['//evil.example/', {}, 400],
    ['https://evil.example/', {}, 400],
    ['/config.json', {}, 404],
    [`/api/tasks/${id}?after=-1`, {}, 400],
    [`/api/tasks/${id}?after=1&after=2`, {}, 400],
    [`/api/tasks/${id}?limit=501`, {}, 400],
    [`/api/tasks/${id}?file=auth.json`, {}, 400],
  ];
  for (const [url, options, status] of rejected) assert.equal((await request(handler, url, options)).status, status, url);
  assert.equal(store.calls.length, 0);
  assert.equal((await request(handler, '/', { headers: { host: 'localhost:8777', origin: 'http://localhost:8777', 'sec-fetch-site': 'same-origin' } })).status, 200);
});

test('missing tasks are 404 and read failures never expose raw diagnostics', async () => {
  const store = fakeStore(); const handler = createMonitorHandler({ store });
  assert.equal((await request(handler, '/api/tasks/00000000-0000-4000-8000-000000000000')).status, 404);
  store.listTasks = async () => { throw new Error('secret-token private-path'); };
  const failure = await request(handler, '/api/tasks');
  assert.equal(failure.status, 503); assert.doesNotMatch(failure.body, /secret-token|private-path/);
});

test('static UI inserts all task data as text and CSP permits only the exact bundled script', async () => {
  const html = await readFile(new URL('./monitor.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /innerHTML|outerHTML|insertAdjacentHTML|eval\(|document\.write/);
  assert.match(html, /node\.textContent = text/);
  assert.doesNotMatch(html, /https?:\/\//);
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const hash = createHash('sha256').update(script).digest('base64');
  const result = await request(createMonitorHandler({ store: fakeStore() }), '/');
  assert.match(result.headers['Content-Security-Policy'], new RegExp(hash.replace(/[+\/]/g, '\\$&')));
  assert.doesNotMatch(result.headers['Content-Security-Policy'], /script-src[^;]*unsafe-inline/);
});

test('CLI accepts only a local port and cannot select arbitrary log directories or listeners', () => {
  assert.deepEqual(parseMonitorArgs([]), { port: 8777 });
  assert.deepEqual(parseMonitorArgs(['--port', '9001']), { port: 9001 });
  assert.deepEqual(parseMonitorArgs(['--help']), { help: true });
  for (const args of [['--port', '0'], ['--port', '65536'], ['--host','0.0.0.0'], ['--directory','/'], ['--port','9001','extra']]) assert.throws(() => parseMonitorArgs(args));
});

test('server rejects invalid ports before opening a listener', async () => {
  await assert.rejects(startMonitor({ store: fakeStore(), port: -1 }), TypeError);
  await assert.rejects(startMonitor({ store: fakeStore(), port: '8777' }), TypeError);
});
