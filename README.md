# LendLoop

> Borrow what you need. Lend what you don't.

A neighborhood tool-lending board. Neighbors list tools, request to borrow them for a date range, approve or decline requests, and get automated notifications and overdue reminders handled by **n8n**.

**Stack:** Next.js (App Router) · Clerk (auth) · Convex (data + backend logic) · n8n (workflow automation, self-hosted via Docker) · TypeScript

---

## Features

**Public page** (signed out): LendLoop name and tagline, a read-only list of available tools (**name and category only**, no owner details), and a "Sign in to lend or borrow" button (Clerk).

**Signed-in users**

- List a tool (name, category, condition, short description); edit and delete their own listings.
- Browse all tools with availability status, filterable by category.
- Request a tool for a date range; approve or decline requests on their own tools; mark a loan returned.
- Views: **Browse**, **My listings**, **My requests**, **Incoming requests**.
- Toggle email notifications on or off.
- See recent automation activity on each loan, e.g. "overdue reminder: sent today".

**Admins** (extra): remove any listing, view all loans, mark a lender as "Trusted Lender", and read an audit log of admin actions.

---

## Architecture

```
Browser ──Clerk JWT──▶ Convex (queries / mutations, RBAC enforced here)
                         │
   loan created / approved / declined / returned
                         ▼
         scheduler ─▶ internal action `automation:notify`
                         │  HMAC-SHA256 signed POST (retried with backoff)
                         ▼
                 n8n webhook ─▶ verify signature ─▶ compose ─▶ notify (mock / Resend)

n8n daily schedule ─Bearer GET /overdue─▶ Convex HTTP endpoint
                   ─▶ remind each borrower
                   ─Bearer POST /reminder-result (idempotent)─▶ Convex

Any n8n workflow failure ─▶ Error workflow ─▶ POST /automation-failure ─▶ Convex + ops alert
Clerk user.deleted ─Svix-signed POST /clerk-webhook─▶ Convex (deactivate account)
```

| Path                                      | Purpose                                                                      |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| `app/`                                    | Next.js UI (`page.tsx` public page, `dashboard/Dashboard.tsx` signed-in app) |
| `convex/schema.ts`                        | Tables: `users`, `tools`, `loans`, `automationEvents`, `auditLogs`           |
| `convex/lib.ts`                           | `requireUser` / `requireAdmin` guards, audit helper                          |
| `convex/tools.ts`, `loans.ts`, `users.ts` | Queries and mutations with access rules                                      |
| `convex/automation.ts`                    | Signed webhook to n8n, retries with exponential backoff                      |
| `convex/http.ts`                          | HTTP endpoints for n8n and Clerk                                             |
| `n8n/`                                    | Exported workflows (see below)                                               |
| `docker-compose.yml`                      | n8n in queue mode (Postgres + Redis + worker)                                |

`automationEvents` is both the **audit trail** (shown on each loan in the UI) and the **idempotency ledger** (unique `eventKey` per notification or reminder).

---

## Local setup

**Prerequisites:** Node 20+, Docker, free Clerk and Convex accounts, and a tunnel (ngrok or cloudflared) so Convex Cloud can reach your local n8n.

### 1. Install

```bash
npm install
```

### 2. Clerk

1. Create a Clerk application.
2. In the Clerk dashboard, go to **Configure → JWT templates → New template → Convex**. Keep the name `convex`, and set the claims to:
   ```json
   {
     "aud": "convex",
     "name": "{{user.full_name}}",
     "email": "{{user.primary_email_address}}"
   }
   ```
   The `email` and `name` claims are what Convex uses as the notification recipient and display name.
3. Copy the publishable key, the secret key, and the issuer URL (`https://<instance>.clerk.accounts.dev`).

### 3. Convex

```bash
npx convex dev        # logs in, creates a dev deployment, writes NEXT_PUBLIC_CONVEX_URL to .env.local
```

Leave it running. In another terminal set the deployment variables:

