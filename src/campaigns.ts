/**
 * Campaign helpers — multi-step email drip sequences over the lead pipeline.
 *
 * This is the orchestration surface for Phase B: create/list/inspect/edit
 * campaigns, enroll leads, and pause/resume. The SENDING + PACING (jitter,
 * warmup ramp, daily cap) does NOT happen here — a synchronous MCP call can't
 * sleep minutes between sends without hanging the connector. It lives in the
 * scheduled `campaign-drip-runner` edge function, which polls
 * campaign_enrollments.next_send_at. These helpers only set up the schedule.
 *
 * All DB ops run under the caller's Supabase client (per-user RLS) — never the
 * service role. The drip runner is the only service-role writer (campaign_sends,
 * enrollment advancement), by design.
 *
 * Pure pacing math (warmupCap, daysSince) is exported and unit-tested without a
 * DB; jitter reuses jitterDelaySeconds from verify.ts so cadence stays consistent
 * with the send path.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { jitterDelaySeconds } from "./verify.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface CampaignStepInput {
  /** Days to wait before this step (after enrollment for step 0, after the prev send otherwise). */
  wait_days?: number;
  subject: string;
  body: string;
}

export interface CampaignInput {
  name: string;
  steps: CampaignStepInput[];
  daily_cap?: number;
  warmup_start?: number;
  warmup_growth?: number;
  jitter_min_sec?: number;
  jitter_max_sec?: number;
  from_email?: string | null;
}

export interface Campaign {
  id: string;
  user_id: string;
  name: string;
  status: "draft" | "active" | "paused" | "completed";
  daily_cap: number;
  warmup_start: number;
  warmup_growth: number;
  jitter_min_sec: number;
  jitter_max_sec: number;
  from_email: string | null;
  created_at: string;
  updated_at: string;
}

export interface CampaignStep {
  id: string;
  campaign_id: string;
  step_order: number;
  wait_days: number;
  subject: string;
  body: string;
}

/** Columns a user may set/patch on a campaign (pacing + name + status). */
const PACING_KEYS = [
  "daily_cap", "warmup_start", "warmup_growth", "jitter_min_sec", "jitter_max_sec", "from_email",
] as const;

// ── Pure pacing math (unit-tested, no DB) ────────────────────────────────────

/** Whole days elapsed since an ISO timestamp (floored, never negative). */
export function daysSince(iso: string | null | undefined, now: number = Date.now()): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

/**
 * Warmup-adjusted daily send cap for a campaign on a given day. Day 0 sends
 * `warmup_start`; each day the allowance grows by `warmup_growth` (compounded),
 * clamped to `daily_cap`. Ramping the volume — not blasting day one — is what
 * keeps a fresh domain out of the spam folder.
 */
export function warmupCap(
  c: { daily_cap: number; warmup_start: number; warmup_growth: number },
  daysSinceCreated: number
): number {
  const days = Math.max(0, Math.floor(daysSinceCreated));
  const ramped = Math.round(c.warmup_start * Math.pow(1 + c.warmup_growth, days));
  return Math.max(1, Math.min(c.daily_cap, ramped));
}

// ── Create / list / detail ───────────────────────────────────────────────────

/**
 * Create a campaign + its ordered steps. Validates a non-empty name and at
 * least one step with both subject and body. Step 0 defaults to wait_days 0
 * (send on enrollment); later steps default to 3 days so an unspecified
 * sequence still paces itself instead of firing every step at once.
 */
export async function createCampaign(
  supabase: SupabaseClient,
  userId: string,
  input: CampaignInput
): Promise<{ campaign: Campaign; steps: CampaignStep[] }> {
  const name = input.name?.trim();
  if (!name) throw new Error("Campaign name is required.");
  const steps = (input.steps ?? []).filter((s) => s && s.subject?.trim() && s.body?.trim());
  if (steps.length === 0) throw new Error("A campaign needs at least one step with a subject and body.");

  const row: Record<string, unknown> = { user_id: userId, name, status: "draft" };
  const inputRec = input as unknown as Record<string, unknown>;
  for (const k of PACING_KEYS) {
    const v = inputRec[k];
    if (v !== undefined && v !== null) row[k] = v;
  }

  const { data, error } = await supabase.from("email_campaigns").insert(row as never).select("*").maybeSingle();
  if (error) throw new Error(error.message);
  const campaign = data as unknown as Campaign;

  const stepRows = steps.map((s, i) => ({
    campaign_id: campaign.id,
    step_order: i,
    wait_days: s.wait_days ?? (i === 0 ? 0 : 3),
    subject: s.subject.trim(),
    body: s.body.trim(),
  }));
  const { data: sd, error: se } = await supabase.from("campaign_steps").insert(stepRows as never).select("*");
  if (se) throw new Error(se.message);
  return { campaign, steps: (sd as unknown as CampaignStep[]) ?? [] };
}

/** List the user's campaigns, newest first. */
export async function listCampaigns(supabase: SupabaseClient, limit = 50): Promise<Campaign[]> {
  const { data, error } = await supabase
    .from("email_campaigns")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(Math.min(limit, 200));
  if (error) throw new Error(error.message);
  return (data as unknown as Campaign[]) ?? [];
}

