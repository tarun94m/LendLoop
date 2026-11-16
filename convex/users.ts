import { mutation, internalMutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireAdmin, requireUser, audit } from "./lib";

/** Upsert profile on sign-in. Role is NEVER taken from the client; new users are always "user". */
export const store = mutation({
  args: {},
  handler: async (ctx) => {
    const id = await ctx.auth.getUserIdentity();
    if (!id) throw new Error("Unauthenticated");
    const existing = await ctx.db.query("users").withIndex("by_clerk", (q) => q.eq("clerkId", id.subject)).unique();
    const profile = { name: id.name ?? id.email ?? "Neighbor", email: id.email ?? "" };
    if (existing) { await ctx.db.patch(existing._id, profile); return existing._id; }
    return ctx.db.insert("users", { clerkId: id.subject, ...profile, role: "user", trusted: false });
  },
});
export const me = query({ args: {}, handler: async (ctx) => {
  const id = await ctx.auth.getUserIdentity();
  if (!id) return null;
  return ctx.db.query("users").withIndex("by_clerk", (q) => q.eq("clerkId", id.subject)).unique();
}});
// Admin bootstrap: only runnable from the Convex dashboard/CLI: npx convex run users:makeAdmin '{"clerkId":"user_..."}'
export const makeAdmin = internalMutation({
  args: { clerkId: v.string() },
  handler: async (ctx, { clerkId }) => {
    const u = await ctx.db.query("users").withIndex("by_clerk", (q) => q.eq("clerkId", clerkId)).unique();
    if (!u) throw new Error("User not found (sign in once first)");
    await ctx.db.patch(u._id, { role: "admin" });
  },
});
export const setTrusted = mutation({
  args: { userId: v.id("users"), trusted: v.boolean() },
  handler: async (ctx, { userId, trusted }) => { const a = await requireAdmin(ctx); await ctx.db.patch(userId, { trusted }); await audit(ctx, a, trusted ? "trusted_granted" : "trusted_revoked", userId); },
});
export const listLenders = query({ args: {}, handler: async (ctx) => {
  await requireAdmin(ctx);
  return (await ctx.db.query("users").collect()).map((u) => ({ _id: u._id, name: u.name, role: u.role, trusted: u.trusted }));
}});

export const setNotify = mutation({ args: { enabled: v.boolean() }, handler: async (ctx, { enabled }) => {
  const me = await requireUser(ctx); await ctx.db.patch(me._id, { notifyEmail: enabled });
}});
export const auditLog = query({ args: {}, handler: async (ctx) => {
  await requireAdmin(ctx);
  const rows = await ctx.db.query("auditLogs").order("desc").take(30);
  return Promise.all(rows.map(async (r) => ({ ...r, actorName: (await ctx.db.get(r.actorId))?.name })));
}});
/** Called only by the Svix-verified Clerk webhook. Idempotent. Revokes listings + open requests. */
export const deactivate = internalMutation({ args: { clerkId: v.string() }, handler: async (ctx, { clerkId }) => {
  const u = await ctx.db.query("users").withIndex("by_clerk", (q) => q.eq("clerkId", clerkId)).unique();
  if (!u || u.deactivated) return;
  await ctx.db.patch(u._id, { deactivated: true, trusted: false, notifyEmail: false });
  for (const t of await ctx.db.query("tools").withIndex("by_owner", (q) => q.eq("ownerId", u._id)).collect()) {
    const loans = await ctx.db.query("loans").withIndex("by_tool", (q) => q.eq("toolId", t._id)).collect();
    for (const l of loans) if (l.status === "requested") await ctx.db.patch(l._id, { status: "declined" });
    if (!loans.some((l) => l.status === "approved")) await ctx.db.delete(t._id); // active loans stay for admin to resolve
  }
  for (const l of await ctx.db.query("loans").withIndex("by_borrower", (q) => q.eq("borrowerId", u._id)).collect())
    if (l.status === "requested") await ctx.db.patch(l._id, { status: "declined" });
  await ctx.db.insert("auditLogs", { actorId: u._id, action: "account_deactivated", target: clerkId });
}});
export const whoami = query({ args: {}, handler: async (ctx) => ctx.auth.getUserIdentity() });