```bash
npx convex env set CLERK_JWT_ISSUER_DOMAIN https://<instance>.clerk.accounts.dev
npx convex env set LENDLOOP_WEBHOOK_SECRET <random hex>    # Convex -> n8n signing key
npx convex env set N8N_API_KEY <random hex>                # n8n -> Convex bearer token
```

Generate random values with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

### 4. Environment files

Create these in the project root (all are git-ignored):

`.env.local`

```
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
NEXT_PUBLIC_CONVEX_URL=https://<deployment>.convex.cloud
```

`.env` (read by Docker Compose for variable substitution)

```
POSTGRES_PASSWORD=<choose a password>
```

`.env.n8n` (passed into the n8n containers)

```
LENDLOOP_WEBHOOK_SECRET=<same value as in Convex>
CONVEX_SITE_URL=https://<deployment>.convex.site
N8N_ENCRYPTION_KEY=<random hex>
POSTGRES_PASSWORD=<same as .env>
MAIL_FROM=LendLoop <onboarding@resend.dev>
OPS_ALERT_WEBHOOK_URL=<Slack-compatible incoming webhook, optional>
```

### 5. Run the app

```bash
npm run dev           # http://localhost:3000
```

Sign up, then make yourself an admin (the user must have signed in once so a row exists):

```bash
npx convex run users:makeAdmin '{"clerkId":"user_..."}'
```

(On Windows PowerShell use `'{clerkId: \"user_...\"}'`.) `makeAdmin` is an `internalMutation`, so it can only be run from the CLI or dashboard, never from a client.

### 6. n8n

```bash
docker compose up -d       # n8n, n8n-worker, postgres, redis
```

1. Open `http://localhost:5678` and create the owner account.
2. **Credentials → Header Auth**: header name `Authorization`, value `Bearer <N8N_API_KEY>`. Select it on every HTTP Request node.
3. Import the three files in `n8n/`. **Import each into its own blank workflow**; importing while another workflow is open merges the nodes into it.
4. Publish **LendLoop - Error handler** first. In the other two workflows open **⋯ → Settings → Error workflow** and select it (only published workflows are listed, and a workflow cannot be its own error workflow).
5. Publish **Request notification** and **Overdue reminders**.
6. Expose n8n to Convex Cloud and tell Convex the webhook URL:
   ```bash
   ngrok http 5678      # or: cloudflared tunnel --url http://localhost:5678
   npx convex env set N8N_WEBHOOK_URL https://<tunnel-host>/webhook/lendloop-request
   ```
   Free tunnel URLs change on restart, so re-run the `env set` command when they do. For manual `curl` / `Invoke-WebRequest` tests through ngrok, add the header `ngrok-skip-browser-warning: true`.

### 7. Optional: real email and Clerk webhook

- **Resend:** create a Header Auth credential `Resend API key` (`Authorization: Bearer re_...`), select it on the "Send email (Resend)" node, and activate that node. It is **deactivated by default**; the workflow's "Compose + mock notify" node produces the message and recipient either way.
- **Clerk deletion sync:** add a Clerk webhook endpoint `<CONVEX_SITE_URL>/clerk-webhook` for `user.deleted`, then `npx convex env set CLERK_WEBHOOK_SECRET whsec_...`.

---

## Environment variables

