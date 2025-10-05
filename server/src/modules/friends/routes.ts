import { Router } from "express";

import {
  listFriends,
  postRequest,
  acceptFriendRequest,
  declineFriendRequest,
  searchUsers,
  getUserPublic,
  cancelFriendRequest,
  unfriend,
  statusWith,
  counts,
} from "./controller.js";
import { requireAuth } from "../../middlewares/auth.js";

export const friendsRouter = Router();

friendsRouter.get("/", requireAuth, listFriends);
friendsRouter.post("/requests", requireAuth, postRequest);
friendsRouter.post("/requests/:id/accept", requireAuth, acceptFriendRequest);
friendsRouter.post("/requests/:id/decline", requireAuth, declineFriendRequest);
friendsRouter.delete("/requests/:id", requireAuth, cancelFriendRequest);
friendsRouter.delete("/:userId", requireAuth, unfriend);
friendsRouter.get("/status/:otherId", requireAuth, statusWith);
friendsRouter.get("/counts", requireAuth, counts);

// user helpers
friendsRouter.get("/users/search", requireAuth, searchUsers);
friendsRouter.get("/users/:id/public", getUserPublic);
