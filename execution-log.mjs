import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, lstat, open, readdir, realpath, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_LOG_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '.execution-logs');
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TYPES = new Set(['task_started', 'task_finished', 'progress', 'command', 'tool', 'fileChange', 'truncated']);
const PHASES = new Set(['started', 'completed']);
const SENSITIVE_KEY = '(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|access[_-]?key|private[_-]?key|session[_-]?key|app[_-]?secret|client[_-]?secret|password|passwd|authorization|credentials?|token|secret|cookie)';
const QUOTED_OR_WORD = `(?:"(?:\\\\.|[^"\\\\\\r\\n])*(?:"|$)|'(?:\\\\.|[^'\\\\\\r\\n])*(?:'|$)|[^\\s,;\\r\\n]+)`;
const ASSIGNMENT = new RegExp(`((?:[A-Za-z0-9_.-]*${SENSITIVE_KEY}[A-Za-z0-9_.-]*)["']?\\s*[:=]\\s*)${QUOTED_OR_WORD}`, 'gi');
const FLAG = new RegExp(`((?:--?)[A-Za-z0-9_-]*${SENSITIVE_KEY}[A-Za-z0-9_-]*\\s+)${QUOTED_OR_WORD}`, 'gi');
const AUTH_FILE = /(?:^|[\/\s"'=])(?:auth\.json|credentials(?:\.json)?|\.npmrc|\.env(?:\.[A-Za-z0-9_-]+)?|[^\/\s"']*\.keychain(?:-db)?)(?=$|[\/\s"'])|\.dws(?:-[A-Za-z0-9_-]+)?-auth[\/]|\bDWS_(?:CONFIG|KEYCHAIN)_DIR\b|\bsecurity\s+(?:find|dump|export)[-\w]*/i;

/** Only display this result. Raw protocol, authentication and reasoning are never logged. */
export function redactLogText(value, maximum = 65536) {
  if (typeof value !== 'string') return '';
  const clean = value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\|$)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[private key redacted]')
    .replace(/((?:^|\n)\s*(?:set-)?cookie\s*:\s*)[^\r\n]*/gi, '$1[redacted]')
    .replace(/\b(?:Basic|Bearer)\s+[^\s,;"']*/gi, '[authorization redacted]')
    .replace(ASSIGNMENT, '$1[redacted]')
    .replace(FLAG, '$1[redacted]')
    .replace(/\b(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]*/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){1,2}/g, '[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]*@/gi, '$1[redacted]@');
  return clean.length > maximum ? `${clean.slice(0, maximum)}\n[output truncated]` : clean;
}

function checkedId(id) {
  if (typeof id !== 'string' || !ID.test(id)) throw new TypeError('Invalid execution log ID.');
  return id;
}

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError('Invalid execution log size limit.');
  return value;
}

function text(value, limit = 65536) { return redactLogText(value, limit); }
function label(value) { return text(value, 1024); }
function number(value) { return Number.isFinite(value) ? value : undefined; }
function tier(value) { return value === null ? null : typeof value === 'string' ? label(value) : undefined; }