| Variable                                                | Where                       | Purpose                                             |
| ------------------------------------------------------- | --------------------------- | --------------------------------------------------- |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | `.env.local`                | Clerk keys (secret key is server-only)              |
| `NEXT_PUBLIC_CONVEX_URL`                                | `.env.local`                | Convex client URL                                   |
| `CLERK_JWT_ISSUER_DOMAIN`                               | Convex env                  | Issuer Convex trusts for login tokens               |
| `LENDLOOP_WEBHOOK_SECRET`                               | Convex env + `.env.n8n`     | HMAC key for Convex → n8n payloads                  |
| `N8N_API_KEY`                                           | Convex env + n8n credential | Bearer token for n8n → Convex endpoints             |
| `N8N_WEBHOOK_URL`                                       | Convex env                  | Production webhook URL of the notification workflow |
| `CLERK_WEBHOOK_SECRET`                                  | Convex env (optional)       | Verifies Svix signatures on `/clerk-webhook`        |
| `CONVEX_SITE_URL`                                       | `.env.n8n`                  | Base URL of Convex HTTP endpoints (`*.convex.site`) |
| `N8N_ENCRYPTION_KEY`                                    | `.env.n8n`                  | Encrypts n8n credentials at rest                    |
| `POSTGRES_PASSWORD`                                     | `.env` and `.env.n8n`       | n8n's database                                      |
| `MAIL_FROM`, `OPS_ALERT_WEBHOOK_URL`                    | `.env.n8n`                  | Email sender; ops alert channel                     |

`.env.example` lists all of these with placeholders. Real values are never committed.

---

## Roles and access control

Roles live in the Convex `users` table. They are never accepted from the client: new users are always `user`, and `users:makeAdmin` is an internal function. **Every rule is enforced inside Convex functions**, not just hidden in the UI.

| Action                                     | user                                                                                  | admin                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------- | ----------------------------- |
| Read the public tool list (name, category) | yes, signed out too                                                                   | yes                           |
| Create a listing                           | yes                                                                                   | yes                           |
| Edit / delete a listing                    | own only                                                                              | **remove** any; edit own only |
| Request to borrow                          | yes (not own tool, valid future dates, no overlap with an approved loan, max 10/hour) | same                          |
| Approve / decline a request                | only on own tools                                                                     | only on own tools             |
| Mark a loan returned                       | owner of the tool                                                                     | owner or any loan             |
| View loans                                 | own borrowing and incoming only                                                       | all loans (`loans:adminAll`)  |
| Mark Trusted Lender, read audit log        | no                                                                                    | yes                           |

Implementation notes:

- `requireUser` resolves the caller from the verified Clerk JWT (`ctx.auth`), never from arguments, and rejects deactivated accounts. `requireAdmin` builds on it.
- Ownership is checked per document, so knowing an id grants nothing.
- Overlapping-date conflicts are checked against `approved` loans both at request time and again at approval time, inside Convex transactions, so two concurrent approvals cannot both succeed. Pending requests intentionally don't block each other.
- Admin actions (listing removal, trusted-lender changes) and account deactivations are written to `auditLogs`.

---

## n8n workflows (`n8n/`)

| File                          | Trigger        | What it does                                                                                                                                          |
| ----------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `1-request-notification.json` | Webhook (POST) | Verifies the HMAC signature and timestamp, composes a message by event type, notifies the recipient (logged mock; Resend node optional), responds 200 |
| `2-overdue-reminders.json`    | Daily 09:00    | `GET /overdue` → one item per loan → send reminder (mock) → `POST /reminder-result`                                                                   |
| `3-error-handler.json`        | Error Trigger  | Reports the failed workflow to `POST /automation-failure` and posts to the ops alert URL                                                              |

Events that notify: request created (to the owner), approved, declined and returned (to the borrower). Users can opt out; Convex then records `skipped` and never calls n8n.

---

## Security and data-minimization decisions

**Convex → n8n**

- Payload is signed with HMAC-SHA256 over `timestamp.body`. n8n recomputes it, compares with `timingSafeEqual`, and rejects timestamps older than 5 minutes (replay protection). A bad signature fails the execution, so the caller gets a non-2xx response and Convex retries or records a failure.
- The payload carries only what a notification needs: event type, tool name, dates, and the recipient's name and email. No user ids, descriptions, or details about the other party.

**n8n → Convex**

- `/overdue`, `/reminder-result` and `/automation-failure` require a bearer token, compared in constant time. `/overdue` returns only loan id, tool name, due date, days overdue, borrower name/email and an idempotency key.

**Secrets**

- Only in env vars, Convex env and n8n credentials. The exported workflow JSON contains `$env.…` references and credential names, never values. `.env*` is git-ignored (only `.env.example` is committed).

