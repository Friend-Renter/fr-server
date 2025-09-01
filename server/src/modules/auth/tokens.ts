/** JWT helpers: sign/verify access & refresh tokens, with rotation support. */
import { randomUUID } from "crypto";

import jwt, { type JwtPayload, type SignOptions, type Secret } from "jsonwebtoken";

import { env } from "../../config/env.js";

export type Role = "renter" | "host" | "admin";

export type AccessClaims = JwtPayload & {
  sub: string; // user id
  role: Role;
  type: "access";
  jti: string; // token id (optional but nice for tracing)
};

export type RefreshClaims = JwtPayload & {
  sub: string; // user id
  type: "refresh";
  jti: string; // session id; we’ll store this in Redis
};

export function newJti(): string {
  return randomUUID();
}

export function signAccessToken(input: { sub: string; role: Role; jti?: string }): string {
  const jti = input.jti ?? newJti();
  const payload: Partial<AccessClaims> = { sub: input.sub, role: input.role, type: "access" };

  const opts: SignOptions = {
    algorithm: "HS256",
    expiresIn: env.JWT_ACCESS_TTL, // "15m"
    issuer: env.JWT_ISS,
    audience: env.JWT_AUD,
    jwtid: jti,
  };

  return jwt.sign(payload, env.JWT_SECRET as Secret, opts);
}

export function signRefreshToken(input: { sub: string; jti?: string }): string {
  const jti = input.jti ?? newJti();
  const payload: Partial<RefreshClaims> = { sub: input.sub, type: "refresh" };

  const opts: SignOptions = {
    algorithm: "HS256",
    expiresIn: env.JWT_REFRESH_TTL, // "30d"
    issuer: env.JWT_ISS,
    audience: env.JWT_AUD,
    jwtid: jti,
  };

  const secret: Secret = (env.JWT_REFRESH_SECRET || env.JWT_SECRET) as Secret;
  return jwt.sign(payload, secret, opts);
}

export function verifyAccess(token: string): AccessClaims {
  const decoded = jwt.verify(token, env.JWT_SECRET, {
    algorithms: ["HS256"],
    issuer: env.JWT_ISS,
    audience: env.JWT_AUD,
  }) as AccessClaims;
  if (decoded.type !== "access")
    throw Object.assign(new Error("Invalid token type"), { code: "INVALID_TOKEN" });
  return decoded;
}

export function verifyRefresh(token: string): RefreshClaims {
  const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET || env.JWT_SECRET, {
    algorithms: ["HS256"],
    issuer: env.JWT_ISS,
    audience: env.JWT_AUD,
  }) as RefreshClaims;
  if (decoded.type !== "refresh")
    throw Object.assign(new Error("Invalid token type"), { code: "INVALID_TOKEN" });
  return decoded;
}
