import { Router } from "express";

import { getMe } from "./controller.js";
import { requireAuth } from "../../middlewares/auth.js";

const usersRouter = Router();

// current user
usersRouter.get("/me", requireAuth, getMe);

export default usersRouter;
