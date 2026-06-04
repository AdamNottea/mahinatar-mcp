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

// Basic deliverability guard: reject obviously-malformed addresses before they
// turn into hard bounces (repeat hard bounces wreck the sending domain's rep).
// Local part excludes %/<>// so scrape artifacts ("%20maxbizz@mail.com", maps
// URLs) are rejected; sentinels like "<UNKNOWN>" are denied explicitly.
const EMAIL_RE = /^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const EMAIL_SENTINELS = new Set(["<unknown>", "unknown", "n/a", "na", "none", "null", "-"]);
export function isSendableEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const e = email.trim();
  if (!e || e.length > 254) return false;
  if (EMAIL_SENTINELS.has(e.toLowerCase())) return false;
  return EMAIL_RE.test(e);
}

/**
 * Builds RFC 8058 one-click unsubscribe headers. Required by Gmail/Yahoo bulk
 * rules and a CAN-SPAM-friendly signal. One-click POST is only emitted when an
 * https endpoint exists (RFC 8058 forbids pairing List-Unsubscribe-Post with a
 * mailto), otherwise a mailto fallback is used.
 */
export function buildComplianceHeaders(opts?: {
  fromEmail?: string;
  unsubscribeUrl?: string;
}): Record<string, string> {
  const fromEmail = opts?.fromEmail ?? config.fromEmail;
  const url = opts?.unsubscribeUrl ?? config.unsubscribeUrl;
  const domain = fromEmail?.split("@")[1];
  const mailto = domain ? `mailto:unsubscribe@${domain}?subject=unsubscribe` : null;
  const headers: Record<string, string> = {};
  if (url) {
    headers["List-Unsubscribe"] = mailto ? `<${url}>, <${mailto}>` : `<${url}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  } else if (mailto) {
    headers["List-Unsubscribe"] = `<${mailto}>`;
  }
  return headers;
}

/** Appends the configured physical postal address (CAN-SPAM) when set + absent. */
function withComplianceFooter(body: string): string {
  const addr = config.postalAddress;
  if (!addr || body.includes(addr)) return body;
  return `${body}\n\n—\n${addr}`;
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
      ...(config.replyTo ? { reply_to: config.replyTo } : {}),
      subject: args.subject,
      text: withComplianceFooter(args.body),
      headers: buildComplianceHeaders(),
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Resend API error ${res.status}: ${detail}`);
  }

  const json = (await res.json()) as { id?: string };
  return { id: json.id ?? "unknown" };
}
