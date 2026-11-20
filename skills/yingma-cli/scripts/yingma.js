#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline/promises');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const VERSION = '0.5.4';
const DEFAULT_API_BASE = 'https://api.yingma.tv';
const CANVAS_NODE_KINDS = new Set(['text', 'image', 'video', 'audio', 'script', 'frame_breakdown', 'director', 'assemble', 'group', 'subject']);

function usage() {
  return [
    'yingma ' + VERSION + ' - 小影马 Agent CLI',
    '',
    'Usage:',
    '  yingma auth login --web [--client cli|dsh|workbuddy|doubao] [--web-origin URL] [--no-open]   在网页上授权登录（推荐）',
    '  yingma auth login [--email EMAIL | --phone PHONE]',
    '  yingma auth web-start [--client cli|dsh|workbuddy|doubao] [--web-origin URL] [--open]',
    '  yingma auth web-poll --device-code-stdin',
    '  yingma auth captcha --output FILE',
    '  yingma auth request-email --email EMAIL --captcha-id ID --captcha-code CODE',
    '  yingma auth login-email --email EMAIL --code CODE',
    '  yingma auth request-sms --phone PHONE --captcha-id ID --captcha-code CODE',
    '  yingma auth login-sms --phone PHONE --code CODE',
    '  yingma auth login-password --account ACCOUNT --captcha-id ID --captcha-code CODE --password-stdin',
    '  yingma auth set-token --token-stdin',
    '  yingma auth status | logout | handoff',
    '  yingma doctor',
    '  yingma account me | balance',
    '  yingma project list | stats | create | get | use ID | current | unuse',
    '  yingma script get | save --file FILE | develop --yes',
    '  yingma scene list | yingma shot list | yingma artifact list',
    '  yingma asset generate --item ITEM_ID --yes',
    '  yingma keyframe generate --shot SHOT_ID --yes',
    '  yingma video generate --shot SHOT_ID --yes',
    '  yingma episode list | render --episode NUMBER --yes',
    '  yingma pipeline status | collab [list|claim|release|heartbeat]',
    '  yingma pipeline script-versions | delivery-plan',
    '  yingma interactive get | settings | vars | items',
    '  yingma interactive node add|patch|remove|studio|script|storyboard|assemble|bind-render|confirm',
    '  yingma interactive edge connect|disconnect',
    '  yingma interactive script save|outline-save|import|scene-add|scene-remove|chapter-add|chapter-rename|chapter-remove|confirm|reset',
    '  yingma interactive produce start|status | assets generate | export start|status|download-link',
    '  yingma download --url URL --output FILE [--project PROJECT_ID] [--force]',
    '  yingma canvas get | list | summary | create | use | view | export | import --yes',
    '  yingma canvas skill list | collab [claim|release] | session acquire|release|heartbeat',
    '  yingma canvas node list | add | move | patch | remove --yes | run --yes | generate --yes',
    '  yingma canvas node duplicate | storyboard-preview | script-patch | script-generate-nodes | media-cancel --yes',
    '  yingma canvas node list [--kind K[,K]] [--group ID] [--status S] [--edges] [--full] [--limit N --offset N]',
    '  yingma canvas edge list [--node NODE_ID] [--full] [--limit N --offset N] | remove --yes',
    '  yingma canvas connect --source NODE_ID --target NODE_ID | connect-many --links-file FILE',
    '  yingma canvas snippet apply --skill SKILL --yes',
    '  yingma canvas library character-list | character-apply | starter-apply | team-place',
    '  yingma canvas prompt translate|optimize-image|optimize-video|reverse --yes',
    '  yingma canvas video frame|reshoot|clone|trim|split|crop|hd|fps|erase|av-split|depth --id NODE_ID --yes',
    '  yingma canvas image erase --id NODE_ID --boxes JSON --yes',
    '  yingma canvas subject upload --file FILE | sheet --main-path PATH --side-paths PATHS --yes',
    '  yingma canvas director screenshot --id NODE_ID --file IMAGE --yes',
    '  yingma canvas audio edit --id NODE_ID --action trim|speed --yes',
    '  yingma canvas validate | diff --file STATE.json | node inspect --id NODE_ID',
    '  yingma mcp    (MCP stdio server for agents: DeepSeek Harness, Claude Code, Codex)',
    '',
    'Use YINGMA_TOKEN for a non-persistent CI credential. API endpoint defaults to',
    DEFAULT_API_BASE + '. Add --dry-run to preview a write request without sending it.'
  ].join('\n');
}

function parseArgs(tokens) {
  const options = {};
  const positionals = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    if (body.startsWith('no-')) {
      options[body.slice(3)] = false;
      continue;
    }
    const equals = body.indexOf('=');
    if (equals >= 0) {
      options[body.slice(0, equals)] = body.slice(equals + 1);
      continue;
    }
    const next = tokens[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      options[body] = next;
      i += 1;
    } else {
      options[body] = true;
    }
  }
  return { options, positionals };
}

function value(options, name, required) {
  const result = options[name];
  if ((result === undefined || result === true || result === '') && required) {
    throw new Error('Missing required option --' + name);
  }
  return result;
}

function bool(options, name) {
  return options[name] === true || options[name] === 'true' || options[name] === '1';
}

function numberValue(options, name, required) {
  const raw = value(options, name, required);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error('--' + name + ' must be a number');
  return parsed;
}

function readStdin() {
  return fs.readFileSync(0, 'utf8').trim();
}

function configPath() {
  return process.env.YINGMA_CONFIG || path.join(os.homedir(), '.yingma', 'config.json');
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return {};
    throw new Error('Cannot read config: ' + error.message);
  }
}

function writeConfig(next) {
  const destination = configPath();
  const directory = path.dirname(destination);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const temporary = destination + '.tmp-' + process.pid;
  fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, destination);
  fs.chmodSync(destination, 0o600);
}

function getToken() {
  if (process.env.YINGMA_TOKEN && process.env.YINGMA_TOKEN.trim()) {
    return { token: process.env.YINGMA_TOKEN.trim(), source: 'YINGMA_TOKEN' };
  }
  const config = readConfig();
  if (typeof config.access_token === 'string' && config.access_token.trim()) {
    return { token: config.access_token.trim(), source: configPath() };
  }
  return { token: '', source: '' };
}

function getApiBase() {
  const candidate = (process.env.YINGMA_API_BASE || readConfig().api_base || DEFAULT_API_BASE).replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch (_) {
    throw new Error('YINGMA_API_BASE must be a valid URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('YINGMA_API_BASE must use http or https');
  }
  return candidate;
}

// 按 parseArgs 的结果判断，--dry-run=true 和 --dry-run 后面跟值的写法也算预演；
// 只有明确写 --no-dry-run 或 --dry-run=false/0/no 才关掉。
function dryRunFromOptions(options) {
  const raw = options['dry-run'];
  if (raw === undefined || raw === false) return false;
  return !['false', '0', 'no'].includes(String(raw).trim().toLowerCase());
}

let argvOptions;
function dryRunRequested() {
  if (!argvOptions) argvOptions = parseArgs(process.argv.slice(2)).options;
  return dryRunFromOptions(argvOptions);
}

async function request(apiPath, requestOptions) {
  const settings = requestOptions || {};
  const method = settings.method || 'GET';
  const needsAuth = settings.auth !== false;
  const url = new URL(apiPath, getApiBase() + '/');
  // billable：会扣费的 GET（比如导出下载链接）也要被 --dry-run 拦下。
  const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) || settings.billable === true;
  if (dryRunRequested() && isWrite) {
    return {
      dry_run: true,
      request: {
        method: method.toUpperCase(),
        url: url.toString(),
        requires_authentication: needsAuth,
        body: settings.form === undefined ? (settings.body === undefined ? null : settings.body) : { multipart_form: true }
      }
    };
  }
  const token = getToken();
  if (needsAuth && !token.token) {
    throw new Error('Not logged in. Use yingma auth login-email, login-sms, login-password, or set YINGMA_TOKEN.');
  }
  const headers = { Accept: 'application/json' };
  if (settings.body !== undefined) headers['Content-Type'] = 'application/json';
  if (settings.headers) {
    Object.keys(settings.headers).forEach(function (key) {
      headers[key] = settings.headers[key];
    });
  }
  if (needsAuth) headers.Authorization = 'Bearer ' + token.token;
  if (process.env.YINGMA_TEAM && process.env.YINGMA_TEAM.trim()) {
    headers['X-Yingma-Team'] = process.env.YINGMA_TEAM.trim();
  }

  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, 120000);
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: settings.form !== undefined ? settings.form : (settings.body === undefined ? undefined : JSON.stringify(settings.body)),
      signal: controller.signal
    });
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('Request timed out after 120 seconds');
    throw new Error('Network request failed: ' + error.message);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  const contentType = response.headers.get('content-type') || '';
  let body = text;
  if (text && contentType.includes('application/json')) {
    try {
      body = JSON.parse(text);
    } catch (_) {}
  }
  if (response.status === 304 && settings.allow304) {
    return { status: 304, etag: response.headers.get('etag'), body: null };
  }
  if (!response.ok) {
    let detail = '';
    if (body && typeof body === 'object') detail = body.detail || body.message || JSON.stringify(body);
    else detail = String(body).slice(0, 1000);
    if (response.status === 401) detail = 'Login expired or invalid. Run a yingma auth login command.';
    throw new Error('API ' + response.status + (detail ? ': ' + detail : ''));
  }
  const projectBase = canvasBaseFromPath(apiPath);
  if (projectBase) absorbCanvasPayload(projectBase, body);
  if (settings.allow304) {
    return { status: response.status, etag: response.headers.get('etag'), body: body };
  }
  return body;
}

function print(result) {
  if (typeof result === 'string') {
    process.stdout.write(result.endsWith('\n') ? result : result + '\n');
    return;
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

async function downloadResponse(url, authenticated) {
  const headers = { Accept: '*/*' };
  if (authenticated) {
    const token = getToken();
    if (!token.token) throw new Error('Not logged in. Use a yingma auth login command or set YINGMA_TOKEN.');
    headers.Authorization = 'Bearer ' + token.token;
  }
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, 120000);
  let response;
  try {
    response = await fetch(url, { headers: headers, redirect: 'follow', signal: controller.signal });
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('Download timed out after 120 seconds');
    throw new Error('Download failed: ' + error.message);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1000);
    if (response.status === 401) throw new Error('API 401: Login expired or invalid. Run a yingma auth login command.');
    throw new Error('Download HTTP ' + response.status + (detail ? ': ' + detail : ''));
  }
  if (!response.body) throw new Error('Download response did not contain a body.');
  return response;
}

async function writeDownload(response, destination, force) {
  if (fs.existsSync(destination) && !force) {
    throw new Error('Refusing to overwrite ' + destination + '. Re-run with --force to replace it.');
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = destination + '.part-' + process.pid;
  try {
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary, { mode: 0o600 }));
    fs.renameSync(temporary, destination);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (_) {}
    throw error;
  }
  return {
    downloaded_to: destination,
    bytes: fs.statSync(destination).size,
    content_type: response.headers.get('content-type') || null
  };
}

function localProjectPath() {
  return path.join(process.cwd(), '.yingma', 'project.json');
}