function allowedEvent(event, limit) {
  if (!event || !TYPES.has(event.type)) return null;
  switch (event.type) {
    case 'task_started':
      return { type: event.type, text: '任务开始', title: text(event.title, 256), model: text(event.model, 128),
        effort: text(event.effort, 64), serviceTier: tier(event.serviceTier), status: 'running' };
    case 'task_finished': {
      const status = ['completed', 'failed', 'interrupted', 'delivery_unknown'].includes(event.status) ? event.status : 'completed';
      const message = status === 'completed' ? '任务完成' : `任务结束：${status}`;
      const error = text(event.error, limit), answer = text(event.answer, limit);
      return { type: event.type, status, error, answer, text: [message, error, answer].filter(Boolean).join('\n'),
        model: label(event.model), effort: label(event.effort), serviceTier: tier(event.serviceTier) };
    }
    case 'progress': return { type: event.type, text: text(event.text, limit) };
    case 'command': {
      if (!PHASES.has(event.phase)) return null;
      const credentialAccess = Boolean(event.credentialAccess) || (typeof event.command === 'string' && AUTH_FILE.test(event.command));
      const visibleOutput = credentialAccess ? '[认证相关输出已隐藏]' : text(event.output ?? event.aggregatedOutput, limit);
      const output = event.outputTruncated && !visibleOutput.endsWith('[output truncated]') ? `${visibleOutput}\n[output truncated]` : visibleOutput;
      const command = credentialAccess ? '[认证相关命令已隐藏]' : text(event.command, limit);
      const cwd = credentialAccess ? '' : label(event.cwd);
      return { type: event.type, phase: event.phase, itemId: label(event.itemId), command, cwd, output,
        status: label(event.status), exitCode: number(event.exitCode), durationMs: number(event.durationMs), outputTruncated: Boolean(event.outputTruncated), credentialAccess,
        text: [`${event.phase === 'started' ? '$' : '命令完成'} ${command}`, cwd ? `cwd: ${cwd}` : '', output,
          event.exitCode === undefined ? '' : `exit: ${number(event.exitCode) ?? 'unknown'}`].filter(Boolean).join('\n') };
    }
    case 'tool':
      if (!PHASES.has(event.phase)) return null;
      return { type: event.type, phase: event.phase, itemId: label(event.itemId), tool: label(event.tool), server: label(event.server),
        status: label(event.status), text: `${label(event.server)} ${label(event.tool)} ${label(event.status || event.phase)}`.trim() };
    case 'fileChange': {
      if (!PHASES.has(event.phase)) return null;
      const paths = Array.isArray(event.paths) ? event.paths.slice(0, 100).map(label) : [];
      return { type: event.type, phase: event.phase, itemId: label(event.itemId), paths, status: label(event.status),
        text: ['文件修改', label(event.status || event.phase), ...paths].filter(Boolean).join('\n') };
    }
    case 'truncated': return { type: event.type, text: '日志已达到大小上限，后续详细输出未记录。' };
    default: return null;
  }
}

function metadata(id, events) {
  const first = events.find(event => event.type === 'task_started');
  if (!first) return null;
  const last = events.at(-1);
  const finished = events.findLast(event => event.type === 'task_finished');
  return { id, createdAt: first.time, updatedAt: last.time, status: finished?.status || 'running',
    title: first.title, model: finished?.model || first.model, effort: finished?.effort || first.effort,
    serviceTier: finished && Object.hasOwn(finished, 'serviceTier') ? finished.serviceTier : first.serviceTier, eventCount: events.length };
}

/** JSONL is the source of truth; the companion .log is a plain terminal transcript. */
export class ExecutionLogStore {
  constructor({ directory = DEFAULT_LOG_DIRECTORY, maxTaskBytes, maxTextChars } = {}) {
    this.directory = resolve(directory);
    this.maxTaskBytes = boundedInteger(maxTaskBytes, 4 * 1024 * 1024, 4096, 64 * 1024 * 1024);
    this.maxTextChars = boundedInteger(maxTextChars, 65536, 128, 1024 * 1024);
    this._metadataCache = new Map();
  }

