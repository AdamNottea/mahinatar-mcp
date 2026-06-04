/**
 * Deliverability primitives — real email verification + send-pacing jitter.
 *
 * isSendableEmail (in email.ts) only checks SYNTAX. That lets dead mailboxes,
 * typo domains and disposable addresses through, and every one becomes a hard
 * bounce that erodes the sending domain's reputation. verifyEmailDeliverable
 * adds the next cheap layer: the domain must actually be able to receive mail
 * (has an MX record, or an A record as the RFC-5321 fallback) and must not be a
 * known disposable/throwaway domain.
 *
 * This is the #1 pipeline gap from the Bulk Email Tooling & Deliverability 2026
 * note: "Real MX/SMTP verification before queueing." We do MX (DNS), not a full
 * SMTP RCPT probe — SMTP probing is slow, often blocked, and itself a spam
 * signal. MX is the high-value, low-cost check.
 *
 * The DNS resolver is dependency-injected so the logic is unit-testable without
 * real network calls.
 */

import { resolveMx, resolve4 } from "node:dns/promises";
import { isSendableEmail } from "./email.js";

/** Resolver surface we depend on — satisfied by node:dns/promises, mockable in tests. */
export interface DnsResolver {
  resolveMx(hostname: string): Promise<{ exchange: string; priority: number }[]>;
  resolve4(hostname: string): Promise<string[]>;
}

const defaultResolver: DnsResolver = { resolveMx, resolve4 };

/**
 * Known disposable / throwaway email domains. Not exhaustive — a high-signal
 * subset. A lead on one of these will never convert and risks traps, so we
 * never queue it.
 */
const DISPOSABLE_DOMAINS = new Set<string>([
  "mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com",
  "temp-mail.org", "throwawaymail.com", "yopmail.com", "trashmail.com",
  "getnada.com", "maildrop.cc", "sharklasers.com", "guerrillamailblock.com",
  "dispostable.com", "fakeinbox.com", "tempinbox.com", "mailnesia.com",
  "mohmal.com", "emailondeck.com", "spamgourmet.com", "mintemail.com",
]);

export interface VerifyResult {
  email: string;
  deliverable: boolean;
  /** Null when deliverable; otherwise a short machine-ish reason. */
  reason: string | null;
  /** Best (lowest-priority) MX host when found. */
  mxHost?: string;
}

/** Per-process cache keyed by lowercased domain so a batch hits DNS once per domain. */
const domainCache = new Map<string, { deliverable: boolean; reason: string | null; mxHost?: string }>();

/** Test-only: clear the domain cache between cases. */
export function _clearVerifyCache(): void {
  domainCache.clear();
}

/**
 * Verify that an address can plausibly receive mail. Layers: syntax → disposable
 * blocklist → MX record → A-record fallback. Returns deliverable=false with a
 * reason on any failure. Never throws — DNS errors resolve to "no mail exchanger".
 */
export async function verifyEmailDeliverable(
  email: string | null | undefined,
  resolver: DnsResolver = defaultResolver
): Promise<VerifyResult> {
  const raw = (email ?? "").trim();
  if (!isSendableEmail(raw)) {
    return { email: raw, deliverable: false, reason: "invalid syntax" };
  }
  const domain = raw.split("@")[1]?.toLowerCase() ?? "";
  if (!domain) return { email: raw, deliverable: false, reason: "no domain" };

  if (DISPOSABLE_DOMAINS.has(domain)) {
    return { email: raw, deliverable: false, reason: "disposable domain" };
  }

  const cached = domainCache.get(domain);
  if (cached) return { email: raw, ...cached };

  let result: { deliverable: boolean; reason: string | null; mxHost?: string };
  try {
    const mx = await resolver.resolveMx(domain);
    const usable = (mx ?? []).filter((r) => r.exchange && r.exchange.trim());
    if (usable.length > 0) {
      const best = usable.sort((a, b) => a.priority - b.priority)[0];
      result = { deliverable: true, reason: null, mxHost: best.exchange };
    } else {
      // No MX — RFC 5321 §5.1 implicit-MX fallback: a bare A record accepts mail.
      result = await aRecordFallback(domain, resolver);
    }
  } catch {
    // ENODATA/ENOTFOUND on MX → try the A-record fallback before giving up.
    result = await aRecordFallback(domain, resolver);
  }

  domainCache.set(domain, result);
  return { email: raw, ...result };
}

async function aRecordFallback(
  domain: string,
  resolver: DnsResolver
): Promise<{ deliverable: boolean; reason: string | null; mxHost?: string }> {
  try {
    const a = await resolver.resolve4(domain);
    if (a && a.length > 0) return { deliverable: true, reason: null, mxHost: domain };
  } catch {
    /* fall through */
  }
  return { deliverable: false, reason: "no mail exchanger (no MX or A record)" };
}

/** Verify a batch; preserves order. Domain cache makes repeated domains free. */
export async function verifyEmails(
  emails: (string | null | undefined)[],
  resolver: DnsResolver = defaultResolver
): Promise<VerifyResult[]> {
  const out: VerifyResult[] = [];
  for (const e of emails) out.push(await verifyEmailDeliverable(e, resolver));
  return out;
}

/**
 * Randomized inter-send delay in SECONDS. A perfectly regular cadence (e.g. a
 * fixed 5-minute gap) is itself a bot signal; uniform jitter in a human-plausible
 * window is the correct pacing (Bulk Email Tooling & Deliverability 2026). Used
 * by the drip scheduler, not by synchronous bulk-send. RNG is injectable for
 * deterministic tests.
 */
export function jitterDelaySeconds(
  minSec = 90,
  maxSec = 420,
  rng: () => number = Math.random
): number {
  const lo = Math.max(0, Math.min(minSec, maxSec));
  const hi = Math.max(minSec, maxSec);
  return Math.round(lo + rng() * (hi - lo));
}
