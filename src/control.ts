/**
 * Control-plane helpers — the write/orchestration surface that turns the MCP
 * from a read-only outreach tool into something an AI can run the product with:
 * lead CRUD + import + bulk ops + dedupe, generated-site detail, credit status,
 * and thin wrappers over the existing edge functions (generate / publish /
 * delete site, start a Maps scan).
 *
 * All DB ops run under the caller's Supabase client (per-user RLS) — these
 * helpers never escalate. Edge-function wrappers POST to functions/v1/* with the
 * caller's access token so the function authenticates as that user.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Lead } from "./leads.js";
import { VALID_OUTREACH_STATUS } from "./leads.js";
import { config } from "./config.js";

/**
 * Look up the freshest generated site for a lead via PostgREST. generate-website
 * persists its homepage checkpoint at ~82% progress, so when the SSE stream ends
 * before the terminal site_id arrives (generation can run ~5 min), this recovers
 * the real site_id instead of returning null.
 */
async function newestSiteIdForLead(
  supabaseUrl: string,
  accessToken: string,
  leadId: string
): Promise<string | null> {
  try {
    const url = `${supabaseUrl.replace(/\/$/, "")}/rest/v1/generated_sites?select=id&lead_id=eq.${leadId}&order=created_at.desc&limit=1`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, apikey: config.supabaseAnonKey },
    });
    if (!res.ok) return null;
    const rows = (await res.json().catch(() => [])) as { id?: string }[];
    return Array.isArray(rows) && rows[0]?.id ? rows[0].id : null;
  } catch {
    return null;
  }
}

// ── Lead CRUD / import / bulk / dedupe ──────────────────────────────────────

/** Fields accepted when creating or importing a lead. business_name required. */
export interface LeadInput {
  business_name: string;
  owner_name?: string | null;
  owner_email?: string | null;
  owner_phone?: string | null;
  website_url?: string | null;
  city?: string | null;
  state?: string | null;
  category?: string | null;
  notes?: string | null;
  status?: string | null;
}

const INSERTABLE_COLUMNS: (keyof LeadInput)[] = [
  "business_name", "owner_name", "owner_email", "owner_phone",
  "website_url", "city", "state", "category", "notes", "status",
];

/** Strip a raw object down to known insertable columns; drop empty strings. */
function cleanLeadInput(input: Partial<LeadInput>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of INSERTABLE_COLUMNS) {
    const v = input[col];
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    out[col] = typeof v === "string" ? v.trim() : v;
  }
  return out;
}

