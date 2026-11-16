import { query, mutation, internalQuery, internalMutation, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { requireUser, requireAdmin, today } from "./lib";

async function decorate(ctx: QueryCtx, loans: Doc<"loans">[]) {
  return Promise.all(loans.map(async (l) => {
    const [tool, borrower, owner, events] = await Promise.all([
      ctx.db.get(l.toolId), ctx.db.get(l.borrowerId), ctx.db.get(l.ownerId),
      ctx.db.query("automationEvents").withIndex("by_loan", (q) => q.eq("loanId", l._id)).order("desc").take(1),
    ]);
    const ev = events[0];
    return { ...l, toolName: tool?.name ?? "(removed)", borrowerName: borrower?.name, ownerName: owner?.name,
      lastAutomation: ev ? { kind: ev.kind, status: ev.status, at: ev._creationTime } : null };
  }));
}
const notify = (ctx: { scheduler: any }, loanId: Id<"loans">, type: string) =>
  ctx.scheduler.runAfter(0, internal.automation.notify, { loanId, type, attempt: 0 });

export const request = mutation({
  args: { toolId: v.id("tools"), startDate: v.string(), endDate: v.string() },
  handler: async (ctx, a) => {
    const me = await requireUser(ctx);
    const recent = await ctx.db.query("loans").withIndex("by_borrower", (q) => q.eq("borrowerId", me._id)).order("desc").take(10);
    if (recent.length === 10 && Date.now() - recent[9]._creationTime < 3_600_000) throw new Error("Too many requests; try again later (max 10/hour)");
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRe.test(a.startDate) || !dateRe.test(a.endDate)) throw new Error("Please pick both a start and an end date");
if (a.endDate < a.startDate) throw new Error("End date can't be before the start date");
if (a.startDate < today()) throw new Error("Start date can't be in the past");
    const tool = await ctx.db.get(a.toolId);
    if (!tool) throw new Error("Tool not found");
    if (tool.ownerId === me._id) throw new Error("You can't borrow your own tool");
    const existing = await ctx.db.query("loans").withIndex("by_tool", (q) => q.eq("toolId", a.toolId)).collect();
    if (existing.some((l) => l.status === "approved" && l.startDate <= a.endDate && a.startDate <= l.endDate))
      throw new Error("Tool already booked for those dates");
        const id = await ctx.db.insert("loans", {
      toolId: a.toolId,
      ownerId: tool.ownerId,
      borrowerId: me._id,
      startDate: a.startDate,
      endDate: a.endDate,
      status: "requested",
    });
    await notify(ctx, id, "request_created");
    return id;
  },
});
export const decide = mutation({
  args: { loanId: v.id("loans"), approve: v.boolean() },
  handler: async (ctx, { loanId, approve }) => {
    const me = await requireUser(ctx);
    const l = await ctx.db.get(loanId);
    if (!l || l.ownerId !== me._id) throw new Error("Forbidden"); // only the tool's owner
    if (l.status !== "requested") throw new Error("Request already handled");
    if (approve) {
      const others = await ctx.db.query("loans").withIndex("by_tool", (q) => q.eq("toolId", l.toolId)).collect();
      if (others.some((o) => o.status === "approved" && o.startDate <= l.endDate && l.startDate <= o.endDate))
        throw new Error("Overlaps an approved loan");
    }
    await ctx.db.patch(loanId, { status: approve ? "approved" : "declined" });
    await notify(ctx, loanId, approve ? "request_approved" : "request_declined");
  },
});
export const markReturned = mutation({ args: { loanId: v.id("loans") }, handler: async (ctx, { loanId }) => {
  const me = await requireUser(ctx);
  const l = await ctx.db.get(loanId);
  if (!l || (l.ownerId !== me._id && me.role !== "admin")) throw new Error("Forbidden");
  if (l.status !== "approved") throw new Error("Loan is not active");
  await ctx.db.patch(loanId, { status: "returned" });
  await notify(ctx, loanId, "loan_returned");
}});
export const myRequests = query({ args: {}, handler: async (ctx) => {
  const me = await requireUser(ctx);
  return decorate(ctx, await ctx.db.query("loans").withIndex("by_borrower", (q) => q.eq("borrowerId", me._id)).order("desc").collect());
}});
export const incoming = query({ args: {}, handler: async (ctx) => {
  const me = await requireUser(ctx);
  return decorate(ctx, await ctx.db.query("loans").withIndex("by_owner", (q) => q.eq("ownerId", me._id)).order("desc").collect());
}});
export const adminAll = query({ args: {}, handler: async (ctx) => {
  await requireAdmin(ctx);
  return decorate(ctx, await ctx.db.query("loans").order("desc").collect());
}});

// ---- internal helpers used by automation ----
export const notifyData = internalQuery({ args: { loanId: v.id("loans") }, handler: async (ctx, { loanId }) => {
  const l = await ctx.db.get(loanId);
  if (!l) return null;
  const [tool, owner, borrower] = await Promise.all([ctx.db.get(l.toolId), ctx.db.get(l.ownerId), ctx.db.get(l.borrowerId)]);
  return { loan: l, toolName: tool?.name ?? "tool", owner, borrower };
}});
/** Approved loans past their end date that have not been reminded today. Minimal fields only. */
export const overdue = internalQuery({ args: {}, handler: async (ctx) => {
  const t = today();
  const approved = await ctx.db.query("loans").withIndex("by_status", (q) => q.eq("status", "approved")).collect();
  const out = [];
  for (const l of approved) {
    if (l.endDate >= t) continue;
    const key = `reminder:${l._id}:${t}`;
    const done = await ctx.db.query("automationEvents").withIndex("by_key", (q) => q.eq("eventKey", key)).first();
    if (done) continue;
    const [tool, b] = await Promise.all([ctx.db.get(l.toolId), ctx.db.get(l.borrowerId)]);
    if (!b) continue;
    out.push({ loanId: l._id, toolName: tool?.name ?? "tool", dueDate: l.endDate,
      daysOverdue: Math.floor((Date.parse(t) - Date.parse(l.endDate)) / 86400000),
      borrower: { name: b.name, email: b.email }, idempotencyKey: key });
  }
  return out;
}});
/** Idempotent: same eventKey twice is a no-op. */
export const recordEvent = internalMutation({
  args: { eventKey: v.string(), loanId: v.optional(v.id("loans")), kind: v.string(), status: v.string(), detail: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const ex = await ctx.db.query("automationEvents").withIndex("by_key", (q) => q.eq("eventKey", a.eventKey)).first();
    if (ex) {
      if (ex.status !== a.status && ex.status !== "sent") await ctx.db.patch(ex._id, { status: a.status, detail: a.detail }); // allow retry -> sent
      return { duplicate: true };
    }
    await ctx.db.insert("automationEvents", a);
    return { duplicate: false };
  },
});
