/**
 * Resend email wrapper — GUARDED.
 *
 * canSendLive() is the single source of truth for whether a real send is
 * permitted. It requires BOTH the master flag (MAHINATAR_OUTREACH_LIVE="true")
 * AND a RESEND_API_KEY AND a verified from-address. Any caller that wants to
 * send for real MUST check canSendLive() first; sendViaResend throws if the
 * preconditions are not met, so there is no way to send by accident.
 */

import { config } from "./config.js";

export function canSendLive(): { ok: boolean; reason: string | null } {
  if (!config.outreachLive)
    return { ok: false, reason: 'MAHINATAR_OUTREACH_LIVE is not "true" (dry-run mode).' };
  if (!config.resendApiKey)
    return { ok: false, reason: "RESEND_API_KEY is not set." };
  if (!config.fromEmail)
    return { ok: false, reason: "MAHINATAR_FROM_EMAIL is not set." };
  return { ok: true, reason: null };
}

export interface SendResult {
  id: string;
}

export async function sendViaResend(args: {
  to: string;
  subject: string;
  body: string;
}): Promise<SendResult> {
  const guard = canSendLive();
  if (!guard.ok) {
    // Hard stop — should never be reached if callers check canSendLive().
    throw new Error(`Refusing to send: ${guard.reason}`);
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: config.fromEmail,
      to: [args.to],
      subject: args.subject,
      text: args.body,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Resend API error ${res.status}: ${detail}`);
  }

  const json = (await res.json()) as { id?: string };
  return { id: json.id ?? "unknown" };
}
