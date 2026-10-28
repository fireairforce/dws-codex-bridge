import test from 'node:test';
import assert from 'node:assert/strict';
import { cardImages, cardMarkdown } from './card-markdown.mjs';

const cwd = '/workspace';
const fallback = /本机图片，无法在钉钉预览/;

test('the PR screenshot becomes readable text instead of a local image request', () => {
  const text = '已创建：[PR #123](https://example.com/project/pull/123)。\n\n'
    + '![PR 创建结果](/workspace/outputs/example-task/pr-created.png)';
  const result = cardMarkdown(text, { cwd });
  assert.match(result, /PR 创建结果/);
  assert.match(result, /outputs\/example-task\/pr-created\.png/);
  assert.match(result, fallback);
  assert.doesNotMatch(result, /!\[/);
  assert.doesNotMatch(result, /\/workspace\//);
  assert.ok(result.startsWith('已创建：[PR #123](https://example.com/project/pull/123)。'));
});

test('absolute HTTP and HTTPS images retain their complete Markdown', () => {
  for (const image of [
    '![图](https://example.com/image.png)',
    '![图](http://example.com/image.png "A title")',
    '![图](<https://example.com/image%20name.png>)',
  ]) {
    assert.equal(cardMarkdown(`before ${image} after`, { cwd }), `before ${image} after`);
  }
});

test('only local images change when public images and text share an answer', () => {
  const publicImage = '![公开图](https://example.com/public.png)';
  const result = cardMarkdown(`${publicImage}\n\n![本机图](outputs/private.png)\n\n完成。`, { cwd });
  assert.ok(result.startsWith(`${publicImage}\n\n`));
  assert.match(result, /outputs\/private\.png/);
  assert.match(result, fallback);
  assert.ok(result.endsWith('\n\n完成。'));
  assert.equal((result.match(/!\[/g) || []).length, 1);
});

test('angle-bracket paths preserve meaningful filenames containing spaces and parentheses', () => {
  const result = cardMarkdown('![截图](</workspace/screenshots/review shot (1).png> "Final review")', { cwd });
  assert.match(result, /screenshots\/review shot \(1\)\.png/);
  assert.match(result, fallback);
  assert.doesNotMatch(result, /!\[|\/workspace\//);
});

test('balanced and escaped destination parentheses are consumed as part of the image', () => {
  for (const image of [
    '![截图](outputs/review(1).png)',
    '![截图](outputs/review\\(1\\).png)',
    '![截图](outputs/review(1).png "Screenshot (final)")',
  ]) {
    const result = cardMarkdown(`before ${image} after`, { cwd });
    assert.match(result, /review/);
    assert.match(result, /\.png/);
    assert.match(result, fallback);
    assert.doesNotMatch(result, /!\[/);
    assert.ok(result.startsWith('before '));
    assert.ok(result.endsWith(' after'));
  }
});

test('escaped caption brackets and destination brackets remain readable without creating new images', () => {
  const result = cardMarkdown('![PR \\[创建\\]结果](outputs/review[final]\\(1\\).png)', { cwd });
  assert.match(result, /PR \\\[创建\\\]结果/);
  assert.match(result, /`outputs\/review\[final\]\(1\)\.png`/);
  assert.match(result, fallback);
  assert.doesNotMatch(result, /!\[/);
});

test('an image inside a public link keeps that link clickable', () => {
  const target = 'https://example.com/project/pull/123';
  const result = cardMarkdown(`[![打开 PR](/workspace/outputs/pr.png)](${target})`, { cwd });
  assert.ok(result.startsWith('['));
  assert.ok(result.endsWith(`](${target})`));
  assert.match(result, /打开 PR/);
  assert.match(result, /outputs\/pr\.png/);
  assert.doesNotMatch(result, /!\[|\/workspace\//);
});

test('full, collapsed and shortcut reference images resolve local destinations', () => {
  for (const image of ['![截图][asset]', '![asset][]', '![asset]']) {
    const result = cardMarkdown(`${image}\n\n[asset]: /workspace/outputs/reference.png "A title"\n`, { cwd });
    assert.match(result, /outputs\/reference\.png/);
    assert.match(result, fallback);
    assert.doesNotMatch(result, /!\[|\/workspace\//);
  }
});

test('image references resolve labels without depending on case or whitespace', () => {
  const result = cardMarkdown('![截图][BUILD   SHOT]\n\n[build shot]: <outputs/build shot.png>\n', { cwd });
  assert.match(result, /outputs\/build shot\.png/);
  assert.match(result, fallback);
  assert.doesNotMatch(result, /!\[/);
});

test('public reference images and their definitions remain unchanged', () => {
  const text = '![截图][asset]\n\n[asset]: https://example.com/image.png "Title"\n';
  assert.equal(cardMarkdown(text, { cwd }), text);
});

test('unresolved full, collapsed and shortcut image references become explicit text', () => {
  for (const image of ['![未找到的截图][missing]', '![未找到的截图][]', '![未找到的截图]']) {
    const result = cardMarkdown(`before ${image} after`, { cwd });
    assert.match(result, /未找到的截图/);
    assert.match(result, /图片引用未解析，无法在钉钉预览/);
    assert.doesNotMatch(result, /!\[|\[missing\]/);
    assert.ok(result.startsWith('before '));
    assert.ok(result.endsWith(' after'));
  }
});

test('ordinary file links and reference definitions remain unchanged', () => {
  const text = '[报告](/workspace/report.md)\n\n[源码][file]\n\n[file]: /workspace/source.js\n';
  assert.equal(cardMarkdown(text, { cwd }), text);
});

test('a definition shared with a normal link is preserved after the image falls back', () => {
  const definition = '[asset]: /workspace/outputs/shared.png "Shared file"';
  const result = cardMarkdown(`![预览][asset]\n\n[下载文件][asset]\n\n${definition}\n`, { cwd });
  assert.match(result, fallback);
  assert.doesNotMatch(result, /!\[/);
  assert.ok(result.includes('[下载文件][asset]'));
  assert.ok(result.includes(definition));
});

test('image-only definitions with a target on the following line do not retain resource payloads', () => {
  const result = cardMarkdown('![图][asset]\n\n[asset]:\n  data:image/png;base64,PRIVATE_IMAGE_PAYLOAD\n', { cwd });
  assert.match(result, /图（图片地址不受支持，无法在钉钉预览）/);
  assert.doesNotMatch(result, /!\[|\[asset\]:|data:|PRIVATE_IMAGE_PAYLOAD/);
});

test('all duplicate image-only definitions are removed while the first target determines the fallback', () => {
  const result = cardMarkdown('![图][asset]\n\n[asset]: /workspace/outputs/first.png\n'
    + '[asset]: data:image/png;base64,PRIVATE_DUPLICATE\n', { cwd });
  assert.match(result, /outputs\/first\.png/);
  assert.match(result, fallback);
  assert.doesNotMatch(result, /!\[|\[asset\]:|\/workspace\/|data:|PRIVATE_DUPLICATE/);

  const unsupported = cardMarkdown('![图][asset]\n\n[asset]: data:image/png;base64,PRIVATE_PAYLOAD\n'
    + '[asset]: data:image/png;base64,PRIVATE_DUPLICATE\n', { cwd });
  assert.match(unsupported, /图片地址不受支持，无法在钉钉预览/);
  assert.doesNotMatch(unsupported, /!\[|\[asset\]:|data:|PRIVATE_/);
});

test('multiline and duplicate definitions shared with ordinary links remain verbatim', () => {
  const definitions = '[asset]:\n  /workspace/outputs/first.png\n[asset]: /workspace/outputs/second.png\n';
  const result = cardMarkdown(`![图][asset]\n\n[下载][asset]\n\n${definitions}`, { cwd });
  assert.match(result, /outputs\/first\.png/);
  assert.match(result, fallback);
  assert.ok(result.includes('[下载][asset]'));
  assert.ok(result.endsWith(definitions));
});

test('fenced code, inline code and escaped image examples stay literal', () => {
  const examples = [
    '```markdown\n![示例](/workspace/example.png)\n```\n',
    '~~~markdown\n![示例][asset]\n[asset]: /workspace/example.png\n~~~\n',
    'Use `![示例](/workspace/example.png)` in Markdown.',
    'Use ``![示例](outputs/a`b.png)`` in Markdown.',
    '\\![示例](/workspace/example.png)',
    '!\\[示例](/workspace/example.png)',
  ];
  for (const example of examples) assert.equal(cardMarkdown(example, { cwd }), example);
});

test('normal prose after a code block still receives local-image fallback', () => {
  const code = '```markdown\n![示例](outputs/example.png)\n```';
  const result = cardMarkdown(`${code}\n\n![真实截图](outputs/real.png)`, { cwd });
  assert.ok(result.startsWith(code));
  assert.match(result, /outputs\/real\.png/);
  assert.match(result, fallback);
  assert.equal((result.match(/!\[/g) || []).length, 1);
});

test('unsupported resource schemes do not leak their payload or leave image placeholders', () => {
  for (const source of [
    'data:image/png;base64,PRIVATE_IMAGE_PAYLOAD',
    'blob:https://example.com/PRIVATE_BLOB_ID',
    'private:PRIVATE_RESOURCE_ID',
    'javascript:alert(PRIVATE_SCRIPT)',
    'data%3Aimage/png;base64,PRIVATE_IMAGE_PAYLOAD',
    'blob%3Ahttps://example.com/PRIVATE_BLOB_ID',
  ]) {
    const result = cardMarkdown(`![预览](${source})`, { cwd });
    assert.ok(result.trim());
    assert.match(result, /预览/);
    assert.doesNotMatch(result, /!\[|PRIVATE_|data:|blob:|javascript:/);
  }
});

test('HTML character references cannot disguise unsupported image schemes or expose their payload', () => {
  for (const source of [
    'data&#58;image/png;base64,PRIVATE',
    'data&#x3a;image/png;base64,PRIVATE',
    'data&colon;image/png;base64,PRIVATE',
    'd&#97;ta:image/png;base64,PRIVATE',
    'd&#x61;ta:image/png;base64,PRIVATE',
    'da&Tab;ta&colon;image/png;base64,PRIVATE',
    'da&NewLine;ta&colon;image/png;base64,PRIVATE',
    'bl&#111;b&colon;https://example.com/PRIVATE',
    'sandbox:data:image/png;base64,PRIVATE',
  ]) {
    const result = cardMarkdown(`![图](${source})`, { cwd });
    assert.match(result, /图片地址不受支持，无法在钉钉预览/);
    assert.doesNotMatch(result, /!\[|PRIVATE|base64|example\.com/);
  }
  const local = cardMarkdown('![图](outputs/review&chart.png)', { cwd });
  assert.match(local, /`outputs\/review&chart\.png`/);
  assert.match(local, fallback);

  const remote = '![图](https&colon;//example.com/image.png?one=1&two=2)';
  assert.equal(cardMarkdown(remote, { cwd }), remote);
});

test('outside-workspace paths are reduced to a filename rather than exposing machine directories', () => {
  for (const source of ['/Users/person/private/chart.png', '../private/chart.png', 'C:\\Users\\person\\private\\chart.png']) {
    const result = cardMarkdown(`![图](${source})`, { cwd });
    assert.match(result, /chart\.png/);
    assert.match(result, fallback);
    assert.doesNotMatch(result, /Users|person|private|\.\.\//);
  }
});

test('file and sandbox URLs are handled as local resources', () => {
  for (const source of ['file:///workspace/outputs/chart%20one.png', 'sandbox:/mnt/data/chart.png']) {
    const result = cardMarkdown(`![图](${source})`, { cwd });
    assert.match(result, /chart/);
    assert.match(result, /\.png/);
    assert.match(result, fallback);
    assert.doesNotMatch(result, /!\[|file:|sandbox:|\/mnt\/data/);
  }
});

test('image-only replies with empty alt text still produce a useful nonempty fallback', () => {
  const result = cardMarkdown('![](outputs/result.png)', { cwd });
  assert.match(result, /outputs\/result\.png/);
  assert.match(result, fallback);
  assert.doesNotMatch(result, /!\[/);
});

test('local image requests retain source order and deduplicate inline and reference destinations', () => {
  const text = '![第一张](</workspace/outputs/review (1).png>)\n'
    + '![远程](https://example.com/public.png)\n'
    + '![第二张](outputs/second\\(2\\).png "标题")\n'
    + '![重复][first]\n\n[first]: </workspace/outputs/review (1).png>\n';
  assert.deepEqual(cardImages(text), [
    { source: '/workspace/outputs/review (1).png', label: '第一张' },
    { source: 'outputs/second(2).png', label: '第二张' },
  ]);
});

test('full, collapsed and shortcut local images expose the same resources used by rendering', () => {
  const text = '[![完整][full]](https://example.com/result)\n![collapsed][]\n![shortcut]\n'
    + '[full]: outputs/full.png\n[collapsed]: outputs/collapsed.png\n[shortcut]: outputs/shortcut.png\n';
  assert.deepEqual(cardImages(text), [
    { source: 'outputs/full.png', label: '完整' },
    { source: 'outputs/collapsed.png', label: 'collapsed' },
    { source: 'outputs/shortcut.png', label: 'shortcut' },
  ]);
});

test('the host receives original absolute and relative paths for its own security validation', () => {
  assert.deepEqual(cardImages('![绝对](/private/outside/chart.png) ![相对](../../outside/chart.png)'), [
    { source: '/private/outside/chart.png', label: '绝对' },
    { source: '../../outside/chart.png', label: '相对' },
  ]);
  assert.deepEqual(cardImages('![文件](file:///workspace/chart%20one.png) ![资源](sandbox:/mnt/data/chart.png)'), [
    { source: 'file:///workspace/chart%20one.png', label: '文件' },
    { source: 'sandbox:/mnt/data/chart.png', label: '资源' },
  ]);
});

test('image extraction excludes examples, ordinary links, remote images and unsupported resources', () => {
  const text = '```md\n![示例](outputs/fenced.png)\n```\n'
    + '`![示例](outputs/inline.png)` \\![转义](outputs/escaped.png)\n'
    + '[普通链接](outputs/link.png)\n![未知][missing]\n![空]()\n'
    + '![远程](https://example.com/image.png)\n![编码远程](https&colon;//example.com/image.png)\n'
    + '![数据](data:image/png;base64,PRIVATE)\n![编码数据](data%3Aimage/png;base64,PRIVATE)\n'
    + '![伪装数据](d&#97;ta&colon;image/png;base64,PRIVATE)\n'
    + '![Blob](blob:https://example.com/PRIVATE)\n![未知协议](private:PRIVATE)\n'
    + '![资源伪装](sandbox:data:image/png;base64,PRIVATE)';
  assert.deepEqual(cardImages(text), []);
});

test('a delivery note replaces only the default local-image preview note', () => {
  const local = '![结果](/workspace/outputs/chart.png)';
  const result = cardMarkdown(local, { cwd, localImageNote: '图片已另发，可转发' });
  assert.match(result, /结果：`outputs\/chart\.png`/);
  assert.match(result, /图片已另发，可转发/);
  assert.doesNotMatch(result, fallback);
  assert.match(cardMarkdown(local, { cwd }), fallback);
  const unsupported = cardMarkdown('![数据](data:image/png;base64,PRIVATE)', { cwd, localImageNote: '图片已另发' });
  assert.doesNotMatch(unsupported, /图片已另发|PRIVATE/);
  assert.match(unsupported, /图片地址不受支持/);
});

test('extraction decodes escaped labels without changing the image destination', () => {
  assert.deepEqual(cardImages('![复核\\[1\\]](outputs/result.png)'), [
    { source: 'outputs/result.png', label: '复核[1]' },
  ]);
});
