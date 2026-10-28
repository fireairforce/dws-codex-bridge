import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { isAbsolute, resolve } from 'node:path';
import { validateImagePaths } from './media.mjs';

const HOST_INSTRUCTIONS = [
  'The DingTalk host handles all message transport, progress cards, and final delivery. Return your answer to the host; do not send DingTalk messages or cards yourself.',
  'Do not change, log out, copy, expose, or replace DingTalk or Codex authentication, account selection, credentials, or tokens.',
  'Work only on the user task in the supplied working directory. Do not request broader permissions or use another identity to bypass restrictions.',
].join('\n');

function bridgeError(code, message, details = {}) {
  return Object.assign(new Error(message), { name: 'CodexBridgeError', code, ...details });
}

/** The CLI startup check and each turn enforce the same account/catalog gate. */
export function assertCodexReady(checked) {
  if (!checked?.authenticated || checked.account?.type !== 'chatgpt') throw bridgeError('CODEX_ACCOUNT_REQUIRED', 'The existing ChatGPT account is not available; authentication was not changed.');
  if (!checked.modelAvailable || !checked.effortSupported) throw bridgeError('CODEX_MODEL_UNAVAILABLE', `${checked.model} with ${checked.effort} is not advertised by the current account.`);
  if (!checked.serviceTierSupported) throw bridgeError('CODEX_TIER_UNAVAILABLE', 'The requested Fast tier is not advertised by the current account.');
  return checked;
}

