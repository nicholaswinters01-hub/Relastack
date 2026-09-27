import { z } from 'zod';
import { organizationNameSchema } from './organization';

/**
 * Authentication contracts.
 *
 * These schemas are the single definition of what a valid registration or
 * login looks like. The API validates requests against them; the web client
 * validates the same input before submitting, so the user sees errors without
 * a round trip while the server still never trusts the client.
 */

/**
 * Minimum password length.
 *
 * 12 rather than 8. Length dominates every other password rule for real-world
 * resistance to offline cracking, and NIST SP 800-63B explicitly discourages
 * composition rules (one upper, one digit, one symbol) because they push users
 * toward predictable patterns like "Password1!" without adding real entropy.
 */
export const PASSWORD_MIN_LENGTH = 12;

/**
 * Upper bound. Argon2 handles long inputs fine, but an unbounded field is an
 * invitation to send a 10 MB "password" and consume server CPU hashing it.
 */
export const PASSWORD_MAX_LENGTH = 256;

export const emailSchema = z
  .string()
  .trim()
  .min(1, 'Email is required')
  .max(320, 'Email is too long')
  .email('Enter a valid email address')
  // Stored as citext, but normalising here keeps values consistent for any
  // consumer that compares them outside the database.
  .transform((value) => value.toLowerCase());

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`);

const optionalName = z
  .string()
  .trim()
  .max(100, 'Name is too long')
  .optional()
  .transform((value) => (value === '' ? undefined : value));

export const registerRequestSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    firstName: optionalName,
    lastName: optionalName,
    /**
     * Registration creates an organization with the registrant as its owner.
     * Employees join later by invitation (Phase 4) rather than by registering,
     * so every self-registration is a new business signing up.
     */
    organizationName: organizationNameSchema,
    /** Checked by the API only when the deployment requires one. */
    accessCode: z.string().trim().max(200).optional(),
  })
  // A password that is merely the email address passes a length check but is
  // among the first things any credential-stuffing attempt tries.
  .refine((data) => data.password.toLowerCase() !== data.email, {
    message: 'Password must not be your email address',
    path: ['password'],
  });

export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const loginRequestSchema = z.object({
  email: emailSchema,
  // Deliberately NOT `passwordSchema`. Applying the registration policy here
  // would reject an old password that predates a policy change, and would leak
  // the policy to anyone probing the login endpoint.
  password: z.string().min(1, 'Password is required').max(PASSWORD_MAX_LENGTH),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** How long a "forgot password" link works. */
export const PASSWORD_RESET_TTL_MINUTES = 60;

export const forgotPasswordRequestSchema = z.object({ email: emailSchema });
export type ForgotPasswordRequest = z.infer<typeof forgotPasswordRequestSchema>;

export const resetPasswordRequestSchema = z.object({
  token: z.string().trim().min(1, 'This link is not valid').max(200),
  password: passwordSchema,
});
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;

export const userStatusSchema = z.enum(['ACTIVE', 'SUSPENDED']);
export type UserStatus = z.infer<typeof userStatusSchema>;

/**
 * The public shape of a user. Note what is absent: passwordHash, and any
 * session material. This schema is the boundary that keeps them absent —
 * services return it rather than the raw database row.
 */
export const publicUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  status: userStatusSchema,
  lastLoginAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

export type PublicUser = z.infer<typeof publicUserSchema>;

export const authResponseSchema = z.object({
  user: publicUserSchema,
});

export type AuthResponse = z.infer<typeof authResponseSchema>;

export const logoutResponseSchema = z.object({
  success: z.literal(true),
  sessionsRevoked: z.number().int().nonnegative(),
});

export type LogoutResponse = z.infer<typeof logoutResponseSchema>;

/** Name of the cookie carrying the session token. */
export const SESSION_COOKIE_NAME = 'platform_session';
