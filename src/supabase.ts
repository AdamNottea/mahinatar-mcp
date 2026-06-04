/**
 * Supabase client + auth + Elite plan gate.
 *
 * Auth model — two paths, both run under the USER'S OWN Supabase RLS:
 *   1. TOKEN (preferred for Google-login users with no password): set
 *      MAHINATAR_ACCESS_TOKEN (a Supabase user JWT) and optionally
 *      MAHINATAR_REFRESH_TOKEN. We attach the token as a Bearer header on every
 *      request AND call auth.setSession() so getUser() resolves the user.
 *   2. EMAIL/PASSWORD (fallback): signInWithPassword with the anon key.
 * We NEVER use a service-role key — the server cannot escalate past the user's
 * own data, by design.
 *
 * Auth is lazy: the MCP server starts cleanly even with placeholder creds, and
 * the auth error only surfaces when a tool actually needs the session. This is
 * intentional so `node dist/index.js` lists tools without crashing.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config, AUTHORIZED_PLANS, OWNER_EMAILS } from "./config.js";
import { loadTokens, saveTokens, type Tokens } from "./tokenStore.js";

/**
 * Live tokens. Seeded from env on first boot, then sourced from the cache file
 * (rewritten on every refresh). Held mutable so an in-process refresh is used by
 * later requests with NO restart. A freshly spawned process reads the cache here,
 * so a token refreshed in a prior run is picked up without re-running connect.
 */
let tokens: Tokens = loadTokens({
  accessToken: config.accessToken,
  refreshToken: config.refreshToken,
});

export interface Session {
  userId: string;
  email: string;
  planId: string | null;
  planStatus: string | null;
  authorized: boolean;
  authMethod: "token" | "password";
}

export class AuthError extends Error {}

let client: SupabaseClient | null = null;
let authClient: SupabaseClient | null = null;
let sessionPromise: Promise<Session> | null = null;

function assertSupabaseConfig(): void {
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    throw new AuthError(
      "Missing MAHINATAR_SUPABASE_URL or MAHINATAR_SUPABASE_ANON_KEY. Set them in your MCP env config."
    );
  }
}

/**
 * Data client — carries the user JWT as a Bearer header so PostgREST runs every
 * request under that user's RLS. Rebuilt whenever the access token changes (set
 * `client = null`), so a refreshed token takes effect for subsequent queries.
 */
function getClient(): SupabaseClient {
  assertSupabaseConfig();
  if (!client) {
    const headers = tokens.accessToken
      ? { Authorization: `Bearer ${tokens.accessToken}` }
      : undefined;
    client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      ...(headers ? { global: { headers } } : {}),
    });
  }
  return client;
}

