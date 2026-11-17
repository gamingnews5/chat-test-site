import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, readConfig } from '../server.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envPath = path.join(ROOT, '.env');
if (!fs.existsSync(envPath)) {
  console.error('live-check: .env is missing (see .env.example)');
  process.exit(1);
}
process.loadEnvFile(envPath);

let config;
try {
  config = readConfig({ ...process.env, HOST: '127.0.0.1', PORT: '0', COOKIE_SECURE: 'false' });
} catch (error) {
  console.error(`live-check: ${error.message}`);
  process.exit(1);
}

const { server } = createApp(config);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  const login = await fetch(`${base}/__gate/login`, {
    method: 'POST',
    body: new URLSearchParams({ password: config.genericPassword }),
    redirect: 'manual',
  });
  if (login.status !== 303) throw new Error(`gate login returned ${login.status}`);
  const cookie = login.headers.getSetCookie()[0].split(';')[0];

  const modelsResponse = await fetch(`${base}/api/models`, { headers: { cookie } });
  if (!modelsResponse.ok) throw new Error(`/api/models returned ${modelsResponse.status}`);
  const models = await modelsResponse.json();
  if (!models.data.some((model) => model.id === 'deepseek-v4.1-flash')) {
    throw new Error('deepseek-v4.1-flash is not in the model list');
  }

  const chatResponse = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      temperature: 0,
      max_tokens: 64,
      messages: [
        { role: 'system', content: 'Reply in one short sentence.' },
        { role: 'user', content: 'Say exactly: live check passed' },
      ],
    }),
  });
  if (!chatResponse.ok) throw new Error(`/api/chat returned ${chatResponse.status}: ${await chatResponse.text()}`);

  const reader = chatResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let done = false;
  while (!done) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n');
    let index;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') { done = true; continue; }
        try {
          const event = JSON.parse(data);
          content += event?.choices?.[0]?.delta?.content || '';
        } catch {
          // Ignore keepalive or non-JSON frames.
        }
      }
    }
  }
  if (!content.trim()) throw new Error('stream produced no content');
  console.log(`LIVE OK: ${models.data.length} models, deepseek-v4.1-flash reply: ${JSON.stringify(content.trim().slice(0, 120))}`);
} finally {
  await new Promise((resolve) => server.close(resolve));
}
