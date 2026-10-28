import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

const PREVIEW_NOTE = '本机图片，无法在钉钉预览';
const unescape = value => value.replace(/\\([\\`*{}\[\]()#+.!_<> -])/g, '$1');
const referenceId = value => unescape(value).trim().replace(/\s+/g, ' ').toLowerCase();

function isEscaped(text, index) {
  let slashes = 0;
  while (index > 0 && text[--index] === '\\') slashes++;
  return slashes % 2 === 1;
}

// Code is documentation, not an image request. Keep complete fences and code spans verbatim.
function codeRanges(text) {
  const fences = [];
  let opening;
  let offset = 0;
  for (const line of text.match(/[^\n]*(?:\n|$)/g)) {
    if (!line) continue;
    const marker = /^ {0,3}(`{3,}|~{3,})([^\n]*)/.exec(line);
    if (opening) {
      if (marker && marker[1][0] === opening.character && marker[1].length >= opening.length
        && /^[ \t\r]*$/.test(marker[2])) {
        fences.push({ start: opening.start, end: offset + line.length });
        opening = undefined;
      }
    } else if (marker) {
      opening = { start: offset, character: marker[1][0], length: marker[1].length };
    }
    offset += line.length;
  }
  if (opening) fences.push({ start: opening.start, end: text.length });

  const ranges = [...fences];
  let fenceIndex = 0;
  for (let index = 0; index < text.length; index++) {
    const fence = fences[fenceIndex];
    if (fence && index >= fence.start) {
      index = fence.end - 1;
      fenceIndex++;
      continue;
    }
    if (text[index] !== '`' || isEscaped(text, index)) continue;
    const delimiter = /^`+/.exec(text.slice(index))[0];
    const limit = fence?.start ?? text.length;
    const runs = /`+/g;
    runs.lastIndex = index + delimiter.length;
    let closing;
    for (let match; (match = runs.exec(text)) && match.index < limit;) {
      if (match[0].length === delimiter.length) {
        closing = match.index + match[0].length;
        break;
      }
    }
    if (closing) {
      ranges.push({ start: index, end: closing });
      index = closing - 1;
    } else {
      index += delimiter.length - 1;
    }
  }
  return ranges.sort((left, right) => left.start - right.start);
}

function bracket(text, start) {
  if (text[start] !== '[') return null;
  let depth = 1;
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === '\\') { index++; continue; }
    if (text[index] === '[') depth++;
    if (text[index] === ']' && --depth === 0) return { value: text.slice(start + 1, index), end: index + 1 };
  }
  return null;
}

function destination(text, start) {
  let index = start;
  if (text[index] === '<') {
    for (index++; index < text.length; index++) {
      if (text[index] === '\\') { index++; continue; }
      if (text[index] === '>') return { value: text.slice(start + 1, index), end: index + 1 };
      if (text[index] === '\n') return null;
    }
    return null;
  }
  let depth = 0;
  for (; index < text.length; index++) {
    const character = text[index];
    if (character === '\\') { index++; continue; }
    if (character === '(') depth++;
    else if (character === ')') {
      if (depth === 0) break;
      depth--;
    } else if (/\s/.test(character) && depth === 0) break;
  }
  if (depth !== 0) return null;
  return { value: text.slice(start, index), end: index };
}

function inlineLink(text, start) {
  let index = start + 1;
  while (/\s/.test(text[index] || '') && index < text.length) index++;
  const target = destination(text, index);
  if (!target) return null;
  index = target.end;
  const beforeWhitespace = index;
  while (/\s/.test(text[index] || '') && index < text.length) index++;
  if (index > beforeWhitespace && ['"', "'", '('].includes(text[index])) {
    const close = text[index] === '(' ? ')' : text[index];
    index++;
    while (index < text.length && (text[index] !== close || isEscaped(text, index))) index++;
    if (index >= text.length) return null;
    index++;
    while (/\s/.test(text[index] || '') && index < text.length) index++;
  }
  return text[index] === ')' ? { source: target.value, end: index + 1 } : null;
}

function imageOrReference(text, start, references, unresolvedImage = false) {
  const label = bracket(text, start);
  if (!label) return null;
  if (text[label.end] === '(') {
    const link = inlineLink(text, label.end);
    return link ? { ...link, label: label.value } : null;
  }
  const suffix = text[label.end] === '[' ? bracket(text, label.end) : null;
  const id = referenceId(suffix?.value || label.value);
  const definition = references.get(id);
  if (definition) return { source: definition.source, label: label.value, id, end: suffix?.end ?? label.end };
  return unresolvedImage ? { source: null, label: label.value, end: suffix?.end ?? label.end } : null;
}