function readLocalProject() {
  try {
    return JSON.parse(fs.readFileSync(localProjectPath(), 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return {};
    throw new Error('Cannot read ' + localProjectPath() + ': ' + error.message);
  }
}

function writeLocalProject(projectId) {
  const destination = localProjectPath();
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.writeFileSync(destination, JSON.stringify({ project_id: projectId }, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(destination, 0o600);
}

function removeLocalProject() {
  const destination = localProjectPath();
  try {
    fs.unlinkSync(destination);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
}

function resolveProject(options) {
  if (typeof options.project === 'string' && options.project.trim()) return options.project.trim();
  const current = readLocalProject().project_id;
  if (typeof current === 'string' && current.trim()) return current.trim();
  throw new Error('No project selected. Pass --project PROJECT_ID or run yingma project use PROJECT_ID.');
}

function requireConfirmation(options, operation) {
  if (!bool(options, 'yes')) {
    throw new Error(operation + ' requires explicit confirmation. Re-run with --yes after verifying the target.');
  }
}

function addQuery(apiPath, pairs) {
  const query = new URLSearchParams();
  for (const pair of pairs) {
    if (pair[1] !== undefined && pair[1] !== true && pair[1] !== '') query.set(pair[0], String(pair[1]));
  }
  const encoded = query.toString();
  return encoded ? apiPath + '?' + encoded : apiPath;
}

function optionBody(options, names) {
  const body = {};
  for (const name of names) {
    if (options[name] !== undefined && options[name] !== true) body[name.replace(/-/g, '_')] = options[name];
  }
  return body;
}

function jsonObjectOption(options, optionName, fileOptionName) {
  let raw;
  if (fileOptionName && options[fileOptionName] !== undefined && options[fileOptionName] !== true) {
    raw = fs.readFileSync(path.resolve(String(options[fileOptionName])), 'utf8');
  } else if (options[optionName] !== undefined && options[optionName] !== true) {
    raw = String(options[optionName]);
  } else {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('--' + (fileOptionName && options[fileOptionName] !== undefined ? fileOptionName : optionName) + ' must contain valid JSON: ' + error.message);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Canvas data must be a JSON object.');
  }
  return parsed;
}

function jsonArrayOption(options, optionName, fileOptionName) {
  let raw;
  if (fileOptionName && options[fileOptionName] !== undefined && options[fileOptionName] !== true) {
    raw = fs.readFileSync(path.resolve(String(options[fileOptionName])), 'utf8');
  } else if (options[optionName] !== undefined && options[optionName] !== true) {
    raw = String(options[optionName]);
  } else {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('--' + (fileOptionName && options[fileOptionName] !== undefined ? fileOptionName : optionName) + ' must contain valid JSON: ' + error.message);
  }
  if (!Array.isArray(parsed)) throw new Error('--' + optionName + ' must contain a JSON array.');
  return parsed;
}

function csvOption(options, name) {
  if (options[name] === undefined || options[name] === true || options[name] === '') return undefined;
  return String(options[name]).split(',').map(function (item) { return item.trim(); }).filter(Boolean);
}

function optionalString(options, name) {
  return options[name] === undefined || options[name] === true ? undefined : String(options[name]);
}

function requireCanvasNodeKind(kind) {
  if (!CANVAS_NODE_KINDS.has(kind)) {
    throw new Error('Invalid canvas node kind: ' + kind + '. Allowed kinds: ' + Array.from(CANVAS_NODE_KINDS).join(', '));
  }
  return kind;
}

function requireRange(number, name, minimum, maximum) {
  if (number < minimum || number > maximum) {
    throw new Error('--' + name + ' must be between ' + minimum + ' and ' + maximum);
  }
  return number;
}

function numericOptionBody(options, names) {
  const body = {};
  for (const name of names) {
    if (options[name] !== undefined) body[name.replace(/-/g, '_')] = numberValue(options, name, false);
  }
  return body;
}

function requireOneOf(value, optionName, choices) {
  if (!choices.includes(value)) throw new Error('--' + optionName + ' must be ' + choices.join(', ') + '.');
  return value;
}

async function authenticate(response) {
  if (response && response.dry_run) {
    print(response);
    return;
  }
  if (!response || typeof response.access_token !== 'string' || !response.access_token) {
    throw new Error('Login response did not contain an access token');
  }
  const config = readConfig();
  config.access_token = response.access_token;
  writeConfig(config);
  print({ logged_in: true, token_saved_to: configPath(), user: response.user || null });
}

function openLocalFile(filePath) {
  if (process.env.YINGMA_NO_BROWSER) return false;
  try {
    let command;
    let args;
    if (process.platform === 'darwin') {
      command = 'open'; args = [filePath];
    } else if (process.platform === 'win32') {
      command = 'cmd'; args = ['/c', 'start', '', filePath];
    } else {
      command = 'xdg-open'; args = [filePath];
    }
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', function () {});
    child.unref();
    return true;
  } catch (_) {
    return false;
  }
}

async function promptValue(terminal, label, preset) {
  if (preset !== undefined && preset !== true && String(preset).trim()) return String(preset).trim();
  const answer = await terminal.question(label);
  return String(answer || '').trim();
}

// 授权页在网页端，不在 API 域名上：api.X → X；本地 8181 → 3000；其余同源。
function getWebOrigin(options) {
  const explicit = (options && options['web-origin'] !== undefined && options['web-origin'] !== true)
    ? String(options['web-origin'])
    : (process.env.YINGMA_WEB_ORIGIN || readConfig().web_origin || '');
  let parsed;
  if (explicit) {
    try {
      parsed = new URL(explicit);
    } catch (_) {
      throw new Error('--web-origin must be a valid URL');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('--web-origin must use http or https');
    return parsed.origin;
  }
  parsed = new URL(getApiBase());
  if (parsed.hostname.startsWith('api.')) parsed.hostname = parsed.hostname.slice(4);
  else if (['localhost', '127.0.0.1'].includes(parsed.hostname) && parsed.port === '8181') parsed.port = '3000';
  return parsed.origin;
}

// 授权页按客户端显示请求方和文案；不认识的一律按命令行处理（后端同样回落）
const WEB_LOGIN_CLIENTS = ['cli', 'dsh', 'workbuddy', 'doubao'];

async function startWebLogin(options) {
  const client = WEB_LOGIN_CLIENTS.includes(options.client) ? options.client : 'cli';
  const started = await request('/api/auth/cli/requests', { method: 'POST', auth: false, body: { client: client } });
  if (!started || !started.device_code || !started.user_code) throw new Error('授权请求的响应不完整');
  const url = getWebOrigin(options) + '/cli/authorize?code=' + encodeURIComponent(started.user_code);
  return {
    device_code: started.device_code,
    user_code: started.user_code,
    verification_url: url,
    expires_in: started.expires_in,
    interval: started.interval
  };
}

// 轮询一次；批准时保存 token。返回 { status, user? }。
// user 只回 id：输出会落在终端、插件或宿主客户端日志里，手机号、余额、权限这些不该跟着走。
async function pollWebLogin(deviceCode) {
  const out = await request('/api/auth/cli/token', { method: 'POST', auth: false, body: { device_code: deviceCode } });
  if (out && out.status === 'approved') {
    if (typeof out.access_token !== 'string' || !out.access_token) throw new Error('授权响应里没有 token');
    const config = readConfig();
    config.access_token = out.access_token;
    writeConfig(config);
    return { status: 'approved', logged_in: true, token_saved_to: configPath(), user: out.user && out.user.id ? { id: out.user.id } : null };
  }
  return { status: (out && out.status) || 'expired' };
}

async function runWebLogin(options) {
  if (dryRunRequested()) {
    print({ dry_run: true, workflow: ['create authorize request', 'open browser', 'poll until approved', 'save local token'], web_origin: getWebOrigin(options), config_path: configPath() });
    return;
  }
  const started = await startWebLogin(options);
  const opened = options.open === false ? false : openLocalFile(started.verification_url);
  process.stderr.write((opened ? '已在浏览器打开' : '请在浏览器打开') + '：' + started.verification_url + '\n');
  process.stderr.write('确认码：' + started.user_code + '（核对和网页上显示的一致后点授权）\n');
  const deadline = Date.now() + (Number(started.expires_in) || 600) * 1000;
  const interval = Math.max(1, Number(started.interval) || 2) * 1000;
  while (Date.now() < deadline) {
    await new Promise(function (resolve) { setTimeout(resolve, interval); });
    const result = await pollWebLogin(started.device_code);
    if (result.status === 'approved') { print(result); return; }
    if (result.status === 'denied') throw new Error('授权被拒绝');
    if (result.status !== 'pending') throw new Error('授权请求已过期，请重新运行 yingma auth login --web');
  }
  throw new Error('授权请求已过期，请重新运行 yingma auth login --web');
}

async function runGuidedLogin(options) {
  if (dryRunRequested()) {
    print({
      dry_run: true,
      workflow: ['request captcha', 'open captcha image', 'send email/SMS code', 'verify code', 'save local token'],
      channel: options.phone ? 'sms' : 'email',
      config_path: configPath()
    });
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Guided login needs an interactive terminal. Use the request-email/login-email or request-sms/login-sms commands in automation.');
  }
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const channel = options.phone ? 'sms' : options.email ? 'email' : await promptValue(terminal, '登录方式（email/sms，默认 email）：', undefined) || 'email';
    if (!['email', 'sms'].includes(channel)) throw new Error('Login channel must be email or sms.');
    const account = channel === 'sms'
      ? await promptValue(terminal, '手机号：', options.phone)
      : await promptValue(terminal, '邮箱：', options.email);
    if (!account) throw new Error(channel === 'sms' ? 'Phone is required.' : 'Email is required.');

    const captcha = await request('/api/auth/captcha', { auth: false });
    const raw = String(captcha.image_base64 || '').replace(/^data:[^,]+,/, '');
    if (!raw || !captcha.captcha_id) throw new Error('Captcha response was incomplete.');
    const captchaPath = path.join(path.dirname(configPath()), 'captcha.png');
    fs.mkdirSync(path.dirname(captchaPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(captchaPath, Buffer.from(raw, 'base64'), { mode: 0o600 });
    const opened = openLocalFile(captchaPath);
    process.stdout.write((opened ? '已打开' : '请查看') + '图形验证码：' + captchaPath + '\n');
    const captchaCode = await promptValue(terminal, '图形验证码：', options['captcha-code']);
    if (!captchaCode) throw new Error('Captcha code is required.');

    const requestPath = channel === 'sms' ? '/api/auth/sms/send' : '/api/auth/otp/request';
    const requestBody = channel === 'sms'
      ? { phone: account, captcha_id: captcha.captcha_id, captcha_code: captchaCode }
      : { email: account, captcha_id: captcha.captcha_id, captcha_code: captchaCode };
    const sent = await request(requestPath, { method: 'POST', auth: false, body: requestBody });
    process.stdout.write(String((sent && sent.message) || '验证码已发送') + '\n');
    const code = await promptValue(terminal, channel === 'sms' ? '短信验证码：' : '邮箱验证码：', options.code);
    if (!code) throw new Error('Verification code is required.');
    const loginPath = channel === 'sms' ? '/api/auth/sms/login' : '/api/auth/otp/verify';
    const loginBody = channel === 'sms' ? { phone: account, code: code } : { email: account, code: code };
    if (optionalString(options, 'promo-code') !== undefined) loginBody.promo_code = optionalString(options, 'promo-code');
    await authenticate(await request(loginPath, { method: 'POST', auth: false, body: loginBody }));
  } finally {
    terminal.close();
  }
}

async function runAuth(action, options) {
  if (action === 'status') {
    const token = getToken();
    print({ authenticated: Boolean(token.token), credential_source: token.source || null, api_base: getApiBase() });
    return;
  }
  if (action === 'handoff') {
    // 一次性 embed 登录码：给 /embed/canvas 页面在 iframe 里换 token 用。
    print(await request('/api/auth/embed/handoff', { method: 'POST' }));
    return;
  }
  if (action === 'logout') {
    if (process.env.YINGMA_TOKEN && process.env.YINGMA_TOKEN.trim()) {
      throw new Error('YINGMA_TOKEN is set by the environment and cannot be removed by logout. Unset it in the shell or CI secret store.');
    }
    if (dryRunRequested()) {
      print({ dry_run: true, local_operation: 'auth.logout', config_path: configPath() });
      return;
    }
    const config = readConfig();
    delete config.access_token;
    writeConfig(config);
    print({ logged_out: true });
    return;
  }
  if (action === 'login') return bool(options, 'web') ? runWebLogin(options) : runGuidedLogin(options);
  if (action === 'web-start') {
    if (dryRunRequested()) {
      print({ dry_run: true, local_operation: 'auth.web-start', web_origin: getWebOrigin(options) });
      return;
    }
    const started = await startWebLogin(options);
    started.opened = bool(options, 'open') ? openLocalFile(started.verification_url) : false;
    print(started);
    return;
  }
  if (action === 'web-poll') {
    // device_code 从 stdin 读，不进进程列表
    const deviceCode = bool(options, 'device-code-stdin') ? readStdin() : '';
    if (!deviceCode) throw new Error('Pass the device code with --device-code-stdin.');
    if (dryRunRequested()) {
      print({ dry_run: true, local_operation: 'auth.web-poll', config_path: configPath() });
      return;
    }
    print(await pollWebLogin(deviceCode));
    return;
  }
  if (action === 'captcha') {
    const captcha = await request('/api/auth/captcha', { auth: false });
    if (options.output !== undefined && options.output !== true) {
      const raw = String(captcha.image_base64 || '').replace(/^data:[^,]+,/, '');
      if (!raw) throw new Error('Captcha response did not contain image data');
      fs.writeFileSync(path.resolve(String(options.output)), Buffer.from(raw, 'base64'), { mode: 0o600 });
      print({ captcha_id: captcha.captcha_id, image_written_to: path.resolve(String(options.output)) });
      return;
    }
    print(captcha);
    return;
  }
  if (action === 'request-email') {
    print(await request('/api/auth/otp/request', { method: 'POST', auth: false, body: {
      email: value(options, 'email', true),
      captcha_id: value(options, 'captcha-id', true),
      captcha_code: value(options, 'captcha-code', true)
    }}));
    return;
  }
  if (action === 'login-email') {
    const body = {
      email: value(options, 'email', true),
      code: value(options, 'code', true)
    };
    if (options['promo-code'] !== undefined && options['promo-code'] !== true) body.promo_code = String(options['promo-code']);
    await authenticate(await request('/api/auth/otp/verify', { method: 'POST', auth: false, body: body }));
    return;
  }
  if (action === 'request-sms') {
    print(await request('/api/auth/sms/send', { method: 'POST', auth: false, body: {
      phone: value(options, 'phone', true),
      captcha_id: value(options, 'captcha-id', true),
      captcha_code: value(options, 'captcha-code', true)
    }}));
    return;
  }
  if (action === 'login-sms') {
    const body = {
      phone: value(options, 'phone', true),
      code: value(options, 'code', true)
    };
    if (options['promo-code'] !== undefined && options['promo-code'] !== true) body.promo_code = String(options['promo-code']);
    await authenticate(await request('/api/auth/sms/login', { method: 'POST', auth: false, body: body }));
    return;
  }
  if (action === 'login-password') {
    let password = options.password;
    if (bool(options, 'password-stdin')) password = readStdin();
    if (!password || password === true) throw new Error('Pass a password with --password-stdin or --password.');
    if (options.password !== undefined) process.stderr.write('Warning: --password may be retained in shell history. Prefer --password-stdin.\n');
    await authenticate(await request('/api/auth/password/login', { method: 'POST', auth: false, body: {
      account: value(options, 'account', true),
      password: password,
      captcha_id: value(options, 'captcha-id', true),
      captcha_code: value(options, 'captcha-code', true)
    }}));
    return;
  }
  if (action === 'set-token') {
    if (dryRunRequested()) {
      print({ dry_run: true, local_operation: 'auth.set-token', config_path: configPath() });
      return;
    }
    let token = options.token;
    if (bool(options, 'token-stdin')) token = readStdin();
    if (!token || token === true) throw new Error('Pass a token with --token-stdin or --token.');
    if (options.token !== undefined) process.stderr.write('Warning: --token may be retained in shell history. Prefer --token-stdin.\n');
    const config = readConfig();
    config.access_token = String(token).trim();
    writeConfig(config);
    print({ token_saved_to: configPath() });
    return;
  }
  throw new Error('Unknown auth command: ' + (action || ''));
}

function runDoctor() {
  const token = getToken();
  const local = readLocalProject();
  const config = configPath();
  const projectState = localProjectPath();
  print({
    cli: {
      version: VERSION,
      executable: process.argv[1],
      node: process.version
    },
    api_base: getApiBase(),
    authentication: {
      authenticated: Boolean(token.token),
      credential_source: token.source || null,
      config_path: config,
      config_present: fs.existsSync(config)
    },
    working_directory: {
      path: process.cwd(),
      project_id: local.project_id || null,
      project_state: projectState,
      project_selected: Boolean(local.project_id)
    },
    next_step: token.token
      ? (local.project_id ? 'Run yingma canvas summary to inspect the selected project.' : 'Run yingma project list, then yingma project use PROJECT_ID.')
      : 'Run yingma auth captcha, then complete an email or SMS login.'
  });
}

async function runProject(action, options, positionals) {
  if (action === 'list') {
    print(await request(addQuery('/api/projects', [
      ['limit', options.limit],
      ['offset', options.offset],
      ['q', options.query],
      ['status', options.status],
      ['sort', options.sort],
      ['scope', options.scope]
    ])));
    return;
  }
  if (action === 'stats') {
    print(await request('/api/projects/stats'));
    return;
  }
  if (action === 'create') {
    const body = {
      title: options.title === undefined ? '未命名项目' : String(options.title),
      raw_input: options.idea === undefined ? '' : String(options.idea),
      entry_mode: options.mode === undefined ? 'has_idea' : String(options.mode),
      kind: options.kind === undefined ? 'pipeline' : String(options.kind),
      content_locale: options.locale === undefined ? 'zh' : String(options.locale)
    };
    if (options['team-id'] !== undefined) body.team_id = String(options['team-id']);
    const created = await request('/api/projects', { method: 'POST', body: body });
    if (bool(options, 'use') && created && created.id) writeLocalProject(created.id);
    print(created);
    return;
  }
  if (action === 'use') {
    const projectId = positionals[0] || value(options, 'project', true);
    if (dryRunRequested()) {
      print({ dry_run: true, local_operation: 'project.use', project_id: String(projectId), local_state: localProjectPath() });
      return;
    }
    const project = await request('/api/projects/' + encodeURIComponent(String(projectId)));
    writeLocalProject(String(projectId));
    print({
      project_id: String(projectId),
      title: project && project.title ? project.title : null,
      selected_in: localProjectPath()
    });
    return;
  }
  if (action === 'unuse') {
    if (dryRunRequested()) {
      print({ dry_run: true, local_operation: 'project.unuse', local_state: localProjectPath() });
      return;
    }
    removeLocalProject();
    print({ project_selected: false, local_state: localProjectPath() });
    return;
  }
  if (action === 'current') {
    const current = readLocalProject();
    if (!current.project_id) throw new Error('No project is selected in this directory.');
    print({ project_id: current.project_id, local_state: localProjectPath() });
    return;
  }
  if (action === 'get') {
    print(await request('/api/projects/' + encodeURIComponent(resolveProject(options))));
    return;
  }
  throw new Error('Unknown project command: ' + (action || ''));
}

async function runScript(action, options) {
  const projectId = resolveProject(options);
  if (action === 'get') {
    print(await request('/api/projects/' + encodeURIComponent(projectId) + '/content/script'));
    return;
  }
  if (action === 'save') {
    let draft = options.text;
    if (options.file !== undefined && options.file !== true) {
      draft = fs.readFileSync(path.resolve(String(options.file)), 'utf8');
    }
    if (draft === undefined || draft === true) throw new Error('Provide --file FILE or --text TEXT.');
    const body = { script_draft: String(draft) };
    if (options.title !== undefined && options.title !== true) body.title = String(options.title);
    print(await request('/api/projects/' + encodeURIComponent(projectId) + '/script', { method: 'PUT', body: body }));
    return;
  }
  if (action === 'develop') {
    requireConfirmation(options, 'Script development');
    const body = { action: options.action === undefined ? 'start' : String(options.action), confirm_full_generate: true };
    if (options.feedback !== undefined && options.feedback !== true) body.feedback = String(options.feedback);
    if (options.file !== undefined && options.file !== true) body.script_draft = fs.readFileSync(path.resolve(String(options.file)), 'utf8');
    print(await request('/api/projects/' + encodeURIComponent(projectId) + '/develop-script', { method: 'POST', body: body }));
    return;
  }
  throw new Error('Unknown script command: ' + (action || ''));
}

async function runProjectRead(area, action, options) {
  const projectId = resolveProject(options);
  const base = '/api/projects/' + encodeURIComponent(projectId);
  if (area === 'scene' && action === 'list') {
    print(await request(base + '/scenes'));
    return;
  }
  if (area === 'shot' && action === 'list') {
    print(await request(base + '/shots/manifest'));
    return;
  }
  if (area === 'artifact' && action === 'list') {
    print(await request(base + '/artifacts'));
    return;
  }
  throw new Error('Unknown ' + area + ' command: ' + (action || ''));
}

async function runGeneration(area, action, options) {
  if (action !== 'generate') throw new Error('Unknown ' + area + ' command: ' + (action || ''));
  requireConfirmation(options, area + ' generation');
  const projectId = resolveProject(options);
  const base = '/api/projects/' + encodeURIComponent(projectId);
  if (area === 'asset') {
    const body = { item_id: value(options, 'item', true) };
    const count = numberValue(options, 'count', false);
    if (count !== undefined) body.count = count;
    for (const key of ['aspect', 'resolution']) if (options[key] !== undefined && options[key] !== true) body[key] = String(options[key]);
    if (options.model !== undefined && options.model !== true) body.image_model = String(options.model);
    if (bool(options, 'auto-select')) body.auto_select = true;
    print(await request(base + '/reference-assets/generate-item', { method: 'POST', body: body }));
    return;
  }
  const shotId = value(options, 'shot', true);
  const body = { shot_id: shotId };
  const count = numberValue(options, 'count', false);
  if (count !== undefined) body.count = count;
  if (bool(options, 'force')) body.force = true;
  if (bool(options, 'allow-incomplete-refs')) body.allow_incomplete_refs = true;
  const endpoint = area === 'keyframe' ? '/keyframes/generate' : '/videos/generate';
  print(await request(base + '/shots/' + encodeURIComponent(shotId) + endpoint, { method: 'POST', body: body }));
}

async function runEpisode(action, options) {
  const projectId = resolveProject(options);
  const base = '/api/projects/' + encodeURIComponent(projectId);
  if (action === 'list') {
    print(await request(base + '/episodes'));
    return;
  }
  if (action === 'render') {
    requireConfirmation(options, 'Episode render');
    const episode = numberValue(options, 'episode', true);
    const body = {};
    for (const name of ['end-freeze-outro', 'prev-episode-recap', 'include-bgm']) {
      if (options[name] !== undefined) body[name.replace(/-/g, '_')] = bool(options, name);
    }
    if (options['prev-episode-recap-sec'] !== undefined) body.prev_episode_recap_sec = numberValue(options, 'prev-episode-recap-sec', false);
    print(await request(base + '/episodes/' + encodeURIComponent(String(episode)) + '/render', { method: 'POST', body: body }));
    return;
  }
  throw new Error('Unknown episode command: ' + (action || ''));
}

async function runPipeline(action, options, positionals) {
  const projectId = resolveProject(options);
  const base = '/api/projects/' + encodeURIComponent(projectId);
  if (action === 'status') {
    print(await request(base + '/state'));
    return;
  }
  if (action === 'script-versions') {
    print(await request(base + '/script-versions'));
    return;
  }
  if (action === 'delivery-plan') {
    print(await request(base + '/delivery-plan'));
    return;
  }
  if (action === 'collab') {
    const command = positionals[0] || 'list';
    if (command === 'list') {
      print(await request(base + '/pipeline/collab'));
      return;
    }
    if (!['claim', 'release', 'heartbeat'].includes(command)) {
      throw new Error('Pipeline collab command must be list, claim, release, or heartbeat.');
    }
    requireConfirmation(options, 'Pipeline collaboration change');
    const body = {};
    if (optionalString(options, 'kind') !== undefined) body.kind = optionalString(options, 'kind');
    if (optionalString(options, 'id') !== undefined) body.id = optionalString(options, 'id');
    if (command === 'claim' && (!body.kind || !body.id)) throw new Error('Pipeline claim requires --kind KIND --id ID.');
    print(await request(base + '/pipeline/collab/' + command, { method: 'POST', body: body }));
    return;
  }
  throw new Error('Unknown pipeline command: ' + (action || ''));
}

function interactiveText(options) {
  if (options.file !== undefined && options.file !== true) return fs.readFileSync(path.resolve(String(options.file)), 'utf8');
  if (options.text !== undefined && options.text !== true) return String(options.text);
  throw new Error('Provide --file FILE or --text TEXT.');
}

async function runInteractiveNode(base, action, options) {
  const nodeId = action === 'add' ? '' : String(value(options, 'id', true));
  if (action === 'add') {
    requireConfirmation(options, 'Interactive node creation');
    const body = {
      type: optionalString(options, 'type') || 'video',
      x: numberValue(options, 'x', false) || 0,
      y: numberValue(options, 'y', false) || 0,
      title: optionalString(options, 'title') || '',
      after: optionalString(options, 'after') || ''
    };
    print(await request(base + '/nodes', { method: 'POST', body: body }));
    return;
  }
  if (action === 'patch') {
    requireConfirmation(options, 'Interactive node patch');
    const body = jsonObjectOption(options, 'data', 'file');
    print(await request(base + '/nodes/' + encodeURIComponent(nodeId), { method: 'PATCH', body: body }));
    return;
  }
  if (action === 'remove') {
    requireConfirmation(options, 'Interactive node removal');
    print(await request(base + '/nodes/' + encodeURIComponent(nodeId), { method: 'DELETE' }));
    return;
  }
  if (action === 'studio') {
    print(await request(base + '/nodes/' + encodeURIComponent(nodeId) + '/studio'));
    return;
  }
  if (action === 'script') {
    requireConfirmation(options, 'Interactive node script update');
    print(await request(base + '/nodes/' + encodeURIComponent(nodeId) + '/script', { method: 'PUT', body: { text: interactiveText(options) } }));
    return;
  }
  if (['storyboard', 'assemble', 'bind-render', 'confirm'].includes(action)) {
    requireConfirmation(options, 'Interactive node ' + action);
    const body = action === 'confirm' && optionalString(options, 'source') !== undefined ? { source: optionalString(options, 'source') } : {};
    print(await request(base + '/nodes/' + encodeURIComponent(nodeId) + '/' + action, { method: 'POST', body: body }));
    return;
  }
  throw new Error('Unknown interactive node command: ' + (action || ''));
}

async function runInteractiveScript(base, action, options) {
  const writes = ['save', 'outline-save', 'import', 'scene-add', 'scene-remove', 'chapter-add', 'chapter-rename', 'chapter-remove', 'confirm', 'reset', 'pending-confirm', 'pending-discard', 'pending-revert', 'undo'];
  if (!writes.includes(action)) throw new Error('Unknown interactive script command: ' + (action || ''));
  requireConfirmation(options, 'Interactive script ' + action);
  let endpoint = '';
  let method = 'POST';
  let body = {};
  if (action === 'save' || action === 'outline-save') {
    endpoint = action === 'save' ? '/script' : '/script/outline'; method = 'PUT'; body = { text: interactiveText(options) };
  } else if (action === 'import') {
    endpoint = '/script/import'; body = { text: interactiveText(options) };
  } else if (action === 'scene-add') {
    endpoint = '/script/scenes';
    body = { title: optionalString(options, 'title') || '', outline_detail: optionalString(options, 'outline') || '', script_body: optionalString(options, 'body') || '', after_scene_id: optionalString(options, 'after') || '', chapter_id: optionalString(options, 'chapter') || '', at_start: bool(options, 'at-start') };
  } else if (action === 'scene-remove') {
    endpoint = '/script/scenes/' + encodeURIComponent(String(value(options, 'id', true))); method = 'DELETE';
  } else if (action === 'chapter-add') {
    endpoint = '/script/chapters'; body = { title: value(options, 'title', true) };
  } else if (action === 'chapter-rename') {
    endpoint = '/script/chapters/' + encodeURIComponent(String(value(options, 'id', true))); method = 'PATCH'; body = { title: value(options, 'title', true) };
  } else if (action === 'chapter-remove') {
    endpoint = '/script/chapters/' + encodeURIComponent(String(value(options, 'id', true))); method = 'DELETE';
  } else if (action === 'confirm') {
    endpoint = '/script/confirm';
    if (options.file !== undefined && options.file !== true) body.seed_graph = JSON.parse(fs.readFileSync(path.resolve(String(options.file)), 'utf8'));
  } else if (action === 'reset') endpoint = '/script/reset';
  else if (action === 'pending-confirm') endpoint = '/script/pending-edits/confirm';
  else if (action === 'pending-discard') endpoint = '/script/pending-edits/discard';
  else if (action === 'pending-revert') { endpoint = '/script/pending-edits/revert-to'; body = { round_id: value(options, 'round', true) }; }
  else if (action === 'undo') endpoint = '/script/undo-last-agent';
  print(await request(base + endpoint, { method: method, body: body }));
}

async function runInteractive(action, options, positionals) {
  const projectId = resolveProject(options);
  const base = '/api/projects/' + encodeURIComponent(projectId) + '/interactive';
  if (action === 'get') return print(await request(base));
  if (action === 'settings' || action === 'vars' || action === 'items') {
    requireConfirmation(options, 'Interactive ' + action + ' update');
    const data = jsonObjectOption(options, 'data', 'file');
    if (!data) throw new Error('Interactive ' + action + ' requires --data JSON or --file FILE.');
    if (action === 'items' && !Array.isArray(data.items)) throw new Error('Interactive items data must contain an items array.');
    const body = action === 'vars' && !Object.hasOwn(data, 'vars') ? { vars: data } : data;
    print(await request(base + '/' + action, { method: 'PATCH', body: body }));
    return;
  }
  if (action === 'node') return runInteractiveNode(base, positionals[0], options);
  if (action === 'edge') {
    const command = positionals[0];
    if (!['connect', 'disconnect'].includes(command)) throw new Error('Interactive edge command must be connect or disconnect.');
    requireConfirmation(options, 'Interactive edge ' + command);
    const body = { source: value(options, 'source', true), target: value(options, 'target', true), label: optionalString(options, 'label') || '', choice_id: optionalString(options, 'choice') || '' };
    print(await request(base + (command === 'connect' ? '/edges' : '/edges/disconnect'), { method: 'POST', body: body }));
    return;
  }
  if (action === 'script') return runInteractiveScript(base, positionals[0], options);
  if (action === 'produce') {
    const command = positionals[0];
    if (command === 'status') return print(await request(base + '/produce/status'));
    if (command === 'start') { requireConfirmation(options, 'Interactive production'); return print(await request(base + '/produce/start', { method: 'POST', body: {} })); }
    throw new Error('Interactive produce command must be start or status.');
  }
  if (action === 'assets' && positionals[0] === 'generate') {
    requireConfirmation(options, 'Interactive asset generation');
    const body = options.file !== undefined && options.file !== true ? { seed: JSON.parse(fs.readFileSync(path.resolve(String(options.file)), 'utf8')) } : {};
    print(await request(base + '/assets/generate', { method: 'POST', body: body })); return;
  }
  if (action === 'export') {
    const command = positionals[0];
    if (command === 'status') return print(await request(base + '/export/status'));
    if (command === 'start') { requireConfirmation(options, 'Interactive export'); return print(await request(base + '/export', { method: 'POST', body: {} })); }
    if (command === 'download-link') { requireConfirmation(options, 'Interactive export download charge'); return print(await request(base + '/export/download', { billable: true })); }
    throw new Error('Interactive export command must be start, status, or download-link.');
  }
  throw new Error('Unknown interactive command: ' + (action || ''));
}

async function runDownload(options) {
  const rawUrl = String(value(options, 'url', true));
  const destination = path.resolve(String(value(options, 'output', true)));
  let source;
  try {
    source = new URL(rawUrl, getApiBase() + '/');
  } catch (_) {
    throw new Error('--url must be an absolute URL or a /storage/... path.');
  }
  if (!['http:', 'https:'].includes(source.protocol)) throw new Error('--url must use http or https.');
  if (dryRunRequested()) {
    print({
      dry_run: true,
      download: {
        source: source.toString(),
        output: destination,
        overwrite: bool(options, 'force'),
        credential_will_be_sent: source.origin === new URL(getApiBase()).origin
      }
    });
    return;
  }

  const api = new URL(getApiBase());
  let downloadUrl = source;
  let authenticated = source.origin === api.origin;
  if (!authenticated) {
    const projectId = resolveProject(options);
    const signed = await request(addQuery(
      '/api/projects/' + encodeURIComponent(projectId) + '/storage/cdn-download',
      [['url', source.toString()], ['filename', path.basename(destination)]]
    ));
    if (!signed || typeof signed.url !== 'string' || !signed.url) {
      throw new Error('CDN download endpoint did not return a signed URL.');
    }
    downloadUrl = new URL(signed.url);
    authenticated = false;
  } else if (!source.pathname.startsWith('/storage/') && !source.pathname.startsWith('/api/')) {
    throw new Error('Same-origin downloads must use a /storage/... or /api/... URL.');
  }
  print(await writeDownload(await downloadResponse(downloadUrl, authenticated), destination, bool(options, 'force')));
}

function canvasCachePath(base) {
  const crypto = require('node:crypto');
  const team = (process.env.YINGMA_TEAM || '').trim();
  const material = team
    ? getApiBase() + '\n' + String(base) + '\n' + team
    : getApiBase() + '\n' + String(base);
  const key = crypto.createHash('sha256').update(material).digest('hex');
  return path.join(path.dirname(configPath()), 'canvas-cache', key + '.json');
}

function canvasBaseFromPath(apiPath) {
  const match = /\/api\/projects\/[^/?#]+/.exec(String(apiPath || ''));
  return match ? match[0] : '';
}

function looksLikeCanvasState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || state.partial === true) return false;
  if (!Number.isInteger(Number(state.rev)) || !Array.isArray(state.canvases)) return false;
  return state.canvases.every(function (canvas) {
    return canvas && typeof canvas === 'object' && Array.isArray(canvas.nodes) && Array.isArray(canvas.edges);
  });
}

function absorbCanvasPayload(base, payload) {
  if (!payload || typeof payload !== 'object' || payload.partial === true || payload.dry_run) return;
  const state = looksLikeCanvasState(payload)
    ? payload
    : (payload.graph && looksLikeCanvasState(payload.graph) ? payload.graph : null);
  if (!state) return;
  const cached = readCanvasCache(base);
  const nextRev = Number(state.rev);
  const prevRev = cached && cached.state ? Number(cached.state.rev) : -1;
  if (Number.isInteger(prevRev) && nextRev < prevRev) return;
  writeCanvasCache(base, state, canvasEtag(base, nextRev));
}

function readCanvasCache(base) {
  try {
    const parsed = JSON.parse(fs.readFileSync(canvasCachePath(base), 'utf8'));
    if (!parsed || !parsed.state || !Array.isArray(parsed.state.canvases)) return null;
    return parsed;
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    return null;
  }
}

function canvasProjectId(base) {
  const match = /\/api\/projects\/([^/?#]+)/.exec(String(base || ''));
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch (error) {
    return match[1];
  }
}

function canvasEtag(base, rev) {
  const projectId = canvasProjectId(base);
  const number = Number(rev);
  if (!projectId || !Number.isInteger(number) || number < 0) return '';
  return '"' + projectId + ':' + number + '"';
}

function writeCanvasCache(base, state, etag) {
  const destination = canvasCachePath(base);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = destination + '.tmp-' + process.pid;
  const stored = etag || canvasEtag(base, state && state.rev);
  fs.writeFileSync(temporary, JSON.stringify({ etag: stored, state: state }) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, destination);
}

function forgetCanvasCache(base) {
  try {
    fs.unlinkSync(canvasCachePath(base));
  } catch (error) {
    if (!error || error.code !== 'ENOENT') return;
  }
}

function applyCanvasDelta(baseState, delta) {
  if (!delta || Number(baseState.rev) !== delta.since || !delta.state || !Array.isArray(delta.state.canvases)) {
    return null;
  }
  function mergeList(prev, change) {
    if (!change || typeof change !== 'object' || Array.isArray(change)) return null;
    if (!Array.isArray(change.upsert) || (change.ids !== null && !Array.isArray(change.ids))) return null;
    const up = new Map();
    for (const item of change.upsert) {
      if (!item || item.id === undefined || item.id === null) return null;
      up.set(String(item.id), item);
    }
    if (up.size !== change.upsert.length) return null;
    if (change.ids && new Set(change.ids.map(String)).size !== change.ids.length) return null;
    const byId = new Map();
    if (Array.isArray(prev)) {
      for (const item of prev) {
        if (!item || item.id === undefined || item.id === null) return null;
        const id = String(item.id);
        if (byId.has(id)) return null;
        byId.set(id, item);
      }
    }
    let used = 0;
    const out = [];
    if (change.ids) {
      for (const rawId of change.ids) {
        const id = String(rawId);
        const fresh = up.get(id);
        const item = fresh || byId.get(id);
        if (!item) return null;
        if (fresh) used += 1;
        out.push(item);
      }
    } else {
      if (!Array.isArray(prev)) return null;
      for (const item of prev) {
        const fresh = up.get(String(item.id));
        if (fresh) used += 1;
        out.push(fresh || item);
      }
    }
    return used === up.size ? out : null;
  }
  const docs = new Map();
  for (const canvas of baseState.canvases) {
    if (docs.has(canvas.id)) return null;
    docs.set(canvas.id, canvas);
  }
  const canvases = [];
  const seen = new Set();
  for (const raw of delta.state.canvases) {
    const id = String(raw && raw.id);
    if (!raw || seen.has(id) || !Object.prototype.hasOwnProperty.call(raw, 'nodes') || !Object.prototype.hasOwnProperty.call(raw, 'edges')) {
      return null;
    }
    seen.add(id);
    const prev = docs.get(id) || {};
    const doc = {};
    for (const key of Object.keys(raw)) {
      if (key === 'nodes' || key === 'edges') {
        const merged = mergeList(prev[key], raw[key]);
        if (!merged) return null;
        doc[key] = merged;
      } else {
        doc[key] = raw[key];
      }
    }
    canvases.push(doc);
  }
  for (const id of docs.keys()) {
    if (!seen.has(id)) return null;
  }
  const out = {};
  for (const key of Object.keys(delta.state)) out[key] = key === 'canvases' ? canvases : delta.state[key];
  return out;
}

function mergePartialCanvas(baseState, partial) {
  if (!partial || partial.partial !== true || !Array.isArray(partial.canvases)) return null;
  if (!Number.isInteger(partial.rev) || partial.rev < Number(baseState.rev || 0)) return null;
  const next = JSON.parse(JSON.stringify(baseState));
  next.rev = partial.rev;
  if (partial.active_canvas_id) next.active_canvas_id = partial.active_canvas_id;
  if (partial.view_mode) next.view_mode = partial.view_mode;
  for (const doc of partial.canvases) {
    let canvas = (next.canvases || []).find(function (item) { return item.id === doc.id; });
    if (!canvas) {
      canvas = { id: doc.id, name: doc.name || '画布', nodes: [], edges: [], viewport: doc.viewport || { x: 0, y: 0, zoom: 1 } };
      next.canvases.push(canvas);
    }
    if (doc.name) canvas.name = doc.name;
    if (doc.viewport) canvas.viewport = doc.viewport;
    const dropNodes = new Set(doc.remove_node_ids || []);
    if (dropNodes.size) canvas.nodes = (canvas.nodes || []).filter(function (node) { return !dropNodes.has(node.id); });
    const dropEdges = new Set(doc.remove_edge_ids || []);
    if (dropEdges.size) canvas.edges = (canvas.edges || []).filter(function (edge) { return !dropEdges.has(edge.id); });
    for (const node of doc.nodes || []) {
      const index = (canvas.nodes || []).findIndex(function (item) { return item.id === node.id; });
      if (index >= 0) canvas.nodes[index] = node;
      else canvas.nodes.push(node);
    }
    for (const edge of doc.edges || []) {
      const index = (canvas.edges || []).findIndex(function (item) { return item.id === edge.id; });
      if (index >= 0) canvas.edges[index] = edge;
      else canvas.edges.push(edge);
    }
  }
  return next;
}

function partialRemovesNodes(partial) {
  return (partial.canvases || []).some(function (doc) {
    return doc && Array.isArray(doc.remove_node_ids) && doc.remove_node_ids.length > 0;
  });
}

async function getCanvasState(base, attempt) {
  const cached = attempt ? null : readCanvasCache(base);
  const rev = cached && Number.isInteger(Number(cached.state.rev)) ? Number(cached.state.rev) : null;
  const headers = {};
  let apiPath = base + '/canvas';
  if (cached && rev !== null && rev > 0) {
    apiPath += '?since=' + encodeURIComponent(String(rev));
    const match = cached.etag || canvasEtag(base, rev);
    if (match) headers['If-None-Match'] = match;
  }
  const response = await request(apiPath, { allow304: true, headers: headers });
  if (response && response.status === 304 && cached) return cached.state;
  const body = response && Object.prototype.hasOwnProperty.call(response, 'status') && Object.prototype.hasOwnProperty.call(response, 'body')
    ? response.body
    : response;
  const etag = response && response.etag ? response.etag : '';
  if (body && body.canvas_delta && cached) {
    const merged = applyCanvasDelta(cached.state, body.canvas_delta);
    if (merged) {
      writeCanvasCache(base, merged, etag || canvasEtag(base, merged.rev));
      return merged;
    }
    forgetCanvasCache(base);
    if (attempt) throw new Error('Canvas changes could not be merged into the local copy.');
    return getCanvasState(base, 1);
  }
  if (body && Array.isArray(body.canvases)) {
    writeCanvasCache(base, body, etag || canvasEtag(base, body.rev));
    return body;
  }
  throw new Error('Canvas response was not a canvas state.');
}

async function patchCanvas(base, body) {
  const cached = readCanvasCache(base);
  const sentRev = Number((body && body.rev) || 0);
  const cacheRev = cached && cached.state ? Number(cached.state.rev) : NaN;
  const cacheMatches = Number.isInteger(cacheRev) && cacheRev === sentRev;
  const result = await request(base + '/canvas', {
    method: 'PATCH',
    body: body,
    headers: cacheMatches ? { 'X-Canvas-Partial': '1' } : {}
  });
  if (result && result.dry_run) return result;
  if (result && result.partial === true) {
    const nextRev = Number(result.rev);
    if (
      cacheMatches
      && !partialRemovesNodes(result)
      && Number.isInteger(nextRev)
      && nextRev >= sentRev
      && nextRev <= sentRev + 1
    ) {
      const merged = mergePartialCanvas(cached.state, result);
      if (merged) {
        writeCanvasCache(base, merged, canvasEtag(base, merged.rev));
        return merged;
      }
    }
    return getCanvasState(base);
  }
  if (result && result.partial !== true && Array.isArray(result.canvases)) {
    writeCanvasCache(base, result, canvasEtag(base, result.rev));
  }
  return result;
}

function readCanvasStateFile(fileName) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.resolve(String(fileName)), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.canvases)) {
      throw new Error('missing canvases array');
    }
    return parsed;
  } catch (error) {
    throw new Error('Cannot read canvas state file: ' + error.message);
  }
}

function validateCanvasState(state) {
  const errors = [];
  const warnings = [];
  const canvasIds = new Set();
  const stats = { canvases: 0, nodes: 0, edges: 0 };
  if (!state || !Array.isArray(state.canvases)) {
    return { valid: false, errors: ['Canvas state is missing a canvases array.'], warnings: [], stats: stats };
  }
  for (const canvas of state.canvases) {
    stats.canvases += 1;
    const canvasId = String(canvas && canvas.id || '').trim();
    if (!canvasId) {
      errors.push('A canvas is missing id.');
      continue;
    }
    if (canvasIds.has(canvasId)) errors.push('Duplicate canvas id: ' + canvasId);
    canvasIds.add(canvasId);
    const nodeIds = new Set();
    const edgeIds = new Set();
    const nodes = Array.isArray(canvas.nodes) ? canvas.nodes : [];
    const edges = Array.isArray(canvas.edges) ? canvas.edges : [];
    stats.nodes += nodes.length;
    stats.edges += edges.length;
    for (const node of nodes) {
      const nodeId = String(node && node.id || '').trim();
      if (!nodeId) {
        errors.push('Canvas ' + canvasId + ' has a node without id.');
        continue;
      }
      if (nodeIds.has(nodeId)) errors.push('Canvas ' + canvasId + ' has duplicate node id: ' + nodeId);
      nodeIds.add(nodeId);
      if (!CANVAS_NODE_KINDS.has(node.kind)) errors.push('Canvas ' + canvasId + ' node ' + nodeId + ' has invalid kind: ' + node.kind);
      if (node.data !== undefined && (!node.data || typeof node.data !== 'object' || Array.isArray(node.data))) {
        warnings.push('Canvas ' + canvasId + ' node ' + nodeId + ' data is not an object.');
      }
    }
    for (const edge of edges) {
      const edgeId = String(edge && edge.id || '').trim();
      if (!edgeId) {
        errors.push('Canvas ' + canvasId + ' has an edge without id.');
        continue;
      }
      if (edgeIds.has(edgeId)) errors.push('Canvas ' + canvasId + ' has duplicate edge id: ' + edgeId);
      edgeIds.add(edgeId);
      if (!nodeIds.has(edge.source)) errors.push('Canvas ' + canvasId + ' edge ' + edgeId + ' source does not exist: ' + edge.source);
      if (!nodeIds.has(edge.target)) errors.push('Canvas ' + canvasId + ' edge ' + edgeId + ' target does not exist: ' + edge.target);
      if (edge.source === edge.target) warnings.push('Canvas ' + canvasId + ' edge ' + edgeId + ' is a self-loop.');
    }
  }
  if (state.active_canvas_id && !canvasIds.has(state.active_canvas_id)) {
    errors.push('active_canvas_id does not match a canvas: ' + state.active_canvas_id);
  }
  return { valid: errors.length === 0, errors: errors, warnings: warnings, stats: stats };
}

function diffCanvasState(remote, candidate) {
  const remoteCanvases = new Map((remote.canvases || []).map(function (item) { return [item.id, item]; }));
  const candidateCanvases = new Map((candidate.canvases || []).map(function (item) { return [item.id, item]; }));
  const result = { remote_rev: remote.rev, active_canvas_id: { remote: remote.active_canvas_id || '', candidate: candidate.active_canvas_id || '' }, canvases_to_add: [], canvases_to_remove: [], canvases: [] };
  for (const id of candidateCanvases.keys()) if (!remoteCanvases.has(id)) result.canvases_to_add.push(id);
  for (const id of remoteCanvases.keys()) if (!candidateCanvases.has(id)) result.canvases_to_remove.push(id);
  for (const id of candidateCanvases.keys()) {
    if (!remoteCanvases.has(id)) continue;
    const before = remoteCanvases.get(id);
    const after = candidateCanvases.get(id);
    const beforeNodes = new Set((before.nodes || []).map(function (item) { return item.id; }));
    const afterNodes = new Set((after.nodes || []).map(function (item) { return item.id; }));
    const beforeEdges = new Set((before.edges || []).map(function (item) { return item.id; }));
    const afterEdges = new Set((after.edges || []).map(function (item) { return item.id; }));
    const comparison = {
      id: id,
      renamed: String(before.name || '') !== String(after.name || ''),
      nodes_to_add: Array.from(afterNodes).filter(function (nodeId) { return !beforeNodes.has(nodeId); }),
      nodes_to_remove: Array.from(beforeNodes).filter(function (nodeId) { return !afterNodes.has(nodeId); }),
      edges_to_add: Array.from(afterEdges).filter(function (edgeId) { return !beforeEdges.has(edgeId); }),
      edges_to_remove: Array.from(beforeEdges).filter(function (edgeId) { return !afterEdges.has(edgeId); })
    };
    if (comparison.renamed || comparison.nodes_to_add.length || comparison.nodes_to_remove.length || comparison.edges_to_add.length || comparison.edges_to_remove.length) {
      result.canvases.push(comparison);
    }
  }
  return result;
}

async function resolveCanvas(base, options, readForDryRun) {
  const suppliedCanvasId = optionalString(options, 'canvas');
  if (dryRunRequested()) {
    if (!suppliedCanvasId) {
      throw new Error('--dry-run for a canvas-scoped command requires --canvas CANVAS_ID because the active canvas is not read.');
    }
    if (!readForDryRun) return {
      state: { active_canvas_id: suppliedCanvasId, canvases: [] },
      id: suppliedCanvasId,
      canvas: { id: suppliedCanvasId, name: '(dry-run)', nodes: [], edges: [] }
    };
  }
  const state = await getCanvasState(base);
  const canvasId = suppliedCanvasId || state.active_canvas_id;
  if (!canvasId) throw new Error('This project does not have an active canvas. Create one with yingma canvas create.');
  const canvas = Array.isArray(state.canvases) ? state.canvases.find(function (item) { return item.id === canvasId; }) : null;
  if (!canvas) throw new Error('Canvas not found: ' + canvasId);
  return { state: state, id: canvasId, canvas: canvas };
}

async function uploadCanvasFile(base, fileName, options) {
  const absolute = path.resolve(fileName);
  const bytes = fs.readFileSync(absolute);
  const form = new FormData();
  form.append('file', new Blob([bytes]), path.basename(absolute));
  return request(addQuery(base + '/canvas/upload', [
    ['kind', optionalString(options || {}, 'kind') || 'image'],
    ['target_node_id', optionalString(options || {}, 'target')],
    ['x', options && options.x !== undefined ? numberValue(options, 'x', false) : undefined],
    ['y', options && options.y !== undefined ? numberValue(options, 'y', false) : undefined]
  ]), { method: 'POST', form: form });
}

async function uploadCanvasSubjectFile(base, fileName, role, source) {
  const absolute = path.resolve(fileName);
  const bytes = fs.readFileSync(absolute);
  const form = new FormData();
  form.append('file', new Blob([bytes]), path.basename(absolute));
  return request(addQuery(base + '/canvas/subject-file', [
    ['role', role],
    ['source', source]
  ]), { method: 'POST', form: form });
}

// 大画布的完整节点一个约 4KB，几百个节点就是几 MB，Agent 工具只看得到开头。
// 所以列表默认只给能定位节点的字段并分页；要完整内容用 node inspect 或 --full。
const LIST_DEFAULT_LIMIT = 30;

function compactNode(node) {
  const data = node && node.data && typeof node.data === 'object' ? node.data : {};
  const item = { id: node.id, kind: node.kind, label: node.label || '', x: node.x, y: node.y };
  for (const key of ['title', 'status', 'parent_group', 'shot_id']) {
    if (data[key] !== undefined && data[key] !== null && data[key] !== '') item[key] = data[key];
  }
  if (item.title === item.label) delete item.title;
  if (data.url || data.path) item.has_output = true;
  if (data.last_error) item.last_error = String(data.last_error).slice(0, 200);
  return item;
}

function compactEdge(edge) {
  return { id: edge.id, source: edge.source, target: edge.target };
}

function pageOf(items, options) {
  const limit = options.limit === undefined ? LIST_DEFAULT_LIMIT : numberValue(options, 'limit', false);
  const offset = options.offset === undefined ? 0 : numberValue(options, 'offset', false);
  if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer.');
  if (!Number.isInteger(offset) || offset < 0) throw new Error('--offset must be a non-negative integer.');
  const page = items.slice(offset, offset + limit);
  const next = offset + page.length;
  return { total: items.length, offset: offset, items: page, next_offset: next < items.length ? next : null };
}

async function runCanvasNode(base, action, options) {
  if (action === 'list') {
    const selected = await resolveCanvas(base, options);
    const full = bool(options, 'full');
    const kinds = csvOption(options, 'kind');
    const group = optionalString(options, 'group');
    const status = optionalString(options, 'status');
    const nodes = (selected.canvas.nodes || []).filter(function (node) {
      const data = node.data || {};
      if (kinds && !kinds.includes(node.kind)) return false;
      if (group !== undefined && data.parent_group !== group) return false;
      if (status !== undefined && data.status !== status) return false;
      return true;
    });
    const page = pageOf(nodes, options);
    const result = {
      canvas: { id: selected.canvas.id, name: selected.canvas.name },
      total: page.total,
      offset: page.offset,
      next_offset: page.next_offset,
      edge_count: (selected.canvas.edges || []).length,
      nodes: full ? page.items : page.items.map(compactNode)
    };
    if (bool(options, 'edges')) {
      const ids = new Set(page.items.map(function (node) { return node.id; }));
      const edges = (selected.canvas.edges || []).filter(function (edge) { return ids.has(edge.source) || ids.has(edge.target); });
      result.edges = full ? edges : edges.map(compactEdge);
    }
    print(result);
    return;
  }
  if (action === 'inspect') {
    const selected = await resolveCanvas(base, options);
    const nodeId = value(options, 'id', true);
    const node = (selected.canvas.nodes || []).find(function (item) { return item.id === nodeId; });
    if (!node) throw new Error('Node not found in the selected canvas: ' + nodeId);
    const edges = selected.canvas.edges || [];
    print({
      canvas: { id: selected.canvas.id, name: selected.canvas.name },
      node: node,
      incoming_edges: edges.filter(function (edge) { return edge.target === nodeId; }),
      outgoing_edges: edges.filter(function (edge) { return edge.source === nodeId; })
    });
    return;
  }
  if (action === 'add') {
    const selected = await resolveCanvas(base, options);
    const nodeData = jsonObjectOption(options, 'data', 'data-file') || {};
    if (optionalString(options, 'text') !== undefined) nodeData.text = optionalString(options, 'text');
    const node = {
      id: optionalString(options, 'id') || 'node-' + require('node:crypto').randomUUID(),
      kind: requireCanvasNodeKind(value(options, 'kind', true)),
      label: optionalString(options, 'label') || '',
      x: numberValue(options, 'x', false) || 0,
      y: numberValue(options, 'y', false) || 0,
      data: nodeData
    };
    const patch = { rev: Number(selected.state.rev || 0), canvases: [{ id: selected.id, upsert_nodes: [node] }] };
    let result = await patchCanvas(base, patch);
    if (!result.dry_run) {
      const created = (result.canvases || []).some(function (canvas) {
        return canvas.id === selected.id && (canvas.nodes || []).some(function (item) { return item.id === node.id; });
      });
      if (!created) {
        const latest = await getCanvasState(base);
        patch.rev = Number(latest.rev || 0);
        result = await patchCanvas(base, patch);
        const retried = (result.canvases || []).some(function (canvas) {
          return canvas.id === selected.id && (canvas.nodes || []).some(function (item) { return item.id === node.id; });
        });
        if (!retried) throw new Error('Canvas node was not created after retrying with the latest canvas revision.');
      }
    }
    print(result);
    return;
  }
  if (action === 'move') {
    // Moving preserves the existing node fields, so previews also need real state.
    const selected = await resolveCanvas(base, options, true);
    const nodeId = value(options, 'id', true);
    const existing = (selected.canvas.nodes || []).find(function (node) { return node.id === nodeId; });
    if (!existing) throw new Error('Node not found in the selected canvas: ' + nodeId);
    if (options.x === undefined && options.y === undefined) throw new Error('Provide --x, --y, or both.');
    const moved = Object.assign({}, existing);
    if (options.x !== undefined) moved.x = numberValue(options, 'x', false);
    if (options.y !== undefined) moved.y = numberValue(options, 'y', false);
    print(await patchCanvas(base, {
      rev: Number(selected.state.rev || 0),
      canvases: [{ id: selected.id, upsert_nodes: [moved] }]
    }));
    return;
  }
  if (action === 'remove') {
    requireConfirmation(options, 'Canvas node removal');
    const selected = await resolveCanvas(base, options);
    const nodeId = value(options, 'id', true);
    print(await patchCanvas(base, {
      rev: Number(selected.state.rev || 0),
      canvases: [{ id: selected.id, remove_node_ids: [nodeId] }]
    }));
    return;
  }
  const nodeId = action === 'duplicate' ? optionalString(options, 'id') : value(options, 'id', true);
  if (action === 'patch') {
    const body = {};
    const text = optionalString(options, 'text');
    const label = optionalString(options, 'label');
    const data = jsonObjectOption(options, 'data', 'data-file');
    if (text !== undefined) body.text = text;
    if (label !== undefined) body.label = label;
    if (data !== null) body.data = data;
    if (bool(options, 'save-as-is')) body.save_as_is = true;
    if (Object.keys(body).length === 0) throw new Error('Provide --text, --label, --data, or --data-file.');
    print(await request(base + '/canvas/nodes/' + encodeURIComponent(nodeId), { method: 'PATCH', body: body }));
    return;
  }
  if (action === 'run') {
    requireConfirmation(options, 'Canvas node run');
    const body = { node_id: nodeId };
    if (optionalString(options, 'prompt') !== undefined) body.prompt = optionalString(options, 'prompt');
    if (optionalString(options, 'generator') !== undefined) body.generator = optionalString(options, 'generator');
    if (options['end-freeze-outro'] !== undefined) body.end_freeze_outro = bool(options, 'end-freeze-outro');
    print(await request(base + '/canvas/run', { method: 'POST', body: body }));
    return;
  }
  if (action === 'generate') {
    requireConfirmation(options, 'Canvas node generation');
    const body = {};
    const textFields = [
      ['prompt', 'prompt'], ['skill', 'skill'], ['aspect', 'aspect'], ['image-model', 'image_model'],
      ['image-resolution', 'image_resolution'], ['video-model-tier', 'video_model_tier'],
      ['video-resolution', 'video_resolution'], ['audio-mode', 'audio_mode'], ['voice-id', 'voice_id'],
      ['language', 'language'], ['instruction', 'instruction'], ['lyrics', 'lyrics']
    ];
    for (const item of textFields) if (optionalString(options, item[0]) !== undefined) body[item[1]] = optionalString(options, item[0]);
    const numberFields = [['duration', 'duration_sec'], ['image-count', 'image_count'], ['video-count', 'video_count']];
    for (const item of numberFields) {
      if (options[item[0]] === undefined) continue;
      const number = numberValue(options, item[0], false);
      const limits = item[0] === 'duration' ? [4, 30] : [1, 4];
      body[item[1]] = requireRange(number, item[0], limits[0], limits[1]);
    }
    const ttsFields = [['rate', 'tts_rate', 0.5, 2], ['pitch', 'tts_pitch', 0.5, 2], ['volume', 'tts_volume', 0, 100]];
    for (const item of ttsFields) {
      if (options[item[0]] === undefined) continue;
      body[item[1]] = requireRange(numberValue(options, item[0], false), item[0], item[2], item[3]);
    }
    if (bool(options, 'include-self-image')) body.include_self_image = true;
    if (bool(options, 'replace-candidates')) body.replace_candidates = true;
    if (optionalString(options, 'video-gen-mode') !== undefined) body.video_gen_mode = optionalString(options, 'video-gen-mode');
    print(await request(base + '/canvas/nodes/' + encodeURIComponent(nodeId) + '/skill-generate', { method: 'POST', body: body }));
    return;
  }
  if (action === 'organize') {
    requireConfirmation(options, 'Canvas node organization');
    const body = {};
    if (optionalString(options, 'text') !== undefined) body.text = optionalString(options, 'text');
    if (optionalString(options, 'instruction') !== undefined) body.instruction = optionalString(options, 'instruction');
    print(await request(base + '/canvas/nodes/' + encodeURIComponent(nodeId) + '/organize', { method: 'POST', body: body }));
    return;
  }
  if (action === 'script-generate') {
    requireConfirmation(options, 'Canvas script generation');
    const prompt = optionalString(options, 'prompt');
    print(await request(base + '/canvas/nodes/' + encodeURIComponent(nodeId) + '/script/generate', { method: 'POST', body: prompt === undefined ? {} : { prompt: prompt } }));
    return;
  }
  if (action === 'script-compose') {
    requireConfirmation(options, 'Canvas script prompt composition');
    const body = { kind: optionalString(options, 'kind') || 'both' };
    if (!['image', 'video', 'both'].includes(body.kind)) throw new Error('--kind must be image, video, or both');
    const shotIds = csvOption(options, 'shot-ids');
    if (shotIds) body.shot_ids = shotIds;
    print(await request(base + '/canvas/nodes/' + encodeURIComponent(nodeId) + '/script/compose-prompts', { method: 'POST', body: body }));
    return;
  }
  if (action === 'script-spawn') {
    requireConfirmation(options, 'Canvas script generator spawn');
    const body = { kind: optionalString(options, 'kind') || 'video' };
    if (!['image', 'video'].includes(body.kind)) throw new Error('--kind must be image or video');
    const shotIds = csvOption(options, 'shot-ids');
    if (shotIds) body.shot_ids = shotIds;
    if (options['attach-film'] !== undefined) body.attach_film = bool(options, 'attach-film');
    if (options['auto-assemble'] !== undefined) body.auto_assemble = bool(options, 'auto-assemble');
    print(await request(base + '/canvas/nodes/' + encodeURIComponent(nodeId) + '/script/spawn-generators', { method: 'POST', body: body }));
    return;
  }
  if (action === 'script-batch') {
    requireConfirmation(options, 'Canvas script batch generation');
    const body = { scope: value(options, 'scope', true) };
    if (!['assets', 'stills', 'videos'].includes(body.scope)) throw new Error('--scope must be assets, stills, or videos');
    const shotIds = csvOption(options, 'shot-ids');
    const assetIds = csvOption(options, 'asset-ids');
    if (shotIds) body.shot_ids = shotIds;
    if (assetIds) body.asset_ids = assetIds;
    if (options['attach-film'] !== undefined) body.attach_film = bool(options, 'attach-film');
    if (options['auto-assemble'] !== undefined) body.auto_assemble = bool(options, 'auto-assemble');
    if (options['use-storyboard-preview'] !== undefined) body.use_storyboard_preview = bool(options, 'use-storyboard-preview');
    print(await request(base + '/canvas/nodes/' + encodeURIComponent(nodeId) + '/script/batch-generate', { method: 'POST', body: body }));
    return;
  }
  if (action === 'storyboard-preview') {
    requireConfirmation(options, 'Canvas storyboard preview generation');
    const shotIds = csvOption(options, 'shot-ids');
    print(await request(base + '/canvas/nodes/' + encodeURIComponent(nodeId) + '/script/storyboard-preview', { method: 'POST', body: shotIds ? { shot_ids: shotIds } : {} }));
    return;
  }
  if (action === 'script-patch') {
    requireConfirmation(options, 'Canvas script table update');
    const body = jsonObjectOption(options, 'data', 'file') || {};
    if (Object.keys(body).length === 0) throw new Error('Script patch requires --data JSON or --file FILE.');
    print(await request(base + '/canvas/nodes/' + encodeURIComponent(nodeId) + '/script/shots', { method: 'PATCH', body: body }));
    return;
  }
  if (action === 'script-generate-nodes') {
    requireConfirmation(options, 'Canvas script selected-node generation');
    const nodeIds = csvOption(options, 'nodes') || [];
    if (nodeIds.length === 0 || nodeIds.length > 64) throw new Error('--nodes requires 1–64 comma-separated node IDs.');
    const body = { node_ids: nodeIds };
    if (options['use-storyboard-preview'] !== undefined) body.use_storyboard_preview = bool(options, 'use-storyboard-preview');
    if (options['queue-offset'] !== undefined) body.queue_offset = numberValue(options, 'queue-offset', false);
    if (options['queue-total'] !== undefined) body.queue_total = numberValue(options, 'queue-total', false);
    print(await request(base + '/canvas/nodes/' + encodeURIComponent(nodeId) + '/script/generate-nodes', { method: 'POST', body: body }));
    return;
  }
  if (action === 'duplicate') {
    requireConfirmation(options, 'Canvas node duplication');
    const nodeIds = csvOption(options, 'nodes') || (optionalString(options, 'id') ? [optionalString(options, 'id')] : []);
    if (nodeIds.length === 0 || nodeIds.length > 8000) throw new Error('Provide --id NODE_ID or --nodes NODE_ID[,NODE_ID].');
    const body = { node_ids: nodeIds };
    if (options['offset-x'] !== undefined) body.offset_x = numberValue(options, 'offset-x', false);
    if (options['offset-y'] !== undefined) body.offset_y = numberValue(options, 'offset-y', false);
    print(await request(base + '/canvas/duplicate-nodes', { method: 'POST', body: body }));
    return;
  }
  if (action === 'script-extract-assets') {
    requireConfirmation(options, 'Canvas script asset extraction');
    print(await request(base + '/canvas/nodes/' + encodeURIComponent(nodeId) + '/script/extract-assets', { method: 'POST', body: {} }));
    return;
  }
  if (action === 'script-spawn-assets') {
    requireConfirmation(options, 'Canvas script asset layout');
    print(await request(base + '/canvas/nodes/' + encodeURIComponent(nodeId) + '/script/spawn-assets', { method: 'POST', body: {} }));
    return;
  }
  if (action === 'script-cancel') {
    requireConfirmation(options, 'Canvas script job cancellation');
    print(await request(base + '/canvas/nodes/' + encodeURIComponent(nodeId) + '/script/cancel', { method: 'POST', body: {} }));
    return;
  }
  if (action === 'media-cancel') {
    requireConfirmation(options, 'Canvas media job cancellation');
    print(await request(base + '/canvas/nodes/' + encodeURIComponent(nodeId) + '/media/cancel', { method: 'POST', body: {} }));
    return;
  }
  throw new Error('Unknown canvas node command: ' + (action || ''));
}

async function runCanvasEdge(base, action, options) {
  if (action === 'list') {
    const selected = await resolveCanvas(base, options);
    const nodeId = optionalString(options, 'node');
    const edges = (selected.canvas.edges || []).filter(function (edge) {
      return nodeId === undefined || edge.source === nodeId || edge.target === nodeId;
    });
    const page = pageOf(edges, options);
    print({
      canvas: { id: selected.canvas.id, name: selected.canvas.name },
      total: page.total,
      offset: page.offset,
      next_offset: page.next_offset,
      edges: bool(options, 'full') ? page.items : page.items.map(compactEdge)
    });
    return;
  }
  if (action === 'remove') {
    requireConfirmation(options, 'Canvas edge removal');
    const selected = await resolveCanvas(base, options);
    const edgeId = value(options, 'id', true);
    print(await patchCanvas(base, {
      rev: Number(selected.state.rev || 0),
      canvases: [{ id: selected.id, remove_edge_ids: [edgeId] }]
    }));
    return;
  }
  throw new Error('Unknown canvas edge command: ' + (action || ''));
}

async function runCanvasPrompt(base, action, options) {
  requireConfirmation(options, 'Canvas prompt operation');
  if (action === 'translate') {
    const body = {
      text: String(value(options, 'text', true)),
      target: optionalString(options, 'target') || 'en'
    };
    requireOneOf(body.target, 'target', ['en', 'zh']);
    const nodeId = optionalString(options, 'node');
    if (nodeId) body.node_id = nodeId;
    print(await request(base + '/canvas/translate-prompt', { method: 'POST', body: body }));
    return;
  }
  if (action === 'optimize-image' || action === 'optimize-video') {
    const body = {
      node_id: String(value(options, 'id', true)),
      prompt: optionalString(options, 'prompt') || ''
    };
    const skill = optionalString(options, 'skill');
    const aspect = optionalString(options, 'aspect');
    if (skill) body.skill = skill;
    if (aspect) body.aspect = aspect;
    if (action === 'optimize-video' && options.duration !== undefined) {
      body.duration_sec = requireRange(numberValue(options, 'duration', false), 'duration', 4, 30);
    }
    const endpoint = action === 'optimize-image' ? '/canvas/optimize-image-prompt' : '/canvas/optimize-video-prompt';
    print(await request(base + endpoint, { method: 'POST', body: body }));
    return;
  }
  if (action === 'reverse') {
    const nodeId = value(options, 'id', true);
    print(await request(base + '/canvas/nodes/' + encodeURIComponent(nodeId) + '/reverse-prompt', { method: 'POST', body: {} }));
    return;
  }
  throw new Error('Canvas prompt command must be translate, optimize-image, optimize-video, or reverse.');
}

function selectedRange(options, operation) {
  const start = numberValue(options, 'start-sec', true);
  const end = numberValue(options, 'end-sec', true);
  if (start < 0 || end <= start) throw new Error(operation + ' requires --end-sec greater than a non-negative --start-sec.');
  return { start_sec: start, end_sec: end };
}

async function runCanvasVideo(base, action, options) {
  requireConfirmation(options, 'Canvas video operation');
  const nodeId = value(options, 'id', true);
  const nodeBase = base + '/canvas/nodes/' + encodeURIComponent(nodeId);
  if (action === 'frame') {
    const kind = optionalString(options, 'kind') || 'first';
    requireOneOf(kind, 'kind', ['first', 'last', 'current']);
    const body = { kind: kind };
    if (options['at-sec'] !== undefined) {
      body.at_sec = numberValue(options, 'at-sec', false);
      if (body.at_sec < 0) throw new Error('--at-sec must be non-negative.');
    }
    print(await request(nodeBase + '/video-frame', { method: 'POST', body: body }));
    return;
  }
  if (action === 'reshoot') {
    print(await request(nodeBase + '/video-reshoot', { method: 'POST', body: selectedRange(options, 'Video reshoot') }));
    return;
  }
  if (action === 'clone') {
    print(await request(nodeBase + '/video-segment-clone', { method: 'POST', body: {} }));
    return;
  }
  if (action === 'trim') {
    const body = selectedRange(options, 'Video trim');
    if (options.mute !== undefined) body.mute = bool(options, 'mute');
    print(await request(nodeBase + '/video-trim', { method: 'POST', body: body }));
    return;
  }
  if (action === 'split') {
    const ranges = jsonArrayOption(options, 'ranges', 'ranges-file');
    if (!ranges || ranges.length === 0) throw new Error('Video split requires --ranges JSON or --ranges-file FILE.');
    print(await request(nodeBase + '/video-split', { method: 'POST', body: { ranges: ranges } }));
    return;
  }
  if (action === 'crop') {
    const body = Object.assign({ x: 0.08, y: 0.08, w: 0.84, h: 0.84 }, numericOptionBody(options, ['x', 'y', 'w', 'h']));
    if (body.x < 0 || body.y < 0 || body.w <= 0 || body.h <= 0 || body.x + body.w > 1 || body.y + body.h > 1) {
      throw new Error('Crop coordinates must stay within the normalized 0–1 frame.');
    }
    print(await request(nodeBase + '/video-crop', { method: 'POST', body: body }));
    return;
  }
  if (action === 'hd') {
    const body = {
      resolution: optionalString(options, 'resolution') || '1080p',
      interpolate: optionalString(options, 'interpolate') || 'none',
      slowmo: options.slowmo === undefined ? 1 : numberValue(options, 'slowmo', false)
    };
    requireOneOf(body.resolution, 'resolution', ['1080p', '2k', '4k']);
    requireOneOf(body.interpolate, 'interpolate', ['none', '30', '60']);
    requireOneOf(body.slowmo, 'slowmo', [1, 2, 4]);
    print(await request(nodeBase + '/video-hd', { method: 'POST', body: body }));
    return;
  }
  if (action === 'fps') {
    const fps = numberValue(options, 'fps', true);
    requireOneOf(fps, 'fps', [12, 24, 30, 60]);
    print(await request(nodeBase + '/video-fps', { method: 'POST', body: { fps: fps } }));
    return;
  }
  if (action === 'erase') {
    const body = {
      mode: optionalString(options, 'mode') || 'box',
      boxes: jsonArrayOption(options, 'boxes', 'boxes-file') || []
    };
    requireOneOf(body.mode, 'mode', ['box']);
    if (body.boxes.length === 0) throw new Error('Box erase requires --boxes JSON or --boxes-file FILE.');
    if (optionalString(options, 'fill') !== undefined) body.fill = requireOneOf(optionalString(options, 'fill'), 'fill', ['delogo', 'color']);
    if (optionalString(options, 'color') !== undefined) body.color = optionalString(options, 'color');
    print(await request(nodeBase + '/video-erase', { method: 'POST', body: body }));
    return;
  }
  if (action === 'av-split') {
    print(await request(nodeBase + '/video-av-split', { method: 'POST', body: {} }));
    return;
  }
  if (action === 'depth') {
    print(await request(nodeBase + '/video-depth', { method: 'POST', body: { invert: bool(options, 'invert') } }));
    return;
  }
  throw new Error('Canvas video command must be frame, reshoot, clone, trim, split, crop, hd, fps, erase, av-split, or depth.');
}

async function runCanvasSnippet(base, action, options) {
  if (action !== 'apply') throw new Error('Canvas snippet command must be apply.');
  requireConfirmation(options, 'Canvas Skill snippet application');
  const body = {};
  if (optionalString(options, 'skill') !== undefined) body.skill = optionalString(options, 'skill');
  const snippet = jsonObjectOption(options, 'snippet', 'file');
  if (snippet) body.snippet = snippet;
  if (!body.skill && !body.snippet) throw new Error('Provide --skill SKILL or --file SNIPPET.json.');
  if (options.x !== undefined) body.origin_x = numberValue(options, 'x', false);
  if (options.y !== undefined) body.origin_y = numberValue(options, 'y', false);
  print(await request(base + '/canvas/apply-snippet', { method: 'POST', body: body }));
}

async function runCanvasLibrary(base, action, options) {
  if (action === 'character-list') {
    print(await request(base + '/canvas/character-library'));
    return;
  }
  requireConfirmation(options, 'Canvas library operation');
  if (action === 'character-apply') {
    print(await request(base + '/canvas/character-library/apply', { method: 'POST', body: { archetype_id: value(options, 'archetype', true) } }));
    return;
  }
  if (action === 'starter-apply') {
    print(await request(base + '/canvas/starter-library/apply', { method: 'POST', body: { ids: csvOption(options, 'ids') || [] } }));
    return;
  }
  if (action === 'team-place') {
    const body = { team_id: value(options, 'team', true), asset_id: value(options, 'asset', true) };
    if (options.x !== undefined) body.x = numberValue(options, 'x', false);
    if (options.y !== undefined) body.y = numberValue(options, 'y', false);
    print(await request(base + '/canvas/place-team-asset', { method: 'POST', body: body }));
    return;
  }
  throw new Error('Canvas library command must be character-list, character-apply, starter-apply, or team-place.');
}

async function runCanvasDirector(base, action, options) {
  if (action !== 'screenshot') throw new Error('Canvas director command must be screenshot.');
  requireConfirmation(options, 'Canvas director screenshot');
  const bytes = fs.readFileSync(path.resolve(String(value(options, 'file', true))));
  const image = dryRunRequested() ? '[base64 image: ' + bytes.length + ' bytes]' : bytes.toString('base64');
  print(await request(base + '/canvas/director/screenshot', { method: 'POST', body: {
    director_node_id: value(options, 'id', true),
    image_base64: image,
    label: optionalString(options, 'label') || '导演截图'
  } }));
}

async function runCanvasImage(base, action, options) {
  if (action !== 'erase') throw new Error('Canvas image command must be erase.');
  requireConfirmation(options, 'Canvas image operation');
  const boxes = jsonArrayOption(options, 'boxes', 'boxes-file') || [];
  if (boxes.length === 0) throw new Error('Image erase requires --boxes JSON or --boxes-file FILE.');
  const body = { mode: 'box', boxes: boxes };
  if (optionalString(options, 'fill') !== undefined) body.fill = requireOneOf(optionalString(options, 'fill'), 'fill', ['delogo', 'color']);
  if (optionalString(options, 'color') !== undefined) body.color = optionalString(options, 'color');
  const nodeId = value(options, 'id', true);
  print(await request(base + '/canvas/nodes/' + encodeURIComponent(nodeId) + '/image-erase', { method: 'POST', body: body }));
}

async function runCanvasSubject(base, action, options) {
  requireConfirmation(options, 'Canvas subject operation');
  if (action === 'upload') {
    const role = optionalString(options, 'role') || 'image';
    requireOneOf(role, 'role', ['image', 'voice']);
    const source = optionalString(options, 'source') || '';
    if (source && source !== 'record') throw new Error('--source must be record when provided.');
    print(await uploadCanvasSubjectFile(base, value(options, 'file', true), role, source));
    return;
  }
  if (action === 'sheet') {
    const sidePaths = csvOption(options, 'side-paths') || [];
    if (sidePaths.length === 0 || sidePaths.length > 3) throw new Error('--side-paths requires one to three comma-separated project media paths.');
    print(await request(base + '/canvas/subject-sheet', { method: 'POST', body: {
      main_path: value(options, 'main-path', true),
      side_paths: sidePaths
    } }));
    return;
  }
  throw new Error('Canvas subject command must be upload or sheet.');
}

async function runCanvasAudio(base, action, options) {
  if (action !== 'edit') throw new Error('Canvas audio command must be edit.');
  requireConfirmation(options, 'Canvas audio operation');
  const body = { action: optionalString(options, 'action') || '' };
  requireOneOf(body.action, 'action', ['trim', 'speed']);
  if (body.action === 'trim') Object.assign(body, selectedRange(options, 'Audio trim'));
  if (body.action === 'speed') {
    body.rate = numberValue(options, 'rate', true);
    if (body.rate <= 0) throw new Error('--rate must be greater than zero.');
  }
  const nodeId = value(options, 'id', true);
  print(await request(base + '/canvas/nodes/' + encodeURIComponent(nodeId) + '/audio-edit', { method: 'POST', body: body }));
}

async function runCanvas(action, options, positionals) {
  if (action === 'skill' && positionals[0] === 'list') {
    print(await request('/api/skills/system'));
    return;
  }
  const projectId = resolveProject(options);
  const base = '/api/projects/' + encodeURIComponent(projectId);
  if (action === 'get') {
    print(await getCanvasState(base));
    return;
  }
  if (action === 'list') {
    const state = await getCanvasState(base);
    print({
      active_canvas_id: state.active_canvas_id,
      view_mode: state.view_mode,
      canvases: (state.canvases || []).map(function (item) {
        return { id: item.id, name: item.name, node_count: (item.nodes || []).length, edge_count: (item.edges || []).length };
      })
    });
    return;
  }
  if (action === 'summary') {
    const state = await getCanvasState(base);
    const activeCanvas = (state.canvases || []).find(function (item) { return item.id === state.active_canvas_id; }) || null;
    const node_kinds = {};
    for (const canvas of state.canvases || []) {
      for (const node of canvas.nodes || []) {
        const kind = String(node.kind || 'unknown');
        node_kinds[kind] = (node_kinds[kind] || 0) + 1;
      }
    }
    const validation = validateCanvasState(state);
    print({
      project_id: projectId,
      revision: state.rev || null,
      active_canvas: activeCanvas ? {
        id: activeCanvas.id,
        name: activeCanvas.name || '',
        node_count: (activeCanvas.nodes || []).length,
        edge_count: (activeCanvas.edges || []).length
      } : null,
      canvas_count: (state.canvases || []).length,
      node_kinds: node_kinds,
      validation: validation
    });
    return;
  }
  if (action === 'validate') {
    print(validateCanvasState(await getCanvasState(base)));
    return;
  }
  if (action === 'diff') {
    const candidate = readCanvasStateFile(value(options, 'file', true));
    const validation = validateCanvasState(candidate);
    print({
      candidate_valid: validation.valid,
      candidate_errors: validation.errors,
      candidate_warnings: validation.warnings,
      diff: diffCanvasState(await getCanvasState(base), candidate)
    });
    return;
  }
  if (action === 'create') {
    const name = optionalString(options, 'name') || optionalString(options, 'title') || '';
    print(await request(base + '/canvas/canvases', { method: 'POST', body: { name: name } }));
    return;
  }
  if (action === 'use') {
    const canvasId = positionals[0] || value(options, 'canvas', true);
    print(await request(base + '/canvas/active-canvas', { method: 'PATCH', body: { canvas_id: String(canvasId) } }));
    return;
  }
  if (action === 'rename') {
    const selected = await resolveCanvas(base, options);
    print(await patchCanvas(base, {
      rev: Number(selected.state.rev || 0),
      canvases: [{ id: selected.id, name: value(options, 'name', true) }]
    }));
    return;
  }
  if (action === 'view') {
    const mode = value(options, 'mode', true);
    if (mode !== 'workflow' && mode !== 'storyboard') throw new Error('--mode must be workflow or storyboard');
    print(await request(base + '/canvas/view-mode', { method: 'PATCH', body: { view_mode: mode } }));
    return;
  }
  if (action === 'export') {
    const output = value(options, 'output', true);
    if (dryRunRequested()) {
      print({ dry_run: true, local_operation: 'canvas.export', output: path.resolve(String(output)) });
      return;
    }
    const state = await getCanvasState(base);
    const destination = path.resolve(String(output));
    fs.writeFileSync(destination, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    print({ canvas_state_written_to: destination, rev: state.rev, canvas_count: (state.canvases || []).length });
    return;
  }
  if (action === 'import') {
    requireConfirmation(options, 'Canvas state import');
    const source = value(options, 'file', true);
    const state = readCanvasStateFile(source);
    const validation = validateCanvasState(state);
    if (!validation.valid) {
      throw new Error('Canvas import is blocked by structural errors: ' + validation.errors.join(' | '));
    }
    const imported = await request(base + '/canvas', { method: 'PUT', body: state });
    if (imported && Array.isArray(imported.canvases)) writeCanvasCache(base, imported, canvasEtag(base, imported.rev));
    else forgetCanvasCache(base);
    print(imported);
    return;
  }
  if (action === 'patch') {
    requireConfirmation(options, 'Raw canvas patch');
    const source = value(options, 'file', true);
    const patch = jsonObjectOption({ 'data-file': source }, 'data', 'data-file');
    print(await patchCanvas(base, patch));
    return;
  }
  if (action === 'upload') {
    print(await uploadCanvasFile(base, value(options, 'file', true), options));
    return;
  }
  if (action === 'connect') {
    const body = {
      source_node_id: value(options, 'source', true),
      target_node_id: value(options, 'target', true)
    };
    if (body.source_node_id === body.target_node_id) throw new Error('Canvas links cannot connect a node to itself.');
    if (optionalString(options, 'source-handle') !== undefined) body.source_handle = optionalString(options, 'source-handle');
    if (optionalString(options, 'target-handle') !== undefined) body.target_handle = optionalString(options, 'target-handle');
    print(await request(base + '/canvas/connect', { method: 'POST', body: body }));
    return;
  }
  if (action === 'connect-many') {
    const links = jsonArrayOption(options, 'links', 'links-file');
    if (!links || links.length === 0 || links.length > 64) throw new Error('Connect many requires 1–64 links via --links JSON or --links-file FILE.');
    for (const link of links) {
      if (!link || typeof link !== 'object' || !link.source_node_id || !link.target_node_id) {
        throw new Error('Each link must contain source_node_id and target_node_id.');
      }
      if (link.source_node_id === link.target_node_id) throw new Error('Canvas links cannot connect a node to itself.');
    }
    print(await request(base + '/canvas/connect-many', { method: 'POST', body: { links: links } }));
    return;
  }
  if (action === 'ref-spawn') {
    const body = {
      source_node_id: value(options, 'source', true),
      kind: requireCanvasNodeKind(value(options, 'kind', true))
    };
    if (options.x !== undefined) body.x = numberValue(options, 'x', false);
    if (options.y !== undefined) body.y = numberValue(options, 'y', false);
    if (optionalString(options, 'direction') !== undefined) body.direction = requireOneOf(optionalString(options, 'direction'), 'direction', ['generate', 'context']);
    print(await request(base + '/canvas/ref-spawn', { method: 'POST', body: body }));
    return;
  }
  if (action === 'collab') {
    const collabAction = positionals[0] || 'list';
    if (collabAction === 'list') {
      print(await request(base + '/canvas/collab'));
      return;
    }
    if (collabAction === 'claim' || collabAction === 'release') {
      requireConfirmation(options, 'Canvas collaboration claim change');
      const nodeIds = csvOption(options, 'nodes') || [];
      if (collabAction === 'claim' && nodeIds.length === 0) throw new Error('Canvas claim requires --nodes NODE_ID[,NODE_ID].');
      print(await request(base + '/canvas/collab/' + collabAction, { method: 'POST', body: { node_ids: nodeIds } }));
      return;
    }
    throw new Error('Canvas collab command must be list, claim, or release.');
  }
  if (action === 'session') {
    if (positionals[0] === 'acquire') {
      print(await request(base + '/canvas/writer-session', { method: 'POST', body: {} }));
      return;
    }
    if (positionals[0] === 'release') {
      print(await request(base + '/canvas/writer-session', { method: 'DELETE' }));
      return;
    }
    if (positionals[0] === 'heartbeat') {
      print(await request(base + '/canvas/writer-heartbeat', { method: 'POST', body: {} }));
      return;
    }
    throw new Error('Canvas session command must be acquire, release, or heartbeat.');
  }
  if (action === 'prompt') return runCanvasPrompt(base, positionals[0], options);
  if (action === 'snippet') return runCanvasSnippet(base, positionals[0], options);
  if (action === 'library') return runCanvasLibrary(base, positionals[0], options);
  if (action === 'director') return runCanvasDirector(base, positionals[0], options);
  if (action === 'video') return runCanvasVideo(base, positionals[0], options);
  if (action === 'image') return runCanvasImage(base, positionals[0], options);
  if (action === 'subject') return runCanvasSubject(base, positionals[0], options);
  if (action === 'audio') return runCanvasAudio(base, positionals[0], options);
  if (action === 'node') return runCanvasNode(base, positionals[0], options);
  if (action === 'edge') return runCanvasEdge(base, positionals[0], options);
  throw new Error('Unknown canvas command: ' + (action || ''));
}

// ── MCP（stdio）────────────────────────────────────────────
// 给外部 Agent（DeepSeek Harness、Claude Code、Codex 等）用：把小影马的 agent-tools 接口
// 翻译成 MCP 工具。一行一条 JSON-RPC；stdout 只能写协议消息，日志一律写 stderr。
// 登录、接口地址、项目选择都复用 CLI 本身的。

const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MCP_RESULT_LIMIT = 12000;
const MCP_INSTRUCTIONS = [
  '小影马（yingma）项目工具。工具按当前项目类型提供：无限画布、Agent 流水线或互动影游。',
  '先用读工具了解现状，再写；写之前必须读过要改的对象，内容在你读取后被改动会被拒绝，重新读即可。',
  '写工具返回 op_id，可用 undo 撤销。删除、扣费类操作会返回 pending_confirmation：请告诉用户去小影马页面确认，',
  '再用 action_status 查结果，不要换个方式绕过确认。',
  '用 yingma_project_list / yingma_project_use 查看或切换项目。'
].join('');

function mcpLog(message) {
  process.stderr.write('[yingma mcp] ' + message + '\n');
}

function dshStatePath() {
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'yingma-canvas', 'state.json');
}

function readDshProject() {
  try {
    const state = JSON.parse(fs.readFileSync(dshStatePath(), 'utf8'));
    return typeof state.projectId === 'string' && state.projectId ? state.projectId : '';
  } catch (_) {
    return '';
  }
}

function mcpCompact(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= MCP_RESULT_LIMIT) return text;
  return text.slice(0, MCP_RESULT_LIMIT) + '…（结果过长已截断，请缩小读取范围）';
}

function createMcpServer(io) {
  const caller = 'mcp-' + require('node:crypto').randomBytes(6).toString('hex');
  // 项目来源：yingma_project_use 指定 > YINGMA_PROJECT > DSH 插件里选的项目 > 当前目录 .yingma/project.json
  let override = '';
  let listedProject = null;
  let listedKind = null;
  let remoteTools = [];

  function currentProject() {
    if (override) return { id: override, source: 'session' };
    if (process.env.YINGMA_PROJECT && process.env.YINGMA_PROJECT.trim()) {
      return { id: process.env.YINGMA_PROJECT.trim(), source: 'env' };
    }
    const fromDsh = process.env.YINGMA_PROJECT_SOURCE === 'dsh' ? readDshProject() : '';
    if (fromDsh) return { id: fromDsh, source: 'dsh' };
    const local = readLocalProject().project_id;
    if (typeof local === 'string' && local.trim()) return { id: local.trim(), source: 'directory' };
    return { id: '', source: 'none' };
  }

  const localTools = [
    {
      name: 'yingma_project_list',
      description: '列出小影马项目（id、标题、类型）。kind 可筛选 canvas / pipeline / interactive。',
      inputSchema: {
        type: 'object',
        properties: { kind: { type: 'string', enum: ['canvas', 'pipeline', 'interactive'] }, query: { type: 'string' } },
        additionalProperties: false
      },
      annotations: { readOnlyHint: true },
      async run(args) {
        const list = await request(addQuery('/api/projects', [['limit', 50], ['q', args.query]]));
        const items = (Array.isArray(list) ? list : []).filter(function (p) { return !args.kind || p.kind === args.kind; });
        return {
          current: currentProject(),
          projects: items.map(function (p) { return { id: p.id, title: p.title, kind: p.kind, updated_at: p.updated_at }; })
        };
      }
    },
    {
      name: 'yingma_project_use',
      description: '切换本次会话操作的项目。切换后工具清单会按项目类型更新。',
      inputSchema: {
        type: 'object',
        properties: { project_id: { type: 'string' } },
        required: ['project_id'],
        additionalProperties: false
      },
      async run(args) {
        const projectId = String(args.project_id || '').trim();
        if (!projectId) throw new Error('缺少 project_id');
        const project = await request('/api/projects/' + encodeURIComponent(projectId));
        override = projectId;
        await refreshTools(true);
        return { project_id: projectId, title: project && project.title, kind: project && project.kind };
      }
    }
  ];

  async function refreshTools(notify) {
    const project = currentProject();
    if (!project.id) {
      const changed = listedProject !== '';
      listedProject = '';
      listedKind = null;
      remoteTools = [];
      if (notify && changed) send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      return;
    }
    if (project.id === listedProject && remoteTools.length) return;
    const catalog = await request('/api/projects/' + encodeURIComponent(project.id) + '/agent-tools');
    const names = function (list) { return list.map(function (t) { return t.name; }).sort().join(','); };
    const before = names(remoteTools);
    remoteTools = Array.isArray(catalog.tools) ? catalog.tools : [];
    listedProject = project.id;
    listedKind = catalog.kind || null;
    if (notify && before !== names(remoteTools)) send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  }

  function describeRemote(tool) {
    const tag = { destructive: '【需用户在小影马页面确认】', billable: '【扣费，需用户在小影马页面确认】' }[tool.risk] || '';
    const annotations = { readOnlyHint: tool.risk === 'read' };
    if (tool.risk === 'destructive') annotations.destructiveHint = true;
    return { name: tool.name, description: tag + tool.description, inputSchema: tool.input_schema, annotations: annotations };
  }

  function send(message) {
    io.write(JSON.stringify(message) + '\n');
  }

  function toolResult(value, isError) {
    return { content: [{ type: 'text', text: mcpCompact(value) }], isError: Boolean(isError) };
  }

  async function callTool(name, args) {
    const local = localTools.find(function (t) { return t.name === name; });
    if (local) {
      try {
        return toolResult(await local.run(args || {}), false);
      } catch (error) {
        return toolResult(error.message || String(error), true);
      }
    }
    const project = currentProject();
    if (!project.id) {
      return toolResult('还没有选项目：先用 yingma_project_list 查看，再用 yingma_project_use 选择。', true);
    }
    try {
      await refreshTools(true);
      const out = await request(
        '/api/projects/' + encodeURIComponent(project.id) + '/agent-tools/' + encodeURIComponent(name),
        { method: 'POST', body: { args: args || {} }, headers: { 'X-Agent-Caller': caller } }
      );
      if (out && out.ok === false) return toolResult(out.error || out, true);
      return toolResult(out, false);
    } catch (error) {
      return toolResult(error.message || String(error), true);
    }
  }

  async function handle(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      // 规范要求：认不出 id 的非法请求也要回，id 用 null；带 id 的就回原 id
      const id = message && typeof message === 'object' && message.id !== undefined ? message.id : null;
      send({ jsonrpc: '2.0', id: id, error: { code: -32600, message: 'Invalid Request' } });
      return;
    }
    const isRequest = message.id !== undefined && message.id !== null;
    const reply = function (result) { if (isRequest) send({ jsonrpc: '2.0', id: message.id, result: result }); };
    const fail = function (code, text) { if (isRequest) send({ jsonrpc: '2.0', id: message.id, error: { code: code, message: text } }); };
    const params = message.params || {};
    switch (message.method) {
      case 'initialize': {
        const asked = params.protocolVersion;
        reply({
          protocolVersion: MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'yingma', version: VERSION },
          instructions: MCP_INSTRUCTIONS
        });
        return;
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return;
      case 'ping':
        reply({});
        return;
      case 'tools/list': {
        try {
          await refreshTools(false);
        } catch (error) {
          mcpLog('读取工具清单失败：' + error.message);
        }
        reply({ tools: localTools.map(function (t) {
          return { name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations };
        }).concat(remoteTools.map(describeRemote)) });
        return;
      }
      case 'tools/call': {
        if (typeof params.name !== 'string') return fail(-32602, 'tools/call 缺少 name');
        reply(await callTool(params.name, params.arguments));
        return;
      }
      default:
        fail(-32601, 'Method not found: ' + message.method);
    }
  }

  // DSH 侧栏里换了项目：工具清单可能要换（画布 / 流水线 / 互动影游各不相同）
  function watchProjectChanges() {
    let last = currentProject().id;
    const timer = setInterval(function () {
      const now = currentProject().id;
      if (now === last) return;
      last = now;
      refreshTools(true).catch(function (error) { mcpLog('刷新工具清单失败：' + error.message); });
    }, 3000);
    timer.unref();
  }

  return { handle: handle, watchProjectChanges: watchProjectChanges, caller: caller, currentProject: currentProject };
}

async function runMcp() {
  const server = createMcpServer({ write: function (text) { process.stdout.write(text); } });
  server.watchProjectChanges();
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let chain = Promise.resolve();
  lines.on('line', function (line) {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch (_) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
      return;
    }
    // 按到达顺序处理：tools/call 之间可能依赖（先读后写）
    chain = chain.then(function () { return server.handle(message); }).catch(function (error) {
      mcpLog('处理消息失败：' + (error && error.message));
    });
  });
  await new Promise(function (resolve) { lines.on('close', resolve); });
  await chain;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const positionals = parsed.positionals;
  if (bool(parsed.options, 'version')) {
    print({ version: VERSION, api_base: getApiBase() });
    return;
  }
  if (bool(parsed.options, 'help') || positionals.length === 0) {
    print(usage());
    return;
  }
  if (positionals[0] === 'version') {
    print({ version: VERSION, api_base: getApiBase() });
    return;
  }
  const area = positionals[0];
  const action = positionals[1];
  const rest = positionals.slice(2);
  if (area === 'doctor') return runDoctor();
  if (area === 'auth') return runAuth(action, parsed.options);
  if (area === 'account') {
    if (action === 'me') return print(await request('/api/auth/me'));
    if (action === 'balance') return print(await request('/api/auth/balance'));
    throw new Error('Unknown account command: ' + (action || ''));
  }
  if (area === 'project') return runProject(action, parsed.options, rest);
  if (area === 'script') return runScript(action, parsed.options);
  if (area === 'scene' || area === 'shot' || area === 'artifact') return runProjectRead(area, action, parsed.options);
  if (area === 'asset' || area === 'keyframe' || area === 'video') return runGeneration(area, action, parsed.options);
  if (area === 'episode') return runEpisode(action, parsed.options);
  if (area === 'pipeline') return runPipeline(action, parsed.options, rest);
  if (area === 'interactive') return runInteractive(action, parsed.options, rest);
  if (area === 'download') return runDownload(parsed.options);
  if (area === 'canvas') return runCanvas(action, parsed.options, rest);
  if (area === 'mcp') return runMcp();
  throw new Error('Unknown command group: ' + area);
}

if (require.main === module) {
  main().catch(function (error) {
    process.stderr.write('yingma: ' + (error && error.message ? error.message : String(error)) + '\n');
    process.exitCode = 1;
  });
}

module.exports = {
  applyCanvasDelta: applyCanvasDelta,
  mergePartialCanvas: mergePartialCanvas,
  canvasEtag: canvasEtag,
  looksLikeCanvasState: looksLikeCanvasState,
  partialRemovesNodes: partialRemovesNodes,
  createMcpServer: createMcpServer
};
