import { execFileSync } from 'node:child_process';

const messages = {
  invalid_pid: '未记录有效宿主进程。',
  not_found: '已确认宿主进程不存在。',
  matched: '已核验宿主进程归属。',
  different_process: '记录的进程不属于此宿主。',
  inspection_denied: '当前执行环境禁止检查进程，无法核验宿主是否运行。',
  inspection_unavailable: '进程检查工具不可用，无法核验宿主是否运行。',
  inspection_failed: '进程检查未完成，无法核验宿主是否运行。',
};

function result(running, reason) {
  return { running, reason, message: messages[reason] };
}

/** Do not expose ps output: another process's argv may contain private data. */
export function inspectBridgeProcess(pid, { entry, runPs = execFileSync } = {}) {
  if (!Number.isSafeInteger(pid) || pid < 2) return result(false, 'invalid_pid');
  if (typeof entry !== 'string' || !entry) throw new TypeError('A bridge entry path is required.');
  let command;
  try {
    command = runPs('/bin/ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 65536,
    });
  } catch (error) {
    const empty = value => value === undefined || value === null || String(value).trim() === '';
    if (error?.status === 1 && !error.code && !error.signal && empty(error.stdout) && empty(error.stderr)) {
      return result(false, 'not_found');
    }
    if (error?.code === 'EPERM' || error?.code === 'EACCES') return result(null, 'inspection_denied');
    if (error?.code === 'ENOENT') return result(null, 'inspection_unavailable');
    return result(null, 'inspection_failed');
  }
  if (typeof command !== 'string' || !command.trim()) return result(null, 'inspection_failed');
  const matched = command.includes(entry) && /\srun(?:\s|$)/.test(command);
  return result(matched, matched ? 'matched' : 'different_process');
}

/** Lifecycle commands must stop when process identity cannot be checked. */
export function requireKnownProcessStatus(inspection) {
  if (inspection.running === null) {
    throw new Error(`${inspection.message}已停止本次进程操作，没有启动、停止或替换宿主。`);
  }
  return inspection.running;
}
