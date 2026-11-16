import { query, mutation, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { Doc } from "./_generated/dataModel";
import { requireUser, audit } from "./lib";

async function onLoan(ctx: QueryCtx, tool: Doc<"tools">) {
  const loans = await ctx.db.query("loans").withIndex("by_tool", (q) => q.eq("toolId", tool._id)).collect();
  return loans.some((l) => l.status === "approved");
}

/** PUBLIC: name + category only. No owner info, no ids beyond the opaque key. */
export const listPublic = query({ args: {}, handler: async (ctx) => {
  const tools = await ctx.db.query("tools").collect();
  const out = [];
  for (const t of tools) if (!(await onLoan(ctx, t))) out.push({ _id: t._id, name: t.name, category: t.category });
  return out;
}});

export const listAll = query({
  args: { category: v.optional(v.string()) },
  handler: async (ctx, { category }) => {
    await requireUser(ctx);
    const tools = await ctx.db.query("tools").collect();
    const out = [];
    for (const t of tools) {
      if (category && t.category !== category) continue;
      const owner = await ctx.db.get(t.ownerId);
      out.push({ ...t, available: !(await onLoan(ctx, t)), ownerName: owner?.name, ownerTrusted: owner?.trusted ?? false });
    }
    return out;
  },
});
export const mine = query({ args: {}, handler: async (ctx) => {
  const me = await requireUser(ctx);
  return ctx.db.query("tools").withIndex("by_owner", (q) => q.eq("ownerId", me._id)).collect();
}});

const fields = { name: v.string(), category: v.string(), condition: v.string(), description: v.string() };
const clean = (a: { name: string; category: string; condition: string; description: string }) => {
  const r = { name: a.name.trim(), category: a.category.trim().toLowerCase(), condition: a.condition.trim(), description: a.description.trim() };
  if (!r.name) throw new Error("Please enter a tool name");
  if (r.name.length > 80) throw new Error("Name must be 80 characters or fewer");
  if (r.description.length > 300) throw new Error("Description must be 300 characters or fewer");
  return r;
};
export const create = mutation({ args: fields, handler: async (ctx, a) => {
  const me = await requireUser(ctx);
  return ctx.db.insert("tools", { ownerId: me._id, ...clean(a) });
}});
export const update = mutation({ args: { toolId: v.id("tools"), ...fields }, handler: async (ctx, { toolId, ...a }) => {
  const me = await requireUser(ctx);
  const t = await ctx.db.get(toolId);
  if (!t || t.ownerId !== me._id) throw new Error("Forbidden"); // admins may remove but not edit others' listings
  await ctx.db.patch(toolId, clean(a));
}});
export const remove = mutation({ args: { toolId: v.id("tools") }, handler: async (ctx, { toolId }) => {
  const me = await requireUser(ctx);
  const t = await ctx.db.get(toolId);
  if (!t) return;
  if (t.ownerId !== me._id && me.role !== "admin") throw new Error("Forbidden");
  if (await onLoan(ctx, t)) throw new Error("Tool is currently on loan");
  await ctx.db.delete(toolId);
  if (t.ownerId !== me._id) await audit(ctx, me, "listing_removed_by_admin", toolId, t.name);
}});
