/**
 * Tool registration. Each tool is registered on the McpServer with a zod
 * schema. Outreach tools go through requireElite() (the Elite gate); whoami
 * does not. The send tool additionally enforces the dry-run guard + throttle.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getSession, getAuthedClient, requireElite, getAccessToken, AuthError } from "../supabase.js";
import { canSendLive, sendViaResend, isSendableEmail } from "../email.js";
import { config, MAX_SENDS_PER_RUN } from "../config.js";
import {
  listLeads,
  fetchLead,
  markLeadContacted,
  suppressionReason,
  updateLead,
  searchLeads,
  listGeneratedSites,
} from "../leads.js";
import { pipelineSummary, nextActions, dueFollowups } from "../pipeline.js";
import { buildDraft, type Tone } from "../draft.js";
import { verifyEmails, verifyEmailDeliverable } from "../verify.js";
import {
  createLead, importLeads, bulkUpdateLeads, findDuplicateLeads,
  fetchSiteDetail, creditStatus, generateSite, publishSite, deleteSite, startScan,
} from "../control.js";

/** In-memory live-send counter for this server run (throttle). */
let sendsThisRun = 0;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
function err(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Wraps a handler, turning AuthError (incl. Elite gate) into a clean message. */
async function guarded(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AuthError) return err(e.message);
    return err(`Error: ${(e as Error).message}`);
  }
}

