/**
 * Central env config. Read once at module load. No secrets are logged.
 */

export interface Config {
  supabaseUrl: string;
  supabaseAnonKey: string;
  email: string;
  password: string;
  resendApiKey: string | undefined;
  /** Master safety switch: only the literal "true" enables live send. */
  outreachLive: boolean;
  fromEmail: string | undefined;
}

function req(name: string): string {
  return process.env[name]?.trim() ?? "";
}

export const config: Config = {
  supabaseUrl: req("MAHINATAR_SUPABASE_URL") || "https://ezugxjvjjqiccxocsojw.supabase.co",
  supabaseAnonKey: req("MAHINATAR_SUPABASE_ANON_KEY"),
  email: req("MAHINATAR_EMAIL"),
  password: req("MAHINATAR_PASSWORD"),
  resendApiKey: req("RESEND_API_KEY") || undefined,
  outreachLive: req("MAHINATAR_OUTREACH_LIVE").toLowerCase() === "true",
  fromEmail: req("MAHINATAR_FROM_EMAIL") || undefined,
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
  "Mahinatar pipeline outreach is an Elite feature. Upgrade at https://mahinatar.com/pricing to unlock lead outreach.";