/** Normalize for dedupe: lowercase, collapse whitespace, drop punctuation. */
function dedupeKey(name: string | null | undefined, city: string | null | undefined): string {
  const norm = (s: string | null | undefined) =>
    (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return `${norm(name)}|${norm(city)}`;
}

/** Insert one lead owned by userId. Returns the created row. */
export async function createLead(
  supabase: SupabaseClient,
  userId: string,
  input: LeadInput
): Promise<Lead> {
  if (!input.business_name || !input.business_name.trim()) {
    throw new Error("business_name is required to create a lead.");
  }
  const row = { ...cleanLeadInput(input), user_id: userId };
  const { data, error } = await supabase.from("leads").insert(row as never).select("*").maybeSingle();
  if (error) throw new Error(error.message);
  return data as unknown as Lead;
}

export interface ImportResult {
  inserted: number;
  skipped_duplicates_in_batch: number;
  skipped_invalid: number;
  lead_ids: string[];
}

/**
 * Bulk-import leads. De-duplicates WITHIN the batch (by email, else name+city)
 * so a CSV with repeated rows doesn't double-insert. Does not dedupe against
 * existing rows — use findDuplicateLeads for that. Inserts in one round-trip.
 */
export async function importLeads(
  supabase: SupabaseClient,
  userId: string,
  rows: Partial<LeadInput>[]
): Promise<ImportResult> {
  const seen = new Set<string>();
  const toInsert: Record<string, unknown>[] = [];
  let skippedDup = 0;
  let skippedInvalid = 0;

  for (const raw of rows) {
    const name = raw.business_name?.trim();
    if (!name) { skippedInvalid += 1; continue; }
    const email = raw.owner_email?.trim().toLowerCase();
    const key = email && email.length > 0 ? `email:${email}` : `nc:${dedupeKey(name, raw.city)}`;
    if (seen.has(key)) { skippedDup += 1; continue; }
    seen.add(key);
    toInsert.push({ ...cleanLeadInput({ ...raw, business_name: name }), user_id: userId });
  }

  if (toInsert.length === 0) {
    return { inserted: 0, skipped_duplicates_in_batch: skippedDup, skipped_invalid: skippedInvalid, lead_ids: [] };
  }

  const { data, error } = await supabase.from("leads").insert(toInsert as never).select("id");
  if (error) throw new Error(error.message);
  const ids = ((data as unknown as { id: string }[]) ?? []).map((r) => r.id);
  return { inserted: ids.length, skipped_duplicates_in_batch: skippedDup, skipped_invalid: skippedInvalid, lead_ids: ids };
}

export interface BulkUpdateResult {
  requested: number;
  updated: number;
  applied: string[];
}

/**
 * Apply the same status and/or stage (outreach_status) to a set of leads in one
 * statement. Append-note is intentionally NOT supported here (per-lead note
 * append needs a read-modify-write per row; use mahinatar_update_lead for that).
 */
export async function bulkUpdateLeads(
  supabase: SupabaseClient,
  ids: string[],
  patch: { status?: string; stage?: string }
): Promise<BulkUpdateResult> {
  const uniqueIds = Array.from(new Set(ids)).filter(Boolean);
  if (uniqueIds.length === 0) return { requested: 0, updated: 0, applied: [] };
  if (patch.stage && !VALID_OUTREACH_STATUS.has(patch.stage)) {
    throw new Error(`Invalid stage '${patch.stage}'. outreach_status must be one of: ${[...VALID_OUTREACH_STATUS].join(", ")}.`);
  }

  const update: Record<string, unknown> = {};
  const applied: string[] = [];
  if (patch.status) { update.status = patch.status; applied.push("status"); }
  if (patch.stage) { update.outreach_status = patch.stage; applied.push("stage"); }
  if (applied.length === 0) return { requested: uniqueIds.length, updated: 0, applied };
  update.updated_at = new Date().toISOString();

  const { data, error } = await supabase.from("leads").update(update as never).in("id", uniqueIds).select("id");
  if (error) throw new Error(error.message);
  const updated = ((data as unknown as { id: string }[]) ?? []).length;
  return { requested: uniqueIds.length, updated, applied };
}

export interface DuplicateGroup {
  key: string;
  reason: "email" | "name+city";
  count: number;
  lead_ids: string[];
}

/**
 * Find likely-duplicate leads in the user's pipeline: same owner_email, or same
 * normalized business_name + city. Read-only — reports groups so the caller (or
 * a human) decides what to merge. Never auto-deletes.
 */
export async function findDuplicateLeads(
  supabase: SupabaseClient,
  scanLimit = 2000
): Promise<{ groups: DuplicateGroup[]; scanned: number }> {
  const { data, error } = await supabase
    .from("leads")
    .select("id, business_name, owner_email, city, created_at")
    .order("created_at", { ascending: true })
    .limit(scanLimit);
  if (error) throw new Error(error.message);
  const rows = (data as unknown as { id: string; business_name: string | null; owner_email: string | null; city: string | null }[]) ?? [];

  const byEmail = new Map<string, string[]>();
  const byNameCity = new Map<string, string[]>();
  for (const r of rows) {
    const email = r.owner_email?.trim().toLowerCase();
    if (email) byEmail.set(email, [...(byEmail.get(email) ?? []), r.id]);
    else {
      const k = dedupeKey(r.business_name, r.city);
      if (k.replace(/[|\s]/g, "")) byNameCity.set(k, [...(byNameCity.get(k) ?? []), r.id]);
    }
  }

  const groups: DuplicateGroup[] = [];
  for (const [key, ids] of byEmail) if (ids.length > 1) groups.push({ key, reason: "email", count: ids.length, lead_ids: ids });
  for (const [key, ids] of byNameCity) if (ids.length > 1) groups.push({ key, reason: "name+city", count: ids.length, lead_ids: ids });
  groups.sort((a, b) => b.count - a.count);
  return { groups, scanned: rows.length };
}

// ── Generated-site detail ───────────────────────────────────────────────────

/** Full generated-site row + computed public url. Defensive about columns. */
export async function fetchSiteDetail(
  supabase: SupabaseClient,
  id: string
): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase.from("generated_sites").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const row = data as Record<string, unknown>;
  const slug = row.preview_slug || row.site_slug;
  const url = row.custom_domain
    ? `https://${String(row.custom_domain).replace(/^https?:\/\//, "")}`
    : slug ? `https://www.mahinatar.me/s/${slug}` : null;
  const published = Boolean(row.published_at || row.is_published_on_free);
  return { ...row, computed_url: url, computed_status: published ? "published" : row.is_done ? "done" : "draft" };
}

// ── Credit / usage status ───────────────────────────────────────────────────

