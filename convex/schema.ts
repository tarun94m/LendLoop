import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    clerkId: v.string(), name: v.string(), email: v.string(),
    role: v.union(v.literal("admin"), v.literal("user")),
    trusted: v.boolean(),
    notifyEmail: v.optional(v.boolean()), deactivated: v.optional(v.boolean()),
  }).index("by_clerk", ["clerkId"]),
  tools: defineTable({
    ownerId: v.id("users"), name: v.string(), category: v.string(),
    condition: v.string(), description: v.string(),
  }).index("by_owner", ["ownerId"]),
  loans: defineTable({
    toolId: v.id("tools"), ownerId: v.id("users"), borrowerId: v.id("users"),
    startDate: v.string(), endDate: v.string(), // YYYY-MM-DD
    status: v.union(v.literal("requested"), v.literal("approved"), v.literal("declined"), v.literal("returned")),
  }).index("by_tool", ["toolId"]).index("by_owner", ["ownerId"])
    .index("by_borrower", ["borrowerId"]).index("by_status", ["status"]),
  auditLogs: defineTable({ actorId: v.id("users"), action: v.string(), target: v.string(), detail: v.optional(v.string()) }),
  // Idempotency ledger for every automation side effect
  automationEvents: defineTable({
    eventKey: v.string(), loanId: v.optional(v.id("loans")),
    kind: v.string(), status: v.string(), detail: v.optional(v.string()),
  }).index("by_key", ["eventKey"]).index("by_loan", ["loanId"]),
});
