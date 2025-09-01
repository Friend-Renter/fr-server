import type { Request, Response } from "express";

import { findById, toPublicUser } from "./service.js";
import { getAuth } from "../../middlewares/auth.js";
import { asyncHandler, jsonOk } from "../../utils/http.js";

export const getMe = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = getAuth(req);
  const user = await findById(userId);
  if (!user) {
    return res.status(404).json({ error: { code: "USER_NOT_FOUND", message: "User not found" } });
  }
  return jsonOk(res, { user: toPublicUser(user) });
});