/** Tally an array of {status} rows into a count-by-status map. */
function tally(rows: { status?: string | null }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = (r.status ?? "unknown").toString();
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/**
 * Full campaign view in one shot — the "review in one spot" surface: the
 * campaign row, its ordered steps, enrollment counts by status, and send counts
 * by status. Returns null if the campaign isn't visible to the caller.
 */
export async function campaignDetail(
  supabase: SupabaseClient,
  id: string
): Promise<
  | {
      campaign: Campaign;
      steps: CampaignStep[];
      enrollment_counts: Record<string, number>;
      enrollments_total: number;
      send_counts: Record<string, number>;
      sends_total: number;
    }
  | null
> {
  const { data, error } = await supabase.from("email_campaigns").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const campaign = data as unknown as Campaign;

  const { data: sd } = await supabase
    .from("campaign_steps")
    .select("*")
    .eq("campaign_id", id)
    .order("step_order", { ascending: true });
  const steps = (sd as unknown as CampaignStep[]) ?? [];

  const { data: ed } = await supabase.from("campaign_enrollments").select("status").eq("campaign_id", id);
  const enrollments = (ed as unknown as { status: string }[]) ?? [];

  const { data: sendData } = await supabase.from("campaign_sends").select("status").eq("campaign_id", id);
  const sends = (sendData as unknown as { status: string }[]) ?? [];

  return {
    campaign,
    steps,
    enrollment_counts: tally(enrollments),
    enrollments_total: enrollments.length,
    send_counts: tally(sends),
    sends_total: sends.length,
  };
}

// ── Edit / pause / resume ────────────────────────────────────────────────────

export interface CampaignPatch {
  name?: string;
  status?: "draft" | "active" | "paused" | "completed";
  daily_cap?: number;
  warmup_start?: number;
  warmup_growth?: number;
  jitter_min_sec?: number;
  jitter_max_sec?: number;
  from_email?: string | null;
}

/** Patch a campaign's name/status/pacing. Only provided fields are written. */
export async function editCampaign(
  supabase: SupabaseClient,
  id: string,
  patch: CampaignPatch
): Promise<{ id: string; applied: string[] }> {
  const update: Record<string, unknown> = {};
  const applied: string[] = [];
  if (patch.name?.trim()) { update.name = patch.name.trim(); applied.push("name"); }
  if (patch.status) { update.status = patch.status; applied.push("status"); }
  const patchRec = patch as unknown as Record<string, unknown>;
  for (const k of PACING_KEYS) {
    const v = patchRec[k];
    if (v !== undefined) { update[k] = v; applied.push(k); }
  }
  if (applied.length === 0) return { id, applied };
  update.updated_at = new Date().toISOString();
  const { error } = await supabase.from("email_campaigns").update(update as never).eq("id", id);
  if (error) throw new Error(error.message);
  return { id, applied };
}

/** Set a campaign status (used by pause/resume tools). */
export async function setCampaignStatus(
  supabase: SupabaseClient,
  id: string,
  status: "active" | "paused"
): Promise<{ id: string; status: string }> {
  const { error } = await supabase
    .from("email_campaigns")
    .update({ status, updated_at: new Date().toISOString() } as never)
    .eq("id", id);
  if (error) throw new Error(error.message);
  return { id, status };
}

// ── Enrollment ───────────────────────────────────────────────────────────────

export interface EnrollResult {
  requested: number;
  enrolled: number;
  skipped_duplicates: number;
}

/**
 * Enroll leads into a campaign. Each enrollment starts at step 0 with the first
 * send scheduled at `now + jitter` (so even an immediate enrollment doesn't fire
 * a synchronous blast — the runner picks them up spread out). The unique
 * (campaign_id, lead_id) constraint means a lead already enrolled is ignored
 * (upsert ignoreDuplicates), not double-sent. RNG is injectable for tests.
 */
export async function enrollLeads(
  supabase: SupabaseClient,
  userId: string,
  campaignId: string,
  leadIds: string[],
  opts: { jitterMinSec?: number; jitterMaxSec?: number; rng?: () => number; now?: number } = {}
): Promise<EnrollResult> {
  const ids = Array.from(new Set(leadIds)).filter(Boolean);
  if (ids.length === 0) return { requested: 0, enrolled: 0, skipped_duplicates: 0 };

  const now = opts.now ?? Date.now();
  const rows = ids.map((leadId) => {
    const delayMs = jitterDelaySeconds(opts.jitterMinSec ?? 90, opts.jitterMaxSec ?? 420, opts.rng) * 1000;
    return {
      campaign_id: campaignId,
      lead_id: leadId,
      user_id: userId,
      status: "active",
      current_step: 0,
      next_send_at: new Date(now + delayMs).toISOString(),
    };
  });

  const { data, error } = await supabase
    .from("campaign_enrollments")
    .upsert(rows as never, { onConflict: "campaign_id,lead_id", ignoreDuplicates: true })
    .select("id");
  if (error) throw new Error(error.message);
  const enrolled = ((data as unknown as { id: string }[]) ?? []).length;
  return { requested: ids.length, enrolled, skipped_duplicates: ids.length - enrolled };
}

/**
 * Per-enrollment + per-step status for a campaign — the granular view (who is at
 * what step, when their next send fires). Returns null if not visible.
 */
export async function campaignStatus(
  supabase: SupabaseClient,
  id: string,
  limit = 200
): Promise<
  | {
      campaign_id: string;
      enrollments: { lead_id: string; status: string; current_step: number; next_send_at: string | null }[];
      by_status: Record<string, number>;
    }
  | null
> {
  const { data: c, error: ce } = await supabase.from("email_campaigns").select("id").eq("id", id).maybeSingle();
  if (ce) throw new Error(ce.message);
  if (!c) return null;

  const { data, error } = await supabase
    .from("campaign_enrollments")
    .select("lead_id, status, current_step, next_send_at")
    .eq("campaign_id", id)
    .order("next_send_at", { ascending: true })
    .limit(Math.min(limit, 1000));
  if (error) throw new Error(error.message);
  const enrollments =
    (data as unknown as { lead_id: string; status: string; current_step: number; next_send_at: string | null }[]) ?? [];
  return { campaign_id: id, enrollments, by_status: tally(enrollments) };
}
