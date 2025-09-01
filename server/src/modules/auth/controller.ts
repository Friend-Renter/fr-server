import type { Request, Response } from "express";

import { registerSchema, loginSchema } from "./schemas.js";
import { signAccessToken, signRefreshToken } from "./tokens.js";
import { asyncHandler, jsonOk } from "../../utils/http.js";
import { createUser, findByEmail, toPublicUser, verifyPassword } from "../user/service.js";

export const register = asyncHandler(async (req: Request, res: Response) => {
  const body = registerSchema.parse(req.body);

  // Create user (model’s virtual `password` will hash it)
  const user = await createUser({
    email: body.email,
    password: body.password,
    firstName: body.firstName,
    lastName: body.lastName,
  });

  // Auto-login
  const accessToken = signAccessToken({ sub: user.id, role: user.role });
  const refreshToken = signRefreshToken({ sub: user.id });

  return res.status(201).json({
    user: toPublicUser(user),
    tokens: { accessToken, refreshToken },
  });
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const body = loginSchema.parse(req.body);

  const user = await findByEmail(body.email, { withPassword: true });
  if (!user) {
    return res
      .status(401)
      .json({ error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password" } });
  }

  const ok = await verifyPassword(body.password, user);
  if (!ok) {
    return res
      .status(401)
      .json({ error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password" } });
  }

  const accessToken = signAccessToken({ sub: user.id, role: user.role });
  const refreshToken = signRefreshToken({ sub: user.id });

  jsonOk(res, {
    user: toPublicUser(user),
    tokens: { accessToken, refreshToken },
  });
});
