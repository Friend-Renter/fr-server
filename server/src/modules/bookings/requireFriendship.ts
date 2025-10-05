import type { Request, Response, NextFunction } from "express";

import { getAuth } from "../../middlewares/auth.js";
import { guardFriendshipOrEnsurePending } from "../friends/controller.js";

/** Enforce “must be friends to book” — guest must be friends with hostId in body or param */
export async function requireFriendship(req: Request, res: Response, next: NextFunction) {
  const { userId: guestId } = getAuth(req);
  const hostId = String(req.body?.hostId || req.params.hostId || "");
  if (!hostId)
    return res
      .status(422)
      .json({
        error: { code: "VALIDATION", details: [{ path: ["hostId"], message: "hostId required" }] },
      });

  const err = await guardFriendshipOrEnsurePending(guestId, hostId);
  if (err) return res.status(403).json({ error: err });
  return next();
}
