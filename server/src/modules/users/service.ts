/** Users service — uses model hooks/virtuals; keeps controllers thin */
import { User, type UserDoc, type Role } from "./model.js";
import { connectMongo } from "../../config/db.js";

/** Normalize emails consistently */
function normEmail(email: string) {
  return email.trim().toLowerCase();
}

export type CreateUserInput = {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  role?: "renter" | "host" | "admin";
};

export async function createUser(input: CreateUserInput): Promise<UserDoc> {
  await connectMongo();
  const doc = new User({
    email: input.email,
    firstName: input.firstName,
    lastName: input.lastName,
    role: input.role ?? "renter",
  } as Partial<UserDoc>) as any;

  // trigger hashing via virtual
  doc.password = input.password;
  await doc.save();
  return doc;
}

export async function findByEmail(
  email: string,
  opts?: { withPassword?: boolean }
): Promise<UserDoc | null> {
  await connectMongo();
  const q = User.findOne({ email: email.toLowerCase().trim() });
  if (opts?.withPassword) q.select("+passwordHash");
  return q.exec();
}

export async function findById(
  id: string,
  opts?: { withPassword?: boolean }
): Promise<UserDoc | null> {
  await connectMongo();
  const q = User.findById(id);
  if (opts?.withPassword) q.select("+passwordHash");
  return q.exec();
}

export async function verifyPassword(password: string, user: UserDoc): Promise<boolean> {
  if ((user as any).passwordHash) {
    return User.hydrate(user).isCorrectPassword(password);
  }
  // If passwordHash not selected, re-fetch with hash
  const fresh = await findById(user.id, { withPassword: true });
  if (!fresh) return false;
  return fresh.isCorrectPassword(password);
}

/** Safe public shape for API responses */
export function toPublicUser(u: UserDoc) {
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    firstName: u.firstName,
    lastName: u.lastName,
    fullName: u.fullName,
    isEmailVerified: u.isEmailVerified,
    isActive: u.isActive,
    deactivatedAt: u.deactivatedAt ?? null,
    kycStatus: u.kycStatus,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
    // NOTE: intentionally excluding defaultAddress & payout from public user for now
  };
}