function safeErrorText(value) {
  return String(value ?? '')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/((?:access_token|refresh_token|id_token|appSecret|authorization)[\s"':=]+)[^\s,;"']+/gi, '$1[redacted]')
    .slice(0, 1000);
}

async function waitForOptionalLog(promise) {
  let timer;
  try {
    return await Promise.race([Promise.resolve(promise).then(() => true, () => false),
      new Promise(resolveWait => { timer = setTimeout(() => resolveWait(false), 500); })]);
  } finally { clearTimeout(timer); }
}

/** A private stdio client. It never starts an HTTP/WebSocket listener or handles DWS. */
export class CodexClient {
  constructor({ codex, model, effort, serviceTier = null, cwd,
    turnTimeoutMs = 1_200_000, requestTimeoutMs = 60_000, developerInstructions = '',
    dwsConfigDir, dwsKeychainDir } = {}) {
    if (!cwd || !isAbsolute(cwd)) throw new TypeError('Codex cwd must be an absolute path.');
    if (typeof codex !== 'string' || !isAbsolute(codex)) throw new TypeError('Codex executable must be an absolute path.');
    if (typeof model !== 'string' || !model.trim()) throw new TypeError('A Codex model is required.');
    if (typeof effort !== 'string' || !effort.trim()) throw new TypeError('A Codex reasoning effort is required.');
    if (serviceTier !== null && serviceTier !== 'priority') throw new TypeError('Unsupported Codex service tier.');
    if (!Number.isSafeInteger(turnTimeoutMs) || turnTimeoutMs <= 0) throw new TypeError('Invalid turnTimeoutMs.');
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) throw new TypeError('Invalid requestTimeoutMs.');
    if (dwsConfigDir !== undefined && !isAbsolute(dwsConfigDir)) throw new TypeError('DWS config directory must be absolute.');
    if (dwsKeychainDir !== undefined && !isAbsolute(dwsKeychainDir)) throw new TypeError('DWS keychain directory must be absolute.');
    this.codex = codex;
    this.cwd = resolve(cwd);
    this.model = model;
    this.effort = effort;
    this.serviceTier = serviceTier;
    this.turnTimeoutMs = turnTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.developerInstructions = [HOST_INSTRUCTIONS, developerInstructions].filter(Boolean).join('\n\n');
    this._env = { ...process.env,
      ...(dwsConfigDir ? { DWS_CONFIG_DIR: dwsConfigDir } : {}),
      ...(dwsKeychainDir ? { DWS_KEYCHAIN_DIR: dwsKeychainDir } : {}),
    };
    this._pending = new Map();
    this._loadedThreads = new Set();
    this._nextId = 1;
    this._runTail = Promise.resolve();
    this._child = null;
    this._active = null;
    this._closing = false;
    this._closed = false;
    this._failure = null;
  }

  async initialize() {
    await this._ensureInitialized();
    return this.check();
  }

  async _ensureInitialized() {
    this._assertOpen();
    if (!this._initializing) {
      this._initializing = (async () => {
        const child = spawn(this.codex, ['app-server', '--stdio'], {
          cwd: this.cwd, env: this._env, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
        });
        this._child = child;
        this._childClosed = new Promise((done) => child.once('close', done));
        child.stderr.on('data', () => {}); // Drain diagnostics without exposing raw logs or credentials.
        child.stdin.on('error', () => {
          if (!this._closing) this._fatal(bridgeError('CODEX_STDIN_CLOSED', 'Codex input closed unexpectedly.'));
        });
        child.on('error', (error) => this._fatal(bridgeError('CODEX_PROCESS_ERROR', `Codex process error: ${safeErrorText(error.code || error.message)}`)));
        child.on('close', (code, signal) => {
          if (!this._closing && !this._failure) this._fatal(bridgeError('CODEX_PROCESS_EXITED', `Codex exited (${signal || code}).`));
        });
        this._lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
        this._lines.on('line', (line) => this._handleLine(line));
        await this._request('initialize', {
          clientInfo: { name: 'dws_local_codex', title: 'DWS Local Codex', version: '0.1.0' },
          capabilities: { experimentalApi: false },
        });
        this._write({ method: 'initialized', params: {} });
      })();
    }
    await this._initializing;
    this._assertOpen();
  }

  /** Read-only account/catalog checks. No login, thread creation, or model turn. */
  async check() {
    await this._ensureInitialized();
    const accountResult = await this._request('account/read', { refreshToken: false });
    const account = accountResult.account;
    let cursor;
    let selected;
    let catalogComplete = false;
    const seen = new Set();
    for (let page = 0; page < 20; page += 1) {
      const result = await this._request('model/list', { limit: 100, includeHidden: true, ...(cursor ? { cursor } : {}) });
      selected = (result.data || []).find((model) => model.model === this.model || model.id === this.model);
      if (selected || !result.nextCursor) {
        catalogComplete = !result.nextCursor;
        break;
      }
      if (seen.has(result.nextCursor)) throw bridgeError('CODEX_CATALOG_CURSOR_LOOP', 'Codex model catalog did not advance.');
      seen.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    const supportedEfforts = (selected?.supportedReasoningEfforts || []).map((item) => item.reasoningEffort).filter((item) => typeof item === 'string');
    const supportedServiceTiers = (selected?.serviceTiers || []).map(({ id, name }) => ({ id, name }));
    this._checkSummary = {
      authenticated: Boolean(account),
      account: account ? { type: account.type, ...(account.type === 'chatgpt' ? { email: account.email, planType: account.planType } : {}) } : null,
      requiresOpenaiAuth: Boolean(accountResult.requiresOpenaiAuth),
      model: this.model, modelAvailable: Boolean(selected),
      effort: this.effort, effortSupported: supportedEfforts.includes(this.effort), supportedEfforts,
      serviceTier: this.serviceTier,
      serviceTierSupported: this.serviceTier === null || supportedServiceTiers.some(({ id }) => id === this.serviceTier),
      supportedServiceTiers,
      catalogComplete, sandbox: 'workspace-write', approvalPolicy: 'never',
    };
    return structuredClone(this._checkSummary);
  }

  /** Calls are serialized so a thread can never receive overlapping turns. */
  run(options) {
    const operation = this._runTail.then(() => this._run(options));
    this._runTail = operation.catch(() => {});
    return operation;
  }

  async _run({ threadId, text, imagePaths = [], onProgress, onExecutionEvent } = {}) {
    if (typeof text !== 'string' || !text.trim()) throw new TypeError('Codex text must be nonempty.');
    if (threadId !== undefined && (typeof threadId !== 'string' || !threadId)) throw new TypeError('Invalid threadId.');
    if (onProgress !== undefined && typeof onProgress !== 'function') throw new TypeError('onProgress must be a function.');
    if (onExecutionEvent !== undefined && typeof onExecutionEvent !== 'function') throw new TypeError('onExecutionEvent must be a function.');
    let currentThread = threadId;
    try {
      const images = await validateImagePaths(imagePaths, this.cwd);
      await this._ensureInitialized();
      const checked = this._checkSummary || await this.check();
      assertCodexReady(checked);
      if (!currentThread || !this._loadedThreads.has(currentThread)) {
        const result = await this._request(currentThread ? 'thread/resume' : 'thread/start', {
          ...(currentThread ? { threadId: currentThread, excludeTurns: true } : {}),
          model: this.model, serviceTier: this.serviceTier, cwd: this.cwd, approvalPolicy: 'never', sandbox: 'workspace-write',
          developerInstructions: this.developerInstructions,
        });
        currentThread = result.thread?.id;
        if (!currentThread) throw bridgeError('CODEX_THREAD_MISSING', 'Codex did not return a thread ID.');
        if (result.model !== this.model || result.approvalPolicy !== 'never' || result.sandbox?.type !== 'workspaceWrite' || resolve(result.cwd || '') !== this.cwd) {
          throw bridgeError('CODEX_SCOPE_MISMATCH', 'Codex did not apply the requested model, directory, or sandbox.');
        }
        if (this.serviceTier !== null && result.serviceTier !== this.serviceTier) {
          throw bridgeError('CODEX_TIER_MISMATCH', 'Codex did not apply the requested Fast tier.');
        }
        if (result.thread.status?.type === 'active') throw bridgeError('CODEX_THREAD_BUSY', 'The saved Codex thread already has running work.');
        this._loadedThreads.add(currentThread);
      }
      let finish;
      let fail;
      const completion = new Promise((resolveTurn, rejectTurn) => { finish = resolveTurn; fail = rejectTurn; });
      completion.catch(() => {});
      const context = { threadId: currentThread, turnId: null, pendingNotifications: [], messages: new Map(), onProgress,
        onExecutionEvent, executionTail: Promise.resolve(), observedItems: new Set(),
        progressTail: Promise.resolve(), progressSeen: new Set(), resolve: finish, reject: fail, settled: false };
      this._active = context;
      context.timer = setTimeout(() => {
        const error = bridgeError('CODEX_TURN_TIMEOUT', 'Codex did not complete within the configured time.', { threadId: currentThread, turnId: context.turnId });
        this._cancelContext(context, error);
      }, this.turnTimeoutMs);
      this._progress(context, '正在思考…');
      try {
        const started = await this._request('turn/start', {
          threadId: currentThread, input: [{ type: 'text', text }, ...images.map(path => ({ type: 'localImage', path }))],
          model: this.model, effort: this.effort, serviceTier: this.serviceTier,
          cwd: this.cwd, approvalPolicy: 'never',
          sandboxPolicy: { type: 'workspaceWrite', writableRoots: [this.cwd], networkAccess: false },
        });
        if (!started.turn?.id) throw bridgeError('CODEX_TURN_MISSING', 'Codex did not return a turn ID.');
        context.turnId = started.turn.id;
        // Resume can replay notifications from an earlier turn before this RPC responds.
        // Correlate against the server-assigned ID, then replay only matching notifications.
        for (const notification of context.pendingNotifications.splice(0)) this._handleNotification(notification);
        if (started.turn.status && started.turn.status !== 'inProgress') this._finishContext(context, started.turn);
        const answer = await completion;
        return { threadId: currentThread, text: answer, model: this.model, effort: this.effort, serviceTier: this.serviceTier };
      } catch (error) {
        if (!context.settled) this._cancelContext(context, error);
        throw error;
      } finally {
        clearTimeout(context.timer);
        if (!await waitForOptionalLog(context.executionTail)) {
          context.executionLogFailed = true;
          context.executionLogDisabled = true;
        }
        if (this._active === context) this._active = null;
      }
    } catch (error) {
      if (currentThread && error && typeof error === 'object' && !error.threadId) error.threadId = currentThread;
      throw error;
    }
  }

  _assertOpen() {
    if (this._failure) throw this._failure;
    if (this._closing || this._closed) throw bridgeError('CODEX_CLIENT_CLOSED', 'Codex client is closed.');
  }

  _write(message) {
    if (!this._child?.stdin.writable) throw bridgeError('CODEX_STDIN_CLOSED', 'Codex input is unavailable.');
    this._child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error && !this._closing) this._fatal(bridgeError('CODEX_WRITE_FAILED', 'Writing to Codex failed.'));
    });
  }

  _request(method, params, timeoutMs = this.requestTimeoutMs) {
    if (this._failure) return Promise.reject(this._failure);
    const id = this._nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => this._fatal(bridgeError('CODEX_RPC_TIMEOUT', `Codex request timed out: ${method}.`)), timeoutMs);
      this._pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer, method });
      try { this._write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this._pending.delete(id); rejectRequest(error); }
    });
  }

  _handleLine(line) {
    if (!line.trim()) return;
    if (line.length > 16 * 1024 * 1024) { this._fatal(bridgeError('CODEX_PROTOCOL_SIZE', 'Codex returned an oversized protocol message.')); return; }
    let message;
    try { message = JSON.parse(line); }
    catch { this._fatal(bridgeError('CODEX_PROTOCOL_JSON', 'Codex returned invalid protocol JSON.')); return; }
    if (message.method && Object.hasOwn(message, 'id')) { this._refuseServerRequest(message); return; }
    if (Object.hasOwn(message, 'id')) {
      const pending = this._pending.get(message.id);
      if (!pending) return;
      this._pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(bridgeError('CODEX_RPC_ERROR', `${pending.method}: ${safeErrorText(message.error.message)}`, { rpcCode: message.error.code }));
      else pending.resolve(message.result ?? {});
      return;
    }
    this._handleNotification(message);
  }

  _handleNotification(message) {
    const context = this._active;
    const params = message.params || {};
    if (!context || context.settled || params.threadId !== context.threadId) return;
    const turnId = params.turnId || params.turn?.id;
    if (!context.turnId) {
      if (context.pendingNotifications.length >= 1024) {
        this._fatal(bridgeError('CODEX_NOTIFICATION_OVERFLOW', 'Codex returned too many notifications before confirming the turn.'));
      } else context.pendingNotifications.push(message);
      return;
    }
    if (turnId && turnId !== context.turnId) return;
    // Execution details require an explicit, matching live turn. History replay,
    // account notifications and unscoped messages never enter the log callback.
    if (turnId === context.turnId) {
      if (message.method === 'item/started' || message.method === 'item/completed') {
        this._observeExecutionItem(context, params.item, message.method === 'item/started' ? 'started' : 'completed');
      } else if (message.method === 'item/commandExecution/outputDelta' && typeof params.delta === 'string') {
        this._executionEvent(context, { type: 'command', phase: 'output', itemId: params.itemId, delta: params.delta });
      }
    }
    if (message.method === 'item/completed' && params.item?.type === 'agentMessage') {
      context.messages.set(params.item.id, { text: params.item.text, phase: params.item.phase });
    } else if (message.method === 'item/started' && ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(params.item?.type)) {
      this._progress(context, '正在执行任务…');
    } else if (message.method === 'turn/completed') {
      this._finishContext(context, params.turn);
    }
  }

  _observeExecutionItem(context, item, phase) {
    if (!item || typeof item.id !== 'string') return;
    const key = `${phase}:${item.id}`;
    if (context.observedItems.has(key)) return;
    context.observedItems.add(key);
    if (item.type === 'commandExecution') {
      this._executionEvent(context, { type: 'command', phase, itemId: item.id,
        command: item.command, cwd: item.cwd, status: item.status,
        ...(phase === 'completed' ? { aggregatedOutput: item.aggregatedOutput,
          exitCode: item.exitCode, durationMs: item.durationMs } : {}) });
    } else if (item.type === 'fileChange') {
      this._executionEvent(context, { type: 'fileChange', phase, itemId: item.id,
        paths: (Array.isArray(item.changes) ? item.changes : []).map(change => change?.path).filter(path => typeof path === 'string'), status: item.status });
    } else if (['mcpToolCall', 'dynamicToolCall', 'webSearch', 'collabToolCall'].includes(item.type)) {
      this._executionEvent(context, { type: 'tool', phase, itemId: item.id,
        tool: typeof item.tool === 'string' ? item.tool : item.type,
        ...(typeof item.server === 'string' ? { server: item.server } : {}), status: item.status });
    } else if (item.type === 'agentMessage' && item.phase === 'commentary' && phase === 'completed' && typeof item.text === 'string') {
      this._executionEvent(context, { type: 'progress', text: item.text });
    }
    // In particular, reasoning items, tool arguments/results and RPC stderr are
    // deliberately absent from this allowlist.
  }

  _executionEvent(context, event) {
    if (!context.onExecutionEvent || context.settled) return;
    if (context.executionLogDisabled || (context.executionPending || 0) >= 512) {
      context.executionLogFailed = true;
      context.executionLogDisabled = true;
      return;
    }
    context.executionPending = (context.executionPending || 0) + 1;
    context.executionTail = context.executionTail.then(async () => {
      try {
        if (context.executionLogDisabled) return;
        if (!await waitForOptionalLog(Promise.resolve().then(() => context.onExecutionEvent(event)))) {
          // Monitoring is optional: a stuck disk/viewer must not repeat,
          // cancel or indefinitely delay a completed model turn.
          context.executionLogFailed = true;
          context.executionLogDisabled = true;
        }
      } finally { context.executionPending -= 1; }
    });
  }

  _progress(context, text) {
    if (!context.onProgress || context.progressSeen.has(text) || context.settled) return;
    context.progressSeen.add(text);
    context.progressTail = context.progressTail.then(() => context.onProgress(text)).catch(() => {
      this._cancelContext(context, bridgeError('CODEX_PROGRESS_FAILED', 'The host could not update task progress.', { threadId: context.threadId }));
    });
  }

  async _finishContext(context, turn) {
    if (context.settled || context.finishing) return;
    context.finishing = true;
    for (const item of turn?.items || []) {
      if (item.type === 'agentMessage' && !context.messages.has(item.id)) context.messages.set(item.id, { text: item.text, phase: item.phase });
      this._observeExecutionItem(context, item, 'completed');
    }
    await context.progressTail;
    if (context.settled) return;
    if (turn?.status !== 'completed') {
      this._settle(context, bridgeError('CODEX_TURN_FAILED', `Codex turn ${turn?.status || 'failed'}${turn?.error?.message ? `: ${safeErrorText(turn.error.message)}` : '.'}`, { threadId: context.threadId, turnId: context.turnId }));
      return;
    }
    const items = [...context.messages.values()];
    const finals = items.filter((item) => item.phase === 'final_answer' && typeof item.text === 'string' && item.text.trim());
    // Older servers may omit phase. Explicit commentary/partial answers never become final output.
    const legacy = items.filter((item) => !item.phase && typeof item.text === 'string' && item.text.trim());
    const answer = finals.length ? finals.map((item) => item.text).join('\n\n') : legacy.at(-1)?.text;
    if (!answer) this._settle(context, bridgeError('CODEX_FINAL_MISSING', 'Codex completed without a final answer.', { threadId: context.threadId, turnId: context.turnId }));
    else this._settle(context, null, answer);
  }

  _settle(context, error, answer) {
    if (context.settled) return;
    context.settled = true;
    clearTimeout(context.timer);
    if (error) context.reject(error); else context.resolve(answer);
  }

  _cancelContext(context, error) {
    if (context.settled) return;
    this._settle(context, error);
    // Do not reuse a process after an interrupted/unknown turn; its queued work must stop too.
    if (context.turnId && this._child?.stdin.writable) {
      try { this._write({ id: this._nextId++, method: 'turn/interrupt', params: { threadId: context.threadId, turnId: context.turnId } }); } catch {}
    }
    this._fatal(error);
  }

  _refuseServerRequest(message) {
    let result;
    switch (message.method) {
      case 'currentTime/read': result = { currentTimeAt: Math.floor(Date.now() / 1000) }; break;
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval': result = { decision: 'cancel' }; break;
      case 'execCommandApproval':
      case 'applyPatchApproval': result = { decision: 'abort' }; break;
      case 'item/permissions/requestApproval': result = { permissions: {}, scope: 'turn' }; break;
      case 'item/tool/requestUserInput': result = { answers: {} }; break;
      case 'mcpServer/elicitation/request': result = { action: 'decline' }; break;
      case 'item/tool/call': result = { success: false, contentItems: [{ type: 'inputText', text: 'This host does not execute external tool requests.' }] }; break;
      default: break;
    }
    try {
      this._write(result ? { id: message.id, result } : { id: message.id, error: { code: -32601, message: 'This host does not implement this server request.' } });
    } catch (error) { this._fatal(error); return; }
    if (message.method !== 'currentTime/read') {
      const error = bridgeError('CODEX_INTERACTION_REQUIRED', `Codex requested unsupported interaction: ${message.method}.`, { threadId: this._active?.threadId, turnId: this._active?.turnId });
      if (this._active) this._cancelContext(this._active, error); else this._fatal(error);
    }
  }

  _fatal(error) {
    if (!this._failure) this._failure = error;
    for (const pending of this._pending.values()) { clearTimeout(pending.timer); pending.reject(this._failure); }
    this._pending.clear();
    if (this._active) this._settle(this._active, this._failure);
    if (this._child && !this._closing) {
      this._child.stdin.end();
      this._child.kill('SIGTERM');
    }
  }

  async close() {
    if (this._closePromise) return this._closePromise;
    this._closing = true;
    this._closePromise = (async () => {
      const child = this._child;
      const closedError = bridgeError('CODEX_CLIENT_CLOSED', 'Codex client was closed.');
      if (this._active?.turnId && child?.stdin.writable) {
        try { this._write({ id: this._nextId++, method: 'turn/interrupt', params: { threadId: this._active.threadId, turnId: this._active.turnId } }); } catch {}
      }
      for (const pending of this._pending.values()) { clearTimeout(pending.timer); pending.reject(closedError); }
      this._pending.clear();
      if (this._active) this._settle(this._active, closedError);
      if (child) {
        child.stdin.end();
        const waitClosed = (ms) => new Promise((done) => { const timer = setTimeout(() => done(false), ms); this._childClosed.then(() => { clearTimeout(timer); done(true); }); });
        if (!await waitClosed(1500)) {
          child.kill('SIGTERM');
          if (!await waitClosed(2500)) { child.kill('SIGKILL'); await waitClosed(1500); }
        }
      }
      this._lines?.close();
      this._closed = true;
    })();
    return this._closePromise;
  }
}

export default CodexClient;
