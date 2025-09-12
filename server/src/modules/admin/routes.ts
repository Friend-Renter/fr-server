import { Router } from "express";

import {
  listUsersQuery,
  patchUserBody,
  listListingsQuery,
  patchListingBody,
  putFlagBody,
} from "./schemas.js";
import {
  adminListUsers,
  adminPatchUser,
  adminListListings,
  adminPatchListing,
  listFlags,
  putFlag,
} from "./service.js";
import { requireAuth, requireRole, getAuth } from "../../middlewares/auth.js";
import { asyncHandler, jsonOk } from "../../utils/http.js";

const adminRouter = Router();

// all admin routes require admin role
adminRouter.use(requireAuth, requireRole("admin"));

adminRouter.get(
  "/users",
  asyncHandler(async (req, res) => {
    const q = listUsersQuery.parse(req.query);
    const out = await adminListUsers(q);
    jsonOk(res, out);
  })
);

adminRouter.patch(
  "/users/:id",
  asyncHandler(async (req, res) => {
    const admin = getAuth(req);
    const body = patchUserBody.parse(req.body);
    const userId = req.params.id;
    const out = await adminPatchUser(admin.userId, userId, body);
    jsonOk(res, { ok: true, user: out });
  })
);

adminRouter.get(
  "/listings",
  asyncHandler(async (req, res) => {
    const q = listListingsQuery.parse(req.query);
    const out = await adminListListings(q);
    jsonOk(res, out);
  })
);

adminRouter.patch(
  "/listings/:id",
  asyncHandler(async (req, res) => {
    const admin = getAuth(req);
    const body = patchListingBody.parse(req.body);
    const id = req.params.id;
    const out = await adminPatchListing(admin.userId, id, body);
    jsonOk(res, { ok: true, listing: out });
  })
);

adminRouter.get(
  "/features",
  asyncHandler(async (_req, res) => {
    const flags = await listFlags();
    jsonOk(res, { items: flags });
  })
);

adminRouter.put(
  "/features/:key",
  asyncHandler(async (req, res) => {
    const admin = getAuth(req);
    const body = putFlagBody.parse(req.body);
    const key = req.params.key;
    const flag = await putFlag(admin.userId, key, body);
    jsonOk(res, { ok: true, flag });
  })
);

export default adminRouter;