export function registerTools(server: McpServer): void {
  // 1. whoami — no gate.
  server.registerTool(
    "mahinatar_whoami",
    {
      title: "Mahinatar: who am I",
      description:
        "Show the connected Mahinatar account: email, user_id, plan, whether outreach is authorized (Elite gate), and whether live email send is enabled.",
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        const session = await getSession();
        const live = canSendLive();
        return ok({
          email: session.email,
          user_id: session.userId,
          plan_id: session.planId,
          plan_status: session.planStatus,
          authorized: session.authorized,
          auth_method: session.authMethod,
          live_send_enabled: live.ok,
          live_send_blocked_reason: live.ok ? null : live.reason,
          outreach_live_flag: config.outreachLive,
        });
      })
  );

  // 2. list_leads — Elite-gated.
  server.registerTool(
    "mahinatar_list_leads",
    {
      title: "Mahinatar: list leads",
      description:
        "List leads from your Mahinatar pipeline (scoped to your account by RLS). Filter by status and whether an owner email is present.",
      inputSchema: {
        status: z.string().optional().describe("Filter by lead status, e.g. 'new', 'contacted'."),
        hasEmail: z.boolean().optional().describe("true = only leads with an owner_email; false = only those without."),
        limit: z.number().int().min(1).max(100).optional().describe("Max rows (default 25, max 100)."),
      },
    },
    async ({ status, hasEmail, limit }) =>
      guarded(async () => {
        const { supabase } = await requireElite();
        const rows = await listLeads(supabase, {
          status,
          hasEmail,
          limit: Math.min(limit ?? 25, 100),
        });
        return ok({ count: rows.length, leads: rows });
      })
  );

  // 3. lead_detail — Elite-gated.
  server.registerTool(
    "mahinatar_lead_detail",
    {
      title: "Mahinatar: lead detail",
      description: "Full row for one lead by id (RLS-scoped to your account).",
      inputSchema: { id: z.string().describe("Lead id (uuid).") },
    },
    async ({ id }) =>
      guarded(async () => {
        const { supabase } = await requireElite();
        const lead = await fetchLead(supabase, id);
        if (!lead) return err(`No lead found with id ${id} (or not visible to your account).`);
        return ok(lead);
      })
  );

  // 4. draft_outreach — Elite-gated. No LLM; returns brief + sendable draft.
  server.registerTool(
    "mahinatar_draft_outreach",
    {
      title: "Mahinatar: draft outreach",
      description:
        "Build a structured brief + a real first-draft cold outreach email (offering a website) for one lead. Personalize before sending. Always includes an opt-out line.",
      inputSchema: {
        id: z.string().describe("Lead id (uuid)."),
        tone: z.enum(["direct", "friendly", "short"]).optional().describe("Draft tone (default 'friendly')."),
        angle: z.string().optional().describe("Optional extra angle/hook to weave in."),
      },
    },
    async ({ id, tone, angle }) =>
      guarded(async () => {
        const { supabase } = await requireElite();
        const lead = await fetchLead(supabase, id);
        if (!lead) return err(`No lead found with id ${id}.`);
        const draft = buildDraft(lead, (tone ?? "friendly") as Tone, angle);
        return ok(draft);
      })
  );

  // 5. send_outreach — Elite-gated + dry-run guard + throttle + suppression.
  //
  // SAFETY GUARD (read before changing):
  //   - DRY-RUN BY DEFAULT: a real send happens ONLY when canSendLive() is true,
  //     which requires MAHINATAR_OUTREACH_LIVE="true" AND RESEND_API_KEY AND a
  //     from-address. Otherwise we return { sent:false, dryRun:true, preview }.
  //   - THROTTLE: at most MAX_SENDS_PER_RUN real sends per server run.
  //   - SUPPRESSION: skip leads flagged do_not_contact / unsubscribed (defensive).
  //   - REQUIRES owner_email (or an explicit `to`).
  //   On success we best-effort mark the lead contacted.
  server.registerTool(
    "mahinatar_send_outreach",
    {
      title: "Mahinatar: send outreach",
      description:
        "Send (or dry-run) an outreach email to a lead. DRY-RUN BY DEFAULT — only sends for real when live mode + Resend are configured. Throttled and suppression-aware.",
      inputSchema: {
        id: z.string().describe("Lead id (uuid)."),
        subject: z.string().describe("Email subject."),
        body: z.string().describe("Email body (plain text)."),
        to: z.string().email().optional().describe("Override recipient; defaults to the lead's owner_email."),
      },
    },
    async ({ id, subject, body, to }) =>
      guarded(async () => {
        const { supabase, session } = await requireElite();
        const lead = await fetchLead(supabase, id);
        if (!lead) return err(`No lead found with id ${id}.`);

        const recipient = to ?? lead.owner_email ?? null;
        const live = canSendLive();

        // DRY-RUN PATH (default): never sends.
        if (!live.ok) {
          return ok({
            sent: false,
            dryRun: true,
            reason: live.reason,
            preview: { to: recipient, subject, body },
          });
        }

        // ── LIVE PATH below: every guard must pass ──
        const suppression = suppressionReason(lead);
        if (suppression) {
          return ok({ sent: false, dryRun: false, skipped: true, reason: `Suppressed: ${suppression}.` });
        }
        if (!recipient) {
          return err("Cannot send: lead has no owner_email and no `to` override was provided.");
        }
        if (!isSendableEmail(recipient)) {
          return ok({ sent: false, dryRun: false, skipped: true, reason: `Skipped: '${recipient}' is not a valid email (would hard-bounce).` });
        }
        const mx = await verifyEmailDeliverable(recipient);
        if (!mx.deliverable) {
          return ok({ sent: false, dryRun: false, skipped: true, reason: `Skipped: '${recipient}' is undeliverable (${mx.reason}).` });
        }
        if (sendsThisRun >= MAX_SENDS_PER_RUN) {
          return err(
            `Throttle hit: already sent ${sendsThisRun} emails this run (max ${MAX_SENDS_PER_RUN}). Restart the server to reset.`
          );
        }

        const result = await sendViaResend({ to: recipient, subject, body });
        sendsThisRun += 1;

        // Record the send in outreach_log so it shows up in the app's Cold
        // Outreach activity feed. Fire-and-forget — logging must never break a send.
        try {
          await supabase.from("outreach_log").insert({
            user_id: session.userId, lead_id: id, channel: "mcp", status: "sent",
            recipient, subject, body, template_used: "mcp",
          } as never);
        } catch { /* never break a send on a logging failure */ }

        // Best-effort: mark contacted (only updates columns that exist).
        let marked = true;
        try {
          await markLeadContacted(supabase, id);
        } catch {
          marked = false;
        }

        return ok({ sent: true, dryRun: false, id, to: recipient, providerId: result.id, leadMarkedContacted: marked, sendsThisRun });
      })
  );

  // 6. mark_contacted — Elite-gated.
  server.registerTool(
    "mahinatar_mark_contacted",
    {
      title: "Mahinatar: mark contacted",
      description:
        "Mark a lead as contacted (sets outreach_status='sent') and optionally append a note.",
      inputSchema: {
        id: z.string().describe("Lead id (uuid)."),
        note: z.string().optional().describe("Optional note to store on the lead."),
      },
    },
    async ({ id, note }) =>
      guarded(async () => {
        const { supabase } = await requireElite();
        const lead = await fetchLead(supabase, id);
        if (!lead) return err(`No lead found with id ${id}.`);
        // Only touch outreach_status='sent' — the "we reached out" signal.
        // Do NOT set status: the lead_status enum has no 'contacted' value
        // (new|called|no_answer|follow_up|interested|sold|site_*|disqualified|
        // scheduled), and outreach_status's CHECK is not_sent|drafted|sent|
        // replied|bounced. 'contacted' is invalid for BOTH columns.
        const { applied } = await updateLead(supabase, id, { stage: "sent", note });
        return ok({ id, outreach_status: "sent", applied, noteSaved: Boolean(note) });
      })
  );

  // 7. pipeline_summary — Elite-gated. Situational awareness.
  server.registerTool(
    "mahinatar_pipeline_summary",
    {
      title: "Mahinatar: pipeline summary",
      description:
        "Counts of leads by status, total leads, how many have an email, how many are contacted, sold count, and total revenue (if a sale_amount column exists). Use this first for situational awareness.",
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        const { supabase } = await requireElite();
        return ok(await pipelineSummary(supabase));
      })
  );

  // 8. search_leads — Elite-gated. Targeted search.
  server.registerTool(
    "mahinatar_search_leads",
    {
      title: "Mahinatar: search leads",
      description:
        "Filtered lead search for targeting. Matches business/owner/email/category on `query`. Filters by status, hasEmail, hasWebsite, city.",
      inputSchema: {
        query: z.string().optional().describe("Free-text match on business_name/owner_name/owner_email/category."),
        status: z.string().optional().describe("Filter by lead status (e.g. 'new', 'called', 'follow_up')."),
        hasEmail: z.boolean().optional().describe("true = only leads with an owner_email; false = only without."),
        hasWebsite: z.boolean().optional().describe("true = only leads with a website_url; false = only without."),
        city: z.string().optional().describe("Filter by city (partial match)."),
        limit: z.number().int().min(1).max(100).optional().describe("Max rows (default 25, max 100)."),
      },
    },
    async ({ query, status, hasEmail, hasWebsite, city, limit }) =>
      guarded(async () => {
        const { supabase } = await requireElite();
        const rows = await searchLeads(supabase, {
          query,
          status,
          hasEmail,
          hasWebsite,
          city,
          limit: Math.min(limit ?? 25, 100),
        });
        return ok({ count: rows.length, leads: rows });
      })
  );

  // 9. next_actions — Elite-gated. "What should I do to make money right now."
  server.registerTool(
    "mahinatar_next_actions",
    {
      title: "Mahinatar: next actions",
      description:
        "Prioritized money-making to-do list: high-value targets (no real website + has email), uncontacted leads ready to reach out, and stale follow-ups. Returns lead id, business, and why-now, ranked.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional().describe("Max action items (default 15, max 50)."),
      },
    },
    async ({ limit }) =>
      guarded(async () => {
        const { supabase } = await requireElite();
        const items = await nextActions(supabase, Math.min(limit ?? 15, 50));
        return ok({ count: items.length, actions: items });
      })
  );

  // 10. update_lead — Elite-gated. Generalized update (supersedes mark_contacted).
  server.registerTool(
    "mahinatar_update_lead",
    {
      title: "Mahinatar: update lead",
      description:
        "Generalized lead update: change status and/or stage (outreach_status) and/or append a timestamped note. Only touches columns that exist (defensive).",
      inputSchema: {
        id: z.string().describe("Lead id (uuid)."),
        status: z.string().optional().describe("New lead status (e.g. 'called', 'follow_up', 'interested', 'sold')."),
        stage: z.string().optional().describe("New outreach stage (outreach_status), e.g. 'contacted', 'replied'."),
        note: z.string().optional().describe("Note to append (timestamped) to the lead's notes."),
      },
    },
    async ({ id, status, stage, note }) =>
      guarded(async () => {
        const { supabase } = await requireElite();
        const lead = await fetchLead(supabase, id);
        if (!lead) return err(`No lead found with id ${id}.`);
        if (!status && !stage && !note) {
          return err("Nothing to update: provide at least one of status, stage, or note.");
        }
        const { applied } = await updateLead(supabase, id, { status, stage, note });
        return ok({ id, applied, ...(applied.length === 0 ? { warning: "No matching columns existed to update." } : {}) });
      })
  );

  // 11. bulk_draft_outreach — Elite-gated. Drafts only, never sends. Cap 25.
  server.registerTool(
    "mahinatar_bulk_draft_outreach",
    {
      title: "Mahinatar: bulk draft outreach",
      description:
        "Build personalized outreach drafts for multiple leads in one call (each: lead id, business, subject, body with opt-out line). Does NOT send. Pass explicit `ids` OR a `filter`. Capped at 25.",
      inputSchema: {
        ids: z.array(z.string()).optional().describe("Explicit lead ids to draft for."),
        filter: z
          .object({
            status: z.string().optional(),
            hasEmail: z.boolean().optional(),
            limit: z.number().int().min(1).max(25).optional(),
          })
          .optional()
          .describe("Filter to pick leads when `ids` is not given."),
        tone: z.enum(["direct", "friendly", "short"]).optional().describe("Draft tone (default 'friendly')."),
      },
    },
    async ({ ids, filter, tone }) =>
      guarded(async () => {
        const { supabase } = await requireElite();
        const t = (tone ?? "friendly") as Tone;

        let leads;
        if (ids && ids.length > 0) {
          const picked = await Promise.all(ids.slice(0, 25).map((id) => fetchLead(supabase, id)));
          leads = picked.filter((l): l is NonNullable<typeof l> => l != null);
        } else {
          leads = await listLeads(supabase, {
            status: filter?.status,
            hasEmail: filter?.hasEmail ?? true,
            limit: Math.min(filter?.limit ?? 25, 25),
          });
        }

        const drafts = leads.slice(0, 25).map((lead) => {
          const d = buildDraft(lead, t);
          return { lead_id: lead.id, business: lead.business_name, to: d.to, subject: d.subject, body: d.body };
        });
        return ok({ count: drafts.length, tone: t, drafts });
      })
  );

  // 12. due_followups — Elite-gated.
  server.registerTool(
    "mahinatar_due_followups",
    {
      title: "Mahinatar: due follow-ups",
      description:
        "Leads contacted more than N days ago that aren't replied/closed — for follow-up outreach. Approximated via updated_at + a 'contacted' status (no last-contacted column exists).",
      inputSchema: {
        days: z.number().int().min(1).max(365).optional().describe("Threshold in days since last activity (default 5)."),
      },
    },
    async ({ days }) =>
      guarded(async () => {
        const { supabase } = await requireElite();
        const rows = await dueFollowups(supabase, days ?? 5);
        return ok({ count: rows.length, days: days ?? 5, followups: rows });
      })
  );

  // 13. list_sites — Elite-gated. The user's generated websites.
  server.registerTool(
    "mahinatar_list_sites",
    {
      title: "Mahinatar: list generated sites",
      description:
        "List your generated websites (id, business, url, status) so you can reference an already-built site when pitching a lead.",
      inputSchema: {
        status: z.string().optional().describe("Filter: 'published', 'done', or 'draft'."),
        limit: z.number().int().min(1).max(100).optional().describe("Max rows (default 25, max 100)."),
      },
    },
    async ({ status, limit }) =>
      guarded(async () => {
        const { supabase } = await requireElite();
        const sites = await listGeneratedSites(supabase, { status, limit: Math.min(limit ?? 25, 100) });
        return ok({ count: sites.length, sites });
      })
  );

  // ── 14. bulk_send_outreach — parity with the remote server ──────────────────
  server.registerTool(
    "mahinatar_bulk_send_outreach",
    {
      title: "Mahinatar: bulk send outreach",
      description:
        "Send (or dry-run) outreach to a BATCH of emailable leads. Auto-drafts each email, then sends. DRY-RUN BY DEFAULT — only delivers when live mode + Resend are configured (check mahinatar_whoami.live_send_enabled first). Throttled to MAX_SENDS_PER_RUN, suppression-aware, MX-verified, skips leads with no email, marks each sent lead contacted.",
      inputSchema: {
        tone: z.enum(["direct", "friendly", "short"]).optional(),
        angle: z.string().optional(),
        hasWebsite: z.boolean().optional(),
        city: z.string().optional(),
        status: z.string().optional(),
        limit: z.number().int().min(1).max(20).optional(),
      },
    },
    async ({ tone, angle, hasWebsite, city, status, limit }) =>
      guarded(async () => {
        const { supabase, session } = await requireElite();
        const cap = Math.min(limit ?? 10, MAX_SENDS_PER_RUN);
        const rows = await searchLeads(supabase, { hasEmail: true, hasWebsite, city, status, limit: cap });
        const live = canSendLive();
        const results: Record<string, unknown>[] = [];
        for (const lead of rows) {
          if (sendsThisRun >= MAX_SENDS_PER_RUN) { results.push({ id: lead.id, business_name: lead.business_name, sent: false, skipped: true, reason: `run throttle hit (${MAX_SENDS_PER_RUN})` }); continue; }
          const recipient = lead.owner_email;
          if (!recipient) { results.push({ id: lead.id, business_name: lead.business_name, sent: false, skipped: true, reason: "no owner_email" }); continue; }
          if (!isSendableEmail(recipient)) { results.push({ id: lead.id, business_name: lead.business_name, sent: false, skipped: true, reason: "invalid email (would hard-bounce)" }); continue; }
          const suppression = suppressionReason(lead);
          if (suppression) { results.push({ id: lead.id, business_name: lead.business_name, sent: false, skipped: true, reason: `suppressed: ${suppression}` }); continue; }
          const draft = buildDraft(lead, (tone ?? "friendly") as Tone, angle);
          if (!live.ok) { results.push({ id: lead.id, business_name: lead.business_name, sent: false, dryRun: true, to: recipient, subject: draft.subject }); continue; }
          const mx = await verifyEmailDeliverable(recipient);
          if (!mx.deliverable) { results.push({ id: lead.id, business_name: lead.business_name, sent: false, skipped: true, reason: `undeliverable: ${mx.reason}` }); continue; }
          try {
            const r = await sendViaResend({ to: recipient, subject: draft.subject, body: draft.body });
            sendsThisRun += 1;
            try { await supabase.from("outreach_log").insert({ user_id: session.userId, lead_id: lead.id, channel: "mcp", status: "sent", recipient, subject: draft.subject, body: draft.body, template_used: "mcp" } as never); } catch { /* logging must never break a send */ }
            let marked = true; try { await markLeadContacted(supabase, lead.id); } catch { marked = false; }
            results.push({ id: lead.id, business_name: lead.business_name, sent: true, to: recipient, providerId: r.id, leadMarkedContacted: marked });
          } catch (e) { results.push({ id: lead.id, business_name: lead.business_name, sent: false, error: (e as Error).message }); }
        }
        return ok({ live: live.ok, dryRun: !live.ok, dryRunReason: live.ok ? null : live.reason, matched: rows.length, sent: results.filter((r) => r.sent).length, dryRunPreviews: results.filter((r) => r.dryRun).length, skipped: results.filter((r) => r.skipped).length, sendsThisRun, results });
      })
  );

  // ── 15. enrich_leads — parity with the remote server ────────────────────────
  server.registerTool(
    "mahinatar_enrich_leads",
    {
      title: "Mahinatar: enrich leads (find emails)",
      description:
        "Find owner emails for leads that have none (the real bottleneck before outreach). Runs the Apify-backed enrichment on your no-email leads and writes any found owner_email/owner_phone back. Costs enrichment credits.",
      inputSchema: { limit: z.number().int().min(1).max(25).optional(), force: z.boolean().optional() },
    },
    async ({ limit, force }) =>
      guarded(async () => {
        const { supabase } = await requireElite();
        const rows = await searchLeads(supabase, { hasEmail: false, limit: Math.min(limit ?? 15, 25) });
        const leadIds = rows.map((r) => r.id);
        if (leadIds.length === 0) return ok({ requested: 0, message: "No leads without an email to enrich." });
        const accessToken = await getAccessToken();
        const res = await fetch(`${config.supabaseUrl}/functions/v1/enrich-leads-apify`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ lead_ids: leadIds, force: force ?? false }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) return err(`Enrichment failed (${res.status}): ${(json as { error?: string }).error ?? "see app logs."}`);
        return ok({ requested: leadIds.length, ...(json as Record<string, unknown>) });
      })
  );

  // ── 16. verify_emails — real MX/SMTP deliverability check ────────────────────
  server.registerTool(
    "mahinatar_verify_emails",
    {
      title: "Mahinatar: verify emails (MX)",
      description:
        "Verify that addresses can actually receive mail (MX/A-record lookup + disposable-domain block) BEFORE you queue a send. Pass explicit `emails`, or `ids` to verify those leads' owner_email. Returns deliverable + reason per address.",
      inputSchema: { emails: z.array(z.string()).optional(), ids: z.array(z.string()).optional() },
    },
    async ({ emails, ids }) =>
      guarded(async () => {
        const { supabase } = await requireElite();
        let list: string[] = emails ?? [];
        if ((!emails || emails.length === 0) && ids && ids.length > 0) {
          const leads = await Promise.all(ids.slice(0, 100).map((id) => fetchLead(supabase, id)));
          list = leads.map((l) => l?.owner_email).filter((e): e is string => Boolean(e));
        }
        if (list.length === 0) return err("Provide `emails` (array) or `ids` (leads with owner_email) to verify.");
        const r = await verifyEmails(list.slice(0, 100));
        return ok({ count: r.length, deliverable: r.filter((x) => x.deliverable).length, undeliverable: r.filter((x) => !x.deliverable).length, results: r });
      })
  );

  // ── 17. create_lead ─────────────────────────────────────────────────────────
  server.registerTool(
    "mahinatar_create_lead",
    {
      title: "Mahinatar: create lead",
      description: "Add a single lead to your pipeline. business_name required; rest optional.",
      inputSchema: { business_name: z.string(), owner_name: z.string().optional(), owner_email: z.string().optional(), owner_phone: z.string().optional(), website_url: z.string().optional(), city: z.string().optional(), state: z.string().optional(), category: z.string().optional(), notes: z.string().optional(), status: z.string().optional() },
    },
    async (a) =>
      guarded(async () => {
        const { supabase, session } = await requireElite();
        const lead = await createLead(supabase, session.userId, a);
        return ok({ created: true, lead });
      })
  );

  // ── 18. import_leads (bulk) ──────────────────────────────────────────────────
  server.registerTool(
    "mahinatar_import_leads",
    {
      title: "Mahinatar: import leads (bulk)",
      description: "Bulk-import leads (e.g. a pasted CSV). De-dupes within the batch by email else business_name+city. Each row needs business_name.",
      inputSchema: { leads: z.array(z.object({ business_name: z.string(), owner_name: z.string().optional(), owner_email: z.string().optional(), owner_phone: z.string().optional(), website_url: z.string().optional(), city: z.string().optional(), state: z.string().optional(), category: z.string().optional(), notes: z.string().optional(), status: z.string().optional() })).min(1).max(500) },
    },
    async ({ leads }) =>
      guarded(async () => {
        const { supabase, session } = await requireElite();
        return ok(await importLeads(supabase, session.userId, leads));
      })
  );

  // ── 19. bulk_update_leads ────────────────────────────────────────────────────
  server.registerTool(
    "mahinatar_bulk_update_leads",
    {
      title: "Mahinatar: bulk update leads",
      description: "Apply the same status and/or stage (outreach_status) to many leads at once. For per-lead notes use mahinatar_update_lead.",
      inputSchema: { ids: z.array(z.string()).min(1).max(500), status: z.string().optional(), stage: z.string().optional() },
    },
    async ({ ids, status, stage }) =>
      guarded(async () => {
        const { supabase } = await requireElite();
        if (!status && !stage) return err("Provide status and/or stage to apply.");
        return ok(await bulkUpdateLeads(supabase, ids, { status, stage }));
      })
  );

  // ── 20. find_duplicate_leads ─────────────────────────────────────────────────
  server.registerTool(
    "mahinatar_find_duplicate_leads",
    {
      title: "Mahinatar: find duplicate leads",
      description: "Report likely-duplicate leads (same owner_email, or same business_name+city). Read-only — returns groups so you decide what to merge. Never auto-deletes.",
      inputSchema: { scanLimit: z.number().int().min(1).max(5000).optional() },
    },
    async ({ scanLimit }) =>
      guarded(async () => {
        const { supabase } = await requireElite();
        const r = await findDuplicateLeads(supabase, scanLimit ?? 2000);
        return ok({ duplicate_groups: r.groups.length, scanned: r.scanned, groups: r.groups });
      })
  );

  // ── 21. site_detail ──────────────────────────────────────────────────────────
  server.registerTool(
    "mahinatar_site_detail",
    {
      title: "Mahinatar: site detail",
      description: "Full generated-site row by id, including computed public url, publish status, and stored html/site_data. Use to pull a preview URL to pitch.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) =>
      guarded(async () => {
        const { supabase } = await requireElite();
        const site = await fetchSiteDetail(supabase, id);
        return site ? ok(site) : err(`No site found with id ${id}.`);
      })
  );

  // ── 22. generate_site ────────────────────────────────────────────────────────
  server.registerTool(
    "mahinatar_generate_site",
    {
      title: "Mahinatar: generate site",
      description: "Trigger website generation. Pass `lead_id` to build for an existing lead, or `business_name` to build from scratch. Costs generation credits.",
      inputSchema: { lead_id: z.string().optional(), business_name: z.string().optional(), source_url: z.string().optional(), mode: z.enum(["lead", "scratch", "clone"]).optional() },
    },
    async (a) =>
      guarded(async () => {
        await requireElite();
        if (!a.lead_id && !a.business_name) return err("Provide lead_id or business_name.");
        const accessToken = await getAccessToken();
        return ok(await generateSite(config.supabaseUrl, accessToken, a));
      })
  );

  // ── 23. publish_site ─────────────────────────────────────────────────────────
  server.registerTool(
    "mahinatar_publish_site",
    {
      title: "Mahinatar: publish site",
      description: "Publish a generated site to its free public URL.",
      inputSchema: { site_id: z.string() },
    },
    async ({ site_id }) =>
      guarded(async () => {
        await requireElite();
        const accessToken = await getAccessToken();
        return ok(await publishSite(config.supabaseUrl, accessToken, site_id));
      })
  );

  // ── 24. delete_site ──────────────────────────────────────────────────────────
  server.registerTool(
    "mahinatar_delete_site",
    {
      title: "Mahinatar: delete site",
      description: "Delete a generated site and its dependent resources (irreversible). Verifies ownership server-side.",
      inputSchema: { site_id: z.string() },
    },
    async ({ site_id }) =>
      guarded(async () => {
        await requireElite();
        const accessToken = await getAccessToken();
        return ok(await deleteSite(config.supabaseUrl, accessToken, site_id));
      })
  );

  // ── 25. start_scan ───────────────────────────────────────────────────────────
  server.registerTool(
    "mahinatar_start_scan",
    {
      title: "Mahinatar: start scan",
      description: "Start a Google-Maps / niche prospecting scan for a location + category (e.g. location='Austin, TX', category='plumbers'). Surfaces new leads. Costs scan credits.",
      inputSchema: { location: z.string(), category: z.string(), batchMode: z.boolean().optional() },
    },
    async ({ location, category, batchMode }) =>
      guarded(async () => {
        await requireElite();
        const accessToken = await getAccessToken();
        return ok(await startScan(config.supabaseUrl, accessToken, { location, category, batchMode }));
      })
  );

  // ── 26. credit_status ────────────────────────────────────────────────────────
  server.registerTool(
    "mahinatar_credit_status",
    {
      title: "Mahinatar: credit status",
      description: "Current credit balance (subscription + purchased − used) for the connected account.",
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        const { supabase, session } = await requireElite();
        return ok(await creditStatus(supabase, session.userId));
      })
  );
}