/** Current credit balance from subscription_usage (RLS-scoped to the user). */
export async function creditStatus(
  supabase: SupabaseClient,
  userId: string
): Promise<Record<string, unknown>> {
  const { data, error } = await supabase
    .from("subscription_usage")
    .select("credits_used, purchased_credits, subscription_credits, period_start, period_end")
    .eq("user_id", userId)
    .order("period_start", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    // Column drift (period_* may not exist) — retry with the core three.
    const retry = await supabase
      .from("subscription_usage")
      .select("credits_used, purchased_credits, subscription_credits")
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle();
    if (retry.error) throw new Error(retry.error.message);
    return summarizeCredits(retry.data as Record<string, unknown> | null);
  }
  return summarizeCredits(data as Record<string, unknown> | null);
}

function summarizeCredits(row: Record<string, unknown> | null): Record<string, unknown> {
  if (!row) return { found: false, note: "No subscription_usage row — likely a free/unmetered account." };
  const used = Number(row.credits_used ?? 0);
  const purchased = Number(row.purchased_credits ?? 0);
  const subscription = Number(row.subscription_credits ?? 0);
  const remaining = subscription + purchased - used;
  return { found: true, credits_used: used, purchased_credits: purchased, subscription_credits: subscription, credits_remaining: remaining, ...row };
}

// ── Edge-function wrappers ──────────────────────────────────────────────────

/** POST functions/v1/<name> as the user. Returns parsed JSON or throws. */
export async function callEdge(
  supabaseUrl: string,
  accessToken: string,
  name: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const res = await fetch(`${supabaseUrl}/functions/v1/${name}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${name} failed (${res.status}): ${(json.error as string) ?? (json.message as string) ?? "see app logs"}`);
  return json;
}

/**
 * Trigger site generation and return the persisted site_id.
 *
 * generate-website responds with a Server-Sent Events stream (the app UI reads
 * progress from it). The site_id only appears mid/late-stream — in the terminal
 * `complete`/`done` event, and in an early homepage `checkpoint`. The previous
 * implementation called `res.json()` on that stream, which can't parse SSE, so
 * it returned `{}` with no site ("flaky generation"). We now consume the stream
 * and surface the real site_id. mode 'lead' regenerates against an existing
 * lead; 'scratch' builds from a business name with no source URL.
 */
export async function generateSite(
  supabaseUrl: string,
  accessToken: string,
  opts: { lead_id?: string; business_name?: string; source_url?: string; mode?: "lead" | "scratch" | "clone" }
): Promise<Record<string, unknown>> {
  const mode = opts.mode ?? (opts.lead_id ? "lead" : "scratch");
  const body: Record<string, unknown> = { mode };
  if (opts.lead_id) body.lead_id = opts.lead_id;
  if (opts.business_name) body.business_name = opts.business_name;
  if (opts.source_url) body.source_url = opts.source_url;

  const res = await fetch(`${supabaseUrl.replace(/\/$/, "")}/functions/v1/generate-website`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    let msg = raw;
    try { const j = JSON.parse(raw); msg = (j.message as string) ?? (j.error as string) ?? raw; } catch { /* keep raw */ }
    throw new Error(`generate-website failed (${res.status}): ${msg || "see app logs"}`);
  }

  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("event-stream") || !res.body) {
    // Non-stream response (e.g. an early JSON error envelope) — pass it through.
    return (await res.json().catch(() => ({}))) as Record<string, unknown>;
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let siteId: string | null = null;
  let status: string | null = null;
  let lastError: string | null = null;
  const recentEvents: string[] = [];
  const deadlineMs = Date.now() + 180_000; // cap the blocking window; DB fallback covers the slow tail

  try {
    while (Date.now() < deadlineMs) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const blocks = buf.split("\n\n");
      buf = blocks.pop() ?? "";
      for (const block of blocks) {
        const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        const payload = dataLine.slice(5).trim();
        if (!payload) continue;
        let ev: Record<string, unknown>;
        try { ev = JSON.parse(payload) as Record<string, unknown>; } catch { continue; }
        const evType = (ev.type as string) ?? (ev.status as string);
        if (typeof evType === "string") recentEvents.push(evType);
        const sid = (ev.site_id as string) ?? (ev.siteId as string) ?? (ev.checkpointSiteId as string);
        if (typeof sid === "string" && sid) siteId = sid;
        if (ev.type === "complete" || ev.type === "done" || ev.status === "complete") status = "complete";
        if (ev.type === "error" || ev.status === "failed" || ev.error) {
          lastError = (ev.message as string) ?? (ev.error as string) ?? "generation error";
          status = status ?? "failed";
        }
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }

  // Stream didn't surface a site_id in time — but generation continues
  // server-side and persists a checkpoint row. Recover it from the DB.
  if (!siteId && opts.lead_id) {
    siteId = await newestSiteIdForLead(supabaseUrl, accessToken, opts.lead_id);
    if (siteId) status = status ?? "persisted";
  }

  if (siteId) {
    return { site_id: siteId, status: status ?? "done", events: recentEvents.slice(-8) };
  }
  if (status === "failed") {
    return { site_id: null, status: "failed", error: lastError, events: recentEvents.slice(-12) };
  }
  // Still generating (the ~82% checkpoint hasn't landed yet). Honest, not a null
  // error: the site will appear shortly — fetch it with mahinatar_list_sites.
  return {
    site_id: null,
    status: "running",
    note: "Generation is still running (~5 min total). The site persists server-side — call mahinatar_list_sites in a minute to get its id/url.",
    events: recentEvents.slice(-12),
  };
}

export async function publishSite(supabaseUrl: string, accessToken: string, siteId: string): Promise<Record<string, unknown>> {
  return callEdge(supabaseUrl, accessToken, "publish-site", { site_id: siteId });
}

export async function deleteSite(supabaseUrl: string, accessToken: string, siteId: string): Promise<Record<string, unknown>> {
  return callEdge(supabaseUrl, accessToken, "delete-site", { site_id: siteId });
}

/** Start a Google Maps / niche scan (search-places). Surfaces new leads. */
export async function startScan(
  supabaseUrl: string,
  accessToken: string,
  opts: { location: string; category: string; batchMode?: boolean }
): Promise<Record<string, unknown>> {
  return callEdge(supabaseUrl, accessToken, "search-places", {
    location: opts.location,
    category: opts.category,
    ...(opts.batchMode != null ? { batchMode: opts.batchMode } : {}),
  });
}

// ── Site editing (read/write the user's own generated sites) ────────────────

/** Read a generated site's current HTML + data so the agent can decide edits. */
export async function getSiteHtml(
  supabase: SupabaseClient,
  id: string
): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase
    .from("generated_sites")
    .select("id, business_name, site_html, site_data, preview_slug, published_at, updated_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as Record<string, unknown> | null) ?? null;
}

/**
 * Overwrite a generated site's home-page HTML (RLS-scoped to the owner). Lets the
 * agent directly fix/complete a site after inspecting it with getSiteHtml. Keep
 * accessibility intact (skip-link, focus styles, alt text, landmarks) when editing.
 * Re-publish with publishSite to push the change to the live URL.
 */
export async function updateSiteHtml(
  supabase: SupabaseClient,
  id: string,
  html: string
): Promise<Record<string, unknown>> {
  const trimmed = (html ?? "").trim();
  if (trimmed.length < 50) throw new Error("Refusing to write near-empty HTML (min 50 chars).");
  if (new TextEncoder().encode(trimmed).length > 2_000_000) throw new Error("HTML exceeds 2MB limit.");
  const { data, error } = await supabase
    .from("generated_sites")
    .update({ site_html: trimmed, updated_at: new Date().toISOString() } as never)
    .eq("id", id)
    .select("id, preview_slug")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`Site ${id} not found or not owned by you.`);
  return { updated: true, site_id: id, note: "Call mahinatar_publish_site to push this to the live URL." };
}

