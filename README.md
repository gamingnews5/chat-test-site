# Chat Test Site

A one-page OpenCode Go prompt tester. It keeps the system prompt, message, model,
temperature, max tokens, draft, and chat history in browser localStorage. A tiny
Node 22 server proxies the API key, streams replies, and puts the whole site behind
the same password-cookie gate used by the a1 stack.

## Run locally

```bash
cp .env.example .env
chmod 600 .env
# fill OPENCODE_API_KEY, GENERIC_PASSWORD, GATE_COOKIE_SECRET
npm start
```

Open http://127.0.0.1:8810 and sign in with `GENERIC_PASSWORD`. Set
`COOKIE_SECURE=false` only for local HTTP; keep it true behind Cloudflare.

## Checks

```bash
npm test
npm run test:live   # real OpenCode Go call with deepseek-v4.1-flash
```

The unit/integration suite uses a local mock upstream. The live check needs `.env`.
Never use `deepseek-v4-pro` for checks; use `deepseek-v4.1-flash`.

## Deployment shape

`compose.yaml` builds the image and publishes only `127.0.0.1:8810`. The a1-stack
Cloudflare tunnel should route `chat.aidark.net` to that port. The gate is part of
the app: `/__gate/login`, `/__gate/logout`, `/__gate/health`, 30-day `chat_gate`
cookie. Secrets live only in the one app `.env` (mode 600).

### Remaining deploy steps (not done yet)

1. Copy this checkout to a1, for example `/home/ubuntu/apps/chat-test-site`.
2. Create `.env` on a1 (mode 600) with `API Keys/Zen/API Key` from KeePass,
   Igor's `GENERIC_PASSWORD`, and a new `GATE_COOKIE_SECRET`. Set
   `COOKIE_SECURE=true`, `HOST=0.0.0.0`, `PORT=8810`.
3. On a1: `docker compose up -d --build`, then check
   `curl http://127.0.0.1:8810/__gate/health` and a login.
4. In the a1-stack tunnel ingress, add `chat.aidark.net -> http://127.0.0.1:8810`
   before the 404 catch-all. Create the proxied DNS CNAME for `chat.aidark.net`
   to `cae29d7b-900c-41f1-a571-bc57ecd0885b.cfargotunnel.com`.
5. Verify HTTPS login, model list, streaming chat, and Stop through the tunnel.

No a1 container, tunnel ingress, or DNS record has been changed yet.
