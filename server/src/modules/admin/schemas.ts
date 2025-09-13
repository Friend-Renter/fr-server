// zod schemas for admin endpoints
import { z } from "zod/v4";

export const pageQuery = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export const listUsersQuery = pageQuery.extend({
  role: z.enum(["renter", "host", "admin"]).optional(),
  kycStatus: z.enum(["unverified", "pending", "verified", "rejected"]).optional(),
  isActive: z.coerce.boolean().optional(),
  q: z.string().trim().min(1).max(100).optional(),
});

export const patchUserBody = z
  .object({
    role: z.enum(["renter", "host", "admin"]).optional(),
    suspend: z.boolean().optional(),
    unsuspend: z.boolean().optional(),
    kycOverride: z.enum(["unverified", "pending", "verified", "rejected"]).optional(),
  })
  .refine((v) => !(v.suspend && v.unsuspend), {
    message: "suspend and unsuspend are mutually exclusive",
    path: ["suspend"],
  });

export const listListingsQuery = pageQuery.extend({
  status: z.enum(["draft", "pending", "active", "suspended"]).optional(),
  hostId: z
    .string()
    .regex(/^[0-9a-fA-F]{24}$/)
    .optional(),
  q: z.string().trim().min(1).max(100).optional(),
});

export const patchListingBody = z
  .object({
    approve: z.boolean().optional(),
    suspend: z.boolean().optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((v) => !(v.approve && v.suspend), {
    message: "approve and suspend are mutually exclusive",
    path: ["approve"],
  });

export const putFlagBody = z.object({
  enabled: z.boolean(),
  notes: z.string().trim().max(500).optional(),
});
