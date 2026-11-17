import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const COOKIE = 'chat_gate';
const MAX_BODY = 1024 * 1024;
const MAX_MESSAGES = 200;
const MAX_MESSAGE_CHARS = 200_000;
const MAX_TOTAL_CHARS = 600_000;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/app.js', 'app.js'],
  ['/styles.css', 'styles.css'],
  ['/favicon.svg', 'favicon.svg'],
]);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

export function readConfig(env = process.env) {
  const genericPassword = env.GENERIC_PASSWORD || '';
  const cookieSecret = env.GATE_COOKIE_SECRET || '';
  const apiKey = env.OPENCODE_API_KEY || '';
  if (!genericPassword) throw new Error('GENERIC_PASSWORD is required');
  if (Buffer.byteLength(genericPassword) < 8) throw new Error('GENERIC_PASSWORD must be at least 8 bytes');
  if (cookieSecret.length < 32) throw new Error('GATE_COOKIE_SECRET must be at least 32 characters');
  if (!apiKey) throw new Error('OPENCODE_API_KEY is required');
  return {
    port: Number(env.PORT || 8810),
    host: env.HOST || '127.0.0.1',
    apiKey,
    baseUrl: (env.OPENCODE_BASE_URL || 'https://opencode.ai/zen/go/v1').replace(/\/+$/, ''),
    defaultModel: env.DEFAULT_MODEL || 'deepseek-v4.1-flash',
    genericPassword,
    cookieSecret,
    sessionDays: Number(env.GATE_SESSION_DAYS || 30),
    cookieSecure: env.COOKIE_SECURE !== 'false',
    publicDir: path.join(ROOT, 'public'),
  };
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

function passwordMatches(given, expected) {
  return crypto.timingSafeEqual(digest(given), digest(expected));
}

function sign(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function makeSessionCookie(config) {
  const maxAge = Math.max(1, config.sessionDays) * 86400;
  const value = `${Math.floor(Date.now() / 1000) + maxAge}.${crypto.randomBytes(9).toString('base64url')}`;
  const token = `${value}.${sign(config.cookieSecret, value)}`;
  const secure = config.cookieSecure ? '; Secure' : '';
  return `${COOKIE}=${token}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

function validSession(req, config) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return false;
  const i = token.lastIndexOf('.');
  if (i < 1) return false;
  const value = token.slice(0, i);
  const given = Buffer.from(token.slice(i + 1));
  const expected = Buffer.from(sign(config.cookieSecret, value));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return false;
  return Number(value.split('.')[0]) > Date.now() / 1000;
}

function clientIp(req) {
  return String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?').slice(0, 80);
}

function createLoginLimiter() {
  const fails = new Map();
  const windowMs = 15 * 60 * 1000;
  const limit = 10;
  function live(ip) {
    const entry = fails.get(ip);
    if (entry && Date.now() - entry.at > windowMs) {
      fails.delete(ip);
      return null;
    }
    return entry || null;
  }
  return {
    blocked(ip) {
      const entry = live(ip);
      return Boolean(entry && entry.count >= limit);
    },
    failed(ip) {
      const entry = live(ip) || { count: 0, at: Date.now() };
      entry.count += 1;
      entry.at = Date.now();
      fails.set(ip, entry);
      return entry.count;
    },
    reset(ip) {
      fails.delete(ip);
    },
  };
}

function loginPage(message = '') {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Chat Test Site - sign in</title>
<style>
:root{color-scheme:dark;--bg:#0f1115;--panel:#181b22;--line:#2a2f3a;--text:#e7e9ee;--muted:#98a0af;--accent:#6d8cff;--danger:#ff8b8b}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 50% 0%,#1b2140 0,var(--bg) 55%);color:var(--text);font:15px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:20px}
form{width:min(360px,100%);background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:28px;box-shadow:0 20px 60px #0008}
.mark{width:42px;height:42px;border-radius:12px;display:grid;place-items:center;background:linear-gradient(135deg,#6d8cff,#9b6dff);font-weight:800;margin-bottom:18px}
h1{font-size:1.25rem;margin:0 0 6px}
p.sub{color:var(--muted);margin:0 0 22px;font-size:.9rem}
label{display:block;font-size:.82rem;color:var(--muted);margin-bottom:6px}
input{width:100%;padding:11px 12px;border-radius:9px;border:1px solid var(--line);background:#0f1115;color:var(--text);font:inherit;outline:none}
input:focus{border-color:var(--accent);box-shadow:0 0 0 3px #6d8cff26}
button{margin-top:16px;width:100%;padding:11px;border:0;border-radius:9px;background:var(--accent);color:#fff;font:600 15px/1 inherit;cursor:pointer}
button:hover{filter:brightness(1.08)}
.error{color:var(--danger);font-size:.9rem;margin:12px 0 0}
</style>
</head>
<body>
<form method="post" action="/__gate/login">
  <div class="mark" aria-hidden="true">C</div>
  <h1>Chat Test Site</h1>
  <p class="sub">OpenCode Go prompt tester</p>
  <label for="password">Password</label>
  <input id="password" type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required>
  ${message ? `<p class="error" role="alert">${message}</p>` : ''}
  <button type="submit">Sign in</button>
</form>
</body>
</html>`;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': CSP,
    ...headers,
  });
  res.end(body);
}

