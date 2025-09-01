import { Router } from "express";

import { register, login } from "./controller.js";
import { refresh, logout } from "./controller.js";
import { rateLimitIP } from "./rateLimit.js";

export const authRouter = Router();

// Register: names required + strong password; auto-login
authRouter.post("/register", register);

// Login: light IP rate limit (5/min)
authRouter.post("/login", rateLimitIP({ windowMs: 60_000, max: 5 }), login);

// Refresh: rotate token, 10/min per IP
authRouter.post("/refresh", rateLimitIP({ windowMs: 60_000, max: 10 }), refresh);

// Logout: revoke current session, 30/min per IP
authRouter.post("/logout", rateLimitIP({ windowMs: 60_000, max: 30 }), logout);

export default authRouter;
