/**
 * Lead helpers: defensive column selection.
 *
 * The `leads` table schema can drift, so we keep an explicit known-column list
 * and probe once for "optional" compliance columns (do_not_contact, etc.) that
 * may or may not exist. Anything we select that's missing would error, so we
 * only ever select known columns and degrade gracefully for the rest.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** Columns we know exist and surface in list/detail. */
export const LEAD_LIST_COLUMNS = [
  "id",
  "business_name",
  "owner_name",
  "owner_email",
  "owner_phone",
  "website_url",
  "website_status",
  "site_quality",
  "city",
  "state",
  "category",
  "status",
  "outreach_status",
  "notes",
  "created_at",
  "updated_at",
  "sale_amount",
  "temperature",
  "priority",
  "has_generated_site",
  "follow_up_date",
] as const;

export interface Lead {
  id: string;
  business_name: string | null;
  owner_name: string | null;
  owner_email: string | null;
  owner_phone: string | null;
  website_url: string | null;
  website: string | null;
  website_status: string | null;
  site_quality: string | null;
  city: string | null;
  state: string | null;
  category: string | null;
  status: string | null;
  outreach_status: string | null;
  notes: string | null;
  created_at: string | null;
  updated_at?: string | null;
  sale_amount?: number | null;
  temperature?: string | null;
  priority?: string | null;
  has_generated_site?: boolean | null;
  follow_up_date?: string | null;
  // Possible compliance columns, present only on some rows/schemas.
  do_not_contact?: boolean | null;
  unsubscribed?: boolean | null;
  last_contacted_at?: string | null;
}

const SELECT = LEAD_LIST_COLUMNS.join(", ");

/**
 * Probe which of `candidates` actually exist on a table by selecting them in
 * one cheap (limit 0) query and falling back column-by-column on error. Result
 * is cached per table for the process lifetime.
 */
const columnCache = new Map<string, Set<string>>();

export async function existingColumns(
  supabase: SupabaseClient,
  table: string,
  candidates: readonly string[]
): Promise<Set<string>> {
  const cacheKey = `${table}:${candidates.join(",")}`;
  const cached = columnCache.get(cacheKey);
  if (cached) return cached;

  const present = new Set<string>();
  // Fast path: try all at once.
  const { error } = await supabase.from(table).select(candidates.join(", ")).limit(0);
  if (!error) {
    for (const c of candidates) present.add(c);
  } else {
    // Slow path: probe individually.
    for (const c of candidates) {
      const { error: e } = await supabase.from(table).select(c).limit(0);
      if (!e) present.add(c);
    }
  }
  columnCache.set(cacheKey, present);
  return present;
}

export async function fetchLead(
  supabase: SupabaseClient,
  id: string
): Promise<Lead | null> {
  // Select * for detail so optional columns (do_not_contact, etc.) come along
  // if they exist, without us having to name them.
  const { data, error } = await supabase.from("leads").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as Lead | null) ?? null;
}

export async function listLeads(
  supabase: SupabaseClient,
  opts: { status?: string; hasEmail?: boolean; limit: number }
): Promise<Lead[]> {
  let q = supabase.from("leads").select(SELECT).order("created_at", { ascending: false });
  if (opts.status) q = q.eq("status", opts.status);
  if (opts.hasEmail === true) q = q.not("owner_email", "is", null);
  if (opts.hasEmail === false) q = q.is("owner_email", null);
  q = q.limit(opts.limit);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data as unknown as Lead[]) ?? [];
}

/**
 * Returns a reason string if the lead must NOT be contacted, else null.
 * Defensive: only reads fields that may exist on the row object.
 */
export function suppressionReason(lead: Lead): string | null {
  if (lead.do_not_contact === true) return "lead is marked do_not_contact";
  if (lead.unsubscribed === true) return "lead is unsubscribed";
  return null;
}

/**
 * Best-effort update of post-send lead state. Only sets columns that exist.
 * We probe by attempting the richest update and falling back to status-only.
 */
export async function markLeadContacted(
  supabase: SupabaseClient,
  id: string,
  opts: { note?: string } = {}
): Promise<void> {
  const nowIso = new Date().toISOString();

  // Build the richest patch, then strip unknown columns if the DB rejects them.
  const patches: Record<string, unknown>[] = [];

  // Only set outreach_status='sent' — the "we reached out" signal. Do NOT touch
  // `status`: lead_status is an enum with NO 'contacted' value, and
  // outreach_status's CHECK is not_sent|drafted|sent|replied|bounced. 'contacted'
  // is invalid for BOTH columns and previously made every call throw.
  const rich: Record<string, unknown> = {
    outreach_status: "sent",
    last_contacted_at: nowIso,
  };
  if (opts.note) rich.notes = opts.note;
  patches.push(rich);

  // Fallback 1: drop last_contacted_at (may not exist).
  const mid: Record<string, unknown> = {
    outreach_status: "sent",
  };
  if (opts.note) mid.notes = opts.note;
  patches.push(mid);

  // Fallback 2: outreach_status only (always exists).
  patches.push({ outreach_status: "sent" });

  let lastErr: string | null = null;
  for (const patch of patches) {
    const { error } = await supabase.from("leads").update(patch).eq("id", id);
    if (!error) return;
    lastErr = error.message;
    // Only keep falling back on "column does not exist"-style errors.
    if (!/column|schema|does not exist|could not find/i.test(error.message)) {
      throw new Error(error.message);
    }
  }
  throw new Error(lastErr ?? "Failed to update lead.");
}

