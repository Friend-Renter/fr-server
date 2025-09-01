/** Users service — uses model hooks/virtuals; keeps controllers thin */
import { User, type UserDoc, type Role } from "./model.js";
import { connectMongo } from "../../config/db.js";

/** Normalize emails consistently */
function normEmail(email: string) {
  return email.trim().toLowerCase();
}

/** Create a user. Set the virtual `password` to trigger hashing in the model. */
export async function createUser(input: {
  email: string;
  password: string;
  role?: Role;
  firstName?: string;
  lastName?: string;
}): Promise<UserDoc> {
  await connectMongo();
  const doc = new User({
    email: normEmail(input.email),
    role: input.role ?? "renter",
    firstName: input.firstName,
    lastName: input.lastName,
  }) as any;

  doc.password = input.password; // virtual setter (model will hash)
  const saved = await (doc as UserDoc).save();
  return saved;
}

/** Find by email (optionally include passwordHash for auth flows) */
export async function findByEmail(
  email: string,
  opts?: { withPassword?: boolean }
): Promise<UserDoc | null> {
  await connectMongo();
  const q = User.findOne({ email: normEmail(email) });
  if (opts?.withPassword) {
    // passwordHash is select:false by default; explicitly include it
    q.select("+passwordHash");
  }
  return q.exec();
}

/** Verify password (requires a doc with passwordHash selected) */
export async function verifyPassword(plain: string, userWithHash: UserDoc): Promise<boolean> {
  // Will throw if passwordHash wasn't selected
  return userWithHash.isCorrectPassword(plain);
}

/** Shape a safe public payload */
export function toPublicUser(u: UserDoc) {
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    firstName: u.firstName,
    lastName: u.lastName,
    fullName: u.get("fullName"),
    isEmailVerified: u.isEmailVerified,
    isActive: u.isActive,
    deactivatedAt: u.deactivatedAt,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}
