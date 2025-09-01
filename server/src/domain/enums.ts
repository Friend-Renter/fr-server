/** Domain enums (string unions keep JSON clean and easy to index) */

export type Category = "car" | "boat" | "jetski" | "electronics" | "lawn" | "misc";

export type AssetStatus = "pending" | "active" | "suspended" | "archived";

export type ListingStatus = "draft" | "active" | "suspended" | "archived";

/** Booking lifecycle (payment capture happens around completed/checkout) */
export type BookingState =
  | "draft"
  | "pending" // created, awaiting host confirm (if not instant)
  | "accepted" // confirmed (or instant)
  | "declined"
  | "cancelled"
  | "in_progress" // during rental window (checked-in)
  | "completed"; // returned/checked-out (ready for capture/payout)

export type KycStatus = "unverified" | "pending" | "verified" | "rejected";

export type CancellationPolicy = "flexible" | "moderate" | "strict";

/** For audit trails when we integrate Persona */
export type VerificationProvider = "persona";