function sendJson(res, status, payload, headers = {}) {
  send(res, status, JSON.stringify(payload), {
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  });
}

async function readJson(req, limit = MAX_BODY) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('Request body too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Invalid JSON body');
    error.status = 400;
    throw error;
  }
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeChat(body, config) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'Expected a JSON object');
  const model = typeof body.model === 'string' ? body.model.trim() : config.defaultModel;
  if (!MODEL_RE.test(model)) throw httpError(400, 'Invalid model');
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw httpError(400, 'messages must be a non-empty array');
  if (body.messages.length > MAX_MESSAGES) throw httpError(400, 'Too many messages');
  let total = 0;
  const messages = body.messages.map((message, index) => {
    if (!message || typeof message !== 'object') throw httpError(400, `messages[${index}] must be an object`);
    if (!['system', 'user', 'assistant'].includes(message.role)) throw httpError(400, `Invalid role at messages[${index}]`);
    if (typeof message.content !== 'string') throw httpError(400, `messages[${index}].content must be a string`);
    if (message.content.length > MAX_MESSAGE_CHARS) throw httpError(400, `messages[${index}] is too long`);
    total += message.content.length;
    return { role: message.role, content: message.content };
  });
  if (total > MAX_TOTAL_CHARS) throw httpError(400, 'Conversation is too long');

  const upstream = { model, messages, stream: true };
  if (body.temperature !== undefined && body.temperature !== null && body.temperature !== '') {
    const temperature = Number(body.temperature);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw httpError(400, 'temperature must be between 0 and 2');
    upstream.temperature = temperature;
  }
  if (body.max_tokens !== undefined && body.max_tokens !== null && body.max_tokens !== '') {
    const maxTokens = Number(body.max_tokens);
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 200_000) throw httpError(400, 'max_tokens must be an integer between 1 and 200000');
    upstream.max_tokens = maxTokens;
  }
  return upstream;
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function upstreamErrorDetail(text) {
  try {
    const parsed = JSON.parse(text);
    return String(parsed?.error?.message || parsed?.message || parsed?.error || 'Upstream error').slice(0, 1000);
  } catch {
    return String(text || 'Upstream error').slice(0, 1000);
  }
}

