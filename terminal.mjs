import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_DIRECTORY = dirname(SCRIPT_PATH);
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TMUX_SOCKET = 'dws-codex-logs';

function terminalError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function parseTerminalArgs(argv) {
  const options = { tmux: false, once: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i];
    if (argument === '--task') {
      if (options.taskId || !TASK_ID.test(argv[i + 1] || '')) {
        throw terminalError('INVALID_TASK_ID', '--task 必须是日志页面中的任务 UUID。');
      }
      options.taskId = argv[++i];
    } else if (argument === '--tmux') options.tmux = true;
    else if (argument === '--once') options.once = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw terminalError('INVALID_ARGUMENT', '未知参数；请使用 --help 查看用法。');
  }
  if (options.tmux && options.once) {
    throw terminalError('INVALID_ARGUMENT', '--tmux 与 --once 不能同时使用。');
  }
  return options;
}

// Stored events are already sanitized. Strip terminal control sequences again
// at this display boundary so log text cannot issue terminal commands.
export function terminalText(value) {
  return String(value ?? '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '');
}

export function formatEvent(event) {
  const time = terminalText(event.time).slice(0, 40);
  const type = terminalText(event.type).slice(0, 80);
  const text = terminalText(event.text);
  return `[${time}] ${type}${text ? `\n${text}` : ''}\n`;
}

function formatTask(task) {
  const speed = task.serviceTier === 'priority' ? 'Fast' : task.serviceTier === null ? '默认' : '未确认';
  return `\n=== 任务 ${terminalText(task.id)} ===\n`
    + `${terminalText(task.title || 'Bridge 执行日志')}\n`
    + `模型：${terminalText(task.model || '未确认')} · 速度：${speed} · 状态：${terminalText(task.status || '未确认')}\n`;
}

export function tmuxPlan(options = {}) {
  if (options.taskId !== undefined && !TASK_ID.test(options.taskId)) {
    throw terminalError('INVALID_TASK_ID', '--task 必须是日志页面中的任务 UUID。');
  }
  const session = `bridge-logs-${options.taskId || 'latest'}`;
  // Multiple command arguments make tmux exec the viewer directly. None of
  // these strings is evaluated by a shell, and no user-supplied command exists.
  const prefix = ['-L', TMUX_SOCKET, '-f', '/dev/null'];
  return {
    session,
    check: [...prefix, 'has-session', '-t', `=${session}`],
    start: [...prefix, 'new-session', '-d', '-s', session, '-c', PROJECT_DIRECTORY, '--',
      process.execPath, SCRIPT_PATH, ...(options.taskId ? ['--task', options.taskId] : [])],
    keep: [...prefix, 'set-window-option', '-t', `${session}:0`, 'remain-on-exit', 'on'],
    attach: `tmux -L ${TMUX_SOCKET} attach-session -r -t ${session}`,
  };
}

export function startTmuxViewer(options = {}, { run = spawnSync } = {}) {
  const plan = tmuxPlan(options);
  const invoke = args => run('tmux', args, {
    shell: false, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
    timeout: 5000, maxBuffer: 16 * 1024,
  });
  const checked = invoke(plan.check);
  if (checked.error?.code === 'ENOENT') {
    throw terminalError('TMUX_NOT_INSTALLED', '未找到 tmux；可先用本机网页或 node terminal.mjs 查看日志。');
  }
  if (checked.error || ![0, 1].includes(checked.status)) {
    throw terminalError('TMUX_UNAVAILABLE', '无法连接专用 tmux 日志会话；未更改 bridge 进程。');
  }
  if (checked.status === 1) {
    const started = invoke(plan.start);
    if (started.error || started.status !== 0) {
      throw terminalError('TMUX_START_FAILED', '无法启动专用 tmux 日志视图；未更改 bridge 进程。');
    }
    const kept = invoke(plan.keep);
    if (kept.error || kept.status !== 0) {
      throw terminalError('TMUX_SETUP_FAILED', '日志视图已启动，但未能设置退出后保留窗口。');
    }
  }
  return plan.attach;
}

export async function followTerminal(options, { store, write, signal, wait = delay } = {}) {
  if (!store || typeof write !== 'function') throw new TypeError('A log store and output writer are required.');
  if (options.taskId !== undefined && !TASK_ID.test(options.taskId)) {
    throw terminalError('INVALID_TASK_ID', '--task 必须是日志页面中的任务 UUID。');
  }
  let currentId;
  let after = 0;
  let status;
  let waiting = false;
  while (!signal?.aborted) {
    const tasks = options.taskId ? [] : await store.listTasks();
    const latest = [...tasks].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    const task = options.taskId ? await store.getTask(options.taskId) : latest;
    if (task) {
      if (task.id !== currentId) {
        currentId = task.id;
        after = 0;
        status = task.status;
        write(formatTask(task));
      } else if (task.status !== status) {
        status = task.status;
        write(`状态：${terminalText(status)}\n`);
      }
      // Drain bounded pages before sleeping, so --once also includes every
      // retained event. The store imposes its own per-task retention limit.
      for (let page = 0; page < 100; page += 1) {
        const events = await store.readEvents(task.id, { after, limit: 500 });
        for (const event of events) {
          if (!Number.isSafeInteger(event.seq) || event.seq <= after) continue;
          write(formatEvent(event));
          after = event.seq;
        }
        if (events.length < 500) break;
      }
    } else if (!waiting) {
      write(options.taskId ? '指定任务日志尚不存在。\n' : '尚无任务日志；等待 bridge 执行新任务…\n');
      waiting = true;
    }
    if (options.once) break;
    try { await wait(500, undefined, { signal }); }
    catch (error) { if (error.name !== 'AbortError') throw error; }
  }
}

const HELP = `本机 Bridge 脱敏日志（只读）\n\n`
  + `node terminal.mjs                 跟随最新任务\n`
  + `node terminal.mjs --task <UUID>   跟随指定任务\n`
  + `node terminal.mjs --once          输出当前日志后退出\n`
  + `node terminal.mjs --tmux          启动专用 tmux 日志视图\n`
  + `node terminal.mjs --tmux --task <UUID>\n\n`
  + `tmux 视图只读取脱敏日志，不承载或控制 bridge。\n`;

export async function main(argv = process.argv.slice(2)) {
  const options = parseTerminalArgs(argv);
  if (options.help) { process.stdout.write(HELP); return; }
  if (options.tmux) {
    process.stdout.write(`只读连接命令：\n${startTmuxViewer(options)}\n`);
    return;
  }
  const { ExecutionLogStore, DEFAULT_LOG_DIRECTORY } = await import('./execution-log.mjs');
  const store = new ExecutionLogStore({ directory: DEFAULT_LOG_DIRECTORY });
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await followTerminal(options, { store, write: text => process.stdout.write(text), signal: abort.signal });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const known = new Set(['INVALID_TASK_ID', 'INVALID_ARGUMENT', 'TMUX_NOT_INSTALLED',
      'TMUX_UNAVAILABLE', 'TMUX_START_FAILED', 'TMUX_SETUP_FAILED']);
    process.stderr.write(`${known.has(error.code) ? error.message : '无法读取执行日志；请检查本项目的日志目录。'}\n`);
    process.exitCode = 1;
  });
}