/** Anon client with no user-token override — used only for auth (refresh/getUser). */
function getAuthClient(): SupabaseClient {
  assertSupabaseConfig();
  if (!authClient) {
    authClient = createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return authClient;
}

/** True if the JWT is expired or within `skewSec` of expiring (or unparseable). */
function isExpiringSoon(jwt: string, skewSec = 60): boolean {
  try {
    const payload = JSON.parse(
      Buffer.from(jwt.split(".")[1], "base64url").toString("utf8")
    );
    if (typeof payload.exp !== "number") return true;
    return Date.now() / 1000 >= payload.exp - skewSec;
  } catch {
    return true;
  }
}

/**
 * In-flight refresh guard. Supabase refresh tokens are SINGLE-USE and rotate on
 * every exchange; using one twice trips reuse-detection and revokes the ENTIRE
 * token family. ensureFreshToken() fires on every tool call (and again inside
 * getSession/doTokenSignIn's retry), so without this lock two concurrent calls
 * would both POST a refresh with the same RT → family revoked → "token expired"
 * every session. Collapsing concurrent refreshes onto one promise spends the RT
 * exactly once.
 */
let refreshInFlight: Promise<boolean> | null = null;

/**
 * Exchange the refresh token for a fresh access+refresh pair, persist it, and
 * invalidate the data client so the new bearer is used. Returns false (no throw)
 * if refresh fails — the caller surfaces a clean auth error. Serialized: a second
 * caller while a refresh is running awaits the same exchange instead of starting
 * a second one with the (about-to-rotate) same refresh token.
 */
function refreshTokens(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = doRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function doRefresh(): Promise<boolean> {
  if (!tokens.refreshToken) return false;
  const { data, error } = await getAuthClient().auth.refreshSession({
    refresh_token: tokens.refreshToken,
  });
  if (error || !data.session) {
    console.error("mahinatar-mcp: token refresh failed:", error?.message ?? "no session");
    return false;
  }
  tokens = {
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token, // refresh tokens rotate — persist the new one
  };
  saveTokens(tokens);
  client = null; // force rebuild with the new bearer
  return true;
}

/** Refresh proactively if the access token is expired or near-expiry. */
async function ensureFreshToken(): Promise<void> {
  if (!tokens.accessToken) return; // password-auth mode
  if (!isExpiringSoon(tokens.accessToken)) return;
  await refreshTokens(); // best-effort; sign-in below reports a hard failure
}

/** Reads the plan for a user id from the subscriptions table (RLS-scoped). */
async function resolvePlan(
  supabase: SupabaseClient,
  userId: string
): Promise<{ planId: string | null; planStatus: string | null }> {
  let planId: string | null = null;
  let planStatus: string | null = null;
  try {
    const { data: subs } = await supabase
      .from("subscriptions")
      .select("plan_id, status, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (subs && subs.length > 0) {
      planId = (subs[0] as { plan_id: string | null }).plan_id ?? null;
      planStatus = (subs[0] as { status: string | null }).status ?? null;
    }
  } catch {
    // No subscriptions row / table access — treated as unauthorized below
    // unless the email is an owner.
  }
  return { planId, planStatus };
}

function finalize(
  userId: string,
  email: string,
  planId: string | null,
  planStatus: string | null,
  authMethod: "token" | "password"
): Session {
  const planAuthorized = planId != null && AUTHORIZED_PLANS.has(planId.toLowerCase());
  const ownerAuthorized = OWNER_EMAILS.has(email.toLowerCase());
  return {
    userId,
    email,
    planId,
    planStatus,
    authorized: planAuthorized || ownerAuthorized,
    authMethod,
  };
}

async function doTokenSignIn(): Promise<Session> {
  // Refresh up front if the token is stale (covers boot with an expired token).
  await ensureFreshToken();

  let { data, error } = await getAuthClient().auth.getUser(tokens.accessToken);

  // If still rejected (e.g. token expired between the check and the call, or no
  // skew margin), try one refresh + retry before giving up.
  if ((error || !data.user) && (await refreshTokens())) {
    ({ data, error } = await getAuthClient().auth.getUser(tokens.accessToken));
  }

  if (error || !data.user) {
    throw new AuthError(
      `Could not authenticate with the Mahinatar token: ${error?.message ?? "invalid or expired token"}. The refresh token may have been revoked — reconnect from the Mahinatar MCP page.`
    );
  }

  const userId = data.user.id;
  const email = data.user.email ?? config.email ?? "";
  const { planId, planStatus } = await resolvePlan(getClient(), userId);
  return finalize(userId, email, planId, planStatus, "token");
}

async function doPasswordSignIn(): Promise<Session> {
  const supabase = getClient();

  if (!config.email || !config.password) {
    throw new AuthError(
      "No auth configured. Set MAHINATAR_ACCESS_TOKEN (recommended for Google-login users) OR MAHINATAR_EMAIL + MAHINATAR_PASSWORD in your MCP env config."
    );
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email: config.email,
    password: config.password,
  });

  if (error || !data.user) {
    throw new AuthError(
      `Could not sign in to Mahinatar as ${config.email}: ${error?.message ?? "unknown error"}. Check MAHINATAR_EMAIL / MAHINATAR_PASSWORD.`
    );
  }

  const userId = data.user.id;
  const email = data.user.email ?? config.email;
  const { planId, planStatus } = await resolvePlan(supabase, userId);
  return finalize(userId, email, planId, planStatus, "password");
}

async function doSignIn(): Promise<Session> {
  // Prefer token auth when present (Google-login users have no password).
  if (tokens.accessToken) return doTokenSignIn();
  return doPasswordSignIn();
}

/** Returns the signed-in session, signing in once and caching the result. */
export async function getSession(): Promise<Session> {
  if (!sessionPromise) {
    sessionPromise = doSignIn().catch((err) => {
      // Reset so a later call (e.g. after fixing creds) can retry.
      sessionPromise = null;
      throw err;
    });
  }
  return sessionPromise;
}

/** Returns the authenticated Supabase client (after ensuring a session). */
export async function getAuthedClient(): Promise<{ supabase: SupabaseClient; session: Session }> {
  const session = await getSession();
  // Keep the token fresh across long-running sessions (token TTL ~1h). If it
  // refreshed, getClient() rebuilds with the new bearer.
  await ensureFreshToken();
  return { supabase: getClient(), session };
}

/**
 * Current user access token, refreshed if near-expiry. Used by the control-plane
 * edge-function wrappers (generate/publish/delete site, start scan) so the
 * function authenticates as this user. Mirrors how the remote server passes its
 * per-request bearer through to functions/v1/*.
 */
export async function getAccessToken(): Promise<string> {
  await getSession();
  await ensureFreshToken();
  if (!tokens.accessToken) {
    throw new AuthError("No access token available — set MAHINATAR_ACCESS_TOKEN to call edge functions.");
  }
  return tokens.accessToken;
}

/**
 * Elite gate. Ensures a session AND that the user is authorized for outreach.
 * Throws AuthError with the upgrade message if not.
 */
export async function requireElite(): Promise<{ supabase: SupabaseClient; session: Session }> {
  const { supabase, session } = await getAuthedClient();
  if (!session.authorized) {
    const { UPGRADE_MESSAGE } = await import("./config.js");
    throw new AuthError(UPGRADE_MESSAGE);
  }
  return { supabase, session };
}
