import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareImageInput, validateImagePaths, MAX_IMAGES } from './media.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII=', 'base64');
const source = { message_id: 'source-message', conversation_id: 'source-chat' };

async function workspace(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'dws-image-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test('text messages need neither a download nor a filesystem', async () => {
  const result = await prepareImageInput({ ...source, content: '  继续检查代码  ' }, {
    cwd: '/does-not-exist', download: () => assert.fail('text must not download'),
  });
  assert.deepEqual(result, { text: '继续检查代码', imagePaths: [] });
});

test('image messages download with the exact source IDs and keep text and image order', async (t) => {
  const cwd = await workspace(t);
  const calls = [];
  const result = await prepareImageInput({ ...source,
    content: '[图片消息](mediaId=@first-image) 比较两张图 [图片消息](mediaId=$second-image)',
  }, { cwd, download: async args => {
    calls.push(args);
    await writeFile(args.at(-1), png);
  } });
  assert.equal(result.text, '比较两张图');
  assert.equal(result.imagePaths.length, 2);
  for (const [index, args] of calls.entries()) {
    assert.deepEqual(args, ['chat', 'message', 'download-media', '--type', 'mediaId', '--resource-id',
      index === 0 ? '@first-image' : '$second-image', '--message-id', 'source-message',
      '--open-conversation-id', 'source-chat', '--output', result.imagePaths[index]]);
  }
});

test('image-only messages get a prompt and repeated references download once', async (t) => {
  const cwd = await workspace(t);
  let downloads = 0;
  const result = await prepareImageInput({ ...source,
    content: '[图片消息](mediaId=@same-image)\n[图片消息](mediaId=@same-image)',
  }, { cwd, download: async args => { downloads++; await writeFile(args.at(-1), png); } });
  assert.equal(downloads, 1);
  assert.equal(result.imagePaths.length, 1);
  assert.match(result.text, /请查看本条消息附带的图片/);
});

test('invalid references, missing source IDs and too many images never download', async () => {
  const inputs = [
    { ...source, content: '[图片消息](mediaId=@invalid;value)' },
    { content: '[图片消息](mediaId=@image)' },
    { ...source, content: Array.from({ length: MAX_IMAGES + 1 }, (_, i) => `[图片消息](mediaId=@image-${i})`).join(' ') },
  ];
  for (const event of inputs) {
    await assert.rejects(prepareImageInput(event, {
      cwd: '/does-not-exist', download: () => assert.fail('invalid input must not download'),
    }));
  }
});

test('download errors stop image input without exposing CLI diagnostics', async (t) => {
  const cwd = await workspace(t);
  await assert.rejects(prepareImageInput({ ...source, content: '[图片消息](mediaId=@image)' }, {
    cwd, download: async () => { throw new Error('private diagnostic'); },
  }), error => /图片下载失败/.test(error.message) && !error.message.includes('private diagnostic'));
});

test('a success receipt without a file and a non-image payload cannot reach Codex', async (t) => {
  const cwd = await workspace(t);
  const event = { ...source, content: '[图片消息](mediaId=@image)' };
  await assert.rejects(prepareImageInput(event, { cwd, download: async () => {} }));
  await assert.rejects(prepareImageInput(event, { cwd,
    download: async args => writeFile(args.at(-1), '<html>login page</html>'),
  }), /图片格式不受支持/);
});

test('attachment paths and symlinked download directories cannot escape the workspace', async (t) => {
  const cwd = await workspace(t);
  const outside = await workspace(t);
  const root = join(cwd, 'downloads', 'dingtalk-images');
  await mkdir(root, { recursive: true });
  const outsideFile = join(outside, 'outside.png');
  await writeFile(outsideFile, png);
  const escapedFile = join(root, 'escaped.png');
  await symlink(outsideFile, escapedFile);
  await assert.rejects(validateImagePaths([outsideFile], cwd), /超出/);
  await assert.rejects(validateImagePaths([escapedFile], cwd), /超出/);
  await assert.rejects(validateImagePaths(['relative.png'], cwd), /绝对路径/);

  const linkedCwd = await workspace(t);
  await symlink(outside, join(linkedCwd, 'downloads'));
  await assert.rejects(prepareImageInput({ ...source, content: '[图片消息](mediaId=@image)' }, {
    cwd: linkedCwd, download: () => assert.fail('escaped directory must not download'),
  }), /超出/);
});
