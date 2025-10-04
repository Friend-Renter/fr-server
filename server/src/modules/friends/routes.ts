import { Router } from "express";

import {
  listFriends,
  postRequest,
  acceptFriendRequest,
  declineFriendRequest,
  searchUsers,
  getUserPublic,
} from "./controller.js";
import { requireAuth } from "../../middlewares/auth.js";

export const friendsRouter = Router();

friendsRouter.get("/", requireAuth, listFriends);
friendsRouter.post("/requests", requireAuth, postRequest);
friendsRouter.post("/requests/:id/accept", requireAuth, acceptFriendRequest);
friendsRouter.post("/requests/:id/decline", requireAuth, declineFriendRequest);

// user helpers
friendsRouter.get("/users/search", requireAuth, searchUsers);
friendsRouter.get("/users/:id/public", getUserPublic);
