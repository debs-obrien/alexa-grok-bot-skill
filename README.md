# Alexa → Grok Bot skill

Talk to your bot from an Amazon Echo. Say *"Alexa, ask chief bot what's on my calendar tomorrow"*: this Cloudflare Worker verifies the request really came from Alexa and your skill, forwards the spoken query to your bot's webhook as a **read-only** request, and Alexa says a short "On it". The real answer arrives later in your bot's chat.

Built for Grok Bot webhooks, but it works with **any bot that has an HTTPS webhook**. The only file you need to adapt is [`src/wake.ts`](src/wake.ts) (payload shape and auth headers).

Full walkthrough, gotchas and screenshots: **[Talk to my bots through Alexa](https://debbie.codes/blog/talk-to-my-bots-through-alexa/)**.

## Why ack-only?

| Constraint | Reality |
| --- | --- |
| Alexa final response | Hard limit of ~**8 seconds**. Progressive responses don't extend it. |
| Bot webhook | Fire-and-forget: HTTP 200 means the routine *woke*, not that it finished. |
| Result | Alexa always speaks a short ack; the answer lands in chat. |

## Quick start

Prerequisites: Node 22+, a Cloudflare account (free plan is fine), an Amazon developer account, and a bot with a webhook URL and key.

1. **Create the skill.** In the [Alexa Developer Console](https://developer.amazon.com/alexa/console/ask): Create Skill → Custom → Provision your own. Paste the interaction model from `skill-package/interactionModels/custom/` (`en-GB.json` / `en-US.json`; invocation name `chief bot`, change it if you like). Save and **Build Model**.
2. **Copy the skill ID** (`amzn1.ask.skill.…`) from the skill list.
3. **Set it** in `wrangler.toml` → `[vars]` → `SKILL_APPLICATION_ID`. It's not a secret. The Worker rejects any other skill and rejects everything if it's unset.
4. **Install, log in and add secrets:**
   ```bash
   npm ci
   npx wrangler login
   npx wrangler secret put COS_WEBHOOK_URL   # your bot's webhook URL
   npx wrangler secret put COS_WEBHOOK_KEY   # your bot's webhook key
   ```
5. **Deploy:** `npm run deploy`. Wrangler prints `https://<your-worker>.<your-subdomain>.workers.dev`.
6. **Paste the endpoint** in the console under Endpoint → HTTPS: `https://<your-worker>.<your-subdomain>.workers.dev/alexa`, with the SSL option *"My development endpoint is a sub-domain of a domain that has a wildcard certificate"*. Save.
7. **Test tab:** set skill testing to **Development**.
8. **Match the Echo's language.** The skill must have a locale matching your Echo's language (e.g. English (UK) vs English (US)), and the Echo must be on the same Amazon account as the developer console. Otherwise Alexa won't find the skill.

Then: *"Alexa, ask chief bot what's on my calendar tomorrow."*

## Read-only mode: your bot must honour it

Alexa proves a request came from Alexa and your skill, **not who was speaking**. Anyone near the Echo (or a TV) can talk to it. So every webhook call is marked read-only:

```json
{
  "query": "what's on my calendar tomorrow",
  "source": "alexa",
  "requestId": "amzn1.echo-api.request.…",
  "timestamp": "2026-10-05T21:00:05Z",
  "mode": "read-only",
  "policy": "Voice request via Alexa: speaker is not verified. Only look things up, summarise and answer in chat. Anything that sends, deletes, buys, accepts or changes something needs the owner's explicit confirm in chat first.",
  "message": "<policy>\n\nRequest: <query>"
}
```

Headers: `Authorization: Bearer <COS_WEBHOOK_KEY>` and `X-Automation-Key: <COS_WEBHOOK_KEY>`. One try, ~6 s timeout.

**The Worker can only label the request.** The receiving bot's routine has to enforce it: look things up and answer in chat, and ask for a confirm in chat before sending, deleting, buying, accepting or changing anything.

## Local development (mock mode)

```bash
cp .env.example .env
npm ci
npm test               # unit tests
npm run dev            # Express on http://127.0.0.1:43127
npm run curl:fixtures  # health + launch / ask / help against /alexa
```

`MOCK_COS=1` (or no `COS_WEBHOOK_URL`) skips the real POST and logs the payload. `DEV_SKIP_VERIFY=1` lets unsigned fixtures through locally. **Never set it in production**: the config refuses to start if you do.

Local Worker preview: `cp .dev.vars.example .dev.vars && npm run dev:worker`.

## Security

- Amazon signature (`Signature-256` + cert chain URL) and timestamp verified on every request; fails closed.
- Skill ID lock via `SKILL_APPLICATION_ID`.
- Webhook URL and key live in Wrangler secrets, never in git.
- Voice requests are read-only (see above).

## Repo layout

```
src/worker.ts     Cloudflare Worker entry (/alexa + /health)
src/http-app.ts   Shared request handler and intent routing (Worker + Express)
src/verify.ts     Alexa signature + timestamp verification
src/wake.ts       Webhook call to your bot (the file to adapt)
src/speech.ts     Spoken responses
src/config.ts     Env config
src/server.ts     Optional local Express server
skill-package/    skill.json + interaction models
fixtures/         Sample Alexa requests
```

## What it doesn't do

- Speak the bot's final answer (Alexa's 8 s limit; the answer goes to chat).
- Replace the "Alexa" wake word.
- Public Skill Store certification (it's meant to run as a private, in-development skill).

## License

MIT © 2026 Debbie O'Brien
