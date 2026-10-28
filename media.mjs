import { mkdir, mkdtemp, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const IMAGE_REFERENCE = /\[图片消息\]\(mediaId=([^\s)]+)\)/g;
const MEDIA_ID = /^[@$]?[A-Za-z0-9_+=/-]{1,4096}$/;

function isWithin(root, path) {
  const part = relative(root, path);
  return part !== '' && part !== '..' && !part.startsWith('../') && !isAbsolute(part);
}

async function imageRoot(cwd, create = false) {
  const root = await realpath(cwd);
  const downloads = join(root, 'downloads');
  if (create) await mkdir(downloads, { recursive: true, mode: 0o700 });
  const downloadsPath = await realpath(downloads);
  if (!isWithin(root, downloadsPath)) throw new Error('图片下载目录超出当前项目范围。');
  const attachments = join(downloadsPath, 'dingtalk-images');
  if (create) await mkdir(attachments, { recursive: true, mode: 0o700 });
  const attachmentsPath = await realpath(attachments);
  if (!isWithin(root, attachmentsPath)) throw new Error('图片下载目录超出当前项目范围。');
  return attachmentsPath;
}

function isSupportedImage(header, length) {
  return (length >= 8 && header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
    || (length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff)
    || (length >= 6 && ['GIF87a', 'GIF89a'].includes(header.toString('ascii', 0, 6)))
    || (length >= 12 && header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP');
}

/** Keep host-provided image inputs inside the project attachment directory. */
export async function validateImagePaths(imagePaths, cwd) {
  if (!Array.isArray(imagePaths) || imagePaths.length > MAX_IMAGES) {
    throw new Error(`每条消息最多支持 ${MAX_IMAGES} 张图片。`);
  }
  if (imagePaths.length === 0) return [];
  const root = await imageRoot(cwd);
  const validated = [];
  let totalBytes = 0;
  for (const path of imagePaths) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('图片路径必须是宿主下载后的绝对路径。');
    const resolved = await realpath(path);
    if (!isWithin(root, resolved)) throw new Error('图片文件超出当前项目附件目录。');
    const file = await open(resolved, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size === 0 || info.size > MAX_IMAGE_BYTES) {
        throw new Error('图片必须是非空文件，且单张不超过 10 MiB。');
      }
      totalBytes += info.size;
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error('每条消息的图片合计不能超过 20 MiB。');
      const header = Buffer.alloc(12);
      const { bytesRead } = await file.read(header, 0, header.length, 0);
      if (!isSupportedImage(header, bytesRead)) throw new Error('图片格式不受支持，请发送 PNG、JPEG、GIF 或 WebP。');
    } finally {
      await file.close();
    }
    validated.push(resolved);
  }
  return validated;
}

/** Called by the trusted host with IDs from the accepted source message. */
export async function prepareImageInput(event, { cwd, download }) {
  const originalText = event.content.trim();
  const ids = [...new Set([...originalText.matchAll(IMAGE_REFERENCE)].map(match => match[1]))];
  if (ids.length === 0) return { text: originalText, imagePaths: [] };
  if (ids.length > MAX_IMAGES) throw new Error(`每条消息最多支持 ${MAX_IMAGES} 张图片，请分开发送。`);
  if (ids.some(id => !MEDIA_ID.test(id))) throw new Error('图片引用格式无效，未尝试下载。');
  if (!event.message_id || !event.conversation_id) throw new Error('图片缺少来源消息或会话信息，未尝试下载。');
  const root = await imageRoot(cwd, true);
  const taskDir = await mkdtemp(join(root, 'message-'));
  const paths = [];
  for (const [index, id] of ids.entries()) {
    const path = join(taskDir, `image-${index + 1}`);
    try {
      await download(['chat', 'message', 'download-media', '--type', 'mediaId', '--resource-id', id,
        '--message-id', event.message_id, '--open-conversation-id', event.conversation_id, '--output', path]);
    } catch {
      throw new Error('图片下载失败，尚未交给 Codex；请检查宿主 DWS 下载状态后重新发送。');
    }
    paths.push(path);
  }
  const imagePaths = await validateImagePaths(paths, cwd);
  const text = originalText.replace(IMAGE_REFERENCE, '').trim()
    || '请查看本条消息附带的图片，并结合当前对话说明图片内容；如果我的意图不明确，请先简要描述图片。';
  return { text, imagePaths };
}
