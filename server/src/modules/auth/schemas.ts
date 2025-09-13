import { z } from "zod/v4";

export const passwordPolicy = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .regex(/[a-z]/, "Password needs at least one lowercase letter")
  .regex(/[A-Z]/, "Password needs at least one uppercase letter")
  .regex(/\d/, "Password needs at least one number")
  .regex(/[@$!%*?&]/, "Password needs at least one special character (@$!%*?&)");

export const registerSchema = z
  .object({
    firstName: z.string().trim().min(1, "First name is required").max(50),
    lastName: z.string().trim().min(1, "Last name is required").max(50),
    email: z.string().trim().toLowerCase().email("Must use a valid email address"),
    password: passwordPolicy,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Must use a valid email address"),
  password: z.string().min(1, "Password is required"),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, "refreshToken is required"),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
