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
  // Possible compliance columns, present only on some rows/schemas.
  do_not_contact?: boolean | null;
  unsubscribed?: boolean | null;
  last_contacted_at?: string | null;
}

const SELECT = LEAD_LIST_COLUMNS.join(", ");

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

  const rich: Record<string, unknown> = {
    status: "contacted",
    outreach_status: "contacted",
    last_contacted_at: nowIso,
  };
  if (opts.note) rich.notes = opts.note;
  patches.push(rich);

  // Fallback 1: drop last_contacted_at (may not exist).
  const mid: Record<string, unknown> = {
    status: "contacted",
    outreach_status: "contacted",
  };
  if (opts.note) mid.notes = opts.note;
  patches.push(mid);

  // Fallback 2: status only (always exists).
  patches.push({ status: "contacted" });

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
