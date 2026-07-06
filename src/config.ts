/**
 * Central env config. Read once at module load. No secrets are logged.
 */

export interface Config {
  supabaseUrl: string;
  supabaseAnonKey: string;
  email: string;
  password: string;
  /** Supabase user JWT (access token). Preferred auth for Google-login users. */
  accessToken: string;
  /** Optional refresh token paired with the access token. */
  refreshToken: string;
  resendApiKey: string | undefined;
  /** Master safety switch: only the literal "true" enables live send. */
  outreachLive: boolean;
  fromEmail: string | undefined;
  /** Reply-To — from-domain has no inbound MX, so replies need a real inbox. */
  replyTo: string | undefined;
  /** Optional https one-click unsubscribe endpoint (RFC 8058). */
  unsubscribeUrl: string | undefined;
  /** Physical postal address appended to every live send (CAN-SPAM requirement). */
  postalAddress: string | undefined;
}

function req(name: string): string {
  return process.env[name]?.trim() ?? "";
}

export const config: Config = {
  supabaseUrl: req("MAHINATAR_SUPABASE_URL") || "https://ezugxjvjjqiccxocsojw.supabase.co",
  supabaseAnonKey: req("MAHINATAR_SUPABASE_ANON_KEY"),
  email: req("MAHINATAR_EMAIL"),
  password: req("MAHINATAR_PASSWORD"),
  accessToken: req("MAHINATAR_ACCESS_TOKEN"),
  refreshToken: req("MAHINATAR_REFRESH_TOKEN"),
  resendApiKey: req("RESEND_API_KEY") || undefined,
  outreachLive: req("MAHINATAR_OUTREACH_LIVE").toLowerCase() === "true",
  fromEmail: req("MAHINATAR_FROM_EMAIL") || undefined,
  replyTo: req("MAHINATAR_REPLY_TO") || undefined,
  unsubscribeUrl: req("MAHINATAR_UNSUBSCRIBE_URL") || undefined,
  postalAddress: req("MAHINATAR_POSTAL_ADDRESS") || undefined,
};

/** Plans that unlock pipeline outreach. */
export const AUTHORIZED_PLANS = new Set(["elite", "admin", "enterprise", "agency"]);

/**
 * Owner emails that are always authorized regardless of subscription row.
 * (Mahinatar account owner / staff.)
 */
export const OWNER_EMAILS = new Set(["adamnottea@gmail.com"]);

/** Max live sends per server run (in-memory throttle). */
export const MAX_SENDS_PER_RUN = 20;

export const UPGRADE_MESSAGE =
  "Mahinatar pipeline outreach is an Elite feature. Upgrade at https://www.mahinatar.me/pricing to unlock lead outreach.";
