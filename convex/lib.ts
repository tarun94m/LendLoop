import { QueryCtx, MutationCtx } from "./_generated/server";
import { Doc } from "./_generated/dataModel";

type Ctx = QueryCtx | MutationCtx;

/** Every protected function starts here. Identity comes from the verified Clerk JWT, never from args. */
export async function requireUser(ctx: Ctx): Promise<Doc<"users">> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Unauthenticated");
  const user = await ctx.db.query("users").withIndex("by_clerk", (q) => q.eq("clerkId", identity.subject)).unique();
  if (!user) throw new Error("Profile not initialised");
  if (user.deactivated) throw new Error("Account deactivated");
  return user;
}
export async function requireAdmin(ctx: Ctx) {
  const u = await requireUser(ctx);
  if (u.role !== "admin") throw new Error("Forbidden: admin only");
  return u;
}
export const today = () => new Date().toISOString().slice(0, 10);
export const CATEGORIES = ["power tools", "garden", "kitchen", "camping", "hand tools", "other"];

export async function audit(ctx: MutationCtx, actor: Doc<"users">, action: string, target: string, detail?: string) {
  await ctx.db.insert("auditLogs", { actorId: actor._id, action, target, detail });
}
