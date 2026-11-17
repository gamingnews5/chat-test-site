import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PASSWORD = 'correct-horse-battery';
const API_KEY = 'test-api-key';
let upstream;
let upstreamBase;
let appServer;
let base;
let cookie = '';
let lastChat = null;

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

before(async () => {
  upstream = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/models') {
      return json(res, 200, {
        object: 'list',
        data: [
          { id: 'deepseek-v4.1-flash', object: 'model', type: 'chat', name: 'DeepSeek V4.1 Flash' },
          { id: 'glm-5.3', object: 'model', type: 'chat', name: 'GLM-5.3' },
        ],
      });
    }

    if (req.method === 'POST' && req.url === '/chat/completions') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      lastChat = { headers: req.headers, body };
      if (body.model === 'fail-model' || body.model === 'deepseek-v4-pro') {
        return json(res, 429, { error: { message: 'quota exhausted' } });
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"po"}}]}\n\n');
      setTimeout(() => {
        res.write('data: {"choices":[{"delta":{"content":"ng"}}]}\n\n');
        res.end('data: [DONE]\n\n');
      }, 10);
      return;
    }

    json(res, 404, { error: 'not found' });
  });

  const upstreamPort = await listen(upstream);
  upstreamBase = `http://127.0.0.1:${upstreamPort}`;
  const { server } = createApp({
    port: 0,
    host: '127.0.0.1',
    apiKey: API_KEY,
    baseUrl: upstreamBase,
    defaultModel: 'deepseek-v4.1-flash',
    genericPassword: PASSWORD,
    cookieSecret: 'test-cookie-secret-that-is-long-enough-123',
    sessionDays: 30,
    cookieSecure: false,
    publicDir: path.join(ROOT, 'public'),
  });
  appServer = server;
  const port = await listen(server);
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => appServer.close(resolve));
  await new Promise((resolve) => upstream.close(resolve));
});

test('health and gate redirect', async () => {
  const health = await fetch(`${base}/__gate/health`);
  assert.equal(health.status, 200);
  assert.equal(await health.text(), 'ok');

  const page = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/__gate/login');

  const api = await fetch(`${base}/api/models`);
  assert.equal(api.status, 401);
  assert.deepEqual(await api.json(), { error: 'unauthorized' });
});

test('login rejects a bad password and accepts the generic password', async () => {
  const bad = await fetch(`${base}/__gate/login`, {
    method: 'POST',
    body: new URLSearchParams({ password: 'wrong' }),
    redirect: 'manual',
  });
  assert.equal(bad.status, 401);
  assert.match(await bad.text(), /Wrong password/);

  const good = await fetch(`${base}/__gate/login`, {
    method: 'POST',
    body: new URLSearchParams({ password: PASSWORD }),
    redirect: 'manual',
  });
  assert.equal(good.status, 303);
  assert.equal(good.headers.get('location'), '/');
  const setCookies = good.headers.getSetCookie();
  assert.equal(setCookies.length, 1);
  assert.match(setCookies[0], /HttpOnly/);
  cookie = setCookies[0].split(';')[0];
  assert.match(cookie, /^chat_gate=/);
});

test('authenticated page, tampered cookie, and model list', async () => {
  const page = await fetch(`${base}/`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Chat Test Site<\/title>/);

  const css = await fetch(`${base}/styles.css`, { headers: { cookie } });
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);

  const tampered = await fetch(`${base}/api/models`, { headers: { cookie: cookie.slice(0, -1) + 'x' } });
  assert.equal(tampered.status, 401);

  const models = await fetch(`${base}/api/models`, { headers: { cookie } });
  assert.equal(models.status, 200);
  const payload = await models.json();
  assert.deepEqual(payload.data.map((model) => model.id), ['deepseek-v4.1-flash', 'glm-5.3']);
  assert.equal(payload.default, 'deepseek-v4.1-flash');
});

test('chat streams from the mocked upstream with the required headers', async () => {
  const response = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      temperature: 0.2,
      max_tokens: 128,
      messages: [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'ping' },
      ],
    }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const text = await response.text();
  assert.match(text, /"po"/);
  assert.match(text, /"ng"/);
  assert.match(text, /\[DONE\]/);

  assert.equal(lastChat.headers.authorization, `Bearer ${API_KEY}`);
  assert.match(lastChat.headers['x-opencode-session'], /^[0-9a-f-]{36}$/);
  assert.equal(lastChat.body.stream, true);
  assert.equal(lastChat.body.model, 'deepseek-v4.1-flash');
  assert.equal(lastChat.body.temperature, 0.2);
  assert.equal(lastChat.body.max_tokens, 128);
  assert.deepEqual(lastChat.body.messages, [
    { role: 'system', content: 'Be terse.' },
    { role: 'user', content: 'ping' },
  ]);
});

test('chat validates input and forwards upstream errors', async () => {
  const invalid = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'bad model!', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /Invalid model/);

  const failed = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fail-model', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(failed.status, 429);
  assert.equal((await failed.json()).detail, 'quota exhausted');

  const noJson = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'text/plain' },
    body: 'hi',
  });
  assert.equal(noJson.status, 415);
});