  async _directory(create = false) {
    if (create) await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let stat;
    try { stat = await lstat(this.directory); }
    catch (error) { if (error.code === 'ENOENT' && !create) return null; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('Execution log directory must be private and must not be a symlink.');
    return realpath(this.directory);
  }

  async createTask(details = {}) {
    const directory = await this._directory(true);
    const id = randomUUID();
    const eventsPath = join(directory, `${id}.jsonl`);
    const transcriptPath = join(directory, `${id}.log`);
    const events = await open(eventsPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let transcript;
    try { transcript = await open(transcriptPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) { await events.close(); await unlink(eventsPath); throw error; }
    const recorder = new TaskRecorder(this, id, events, transcript);
    try { await recorder._append({ ...details, type: 'task_started' }); }
    catch (error) { await recorder._close(); throw error; }
    return recorder;
  }

  async _read(id, extension) {
    checkedId(id);
    const directory = await this._directory();
    if (!directory) return '';
    let file;
    try {
      file = await open(join(directory, `${id}.${extension}`), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077) throw new Error('Unsafe execution log file.');
      const length = Math.min(stat.size, this.maxTaskBytes);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return '';
      throw new Error('Execution log could not be read safely.');
    } finally { await file?.close(); }
  }

  async readEvents(id, { after = 0, limit = 500 } = {}) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 2000) throw new TypeError('Invalid execution log cursor.');
    return this._parseEvents(await this._read(id, 'jsonl'), after, limit);
  }

  _parseEvents(contents, after = 0, limit = Infinity) {
    const result = [];
    let previous = 0;
    for (const line of contents.split('\n')) {
      if (!line) continue;
      let value;
      try { value = JSON.parse(line); } catch { continue; }
      if (!Number.isSafeInteger(value.seq) || value.seq <= previous || typeof value.time !== 'string' || !Number.isFinite(Date.parse(value.time))) continue;
      previous = value.seq;
      const safe = allowedEvent(value, this.maxTextChars);
      if (safe && value.seq > after) result.push({ seq: value.seq, time: value.time, ...safe });
      if (result.length >= limit) break;
    }
    return result;
  }

  async getTask(id) {
    checkedId(id);
    const directory = await this._directory();
    if (!directory) return null;
    let snapshot;
    try { snapshot = await lstat(join(directory, `${id}.jsonl`)); }
    catch (error) { if (error.code === 'ENOENT') { this._metadataCache.delete(id); return null; } throw error; }
    if (!snapshot.isFile() || snapshot.isSymbolicLink() || snapshot.nlink !== 1 || snapshot.mode & 0o077) throw new Error('Unsafe execution log file.');
    const stamp = [snapshot.dev, snapshot.ino, snapshot.size, snapshot.mtimeMs, snapshot.ctimeMs].join(':');
    const cached = this._metadataCache.get(id);
    if (cached?.stamp === stamp) return cached.task ? { ...cached.task } : null;
    // Parse one bounded snapshot, rather than re-reading the same file for each page.
    const task = metadata(id, this._parseEvents(await this._read(id, 'jsonl')));
    this._metadataCache.delete(id);
    this._metadataCache.set(id, { stamp, task });
    if (this._metadataCache.size > 256) this._metadataCache.delete(this._metadataCache.keys().next().value);
    return task ? { ...task } : null;
  }

  async listTasks() {
    const directory = await this._directory();
    if (!directory) return [];
    const entries = await readdir(directory, { withFileTypes: true });
    const candidates = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const id = entry.name.slice(0, -6);
      if (!ID.test(id)) continue;
      try {
        const snapshot = await lstat(join(directory, entry.name));
        if (snapshot.isFile() && !snapshot.isSymbolicLink() && snapshot.nlink === 1 && !(snapshot.mode & 0o077)) {
          candidates.push({ id, mtimeMs: snapshot.mtimeMs });
        }
      } catch { /* Entries can disappear while the bridge writes logs. */ }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id));
    const tasks = [];
    for (const { id } of candidates.slice(0, 200)) {
      try { const task = await this.getTask(id); if (task) tasks.push(task); } catch { /* Ignore unsafe/unreadable entries. */ }
    }
    return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async readText(id) { return redactLogText(await this._read(id, 'log'), this.maxTaskBytes); }
}

class TaskRecorder {
  constructor(store, id, events, transcript) {
    this.store = store;
    this.id = id;
    this._events = events;
    this._transcript = transcript;
    this._tail = Promise.resolve();
    this._commands = new Map();
    this._seq = 0;
    this._bytes = 0;
    this._truncated = false;
    this._finished = false;
  }

