/**
 * Pipeline intelligence: situational-awareness + "what should I do to make
 * money right now" helpers. All read-only and RLS-scoped. Defensive about
 * columns — probes before selecting optional fields.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { existingColumns, type Lead } from "./leads.js";

const ALL_SELECT = [
  "id",
  "business_name",
  "owner_name",
  "owner_email",
  "website_url",
  "city",
  "state",
  "category",
  "status",
  "outreach_status",
  "site_quality",
  "website_status",
  "created_at",
  "updated_at",
  "has_generated_site",
] as const;

const SELECT = ALL_SELECT.join(", ");

/** Statuses that mean "this lead is done / replied / won't be worked again". */
const CLOSED_STATUSES = new Set(["sold", "disqualified", "interested", "scheduled"]);
const CONTACTED_STATUSES = new Set([
  "called",
  "no_answer",
  "follow_up",
  "interested",
  "scheduled",
]);

function daysAgo(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

/** Counts by status + ready-to-work + revenue (if sale_amount exists). */
export async function pipelineSummary(supabase: SupabaseClient): Promise<unknown> {
  const cols = await existingColumns(supabase, "leads", ["sale_amount", "outreach_status"]);
  const hasRevenue = cols.has("sale_amount");

  const selectCols = hasRevenue ? `${SELECT}, sale_amount` : SELECT;
  // Cap at a sane ceiling so the summary stays cheap on big pipelines.
  const { data, error } = await supabase
    .from("leads")
    .select(selectCols)
    .limit(5000);
  if (error) throw new Error(error.message);

  const rows = (data as unknown as (Lead & { sale_amount?: number | null })[]) ?? [];

  const byStatus: Record<string, number> = {};
  let withEmail = 0;
  let contacted = 0;
  let sold = 0;
  let revenue = 0;

  for (const r of rows) {
    const s = r.status ?? "unknown";
    byStatus[s] = (byStatus[s] ?? 0) + 1;
    if (r.owner_email) withEmail += 1;
    if ((r.status && CONTACTED_STATUSES.has(r.status)) || r.outreach_status === "contacted") {
      contacted += 1;
    }
    if (r.status === "sold") sold += 1;
    if (hasRevenue && typeof r.sale_amount === "number") revenue += r.sale_amount;
  }

  return {
    total_leads: rows.length,
    by_status: byStatus,
    with_email: withEmail,
    contacted,
    sold,
    ...(hasRevenue ? { total_revenue: Math.round(revenue * 100) / 100 } : {}),
    note:
      rows.length >= 5000
        ? "Capped at 5000 rows; counts are a lower bound."
        : "Full pipeline.",
  };
}

export interface ActionItem {
  lead_id: string;
  business: string | null;
  why_now: string;
  priority: number; // lower = do first
}

/**
 * Prioritized money-making to-do list:
 *   1. High-value: no real website + has owner email (best fit for our offer).
 *   2. Ready to reach out: uncontacted + has email.
 *   3. Follow-ups: contacted long ago, not closed.
 */
export async function nextActions(
  supabase: SupabaseClient,
  limit = 15
): Promise<ActionItem[]> {
  const { data, error } = await supabase
    .from("leads")
    .select(SELECT)
    .order("created_at", { ascending: false })
    .limit(1000);
  if (error) throw new Error(error.message);
  const rows = (data as unknown as Lead[]) ?? [];

  const items: ActionItem[] = [];
  for (const r of rows) {
    if (!r.owner_email) continue; // need a way to reach them
    const status = r.status ?? "new";
    if (CLOSED_STATUSES.has(status)) continue;

    const noRealSite =
      !r.website_url ||
      /no[_-]?site|none|missing|broken|directory|placeholder/i.test(r.website_status ?? "") ||
      /poor|bad|none|low/i.test(r.site_quality ?? "");
    const isContacted =
      CONTACTED_STATUSES.has(status) || r.outreach_status === "contacted";
    const stale = daysAgo(r.updated_at);

    if (!isContacted && noRealSite) {
      items.push({
        lead_id: r.id,
        business: r.business_name,
        why_now: `High-value: no real website + has email${r.city ? ` (${r.city})` : ""}. Pitch a site now.`,
        priority: 1,
      });
    } else if (!isContacted) {
      items.push({
        lead_id: r.id,
        business: r.business_name,
        why_now: `Uncontacted + has email${r.city ? ` (${r.city})` : ""}. Ready to reach out.`,
        priority: 2,
      });
    } else if (isContacted && stale != null && stale >= 5) {
      items.push({
        lead_id: r.id,
        business: r.business_name,
        why_now: `Contacted ~${stale}d ago, no reply yet. Send a follow-up.`,
        priority: 3,
      });
    }
  }

  items.sort((a, b) => a.priority - b.priority);
  return items.slice(0, limit);
}

/**
 * Leads contacted more than N days ago that aren't replied/closed.
 * No last_contacted_at column exists on `leads`, so we approximate via
 * updated_at + a 'contacted' signal (status or outreach_status).
 */
export async function dueFollowups(
  supabase: SupabaseClient,
  days: number
): Promise<{ lead_id: string; business: string | null; days_since: number; status: string | null }[]> {
  const { data, error } = await supabase
    .from("leads")
    .select(SELECT)
    .order("updated_at", { ascending: true })
    .limit(1000);
  if (error) throw new Error(error.message);
  const rows = (data as unknown as Lead[]) ?? [];

  const out: { lead_id: string; business: string | null; days_since: number; status: string | null }[] = [];
  for (const r of rows) {
    const status = r.status ?? "";
    const isContacted =
      CONTACTED_STATUSES.has(status) || r.outreach_status === "contacted";
    if (!isContacted) continue;
    if (CLOSED_STATUSES.has(status)) continue;
    const since = daysAgo(r.updated_at);
    if (since == null || since < days) continue;
    out.push({ lead_id: r.id, business: r.business_name, days_since: since, status: r.status });
  }
  return out;
}