/** Appends a timestamped line to an existing notes string. */
function appendNote(existing: string | null | undefined, note: string): string {
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const line = `[${stamp}] ${note.trim()}`;
  return existing && existing.trim() ? `${existing.trim()}\n${line}` : line;
}

/**
 * Generalized lead update. Only touches columns that exist (defensive). Can set
 * status and/or stage (outreach_status) and/or append a timestamped note.
 * Returns which fields were applied.
 */
export async function updateLead(
  supabase: SupabaseClient,
  id: string,
  opts: { status?: string; stage?: string; note?: string }
): Promise<{ applied: string[] }> {
  const cols = await existingColumns(supabase, "leads", [
    "status",
    "outreach_status",
    "notes",
    "updated_at",
  ]);

  const patch: Record<string, unknown> = {};
  const applied: string[] = [];

  if (opts.status && cols.has("status")) {
    patch.status = opts.status;
    applied.push("status");
  }
  if (opts.stage && cols.has("outreach_status")) {
    patch.outreach_status = opts.stage;
    applied.push("stage");
  }
  if (opts.note && cols.has("notes")) {
    // Read current notes so we append rather than overwrite.
    const current = await fetchLead(supabase, id);
    patch.notes = appendNote(current?.notes, opts.note);
    applied.push("note");
  }
  if (cols.has("updated_at")) patch.updated_at = new Date().toISOString();

  if (applied.length === 0) {
    return { applied };
  }

  const { error } = await supabase.from("leads").update(patch).eq("id", id);
  if (error) throw new Error(error.message);
  return { applied };
}

export interface SearchOpts {
  query?: string;
  status?: string;
  hasEmail?: boolean;
  hasWebsite?: boolean;
  city?: string;
  limit: number;
}

/** Filtered lead search for targeting. */
export async function searchLeads(supabase: SupabaseClient, opts: SearchOpts): Promise<Lead[]> {
  let q = supabase.from("leads").select(SELECT).order("created_at", { ascending: false });

  if (opts.status) q = q.eq("status", opts.status);
  if (opts.hasEmail === true) q = q.not("owner_email", "is", null);
  if (opts.hasEmail === false) q = q.is("owner_email", null);
  if (opts.hasWebsite === true) q = q.not("website_url", "is", null);
  if (opts.hasWebsite === false) q = q.is("website_url", null);
  if (opts.city) q = q.ilike("city", `%${opts.city}%`);
  if (opts.query) {
    const term = opts.query.replace(/[%,]/g, " ");
    q = q.or(
      `business_name.ilike.%${term}%,owner_name.ilike.%${term}%,owner_email.ilike.%${term}%,category.ilike.%${term}%`
    );
  }
  q = q.limit(opts.limit);

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data as unknown as Lead[]) ?? [];
}

// ── Generated sites ─────────────────────────────────────────────────────────

const SITE_COLUMNS = [
  "id",
  "lead_id",
  "business_name",
  "city",
  "site_slug",
  "preview_slug",
  "custom_domain",
  "is_published_on_free",
  "published_at",
  "is_done",
  "deleted_at",
  "updated_at",
] as const;

export interface GeneratedSite {
  id: string;
  business: string | null;
  url: string | null;
  status: string;
  lead_id: string | null;
  updated_at: string | null;
}

function siteUrl(row: Record<string, unknown>): string | null {
  if (row.custom_domain) return `https://${String(row.custom_domain).replace(/^https?:\/\//, "")}`;
  const slug = row.preview_slug || row.site_slug;
  if (slug) return `https://mahinatar.com/s/${slug}`;
  return null;
}

function siteStatus(row: Record<string, unknown>): string {
  if (row.published_at || row.is_published_on_free) return "published";
  if (row.is_done) return "done";
  return "draft";
}

/** List the user's generated sites (RLS-scoped). Defensive about columns. */
export async function listGeneratedSites(
  supabase: SupabaseClient,
  opts: { status?: string; limit: number }
): Promise<GeneratedSite[]> {
  const cols = await existingColumns(supabase, "generated_sites", SITE_COLUMNS);
  const selectCols = SITE_COLUMNS.filter((c) => cols.has(c));
  let q = supabase
    .from("generated_sites")
    .select(selectCols.join(", "))
    .order("updated_at", { ascending: false });

  if (cols.has("deleted_at")) q = q.is("deleted_at", null);
  q = q.limit(opts.limit);

  const { data, error } = await q;
  if (error) throw new Error(error.message);

  let rows = (data as unknown as Record<string, unknown>[]) ?? [];
  const mapped: GeneratedSite[] = rows.map((r) => ({
    id: String(r.id),
    business: (r.business_name as string) ?? null,
    url: siteUrl(r),
    status: siteStatus(r),
    lead_id: (r.lead_id as string) ?? null,
    updated_at: (r.updated_at as string) ?? null,
  }));

  if (opts.status) {
    return mapped.filter((s) => s.status === opts.status);
  }
  return mapped;
}