**Idempotency and reliability**

- Every notification or reminder has a unique `eventKey` (`notify:<type>:<loanId>`, `reminder:<loanId>:<date>`). Re-delivering the same key updates the existing row instead of creating a second one, and `/overdue` omits loans already reminded today, so retries and re-runs don't double-send.
- Convex retries failed webhook calls 5 times with exponential backoff (10s, 20s, 40s, 80s), recording `retrying` then `sent` or `failed` on the same row. n8n nodes use `retryOnFail`. Failed workflow runs hit the error workflow, which writes an `n8n_workflow_error` event to Convex and posts to the ops channel, so nothing fails silently. The app itself stays usable when n8n is down.

**Other**

- The public query returns `name` and `category` only. Input is validated server-side (lengths, date format, date range). Borrow requests are rate limited (10/hour/user). Deleted Clerk users are deactivated via a Svix-verified webhook, which revokes their listings and open requests.

---

## Testing the rules

Backend checks without the UI: open the Convex dashboard → **Functions**, tick **Act as a user**, and use `{ "subject": "<clerkId>", "issuer": "<CLERK_JWT_ISSUER_DOMAIN>" }`.

- No identity → `Unauthenticated`. Identity with no profile → `Profile not initialised`.
- Regular user calling `users:listLenders` / `loans:adminAll` → `Forbidden: admin only`; `tools:remove` on someone else's tool, or `loans:markReturned` on a loan they borrowed → `Forbidden`.
- Admin calling `users:listLenders` / `loans:adminAll` → data.

Automation checks: forge a webhook (bad signature) and confirm it is rejected and shows up as an `n8n_workflow_error`; unpublish the notification workflow, create a request, and watch the event go `retrying` → `sent` once republished; make a loan overdue and run the reminder workflow twice to confirm a single reminder.

---

## Known limitations

- Email is a **logged mock** by default (a Resend node is included but disabled).
- n8n verifies the signature by re-serializing the parsed JSON body instead of using the raw request body.
- n8n → Convex write-backs use a bearer token, not an HMAC signature.
- Overdue dates use UTC calendar days.
- n8n Code nodes read the signing secret through `$env`, which requires `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` and `NODE_FUNCTION_ALLOW_BUILTIN=crypto` (set in `docker-compose.yml`).
- Free tunnel URLs change on restart, so `N8N_WEBHOOK_URL` must be updated.
- Clerk `user.updated` events and loans that are active when an account is deleted are not handled.

---

## What I would change for production

1. **Managed email with suppression handling.** Replace the mock with Resend, Postmark or SES on a verified domain (DKIM/SPF), handle bounce and complaint webhooks into a suppression list, and keep per-user notification preferences (opt-out already exists).
2. **Secrets and n8n infrastructure.** Inject secrets from a secret manager (AWS Secrets Manager, Doppler) instead of env files; n8n's built-in external secrets is Enterprise-only, so use container env injection on the community edition. Run n8n in queue mode (already in `docker-compose.yml`) behind TLS with managed Postgres and Redis, and route error-handler alerts to PagerDuty or an ops Slack channel.
3. **Harden the integration.** Verify the HMAC over the **raw** body, HMAC-sign n8n → Convex write-backs as well, support two keys at once to allow secret rotation, and add IP allow-listing for the webhook.
4. **Complete the Clerk sync.** Handle `user.updated` and resolve loans that were active at deletion; move roles into Clerk organization roles or metadata with an audit trail.
5. **Booking model.** Date conflicts are already enforced transactionally against approved loans; consider soft holds with expiry for pending requests.
6. **Abuse and observability.** Extend rate limiting beyond borrow requests, paginate the list queries, add structured logging and alerting on failed events, and per-user time zones for "overdue".
7. **Quality.** `convex-test` RBAC tests, CI (typecheck, build, lint), a separate production Convex deployment and Clerk instance, and database backups for n8n.
