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
let sessionPromise: Promise<Session> | null = null;

function getClient(): SupabaseClient {
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    throw new AuthError(
      "Missing MAHINATAR_SUPABASE_URL or MAHINATAR_SUPABASE_ANON_KEY. Set them in your MCP env config."
    );
  }
  if (!client) {
    // When a token is present, attach it as a Bearer header so PostgREST runs
    // every request as that user (RLS) even before/without setSession resolving.
    const headers = config.accessToken
      ? { Authorization: `Bearer ${config.accessToken}` }
      : undefined;
    client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      ...(headers ? { global: { headers } } : {}),
    });
  }
  return client;
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
  const supabase = getClient();

  // Establish a session object so getUser()/auth refresh work. The Bearer
  // header set in getClient() already scopes PostgREST to this user.
  const { error: setErr } = await supabase.auth.setSession({
    access_token: config.accessToken,
    refresh_token: config.refreshToken || config.accessToken,
  });
  // setSession can fail to refresh if no refresh token; that's fine — getUser
  // with the access token below is the source of truth.

  const { data, error } = await supabase.auth.getUser(config.accessToken);
  if (error || !data.user) {
    throw new AuthError(
      `Could not authenticate with MAHINATAR_ACCESS_TOKEN: ${error?.message ?? setErr?.message ?? "invalid or expired token"}. Get a fresh access token from your Mahinatar session (see README → Token connect).`
    );
  }

  const userId = data.user.id;
  const email = data.user.email ?? config.email ?? "";
  const { planId, planStatus } = await resolvePlan(supabase, userId);
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
  if (config.accessToken) return doTokenSignIn();
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
  return { supabase: getClient(), session };
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
