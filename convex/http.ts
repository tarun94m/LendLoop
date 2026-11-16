import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

// n8n -> Convex. Bearer token compared in constant time. Secrets live only in env / n8n credentials.
function authorized(req: Request) {
  const expected = `Bearer ${process.env.N8N_API_KEY ?? ""}`;
  const got = req.headers.get("authorization") ?? "";
  if (!process.env.N8N_API_KEY || got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

const http = httpRouter();
http.route({ path: "/overdue", method: "GET", handler: httpAction(async (ctx, req) => {
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);
  return json({ loans: await ctx.runQuery(internal.loans.overdue, {}) });
})});
http.route({ path: "/reminder-result", method: "POST", handler: httpAction(async (ctx, req) => {
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);
  const b = await req.json().catch(() => null);
  if (!b?.idempotencyKey || !b?.loanId || !["sent", "failed"].includes(b.status)) return json({ error: "bad request" }, 400);
  const r = await ctx.runMutation(internal.loans.recordEvent, {
    eventKey: String(b.idempotencyKey), loanId: b.loanId as Id<"loans">, kind: "overdue_reminder",
    status: b.status, detail: b.detail ? String(b.detail).slice(0, 200) : undefined });
  return json({ ok: true, duplicate: r.duplicate });
})});
http.route({ path: "/automation-failure", method: "POST", handler: httpAction(async (ctx, req) => {
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);
  const b = await req.json().catch(() => ({}));
  await ctx.runMutation(internal.loans.recordEvent, {
    eventKey: `n8n-error:${String(b.executionId ?? Date.now())}`, kind: "n8n_workflow_error", status: "failed",
    detail: `${String(b.workflow ?? "?")}: ${String(b.message ?? "").slice(0, 150)}` });
  console.error("n8n workflow failure", b.workflow, b.executionId, b.message);
  return json({ ok: true });
})});
// Clerk -> Convex (Svix signature verified). Deleted Clerk user => deactivate account, revoke listings.
http.route({ path: "/clerk-webhook", method: "POST", handler: httpAction(async (ctx, req) => {
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  const body = await req.text();
  const id = req.headers.get("svix-id"), ts = req.headers.get("svix-timestamp"), sigs = req.headers.get("svix-signature");
  if (!secret || !id || !ts || !sigs || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return json({ error: "bad request" }, 400);
  const raw = Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`)))));
  const ok = sigs.split(" ").some((s) => { const g = s.split(",")[1] ?? ""; return g.length === mac.length && [...g].reduce((d, ch, i) => d | (ch.charCodeAt(0) ^ mac.charCodeAt(i)), 0) === 0; });
  if (!ok) return json({ error: "invalid signature" }, 401);
  const evt = JSON.parse(body);
  if (evt.type === "user.deleted" && evt.data?.id) await ctx.runMutation(internal.users.deactivate, { clerkId: evt.data.id });
  return json({ ok: true });
})});
export default http;
