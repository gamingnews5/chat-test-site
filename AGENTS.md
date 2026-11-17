# chat-test-site

Single-page OpenCode Go chat tester for `chat.aidark.net`. Node 22, no runtime
dependencies. Public UI in `public/`; gate, model list, and streaming proxy in
`server.js`.

## Commands

- `npm start` - local server on `127.0.0.1:8810` (loads `.env`).
- `npm test` - integration tests against a local mock upstream.
- `npm run test:live` - real OpenCode Go stream check; needs `.env`.
- `node --check server.js && node --check public/app.js` - syntax check.

## Notes

- OpenCode Go direct base: `https://opencode.ai/zen/go/v1`; models at
  `/models`, streaming chat at `/chat/completions`. Send
  `Authorization: Bearer $OPENCODE_API_KEY` and a UUID `x-opencode-session`.
- Use `deepseek-v4.1-flash` for every check. Never test with `deepseek-v4-pro`.
- Secrets live only in one mode-600 app `.env`: `OPENCODE_API_KEY` from KeePass
  `API Keys/Zen/API Key`, `GENERIC_PASSWORD` from `API Keys/bb.aidark.net/gate`,
  and `GATE_COOKIE_SECRET`. No gate.env or second credential file.
- Gate cookie is `chat_gate`; endpoints are `/__gate/login`, `/__gate/logout`,
  `/__gate/health`; password compare uses SHA-256 digests and `timingSafeEqual`.
- Browser state keys: `chatTestSite.settings.v1`, `chatTestSite.history.v1`.
- Local HTTP needs `COOKIE_SECURE=false`; production keeps it true.
- a1 target: container `chat-test-site`, `127.0.0.1:8810 -> 8810`, read-only,
  cap-drop ALL, 256 MB. Domain through the existing `a1-stack` tunnel.
- Not deployed. Remaining steps: README "Remaining deploy steps". Do not touch
  DNS or the tunnel until asked.
