import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExecutionLogStore } from './execution-log.mjs';

const DEFAULT_PORT = 8777;
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PAGE = readFileSync(new URL('./monitor.html', import.meta.url), 'utf8');

function securityHeaders(html) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((match) => `'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`);
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Content-Security-Policy': `default-src 'none'; script-src ${scripts.join(' ') || "'none'"}; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
  };
}

function validAuthority(host, port) {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/** Read-only HTTP surface. It does not accept commands, task creation, or file paths. */
export function createMonitorHandler({ store, port = DEFAULT_PORT, getPort = () => port, html = PAGE } = {}) {
  if (!store || !['listTasks', 'getTask', 'readEvents'].every((key) => typeof store[key] === 'function')) {
    throw new TypeError('A readable execution log store is required.');
  }
  const headers = securityHeaders(html);
  return async (request, response) => {
    const finish = (status, data, type = 'application/json; charset=utf-8') => {
      response.writeHead(status, { ...headers, 'Content-Type': type });
      response.end(request.method === 'HEAD' ? undefined : type.startsWith('application/json') ? JSON.stringify(data) : data);
    };
    const expectedPort = getPort();
    const authority = request.headers.host;
    if (typeof authority !== 'string' || !validAuthority(authority, expectedPort)) {
      finish(403, { error: '仅允许本机访问。' });
      return;
    }
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== `http://${authority}`) {
      finish(403, { error: '不允许跨来源访问。' });
      return;
    }
    const fetchSite = request.headers['sec-fetch-site'];
    if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
      finish(403, { error: '不允许跨来源访问。' });
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      finish(405, { error: '日志页面仅支持读取。' });
      return;
    }
    const rawPath = request.url || '';
    if (!rawPath.startsWith('/') || rawPath.startsWith('//') || /[\\\x00-\x20]|%(?:2e|2f|5c)/i.test(rawPath)) {
      finish(400, { error: '无效请求。' });
      return;
    }
    let url;
    try { url = new URL(rawPath, `http://${authority}`); }
    catch { finish(400, { error: '无效请求。' }); return; }
    try {
      if (url.pathname === '/' && !url.search) {
        finish(200, html, 'text/html; charset=utf-8');
        return;
      }
      if (url.pathname === '/api/tasks' && !url.search) {
        finish(200, { tasks: await store.listTasks() });
        return;
      }
      const match = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname);
      if (!match || !TASK_ID.test(match[1])) {
        finish(404, { error: '未找到日志。' });
        return;
      }
      const keys = [...url.searchParams.keys()];
      const afterText = url.searchParams.get('after') ?? '0';
      const limitText = url.searchParams.get('limit') ?? '200';
      if (keys.some((key) => !['after', 'limit'].includes(key)) || new Set(keys).size !== keys.length
        || !/^\d{1,15}$/.test(afterText) || !/^\d{1,3}$/.test(limitText)) {
        finish(400, { error: '无效游标。' });
        return;
      }
      const after = Number(afterText);
      const limit = Number(limitText);
      if (!Number.isSafeInteger(after) || limit < 1 || limit > 500) {
        finish(400, { error: '无效游标。' });
        return;
      }
      const task = await store.getTask(match[1]);
      if (!task) { finish(404, { error: '未找到日志。' }); return; }
      const events = await store.readEvents(match[1], { after, limit });
      finish(200, { task, events });
    } catch {
      // Never expose local paths, raw parser errors, log contents, or diagnostics.
      finish(503, { error: '日志暂不可用，请稍后重试。' });
    }
  };
}

export async function startMonitor({ store = new ExecutionLogStore(), port = DEFAULT_PORT } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid monitor port.');
  let server;
  const handler = createMonitorHandler({ store, getPort: () => server.address()?.port ?? port });
  server = createServer(handler);
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1000;
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen({ host: '127.0.0.1', port }, () => {
      server.removeListener('error', fail);
      done();
    });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    server, url,
    close: () => new Promise((done, fail) => {
      server.close((error) => error ? fail(error) : done());
      server.closeIdleConnections();
    }),
  };
}

export function parseMonitorArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  if (args.length === 0) return { port: DEFAULT_PORT };
  if (args.length !== 2 || args[0] !== '--port' || !/^\d{1,5}$/.test(args[1])) {
    throw new TypeError('用法：node monitor.mjs [--port 8777]');
  }
  const port = Number(args[1]);
  if (port < 1 || port > 65535) throw new TypeError('端口须为 1–65535。');
  return { port };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseMonitorArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write('用法：node monitor.mjs [--port 8777]\n仅在 127.0.0.1 提供本项目的只读执行日志。\n');
    } else {
      const monitor = await startMonitor(options);
      process.stdout.write(`Bridge 执行日志：${monitor.url}\n`);
      for (const signal of ['SIGINT', 'SIGTERM']) {
        process.once(signal, () => monitor.close().catch(() => {}).finally(() => { process.exitCode = 0; }));
      }
    }
  } catch (error) {
    const message = error.code === 'EADDRINUSE' ? '日志端口已被占用，请选用其他 --port。'
      : ['EPERM', 'EACCES'].includes(error.code) ? '当前环境不允许启动本机日志端口。'
        : error instanceof TypeError ? error.message : '日志查看器启动失败。';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
