/**
 * Identity & Profile Enrichment Layer
 *
 * Detects corporate environment (Azure AD), silently pulls user profile
 * from Microsoft Graph, and attaches it to the session for enriched
 * coding and analysis.
 *
 * This runs server-side — the frontend passes the Azure AD access token
 * it received from MSAL, and this module uses it to query Graph.
 */

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export interface IdentityConfig {
  /** "auto" | "corporate" | "public" */
  environment: string;
  /** Whether to pull Azure AD profile data */
  enrich_profile: boolean;
  /** Which Graph profile fields to request */
  profile_fields: string[];
  /** Whether to strip PII before storing (replace name with hash, etc.) */
  anonymize: boolean;
}

export interface UserProfile {
  /** Raw fields from Microsoft Graph */
  [key: string]: unknown;
  /** Whether this profile was enriched from Azure AD or is empty */
  enriched: boolean;
}

const DEFAULT_FIELDS = [
  "displayName",
  "department",
  "jobTitle",
  "officeLocation",
  "employeeId",
  "mail",
  "companyName",
  "manager",
];

/**
 * Attempt to enrich a user profile from Microsoft Graph.
 *
 * @param accessToken - Azure AD access token from the frontend (via MSAL)
 * @param identityConfig - Identity settings from the interview config
 * @returns Enriched profile or empty profile if not available
 */
export async function enrichProfile(
  accessToken: string | null,
  identityConfig?: Partial<IdentityConfig>
): Promise<UserProfile> {
  const config: IdentityConfig = {
    environment: identityConfig?.environment || "auto",
    enrich_profile: identityConfig?.enrich_profile ?? true,
    profile_fields: identityConfig?.profile_fields || DEFAULT_FIELDS,
    anonymize: identityConfig?.anonymize ?? false,
  };

  // Skip enrichment if disabled or no token
  if (!config.enrich_profile || !accessToken) {
    return { enriched: false };
  }

  // Skip if environment is explicitly set to public
  if (config.environment === "public") {
    return { enriched: false };
  }

  try {
    const profile = await fetchGraphProfile(accessToken, config.profile_fields);

    // Fetch manager if requested
    if (config.profile_fields.includes("manager")) {
      try {
        const manager = await fetchGraphManager(accessToken);
        profile.manager_name = manager.displayName || undefined;
        profile.manager_department = manager.department || undefined;
      } catch {
        // Manager lookup can fail if user has no manager
      }
    }

    if (config.anonymize) {
      return anonymizeProfile(profile);
    }

    return { ...profile, enriched: true };
  } catch (err) {
    console.error("[identity] Profile enrichment failed:", err);
    return { enriched: false };
  }
}

/**
 * Fetch user profile fields from Microsoft Graph.
 */
async function fetchGraphProfile(
  accessToken: string,
  fields: string[]
): Promise<Record<string, unknown>> {
  // Filter out 'manager' — it's a separate endpoint
  const directFields = fields.filter((f) => f !== "manager");
  const select = directFields.length > 0 ? `?$select=${directFields.join(",")}` : "";

  const resp = await fetch(GRAPH_BASE + "/me" + select, {
    headers: { Authorization: "Bearer " + accessToken },
  });

  if (!resp.ok) {
    throw new Error(`Graph /me failed ${resp.status}: ${await resp.text()}`);
  }

  const data = await resp.json();

  // Only return requested fields
  const profile: Record<string, unknown> = {};
  for (const field of directFields) {
    if (data[field] !== undefined) {
      profile[field] = data[field];
    }
  }

  return profile;
}

/**
 * Fetch user's manager from Microsoft Graph.
 */
async function fetchGraphManager(accessToken: string): Promise<Record<string, unknown>> {
  const resp = await fetch(GRAPH_BASE + "/me/manager", {
    headers: { Authorization: "Bearer " + accessToken },
  });

  if (!resp.ok) throw new Error("Manager lookup failed");
  return resp.json();
}

/**
 * Strip PII from profile, keeping only categorical/structural data.
 * Replaces names with hashed tokens, keeps department/title/location.
 */
function anonymizeProfile(profile: Record<string, unknown>): UserProfile {
  const anon: UserProfile = { enriched: true, anonymized: true };

  // Keep categorical fields as-is
  const keepFields = ["department", "jobTitle", "officeLocation", "companyName"];
  for (const field of keepFields) {
    if (profile[field]) anon[field] = profile[field];
  }

  // Hash identifiable fields
  if (profile.displayName) {
    anon.participant_hash = simpleHash(String(profile.displayName));
  }
  if (profile.employeeId) {
    anon.employee_hash = simpleHash(String(profile.employeeId));
  }
  if (profile.mail) {
    anon.email_hash = simpleHash(String(profile.mail));
  }
  if (profile.manager_name) {
    anon.manager_hash = simpleHash(String(profile.manager_name));
    anon.manager_department = profile.manager_department;
  }

  return anon;
}

/**
 * Simple hash for de-identification — NOT cryptographic, just consistent.
 * Same input always produces the same 8-char token for grouping/analysis.
 */
function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return "p_" + Math.abs(hash).toString(36).slice(0, 8);
}