// Markdown decodes character references in destinations before the renderer loads them.
// Decode only the forms needed to classify a scheme; retain the original filename for display.
function addressForClassification(source) {
  return source.replace(/&#(?:[xX]([\da-fA-F]+)|(\d+));?|&(colon|Tab|NewLine);/g,
    (match, hex, decimal, named) => {
      if (named) return { colon: ':', Tab: '\t', NewLine: '\n' }[named];
      const code = Number.parseInt(hex || decimal, hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
    }).replace(/[\t\r\n]/g, '').trim();
}

function isWebImage(source) {
  const address = addressForClassification(source);
  if (!/^https?:\/\//i.test(address)) return false;
  try { return Boolean(new URL(address).hostname); }
  catch { return false; }
}

function safeText(value) {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/([\\`*{}\[\]()<>!_#|])/g, '\\$1').trim();
}

function localFilename(source, cwd) {
  let path = source;
  try { path = decodeURIComponent(path); } catch { /* Keep a literal filename with malformed escapes. */ }
  if (/^file:/i.test(path)) {
    try { path = fileURLToPath(path); }
    catch { return null; }
  } else {
    if (/^sandbox:/i.test(path)) path = path.slice('sandbox:'.length);
    const address = addressForClassification(path);
    if (/^[a-z][a-z\d+.-]*:/i.test(address) && !/^[a-z]:[\\/]/i.test(address)) return null;
  }
  if (!path) return null;
  const paths = win32.isAbsolute(path) && !posix.isAbsolute(path) ? win32 : posix;
  let display = paths.normalize(path);
  if (paths.isAbsolute(path)) {
    display = typeof cwd === 'string' && paths.isAbsolute(cwd) ? paths.relative(cwd, path) : paths.basename(path);
  }
  if (!display || display === '..' || display.startsWith(`..${paths.sep}`) || paths.isAbsolute(display)) {
    display = paths.basename(path);
  }
  return display.replace(/[\r\n\t]+/g, ' ');
}

function fallback(label, rawSource, cwd, localImageNote) {
  const caption = safeText(unescape(label)) || '图片';
  if (rawSource === null) return `${caption}（图片引用未解析，无法在钉钉预览）`;
  const filename = localFilename(unescape(rawSource), cwd);
  if (!filename) return `${caption}（图片地址不受支持，无法在钉钉预览）`;
  const ticks = '`'.repeat(Math.max(0, ...[...filename.matchAll(/`+/g)].map(match => match[0].length)) + 1);
  const padding = filename.startsWith('`') || filename.endsWith('`')
    || (filename.startsWith(' ') && filename.endsWith(' ')) ? ' ' : '';
  const note = typeof localImageNote === 'string' && localImageNote.trim()
    ? safeText(localImageNote) : PREVIEW_NOTE;
  return `${caption}：${ticks}${padding}${filename}${padding}${ticks}（${note}）`;
}

function parseImages(text) {
  if (typeof text !== 'string') throw new TypeError('Card Markdown must be a string.');
  const code = codeRanges(text);
  const protectedAt = index => code.some(range => range.start <= index && index < range.end);
  const definitions = new Map();
  const definitionRanges = [];
  for (const match of text.matchAll(/^ {0,3}\[([^\]\r\n]+)\]:[ \t]*(?:\r?\n[ \t]*)?([^\r\n]*)(?:\r?\n|$)/gm)) {
    if (protectedAt(match.index)) continue;
    const target = destination(match[2], 0);
    const id = referenceId(match[1]);
    if (target) {
      const definition = { id, source: target.value, start: match.index, end: match.index + match[0].length };
      definitionRanges.push(definition);
      if (!definitions.has(id)) definitions.set(id, definition);
    }
  }

  const images = [];
  const ordinaryReferences = new Set();
  const definitionStarts = new Map(definitionRanges.map(definition => [definition.start, definition]));
  let codeIndex = 0;
  for (let index = 0; index < text.length; index++) {
    while (codeIndex < code.length && code[codeIndex].end <= index) codeIndex++;
    const range = code[codeIndex];
    if (range && index >= range.start) {
      index = range.end - 1;
      codeIndex++;
      continue;
    }
    const definition = definitionStarts.get(index);
    if (definition) { index = definition.end - 1; continue; }
    if (text[index] === '!' && text[index + 1] === '[' && !isEscaped(text, index)) {
      const image = imageOrReference(text, index + 1, definitions, true);
      if (!image) continue;
      images.push({ ...image, start: index });
      index = image.end - 1;
    } else if (text[index] === '[' && !isEscaped(text, index) && text[index - 1] !== '!') {
      const link = imageOrReference(text, index, definitions);
      if (link?.id) ordinaryReferences.add(link.id);
    }
  }
  return { images, definitionRanges, ordinaryReferences };
}

/** Find local image requests for the trusted host to validate; this does not read or upload files. */
export function cardImages(text) {
  const { images } = parseImages(text);
  const seen = new Set();
  const resources = [];
  for (const image of images) {
    if (image.source === null) continue;
    const source = unescape(image.source);
    if (seen.has(source) || isWebImage(source) || !localFilename(source)) continue;
    seen.add(source);
    resources.push({ source, label: unescape(image.label) });
  }
  return resources;
}

/** Normalize image resources for a native DingTalk text card, without reading or uploading files. */
export function cardMarkdown(text, { cwd, localImageNote } = {}) {
  const { images, definitionRanges, ordinaryReferences } = parseImages(text);
  const imageReferences = new Set();
  const edits = [];
  for (const image of images) {
    if (image.source !== null && isWebImage(unescape(image.source))) continue;
    edits.push({ start: image.start, end: image.end,
      value: fallback(image.label, image.source, cwd, localImageNote) });
    if (image.id) imageReferences.add(image.id);
  }
  for (const definition of definitionRanges) {
    if (!imageReferences.has(definition.id) || ordinaryReferences.has(definition.id)) continue;
    edits.push({ start: definition.start, end: definition.end, value: '' });
  }
  return edits.sort((left, right) => right.start - left.start)
    .reduce((result, edit) => result.slice(0, edit.start) + edit.value + result.slice(edit.end), text);
}
