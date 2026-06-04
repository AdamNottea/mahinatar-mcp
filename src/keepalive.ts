/**
 * Keep-alive token refresher — run by launchd on a timer (every ~6h).
 *
 * The Supabase session is killed by the project's INACTIVITY timeout when
 * nothing refreshes the token for days (e.g. Claude Code stays closed). That is
 * why the connector "expires after a day/10 days of not using it". This agent
 * refreshes the token on a schedule, independent of whether Claude Code is open,
 * so the session never goes idle and the refresh-token family stays alive.
 *
 * Bootstrap order: token cache (freshest rotated pair) → ~/.claude.json (the
 * connector env, which launchd does NOT load into process.env). Writes the
 * rotated pair back to the cache so the next MCP boot starts valid.
 *
 * Concurrency: safe against the live MCP server also refreshing — Supabase's
 * refresh-token reuse interval (default ~10s) returns the same rotated token for
 * a near-simultaneous second exchange instead of revoking the family, and a 6h
 * cadence makes an overlap window vanishingly small.
 *
 * NOTE: it cannot beat a hard 30-day session TIME-BOX (absolute max session
 * length) if the Supabase project sets one — that needs a dashboard change or a
 * monthly reconnect. See the vault note "MCP Connector — Keep It Alive".
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "./config.js";
import { loadTokens, saveTokens, jwtExp, type Tokens } from "./tokenStore.js";

interface Boot {
  url: string;
  anon: string;
  tokens: Tokens;
}

/** Find the mahinatar MCP env block anywhere in ~/.claude.json (it lives under
 *  projects.<path>.mcpServers.mahinatar.env). Returns url + anon + tokens. */
function fromClaudeJson(): Boot | null {
  try {
    const root = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8"));
    let found: Boot | null = null;
    const walk = (o: unknown): void => {
      if (found || !o || typeof o !== "object") return;
      const rec = o as Record<string, unknown>;
      const env = (rec.mcpServers as Record<string, { env?: Record<string, string> }> | undefined)?.mahinatar?.env;
      if (env && env.MAHINATAR_REFRESH_TOKEN) {
        found = {
          url: env.MAHINATAR_SUPABASE_URL ?? "",
          anon: env.MAHINATAR_SUPABASE_ANON_KEY ?? "",
          tokens: { accessToken: env.MAHINATAR_ACCESS_TOKEN ?? "", refreshToken: env.MAHINATAR_REFRESH_TOKEN },
        };
        return;
      }
      for (const k of Object.keys(rec)) if (typeof rec[k] === "object") walk(rec[k]);
    };
    walk(root);
    return found;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const ts = new Date().toISOString();
  const boot = fromClaudeJson();
  const url = config.supabaseUrl || boot?.url || "";
  const anon = config.supabaseAnonKey || boot?.anon || "";

  // Refresh token: prefer the cache (freshest rotated pair), else the connector env.
  const cacheTokens = loadTokens({ accessToken: "", refreshToken: "" });
  const seed = boot?.tokens ?? { accessToken: "", refreshToken: "" };
  // Use whichever pair has the later access exp, then take its refresh token.
  const live: Tokens =
    jwtExp(cacheTokens.accessToken) >= jwtExp(seed.accessToken) && cacheTokens.refreshToken
      ? cacheTokens
      : seed;

  if (!live.refreshToken) {
    console.log(`[${ts}] keepalive: no refresh token (connect the Mahinatar MCP first).`);
    return;
  }
  if (!url || !anon) {
    console.log(`[${ts}] keepalive: missing Supabase url/anon key.`);
    return;
  }

  const client = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.refreshSession({ refresh_token: live.refreshToken });
  if (error || !data.session) {
    console.log(`[${ts}] keepalive: refresh FAILED: ${error?.message ?? "no session"} (reconnect the connector).`);
    return;
  }
  saveTokens({ accessToken: data.session.access_token, refreshToken: data.session.refresh_token });
  const exp = data.session.expires_at ? new Date(data.session.expires_at * 1000).toISOString() : "?";
  console.log(`[${ts}] keepalive: refreshed OK — next access exp ${exp}`);
}

main().catch((e) => console.log(`keepalive: ${(e as Error).message}`));
