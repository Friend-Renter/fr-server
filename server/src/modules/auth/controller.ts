import type { Request, Response } from "express";

import { registerSchema, loginSchema } from "./schemas.js";
import { refreshSchema } from "./schemas.js";
import { persistSession, revokeSession, isSessionActive } from "./sessions.js";
import { verifyRefresh, signAccessToken, signRefreshToken } from "./tokens.js";
import { asyncHandler, jsonOk } from "../../utils/http.js";
import { createUser, findByEmail, toPublicUser, verifyPassword } from "../users/service.js";
import { findById } from "../users/service.js";

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

  // Persist refresh session
  const rClaims = verifyRefresh(refreshToken);
  await persistSession({
    userId: rClaims.sub,
    jti: rClaims.jti,
    exp: rClaims.exp,
    iat: rClaims.iat,
    ip: req.ip,
    ua: req.get("user-agent") || null,
  });

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

  const rClaims = verifyRefresh(refreshToken);
  await persistSession({
    userId: rClaims.sub,
    jti: rClaims.jti,
    exp: rClaims.exp,
    iat: rClaims.iat,
    ip: req.ip,
    ua: req.get("user-agent") || null,
  });

  jsonOk(res, {
    user: toPublicUser(user),
    tokens: { accessToken, refreshToken },
  });
});

export const refresh = asyncHandler(async (req: Request, res: Response) => {
  const { refreshToken } = refreshSchema.parse(req.body);

  // 1) Verify token
  let claims;
  try {
    claims = verifyRefresh(refreshToken);
  } catch {
    return res
      .status(401)
      .json({ error: { code: "INVALID_REFRESH", message: "Invalid refresh token" } });
  }

  // 2) Check active session
  const active = await isSessionActive(claims.sub, claims.jti);
  if (!active) {
    return res.status(401).json({
      error: { code: "INVALID_REFRESH", message: "Refresh session not found or expired" },
    });
  }

  // 3) Rotate: revoke old session, issue new pair
  await revokeSession(claims.sub, claims.jti);

  const user = await findById(claims.sub);
  if (!user) {
    return res
      .status(401)
      .json({ error: { code: "INVALID_REFRESH", message: "User no longer exists" } });
  }

  const accessToken = signAccessToken({ sub: user.id, role: user.role });
  const newRefreshToken = signRefreshToken({ sub: user.id });

  const newClaims = verifyRefresh(newRefreshToken);
  await persistSession({
    userId: newClaims.sub,
    jti: newClaims.jti,
    exp: newClaims.exp,
    iat: newClaims.iat,
    ip: req.ip,
    ua: req.get("user-agent") || null,
  });

  return jsonOk(res, { accessToken, refreshToken: newRefreshToken });
});

export const logout = asyncHandler(async (req: Request, res: Response) => {
  const { refreshToken } = refreshSchema.parse(req.body);
  let claims;
  try {
    claims = verifyRefresh(refreshToken);
  } catch {
    return res
      .status(401)
      .json({ error: { code: "INVALID_REFRESH", message: "Invalid refresh token" } });
  }

  await revokeSession(claims.sub, claims.jti);
  return jsonOk(res, { success: true });
});
