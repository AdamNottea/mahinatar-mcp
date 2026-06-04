/**
 * Pipeline intelligence: situational-awareness + "what should I do to make
 * money right now" helpers. All read-only and RLS-scoped. Defensive about
 * columns — probes before selecting optional fields.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { existingColumns, type Lead } from "./leads.js";
import { isSendableEmail } from "./email.js";

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

// Valid outreach_status values that mean "we've reached out" (per the
// leads_outreach_status_check DB constraint: not_sent|drafted|sent|replied|bounced).
// "contacted" is NOT a valid outreach_status — it was used here before and
// silently never matched. "sent"/"replied"/"bounced" are the real signals.
const CONTACTED_OUTREACH = new Set(["sent", "replied", "bounced"]);

function isContactedLead(r: { status?: string | null; outreach_status?: string | null }): boolean {
  return (
    (!!r.status && CONTACTED_STATUSES.has(r.status)) ||
    (!!r.outreach_status && CONTACTED_OUTREACH.has(r.outreach_status))
  );
}

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
    if (isSendableEmail(r.owner_email)) withEmail += 1;
    if (isContactedLead(r)) {
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
    if (!isSendableEmail(r.owner_email)) continue; // need a real way to reach them (rejects <UNKNOWN>/junk)
    const status = r.status ?? "new";
    if (CLOSED_STATUSES.has(status)) continue;

    // "No website" must be PROVABLE from the data, not inferred from a low
    // quality score. site_quality is set to POOR_SITE whenever the scanner gets
    // no signal (e.g. PageSpeed fetch failed) — that means "couldn't measure",
    // NOT "no site". Trusting it produced false "no real website" claims against
    // firms that have established sites. So: only count it as no-website when the
    // URL is absent or website_status explicitly says the site is gone.
    const statusSaysNoSite =
      /\bnone\b|missing|broken|directory|placeholder|no[_-]?site/i.test(r.website_status ?? "");
    const noWebsite = !r.website_url || statusSaysNoSite;
    // Has a real URL but the scan rated it poorly: pitch a rebuild, not "you have
    // no site". Phrased as an offer so it's honest even if the rating is noisy.
    const weakSite = !noWebsite && /poor|bad|low/i.test(r.site_quality ?? "");
    const isContacted = isContactedLead(r);
    const stale = daysAgo(r.updated_at);

    if (!isContacted && noWebsite) {
      items.push({
        lead_id: r.id,
        business: r.business_name,
        why_now: `No website live + has email${r.city ? ` (${r.city})` : ""}. Pitch a new site now.`,
        priority: 1,
      });
    } else if (!isContacted && weakSite) {
      items.push({
        lead_id: r.id,
        business: r.business_name,
        why_now: `Has a site but it scored poorly${r.city ? ` (${r.city})` : ""}. Pitch a modern rebuild.`,
        priority: 2,
      });
    } else if (!isContacted) {
      items.push({
        lead_id: r.id,
        business: r.business_name,
        why_now: `Uncontacted + has email${r.city ? ` (${r.city})` : ""}. Ready to reach out.`,
        priority: 3,
      });
    } else if (isContacted && stale != null && stale >= 5) {
      items.push({
        lead_id: r.id,
        business: r.business_name,
        why_now: `Contacted ~${stale}d ago, no reply yet. Send a follow-up.`,
        priority: 4,
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
    if (!isContactedLead(r)) continue;
    if (CLOSED_STATUSES.has(status)) continue;
    const since = daysAgo(r.updated_at);
    if (since == null || since < days) continue;
    out.push({ lead_id: r.id, business: r.business_name, days_since: since, status: r.status });
  }
  return out;
}
