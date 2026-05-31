/**
 * Supabase client + auth + Elite plan gate.
 *
 * Auth model: we sign in with the user's OWN email/password using the public
 * anon key. Every query therefore runs under that user's Supabase RLS policies.
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
    client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

async function doSignIn(): Promise<Session> {
  const supabase = getClient();

  if (!config.email || !config.password) {
    throw new AuthError(
      "Missing MAHINATAR_EMAIL or MAHINATAR_PASSWORD. Set them in your MCP env config so the server can sign in to your Mahinatar account."
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

  // Read the plan from the subscriptions table (RLS scopes to this user).
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

  const planAuthorized = planId != null && AUTHORIZED_PLANS.has(planId.toLowerCase());
  const ownerAuthorized = OWNER_EMAILS.has(email.toLowerCase());

  return {
    userId,
    email,
    planId,
    planStatus,
    authorized: planAuthorized || ownerAuthorized,
  };
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
