/**
 * Tool registration. Each tool is registered on the McpServer with a zod
 * schema. Outreach tools go through requireElite() (the Elite gate); whoami
 * does not. The send tool additionally enforces the dry-run guard + throttle.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getSession, getAuthedClient, requireElite, AuthError } from "../supabase.js";
import { canSendLive, sendViaResend } from "../email.js";
import { config, MAX_SENDS_PER_RUN } from "../config.js";
import { listLeads, fetchLead, markLeadContacted, suppressionReason } from "../leads.js";
import { buildDraft, type Tone } from "../draft.js";

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
        const { supabase } = await requireElite();
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
        if (sendsThisRun >= MAX_SENDS_PER_RUN) {
          return err(
            `Throttle hit: already sent ${sendsThisRun} emails this run (max ${MAX_SENDS_PER_RUN}). Restart the server to reset.`
          );
        }

        const result = await sendViaResend({ to: recipient, subject, body });
        sendsThisRun += 1;

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
      description: "Mark a lead as contacted and optionally append a note.",
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
        await markLeadContacted(supabase, id, { note });
        return ok({ id, status: "contacted", noteSaved: Boolean(note) });
      })
  );
}
