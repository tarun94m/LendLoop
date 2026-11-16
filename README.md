# LendLoop — neighborhood tool lending

Next.js (App Router) · Clerk · Convex · n8n · TypeScript.
> Status: written to spec but **not yet run end-to-end** in my sandbox. Expect to run `npm i` and `npx convex dev` (which generates `convex/_generated`) and fix any small typing nits.

## Local setup
1. `npm install`
2. **Clerk**: create an app → *JWT Templates → New → Convex* (name must be `convex`; includes `email`/`name`). Copy keys into `.env.local` (see `.env.example`).
3. **Convex**: `npx convex dev`, then set deployment env vars:
   ```
   npx convex env set CLERK_JWT_ISSUER_DOMAIN https://<instance>.clerk.accounts.dev
   npx convex env set N8N_WEBHOOK_URL http://host.docker.internal:5678/webhook/lendloop-request   # use a tunnel (ngrok) if Convex Cloud must reach local n8n
   npx convex env set LENDLOOP_WEBHOOK_SECRET $(openssl rand -hex 32)
   npx convex env set N8N_API_KEY $(openssl rand -hex 32)
   ```
4. `npm run dev`, sign in once, then make yourself admin: `npx convex run users:makeAdmin '{"clerkId":"user_xxx"}'` (internal function, not callable from clients).
5. **n8n**: create `.env.n8n` (`LENDLOOP_WEBHOOK_SECRET`, `CONVEX_SITE_URL`, `N8N_ENCRYPTION_KEY`), `docker compose up -d`, open :5678, then:
   - Credentials → new **Header Auth** named `LendLoop Convex API key`: header `Authorization`, value `Bearer <N8N_API_KEY>`.
   - Import the three files in `n8n/`; re-select the credential on the HTTP nodes.
   - In workflows 1 and 2 → Settings → **Error workflow** = "LendLoop - Error handler". Activate all three.

## Architecture
```
Browser ─Clerk JWT─▶ Convex (queries/mutations; RBAC)
Convex mutation ─scheduler─▶ internal action notify ─HMAC-signed POST─▶ n8n webhook ─▶ notify
n8n daily cron ─Bearer GET /overdue─▶ Convex ─▶ n8n sends reminder ─Bearer POST /reminder-result─▶ Convex (idempotent)
Any n8n failure ─Error Trigger─▶ POST /automation-failure ─▶ recorded in automationEvents + Convex logs
```
`automationEvents` is both the audit trail (shown on each loan: "reminder: sent 2 days ago") and the idempotency ledger.

## Security & data-minimization decisions
- **RBAC in Convex**: every function starts with `requireUser`/`requireAdmin` (convex/lib.ts); identity comes from the verified JWT, never args. Roles live in the `users` table; clients cannot set them (`makeAdmin` is `internalMutation`). Ownership is checked per-document: only the owner approves/declines/edits/deletes; owner **or** admin marks returned; admin may remove any listing (not edit), view all loans, toggle Trusted Lender. Borrowers can't request their own tools; dates and lengths validated; overlap with approved loans rejected.
- **Public query** `tools.listPublic` returns only `name` + `category` (+opaque id), no owner data.
- **Convex → n8n**: HMAC-SHA256 over `timestamp.body`, verified in n8n with `timingSafeEqual` and a 5-min replay window. Payload contains only event type, tool name, dates, and the recipient's name/email — no ids of users, descriptions, or other party's details.
- **n8n → Convex**: bearer key in an n8n Header Auth credential, compared in constant time. Overdue endpoint returns only what a reminder needs.
- **Secrets** only in env/credentials; exported workflow JSON holds a credential *reference*, no secret. Trade-off: the HMAC secret is read via `$env` in a Code node (requires `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` and `NODE_FUNCTION_ALLOW_BUILTIN=crypto`).
- **Idempotency**: events keyed `notify:<type>:<loan>` and `reminder:<loan>:<date>`; `/reminder-result` and `recordEvent` ignore duplicates, and `/overdue` omits loans already reminded today, so retries/re-runs never double-send.
- **Failure handling**: Convex retries webhook delivery 5× with exponential backoff and records `retrying`/`failed`; n8n nodes use retryOnFail; the error workflow reports to Convex so nothing fails silently. Webhook uses "Respond to Webhook" so verification failures return non-2xx and trigger Convex retries.

## Production hardening (implemented vs. remaining)
| Item | Status |
|---|---|
| Real email | **Built**: workflow 1 sends through Resend (Header Auth credential `Resend API key`, `MAIL_FROM` env). Users can opt out (`notifyEmail`); Convex records `skipped` and never calls n8n. *Remaining*: verified domain DKIM/SPF (provider setup) and a bounce/complaint webhook feeding a suppression list. |
| Date conflicts | **Already enforced**, in Convex transactions, against *approved* loans at request time and again at approval time, so two concurrent approvals cannot both succeed. Pending requests intentionally don't block each other. *Option*: soft holds with expiry. |
| n8n infra | **Built**: `docker-compose.yml` runs queue mode (Postgres + Redis + worker). Inject secrets from a manager, e.g. `doppler run -- docker compose up` (n8n's native external-secrets is Enterprise-only). Error workflow also posts to `OPS_ALERT_WEBHOOK_URL` (Slack-compatible; PagerDuty via its Events API webhook). |
| Clerk sync | **Built**: `/clerk-webhook` verifies the Svix signature and 5-min replay window; `user.deleted` deactivates the account, deletes its listings (unless on loan), declines open requests, and blocks all later calls. Set `CLERK_WEBHOOK_SECRET` in Convex and point a Clerk webhook at `<CONVEX_SITE_URL>/clerk-webhook`. *Remaining*: handle `user.updated`; resolve loans that were active at deletion. |
| Audit + rate limit | **Built**: `auditLogs` records admin removals, Trusted Lender changes and deactivations (visible in Admin tab); borrow requests capped at 10/hour/user. *Remaining*: rate limits on other mutations. |

Still to do: verify HMAC over the raw body, HMAC-sign n8n→Convex write-backs with key rotation, per-user time zones, `convex-test` RBAC tests + CI.
