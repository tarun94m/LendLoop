import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

const MAX_ATTEMPTS = 5;
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function sign(secret: string, msg: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
}

/** Convex -> n8n. Signed, minimal payload, retried with exponential backoff, outcome recorded. */
export const notify = internalAction({
  args: { loanId: v.id("loans"), type: v.string(), attempt: v.number() },
  handler: async (ctx, { loanId, type, attempt }) => {
    const url = process.env.N8N_WEBHOOK_URL, secret = process.env.LENDLOOP_WEBHOOK_SECRET;
    const eventKey = `notify:${type}:${loanId}`;
    const d = await ctx.runQuery(internal.loans.notifyData, { loanId });
    if (!d || !url || !secret) {
      await ctx.runMutation(internal.loans.recordEvent, { eventKey, loanId, kind: type, status: "failed", detail: "missing data or config" });
      return;
    }
    // Recipient: owner gets new requests; borrower gets decisions/returns. Only fields n8n needs.
    const to = type === "request_created" ? d.owner : d.borrower;
    if (to?.notifyEmail === false) {
      await ctx.runMutation(internal.loans.recordEvent, { eventKey, loanId, kind: type, status: "skipped", detail: "recipient opted out" });
      return;
    }
    const payload = {
      eventId: eventKey, type, loanId, toolName: d.toolName,
      startDate: d.loan.startDate, endDate: d.loan.endDate,
      recipient: { name: to?.name, email: to?.email },
    };
    const body = JSON.stringify(payload);
    const ts = String(Date.now());
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-lendloop-timestamp": ts, "x-lendloop-signature": await sign(secret, `${ts}.${body}`) },
        body,
      });
      if (!res.ok) throw new Error(`n8n responded ${res.status}`);
      await ctx.runMutation(internal.loans.recordEvent, { eventKey, loanId, kind: type, status: "sent" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt + 1 < MAX_ATTEMPTS) {
        await ctx.runMutation(internal.loans.recordEvent, { eventKey, loanId, kind: type, status: "retrying", detail: `attempt ${attempt + 1}: ${msg}` });
        await ctx.scheduler.runAfter(2 ** attempt * 10_000, internal.automation.notify, { loanId, type, attempt: attempt + 1 });
      } else {
        await ctx.runMutation(internal.loans.recordEvent, { eventKey, loanId, kind: type, status: "failed", detail: msg });
        console.error("notify permanently failed", eventKey, msg); // visible in Convex logs
      }
    }
  },
});
