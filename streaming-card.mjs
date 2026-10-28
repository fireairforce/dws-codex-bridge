import { singleBizId } from './policy.mjs';
import { cardMarkdown } from './card-markdown.mjs';

function executionSummary({ model, serviceTier } = {}) {
  const modelLabel = typeof model === 'string' && model.trim() ? model.trim() : '未确认';
  const speedLabel = serviceTier === 'priority' ? 'Fast' : serviceTier === null ? '默认' : '未确认';
  return `模型：${modelLabel} · 速度：${speedLabel}`;
}

function assertReceipt(result, expectedBizId) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length === 0) {
    throw new Error('卡片请求缺少有效回执，停止后续写入。');
  }
  const ids = new Set();
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.ok === false || node.success === false || node.accepted === false || node.error
      || node.partial === true || (Array.isArray(node.failures) && node.failures.length > 0)) {
      throw new Error('卡片请求返回失败或部分结果，停止后续写入。');
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'bizId' && typeof child === 'string' && child) ids.add(child);
      else if (child && typeof child === 'object') visit(child);
    }
  }
  visit(result);
  if (expectedBizId && [...ids].some(id => id !== expectedBizId)) {
    throw new Error('卡片更新回执的 bizId 不一致，停止后续写入。');
  }
}

/** The host supplies its existing DWS caller after validating the source and target. */
export class StreamingReplyCard {
  constructor(call, { cwd } = {}) {
    if (typeof call !== 'function') throw new TypeError('A host DWS caller is required.');
    this.call = call;
    this.cwd = cwd;
    this.bizId = null;
    this.state = 'new';
    this.progress = [];
  }

  get deliveryUnknown() { return this.state === 'delivery_unknown'; }

  async create({ conversationId, receiverOpenId } = {}) {
    if (this.state !== 'new') throw new Error('卡片创建已经尝试，不重复创建。');
    const targets = [conversationId, receiverOpenId].filter(value => typeof value === 'string' && value.trim());
    if (targets.length !== 1 || (conversationId !== undefined && receiverOpenId !== undefined)) {
      throw new Error('卡片必须且只能指定一个已校验的会话或接收人。');
    }
    const targetArgs = conversationId !== undefined
      ? ['--group', conversationId] : ['--receiver-open-dingtalk-id', receiverOpenId];
    this.state = 'creating';
    try {
      // The owner authorized native reply cards; the host retains exact target validation.
      // Create first and persist the ID before any body update can fail.
      const result = await this.call(['chat', '+messages-send-card', ...targetArgs, '--yes']);
      this.bizId = singleBizId(result);
      assertReceipt(result);
      this.state = 'open';
      return this.bizId;
    } catch (error) {
      this.state = 'delivery_unknown';
      throw error;
    }
  }

  async update(text, { phase = 'progress', execution } = {}) {
    if (this.state !== 'open') throw new Error('卡片已结束或投递状态未知，不继续更新。');
    if (typeof text !== 'string' || !text.trim()) throw new TypeError('卡片正文不能为空。');
    const status = { processing: 1, progress: 2, finished: 3, failed: 5 }[phase];
    if (!status) throw new TypeError('未知卡片状态。');
    const displayText = cardMarkdown(text, { cwd: this.cwd });
    const terminal = phase === 'finished' || phase === 'failed';
    const nextProgress = this.progress.at(-1) === displayText ? [...this.progress] : [...this.progress, displayText];
    const body = terminal
      ? `${phase === 'failed' ? '**任务未完成**\n\n' : ''}${displayText}\n\n---\n\n> ${executionSummary(execution)}`
      : `**正在处理**\n\n${nextProgress.join('\n\n')}\n\n---\n\n> 模型与速度：待执行确认`;
    this.state = 'updating';
    try {
      const result = await this.call(['chat', '+messages-update-card', '--biz-id', this.bizId,
        '--content', body, '--flow-status', String(status), '--yes']);
      assertReceipt(result, this.bizId);
      if (!terminal) this.progress = nextProgress;
      this.state = terminal ? phase : 'open';
      return result;
    } catch (error) {
      this.state = 'delivery_unknown';
      throw error;
    }
  }
}