export function createApp(config) {
  const limiter = createLoginLimiter();
  const publicFiles = new Map();
  for (const name of new Set(FILES.values())) {
    try {
      publicFiles.set(name, fs.readFileSync(path.join(config.publicDir, name)));
    } catch {
      // A missing optional file should not stop the server.
    }
  }
  let modelsCache = null;

  async function fetchModels() {
    if (modelsCache && Date.now() - modelsCache.at < 5 * 60 * 1000) return modelsCache.payload;
    const response = await fetch(`${config.baseUrl}/models`, {
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        accept: 'application/json',
        'x-opencode-session': crypto.randomUUID(),
      },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    if (!response.ok) throw httpError(502, `Model list failed (${response.status}): ${upstreamErrorDetail(text)}`);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw httpError(502, 'Model list returned invalid JSON');
    }
    const data = Array.isArray(parsed?.data)
      ? parsed.data
          .filter((model) => model && typeof model.id === 'string' && (!model.type || model.type === 'chat'))
          .map((model) => ({ id: model.id, name: model.name || model.id, description: model.description || '' }))
      : [];
    const payload = { data, default: config.defaultModel, fetchedAt: new Date().toISOString() };
    modelsCache = { at: Date.now(), payload };
    return payload;
  }

  async function handleLogin(req, res) {
    const ip = clientIp(req);
    if (req.method !== 'POST') return send(res, 200, loginPage());
    if (limiter.blocked(ip)) return send(res, 429, loginPage('Too many attempts. Try again in 15 minutes.'));
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 4096) {
        req.destroy();
        return;
      }
      chunks.push(chunk);
    }
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    const password = form.get('password') || '';
    if (passwordMatches(password, config.genericPassword)) {
      limiter.reset(ip);
      return send(res, 303, '', {
        location: '/',
        'set-cookie': makeSessionCookie(config),
      });
    }
    const count = limiter.failed(ip);
    console.warn(`gate: failed login from ${ip} (#${count})`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** (count - 1), 8000)));
    send(res, 401, loginPage('Wrong password.'));
  }

  async function handleModels(req, res) {
    try {
      const payload = await fetchModels();
      sendJson(res, 200, payload, { 'cache-control': 'private, max-age=60' });
    } catch (error) {
      console.error('models:', error.message);
      sendJson(res, error.status || 502, { error: error.message || 'Model list unavailable' });
    }
  }

  async function handleChat(req, res) {
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Cross-origin request rejected' });
    const contentType = String(req.headers['content-type'] || '');
    if (!contentType.startsWith('application/json')) return sendJson(res, 415, { error: 'Expected application/json' });
    let body;
    try {
      body = normalizeChat(await readJson(req), config);
    } catch (error) {
      return sendJson(res, error.status || 400, { error: error.message || 'Invalid request' });
    }

    const controller = new AbortController();
    const abortOnClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', abortOnClose);

    let upstream;
    try {
      upstream = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'x-opencode-session': crypto.randomUUID(),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      res.off('close', abortOnClose);
      if (controller.signal.aborted) return;
      console.error('chat connect:', error.message);
      return sendJson(res, 502, { error: 'OpenCode Go is unreachable' });
    }

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      res.off('close', abortOnClose);
      console.error(`chat upstream ${upstream.status}: ${upstreamErrorDetail(text)}`);
      return sendJson(res, upstream.status >= 500 ? 502 : upstream.status, {
        error: 'OpenCode Go request failed',
        status: upstream.status,
        detail: upstreamErrorDetail(text),
      });
    }

    const type = upstream.headers.get('content-type') || '';
    if (!type.includes('text/event-stream') || !upstream.body) {
      const text = await upstream.text().catch(() => '');
      res.off('close', abortOnClose);
      return sendJson(res, 502, { error: 'OpenCode Go did not return a stream', detail: upstreamErrorDetail(text) });
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    try {
      await pipeline(Readable.fromWeb(upstream.body), res);
    } catch (error) {
      if (!controller.signal.aborted) console.error('chat stream:', error.message);
    } finally {
      res.off('close', abortOnClose);
    }
  }

  const server = http.createServer(async (req, res) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return send(res, 400, 'Bad request', { 'content-type': 'text/plain; charset=utf-8' });
    }

    try {
      if (pathname === '/__gate/health') {
        return send(res, 200, 'ok', { 'content-type': 'text/plain; charset=utf-8' });
      }
      if (pathname === '/__gate/login') return await handleLogin(req, res);
      if (pathname === '/__gate/logout') {
        return send(res, 303, '', {
          location: '/__gate/login',
          'set-cookie': `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${config.cookieSecure ? '; Secure' : ''}`,
        });
      }
      if (!validSession(req, config)) {
        if (pathname.startsWith('/api') || req.method !== 'GET') return sendJson(res, 401, { error: 'unauthorized' });
        return send(res, 302, '', { location: '/__gate/login' });
      }

      if (pathname === '/api/models') {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
        return await handleModels(req, res);
      }
      if (pathname === '/api/chat') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
        return await handleChat(req, res);
      }

      const file = FILES.get(pathname);
      if (req.method === 'GET' && file && publicFiles.has(file)) {
        return send(res, 200, publicFiles.get(file), {
          'content-type': MIME[path.extname(file)] || 'application/octet-stream',
          'cache-control': 'no-cache',
        });
      }
      send(res, 404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' });
    } catch (error) {
      console.error('request:', error.message);
      if (!res.headersSent) {
        const status = error.status || 500;
        return sendJson(res, status, { error: status === 500 ? 'Internal server error' : error.message });
      }
      res.destroy();
    }
  });

  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;
  return { server, config };
}

async function main() {
  try {
    const envPath = path.join(ROOT, '.env');
    if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
  } catch (error) {
    console.error('env: could not load .env:', error.message);
  }

  let config;
  try {
    config = readConfig();
  } catch (error) {
    console.error(`config: ${error.message}`);
    process.exit(1);
  }

  const { server } = createApp(config);
  server.listen(config.port, config.host, () => {
    console.log(`chat-test-site listening on http://${config.host}:${config.port}`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
