/**
 * Per-user MCP tool permissions — the "AI control panel".
 *
 * The account owner can disable individual tools in-app (mahinatar.me/mcp); the
 * MCP enforces that list on every tool call so toggles take effect in near
 * real time. Default is allow-all (no row / empty array = every tool enabled),
 * so existing connections are unaffected until the owner opts to restrict.
 *
 * Reads are cached briefly (TTL) so a busy session doesn't hammer the DB while
 * still picking up a toggle within a few seconds.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

const CACHE_TTL_MS = 5000;
let cache: { tools: Set<string>; at: number } | null = null;

/** Tools that can never be disabled (the AI must always be able to identify itself). */
export const ALWAYS_ALLOWED = new Set<string>(["mahinatar_whoami"]);

/** Reads the owner's disabled-tool set (RLS-scoped), cached for CACHE_TTL_MS. */
export async function getDisabledTools(
  supabase: SupabaseClient,
  userId: string
): Promise<Set<string>> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.tools;
  try {
    const { data } = await supabase
      .from("mcp_permissions")
      .select("disabled_tools")
      .eq("user_id", userId)
      .maybeSingle();
    const arr = (data as { disabled_tools?: string[] } | null)?.disabled_tools ?? [];
    cache = { tools: new Set(arr), at: now };
  } catch {
    // Fail OPEN on a read error — a transient DB blip must not brick the AI.
    cache = { tools: new Set(), at: now };
  }
  return cache.tools;
}
