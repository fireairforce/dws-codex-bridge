import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cardImages } from './card-markdown.mjs';

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const preparedPlans = new WeakSet();
const attemptedPlans = new WeakSet();
const IMAGE_WARNING = '部分图片未通过文件或大小校验，未发送这些图片。';
const UNKNOWN_WARNING = '图片消息投递尚未确认，请勿重复发送。';

function within(root, path) {
  const part = relative(root, path);
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

function allowed(root, path) {
  return within(join(root, 'outputs'), path) || within(join(root, 'downloads', 'dingtalk-images'), path);
}

function imageExtension(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'gif';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function localPath(source, cwd) {
  if (typeof source !== 'string' || !source || source.includes('\0')) throw new Error('Invalid image path.');
  if (/^file:/i.test(source)) return fileURLToPath(source);
  const path = /^sandbox:/i.test(source) ? source.slice('sandbox:'.length) : source;
  if (/^[a-z][a-z\d+.-]*:/i.test(path)) throw new Error('Unsupported image scheme.');
  return resolve(cwd, decodeURIComponent(path));
}

function caption(label) {
  // The CLI's image parser accepts simple Markdown. Do not embed link syntax in alt text.
  return String(label || '图片').replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/(?:[a-z][a-z\d+.-]*:\/\/|(?:data|javascript|file|sandbox):)[^\s)\]>]*/gi, '')
    .replace(/[\\`*{}\[\]()<>!_#|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) || '图片';
}

function sealPlan(markdown, images, warnings) {
  const plan = Object.freeze({ markdown, images: Object.freeze(images.map(Object.freeze)),
    warnings: Object.freeze([...new Set(warnings)]) });
  preparedPlans.add(plan);
  return plan;
}

/** Copy only validated workspace images into immutable-per-task upload inputs. */
export async function prepareImageReply(text, { cwd } = {}) {
  const candidates = cardImages(text);
  if (candidates.length === 0) return sealPlan('', [], []);
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new TypeError('An absolute workspace cwd is required.');
  const root = await realpath(cwd);
  const lexicalRoot = resolve(cwd);
  const selected = [];
  const seen = new Set();
  const warnings = [];
  let totalBytes = 0;
  for (const image of candidates) {
    let file;
    try {
      const source = localPath(image.source, lexicalRoot);
      if (!allowed(root, source) && !allowed(lexicalRoot, source)) throw new Error('Image is outside the output directories.');
      const path = await realpath(source);
      if (!allowed(root, path)) throw new Error('Image resolves outside the output directories.');
      if (seen.has(path)) continue;
      if (selected.length >= MAX_IMAGES) throw new Error('Too many images.');
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await file.stat();
      if (!info.isFile() || info.size <= 0 || info.size > MAX_IMAGE_BYTES
        || totalBytes + info.size > MAX_TOTAL_BYTES) throw new Error('Image size is invalid.');
      // Read at most one byte beyond the inspected size, rather than trusting a growing file.
      const buffer = Buffer.alloc(info.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const result = await file.read(buffer, length, buffer.length - length, null);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length !== info.size) throw new Error('Image changed while being read.');
      const bytes = buffer.subarray(0, length);
      const extension = imageExtension(bytes);
      if (!extension) throw new Error('Unsupported image format.');
      selected.push({ source: image.source, relativePath: relative(root, path).split(sep).join('/'),
        label: String(image.label || '图片'), extension, bytes });
      totalBytes += length;
      seen.add(path);
    } catch {
      warnings.push(IMAGE_WARNING);
    } finally {
      await file?.close();
    }
  }
  if (selected.length === 0) return sealPlan('', [], warnings);

  const outputs = join(root, 'outputs');
  await mkdir(outputs, { recursive: true, mode: 0o700 });
  if (await realpath(outputs) !== outputs) throw new Error('图片输出目录不安全，未准备发送。');
  const staging = join(outputs, 'bridge-outbound-images');
  await mkdir(staging, { recursive: true, mode: 0o700 });
  if (await realpath(staging) !== staging) throw new Error('图片暂存目录不安全，未准备发送。');
  const taskDirectory = await mkdtemp(join(staging, 'message-'));
  const images = [];
  for (const [index, image] of selected.entries()) {
    const path = join(taskDirectory, `image-${index + 1}.${image.extension}`);
    await writeFile(path, image.bytes, { flag: 'wx', mode: 0o600 });
    images.push({ source: image.source, relativePath: image.relativePath,
      stagedPath: relative(root, path).split(sep).join('/'), label: image.label });
  }
  const markdown = images.map(image => `![${caption(image.label)}](${image.stagedPath})`).join('\n\n');
  return sealPlan(markdown, images, warnings);
}

function receipt(value) {
  const fields = { task: new Set(), message: new Set(), conversation: new Set(), status: new Set() };
  let invalid = false;
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const item of node) visit(item); return; }
    if (node.ok === false || node.success === false || node.accepted === false || node.error
      || node.partial === true || (Array.isArray(node.failures) && node.failures.length)) invalid = true;
    for (const [key, value] of Object.entries(node)) {
      const field = /^(openTaskId|taskId)$/.test(key) ? 'task'
        : /^(openMessageId|openMsgId|messageId|msgId)$/.test(key) ? 'message'
          : /^(openConversationId|conversationId|openCid)$/.test(key) ? 'conversation'
            : /^(sendStatus|deliveryStatus|status)$/.test(key) ? 'status' : null;
      if (field) {
        if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) invalid = true;
        else fields[field].add(value.trim());
      }
      if (['result', 'data', 'response', 'content', 'message', 'sendReceipt', 'messageRef'].includes(key)) visit(value);
    }
  };
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) invalid = true;
  visit(value);
  return { fields, invalid, single: name => fields[name].size === 1 ? [...fields[name]][0] : undefined };
}

function targetArguments(target) {
  if (!target || typeof target !== 'object') throw new TypeError('A validated target is required.');
  const { conversationId, receiverOpenId } = target;
  const values = [conversationId, receiverOpenId].filter(value => value !== undefined);
  if (values.length !== 1 || typeof values[0] !== 'string' || !values[0].trim()
    || values[0] !== values[0].trim()) throw new TypeError('Exactly one validated target is required.');
  return conversationId !== undefined ? ['--group', conversationId] : ['--open-dingtalk-id', receiverOpenId];
}

/** Send at most once, persist the accepted task, then inspect that task without resending. */
export async function deliverImageReply(plan, { call, target, idempotencyKey, onReceipt } = {}) {
  if (!preparedPlans.has(plan)) throw new TypeError('A prepared image plan is required.');
  if (plan.images.length === 0) return { state: 'not_needed' };
  const targetArgs = targetArguments(target);
  if (typeof call !== 'function' || typeof onReceipt !== 'function'
    || typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || /[\r\n\0]/.test(idempotencyKey)) {
    throw new TypeError('A host caller, persistence callback and idempotency key are required.');
  }
  if (attemptedPlans.has(plan)) throw new Error('图片发送已尝试，不能重复发送。');
  attemptedPlans.add(plan);
  let sent;
  try {
    sent = receipt(await call(['chat', '+messages-send', ...targetArgs,
      '--markdown', plan.markdown, '--uuid', idempotencyKey, '--yes']));
  } catch {
    return { state: 'delivery_unknown', warning: UNKNOWN_WARNING };
  }
  const openTaskId = sent.single('task');
  if (sent.invalid || !openTaskId || sent.fields.message.size > 1 || sent.fields.conversation.size > 1
    || (target.conversationId && sent.single('conversation') && sent.single('conversation') !== target.conversationId)) {
    return { state: 'delivery_unknown', ...(openTaskId ? { openTaskId } : {}), warning: UNKNOWN_WARNING };
  }
  const accepted = { openTaskId, ...(sent.single('message') ? { openMessageId: sent.single('message') } : {}),
    ...(sent.single('conversation') ? { conversationId: sent.single('conversation') } : {}) };
  try { await onReceipt(accepted); }
  catch { return { state: 'delivery_unknown', ...accepted, warning: UNKNOWN_WARNING }; }

  let status;
  try { status = receipt(await call(['chat', '+messages-query-send-status', '--open-task-id', openTaskId])); }
  catch { return { state: 'delivery_unknown', ...accepted, warning: UNKNOWN_WARNING }; }
  const openMessageId = status.single('message');
  const conversationId = status.single('conversation');
  if (status.invalid || status.fields.task.size > 1 || (status.single('task') && status.single('task') !== openTaskId)
    || status.fields.message.size > 1 || status.fields.conversation.size > 1
    || (target.conversationId && conversationId && conversationId !== target.conversationId)
    || (accepted.conversationId && conversationId && accepted.conversationId !== conversationId)
    || (accepted.openMessageId && openMessageId && accepted.openMessageId !== openMessageId)) {
    return { state: 'delivery_unknown', ...accepted, warning: UNKNOWN_WARNING };
  }
  const states = [...status.fields.status].map(value => value.toLowerCase());
  // Same textual completion states as the CLI's helpers/chat_delivery.go; unknown/numeric values stay unknown.
  const complete = states.length > 0 && states.every(value => ['delivered', 'success', 'accepted'].includes(value));
  if (complete && openMessageId && conversationId) return { state: 'sent', openTaskId, openMessageId, conversationId };
  return { state: 'delivery_unknown', ...accepted, warning: UNKNOWN_WARNING };
}