/** AI-regenerate one page of a site with an optional instruction (persists). */
export async function regeneratePage(
  supabaseUrl: string,
  accessToken: string,
  opts: { siteId: string; page?: string; instruction?: string }
): Promise<Record<string, unknown>> {
  return callEdge(supabaseUrl, accessToken, "regenerate-page", {
    siteId: opts.siteId,
    ...(opts.page ? { page: opts.page } : {}),
    ...(opts.instruction ? { instruction: opts.instruction } : {}),
  });
}

/** Toggle a site add-on (e.g. chatbot, custom domain) on/off. */
export async function toggleSiteAddon(
  supabaseUrl: string,
  accessToken: string,
  siteId: string,
  action: string
): Promise<Record<string, unknown>> {
  return callEdge(supabaseUrl, accessToken, "toggle-site-addon", { siteId, action });
}

// ── Audit / prospecting / SEO ───────────────────────────────────────────────

/** Analyze a website (conversion/quality audit) by lead or URL. */
export async function analyzeWebsite(
  supabaseUrl: string,
  accessToken: string,
  opts: { leadId?: string; websiteUrl?: string }
): Promise<Record<string, unknown>> {
  return callEdge(supabaseUrl, accessToken, "analyze-website", {
    ...(opts.leadId ? { leadId: opts.leadId } : {}),
    ...(opts.websiteUrl ? { websiteUrl: opts.websiteUrl } : {}),
  });
}

/** Scan a lead's full online presence (site, social, maps, reviews). */
export async function scanPresence(
  supabaseUrl: string,
  accessToken: string,
  leadId: string
): Promise<Record<string, unknown>> {
  return callEdge(supabaseUrl, accessToken, "scan-business-presence", { lead_id: leadId });
}

/** Generate SEO metadata/content for a generated site. */
export async function generateSeo(
  supabaseUrl: string,
  accessToken: string,
  siteId: string
): Promise<Record<string, unknown>> {
  return callEdge(supabaseUrl, accessToken, "generate-seo", { siteId });
}
