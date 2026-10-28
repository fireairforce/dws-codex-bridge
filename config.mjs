import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function requiredText(value, field) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()
    || /[\r\n\0]/.test(value) || /<[^>]+>|REPLACE[_-]|YOUR[_-]/i.test(value)) {
    throw new TypeError(`请在配置中填写 ${field}，不能留空或使用示例占位值。`);
  }
  return value;
}

function absolutePath(value, field) {
  const path = requiredText(value, field);
  if (!isAbsolute(path)) throw new TypeError(`${field} 必须是绝对路径。`);
  return resolve(path);
}

/** Validate before any DWS subscription, model process or state write is started. */
export function validateConfig(input, configPath) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('配置必须是 JSON 对象。');
  const config = {};
  for (const field of ['profile', 'employeeUserId', 'employeeName', 'supervisorOpenId', 'groupConversationId', 'model', 'effort']) {
    config[field] = requiredText(input[field], field);
  }
  for (const field of ['dws', 'codex', 'cwd']) config[field] = absolutePath(input[field], field);
  config.stateDir = input.stateDir === undefined
    ? join(dirname(resolve(configPath)), '.state') : absolutePath(input.stateDir, 'stateDir');
  config.serviceTier = input.serviceTier ?? null;
  if (config.serviceTier !== null && config.serviceTier !== 'priority') throw new TypeError('serviceTier 只能为 null 或 priority。');
  for (const field of ['supervisorUserId', 'groupName']) {
    if (input[field] !== undefined) config[field] = requiredText(input[field], field);
  }
  for (const field of ['dwsConfigDir', 'dwsKeychainDir']) {
    if (input[field] !== undefined) config[field] = absolutePath(input[field], field);
  }
  for (const field of ['turnTimeoutMs', 'requestTimeoutMs']) {
    if (input[field] === undefined) continue;
    if (!Number.isSafeInteger(input[field]) || input[field] <= 0) throw new TypeError(`${field} 必须为正整数。`);
    config[field] = input[field];
  }
  return config;
}

export async function loadConfig({ defaultPath = fileURLToPath(new URL('./config.json', import.meta.url)), env = process.env } = {}) {
  const configPath = resolve(env.DWS_CODEX_CONFIG || defaultPath);
  let source;
  try { source = await readFile(configPath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('找不到桥接配置。请复制 config.example.json 为 config.json 并填写，或用 DWS_CODEX_CONFIG 指定配置文件。');
    throw error;
  }
  let input;
  try { input = JSON.parse(source); }
  catch { throw new Error('桥接配置不是有效的 JSON，请检查配置文件格式。'); }
  return { config: validateConfig(input, configPath), configPath };
}

export function dwsEnvironment(config, env = process.env) {
  return { ...env,
    ...(config.dwsConfigDir ? { DWS_CONFIG_DIR: config.dwsConfigDir } : {}),
    ...(config.dwsKeychainDir ? { DWS_KEYCHAIN_DIR: config.dwsKeychainDir } : {}),
  };
}

export function backgroundEnvironment(configPath, env = process.env) {
  return { ...env, DWS_CODEX_CONFIG: resolve(configPath) };
}
