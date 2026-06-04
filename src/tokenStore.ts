/**
 * Token cache — the durable fix for "token expired, re-run curl / restart".
 *
 * Supabase access tokens (user JWTs) are short-lived (~1h). The MCP server is
 * spawned once and used for hours, so the access token baked into the MCP env
 * config goes stale. Previously that forced a manual re-connect (curl) and a
 * Claude Code restart.
 *
 * This store decouples the live tokens from the frozen env:
 *   - Tokens are read from a cache file on EVERY sign-in attempt (not frozen at
 *     module load), so a refreshed token is picked up without a process restart.
 *   - The env values are only the FIRST-BOOT seed; once the cache exists it wins.
 *   - On refresh, the rotated {access, refresh} pair is written back to the cache
 *     so future boots start from a valid pair — no curl, ever.
 *
 * The cache lives next to the server install (../.token-cache.json) with 0600
 * perms. It holds the same secret class as the env config already did.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

const CACHE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", ".token-cache.json");

/** JWT `exp` (seconds) or 0 if unparseable. Used to pick the fresher token. */
export function jwtExp(jwt: string | null | undefined): number {
  if (!jwt) return 0;
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp : 0;
  } catch {
    return 0;
  }
}

/**
 * Choose the live token pair: whichever of {cache, env seed} has the LATER
 * access-token expiry wins. This is the load-bearing fix for "reconnect doesn't
 * stick": previously the cache was preferred unconditionally, so a stale cached
 * (already-revoked) token shadowed a FRESH reconnect that had just written new
 * tokens into the connector env — the server kept failing with "token expired"
 * even right after reconnecting. Now a fresh env seed (later exp) overrides a
 * stale cache, and a cache refreshed in-flight still beats an old env seed.
 */
export function pickFresherTokens(cache: Tokens | null, envSeed: Tokens): Tokens {
  if (!cache || !cache.accessToken) return envSeed;
  if (!envSeed.accessToken) return cache;
  return jwtExp(envSeed.accessToken) > jwtExp(cache.accessToken) ? envSeed : cache;
}

/**
 * Returns the live tokens: the FRESHER of the cache file and the env seed (see
 * pickFresherTokens). Read fresh each call so a refresh persisted by another
 * path (the MCP server or the keep-alive agent) is seen.
 */
export function loadTokens(envSeed: Tokens): Tokens {
  let cache: Tokens | null = null;
  try {
    if (existsSync(CACHE_PATH)) {
      const raw = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
      if (raw && typeof raw.accessToken === "string" && raw.accessToken) {
        cache = {
          accessToken: raw.accessToken,
          refreshToken: typeof raw.refreshToken === "string" ? raw.refreshToken : "",
        };
      }
    }
  } catch {
    // Corrupt/unreadable cache — fall back to the env seed.
  }
  return pickFresherTokens(cache, envSeed);
}

/** Persist a rotated token pair so future sign-ins start valid. Never throws. */
export function saveTokens(tokens: Tokens): void {
  try {
    writeFileSync(CACHE_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  } catch (e) {
    // Persistence is best-effort; an in-memory refresh still works this run.
    console.error("mahinatar-mcp: could not persist token cache:", (e as Error).message);
  }
}
