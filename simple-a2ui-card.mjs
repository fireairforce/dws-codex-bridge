import { randomUUID } from 'node:crypto';
import { singleBizId } from './policy.mjs';
import { cardMarkdown } from './card-markdown.mjs';

export const SIMPLE_A2UI_CARD_TYPE = 'a2ui-markdown-v1';
const CATALOG = 'https://dingtalk.com/card/a2ui/catalogs/public/catalog.json';

function executionSummary({ model, serviceTier } = {}) {
  const modelLabel = typeof model === 'string' && model.trim() ? model.trim() : '未确认';
  const speedLabel = serviceTier === 'priority' ? 'Fast' : serviceTier === null ? '默认' : '未确认';
  return `模型：${modelLabel} · 速度：${speedLabel}`;
}

function assertReceipt(result, expectedBizId) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || !Object.keys(result).length) {
    throw new Error('卡片请求缺少有效回执，停止后续写入。');
  }
  const ids = new Set();
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.ok === false || node.success === false || node.accepted === false || node.error
      || node.partial === true || (Array.isArray(node.failures) && node.failures.length)) {
      throw new Error('卡片请求返回失败或部分结果，停止后续写入。');
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'bizId' && typeof child === 'string' && child) ids.add(child);
      else if (child && typeof child === 'object') visit(child);
    }
  };
  visit(result);
  if (expectedBizId && [...ids].some(id => id !== expectedBizId)) {
    throw new Error('卡片更新回执的 bizId 不一致，停止后续写入。');
  }
}

/** A complete, single-component card. Existing streaming cards are never migrated. */
export class SimpleA2UIReplyCard {
  constructor(call, { cwd } = {}) {
    if (typeof call !== 'function') throw new TypeError('A host DWS caller is required.');
    this.call = call;
    this.cwd = cwd;
    this.surfaceId = `reply-${randomUUID()}`;
    this.bizId = null;
    this.state = 'new';
    this.progress = [];
  }

  get deliveryUnknown() { return this.state === 'delivery_unknown'; }

  component(text) {
    return { id: 'root', component: 'Markdown', content: text, fallbackMarkdown: text };
  }

  encode(messages) { return JSON.stringify(messages.map(message => JSON.stringify(message))); }

  async create({ conversationId, receiverOpenId } = {}) {
    if (this.state !== 'new') throw new Error('卡片创建已经尝试，不重复创建。');
    const targets = [conversationId, receiverOpenId].filter(value => typeof value === 'string' && value.trim());
    if (targets.length !== 1 || (conversationId !== undefined && receiverOpenId !== undefined)) {
      throw new Error('卡片必须且只能指定一个已校验的会话或接收人。');
    }
    const targetArgs = conversationId !== undefined
      ? ['--conversation-id', conversationId] : ['--open-dingtalk-id', receiverOpenId];
    const text = '正在处理你的消息。';
    const messages = [
      { version: 'v1.0', createSurface: { surfaceId: this.surfaceId, catalogId: CATALOG } },
      { version: 'v1.0', updateDataModel: { surfaceId: this.surfaceId, path: '/', value: {} } },
      { version: 'v1.0', updateComponents: { surfaceId: this.surfaceId, components: [this.component(text)] } },
    ];
    this.state = 'creating';
    try {
      // One creation request already includes readable content; persist its real ID before updates.
      const result = await this.call(['chat', 'message', 'send-a2ui-card', ...targetArgs,
        '--summary', text, '--content', '-', '--support-forward', '--yes'], this.encode(messages));
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
    const flowStatus = { processing: 'PROCESSING', progress: 'INPUTTING', finished: 'FINISH', failed: 'FINISH' }[phase];
    if (!flowStatus) throw new TypeError('未知卡片状态。');
    const displayText = cardMarkdown(text, { cwd: this.cwd });
    const terminal = phase === 'finished' || phase === 'failed';
    const nextProgress = this.progress.at(-1) === displayText ? [...this.progress] : [...this.progress, displayText];
    const body = terminal
      ? `${phase === 'failed' ? '**任务未完成**\n\n' : ''}${displayText}\n\n---\n\n> ${executionSummary(execution)}`
      : `**正在处理**\n\n${nextProgress.join('\n\n')}\n\n---\n\n> 模型与速度：待执行确认`;
    const messages = [{ version: 'v1.0', updateComponents: {
      surfaceId: this.surfaceId, components: [this.component(body)],
    } }];
    this.state = 'updating';
    try {
      const result = await this.call(['chat', 'message', 'update-a2ui-card', '--biz-id', this.bizId,
        '--flow-status', flowStatus, '--content', '-', '--yes'], this.encode(messages));
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