  record(event) {
    if (this._finished) return this._tail;
    // Copy only supported fields now so callers cannot mutate the queued event.
    if (event?.type === 'command') {
      const itemId = label(event.itemId);
      if (!itemId) return this._tail;
      let command = this._commands.get(itemId);
      if (!command) {
        if (this._commands.size >= 128) return this._tail;
        command = { itemId, command: typeof event.command === 'string' ? event.command.slice(0, this.store.maxTextChars) : '',
          cwd: typeof event.cwd === 'string' ? event.cwd.slice(0, 1024) : '', output: '',
          credentialAccess: typeof event.command === 'string' && AUTH_FILE.test(event.command) };
        this._commands.set(itemId, command);
      }
      if (typeof event.command === 'string') {
        command.command = event.command.slice(0, this.store.maxTextChars);
        command.credentialAccess ||= AUTH_FILE.test(event.command);
        if (command.credentialAccess) command.output = '';
      }
      if (typeof event.cwd === 'string') command.cwd = event.cwd.slice(0, 1024);
      if (event.phase === 'output') {
        if (command.credentialAccess) return this._tail;
        const delta = typeof event.delta === 'string' ? event.delta : '';
        const remaining = this.store.maxTextChars - command.output.length;
        if (remaining > 0) command.output += delta.slice(0, remaining);
        if (delta.length > remaining) command.outputTruncated = true;
        return this._tail;
      }
      const aggregate = typeof event.aggregatedOutput === 'string' ? event.aggregatedOutput : typeof event.output === 'string' ? event.output : null;
      const snapshot = { ...command, ...event, output: aggregate === null ? command.output : aggregate.slice(0, this.store.maxTextChars),
        outputTruncated: aggregate === null ? command.outputTruncated : aggregate.length > this.store.maxTextChars,
        credentialAccess: command.credentialAccess || (typeof event.command === 'string' && AUTH_FILE.test(event.command)) };
      if (event.phase === 'completed') this._commands.delete(itemId);
      event = snapshot;
    }
    const safe = allowedEvent(event, this.store.maxTextChars);
    if (!safe || event.type === 'task_started' || event.type === 'task_finished') return this._tail;
    this._tail = this._tail.then(() => this._append(safe));
    return this._tail;
  }

  async finish(details = {}) {
    if (this._finished) return this._tail;
    this._finished = true;
    this._commands.clear();
    this._tail = this._tail.then(() => this._append({ ...details, type: 'task_finished' }, true)).finally(() => this._close());
    return this._tail;
  }

  async flush() { await this._tail; }

  async _append(event, terminal = false) {
    if (this._truncated && !terminal) return;
    let safe = allowedEvent(event, this.store.maxTextChars);
    if (!safe) return;
    let time = new Date().toISOString();
    let line = JSON.stringify({ seq: this._seq + 1, time, ...safe }) + '\n';
    // Keep room for the terminal status even when detailed output is capped.
    const reserve = Math.min(8192, Math.floor(this.store.maxTaskBytes / 4));
    if (!terminal && this._bytes + Buffer.byteLength(line) > this.store.maxTaskBytes - reserve) {
      if (this._truncated) return;
      this._truncated = true;
      safe = allowedEvent({ type: 'truncated' }, this.store.maxTextChars);
      line = JSON.stringify({ seq: this._seq + 1, time, ...safe }) + '\n';
    }
    if (terminal && this._bytes + Buffer.byteLength(line) > this.store.maxTaskBytes) {
      safe = { type: 'task_finished', status: safe.status, text: `任务结束：${safe.status}（详细结果超出日志上限）`, error: '详细结果超出日志上限',
        model: text(safe.model, 128), effort: text(safe.effort, 64), serviceTier: tier(safe.serviceTier) };
      line = JSON.stringify({ seq: this._seq + 1, time, ...safe }) + '\n';
    }
    await this._events.write(line);
    await this._transcript.write(`[${time}] ${safe.text || safe.type}\n\n`);
    this._seq += 1;
    this._bytes += Buffer.byteLength(line);
  }

  async _close() { await Promise.allSettled([this._events.close(), this._transcript.close()]); }
}
