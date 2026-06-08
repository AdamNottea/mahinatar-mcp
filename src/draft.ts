/**
 * Outreach draft composer. No LLM call — produces a structured brief plus a
 * real, sendable first-draft cold email the calling Claude can personalize.
 * Every draft includes an opt-out line (CAN-SPAM / compliance).
 */

import type { Lead } from "./leads.js";

export type Tone = "direct" | "friendly" | "short";

export interface Brief {
  business_name: string;
  owner_name: string | null;
  city: string | null;
  state: string | null;
  category: string | null;
  has_website: boolean;
  website_url: string | null;
  website_status: string | null;
  site_quality: string | null;
}

export interface Draft {
  brief: Brief;
  to: string | null;
  subject: string;
  body: string;
  tone: Tone;
  angle: string | null;
  note: string;
}

const OPT_OUT =
  "If you'd rather not hear from me, just reply STOP and I won't reach out again.";

// Words that are never a person's first name (scrapes often set owner_name to
// the business name, e.g. "The Miller Firm" → "Hi The,"). Reject these so we
// fall back to "Hi there," instead of greeting a fragment.
const NON_NAME_TOKENS = new Set([
  "the", "a", "an", "dr", "dr.", "mr", "mr.", "mrs", "mrs.", "ms", "ms.",
]);
const BUSINESS_SUFFIX = /\b(llc|llp|inc|co|corp|pllc|pa|pc|ltd|group|firm|clinic|spa|associates|services)\b/i;

/**
 * Extract a usable first name from owner_name. Returns null when owner_name is
 * really the business name (equals business_name, contains a company suffix, or
 * starts with an article/title), so the greeting degrades to "Hi there,".
 */
function firstName(name: string | null, businessName?: string | null): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (businessName && trimmed.toLowerCase() === businessName.trim().toLowerCase()) return null;
  if (BUSINESS_SUFFIX.test(trimmed)) return null;
  const first = trimmed.split(/\s+/)[0];
  if (!first) return null;
  if (NON_NAME_TOKENS.has(first.toLowerCase())) return null;
  return first;
}

function hasUsableWebsite(lead: Lead): boolean {
  // A real URL means they have a site. Do NOT infer "no site" from site_quality:
  // the scanner sets POOR_SITE whenever it gets no signal (e.g. PageSpeed fetch
  // failed), which means "couldn't measure", not "no site". Treating that as
  // no-site made drafts falsely claim "I couldn't find a real website" to firms
  // that have established sites. Only an explicit no-site website_status counts.
  const bad = /\bnone\b|missing|broken|directory|placeholder|no[_-]?site/i;
  if (lead.website_status && bad.test(lead.website_status)) return false;
  return Boolean(lead.website_url || lead.website);
}

export function buildDraft(lead: Lead, tone: Tone, angle?: string): Draft {
  const biz = lead.business_name?.trim() || "your business";
  const owner = firstName(lead.owner_name, lead.business_name);
  const greeting = owner ? `Hi ${owner},` : "Hi there,";
  const hasSite = hasUsableWebsite(lead);
  const cityBit = lead.city ? ` in ${lead.city}` : "";
  const catBit = lead.category ? ` ${lead.category} ` : " ";

  const siteLine = hasSite
    ? `I came across ${biz}'s website and a few quick wins jumped out that could turn more visitors into calls.`
    : `I went looking for ${biz} online and couldn't find a real website — which means you're likely losing customers to competitors who have one.`;

  const angleLine = angle ? ` ${angle.trim()}` : "";

  let subject: string;
  let body: string;

  if (tone === "short") {
    subject = hasSite ? `quick idea for ${biz}` : `${biz} website?`;
    body = [
      greeting,
      "",
      hasSite
        ? `Noticed ${biz}'s site${cityBit} — I build fast, modern sites that convert better. Worth a 10-min look?`
        : `Noticed ${biz}${cityBit} doesn't have a real website yet. I build one in days, not months.${angleLine}`,
      "",
      "Want me to send a free mockup?",
      "",
      OPT_OUT,
    ].join("\n");
  } else if (tone === "direct") {
    subject = hasSite ? `${biz}: turning your site into more bookings` : `${biz} is missing a website`;
    body = [
      greeting,
      "",
      siteLine + angleLine,
      "",
      `I'm a web designer working with${catBit}businesses${cityBit}. I can put together a clean, mobile-first site that's built to bring you more leads — and I'll send a free mockup first so you can see it before spending a cent.`,
      "",
      "Open to me sending that over?",
      "",
      "Best,",
      "[Your name]",
      "",
      OPT_OUT,
    ].join("\n");
  } else {
    // friendly (default-ish)
    subject = hasSite ? `loved what ${biz} is doing` : `helping ${biz} get found online`;
    body = [
      greeting,
      "",
      `Hope business is going well at ${biz}!`,
      "",
      siteLine + angleLine,
      "",
      `I help${catBit}businesses${cityBit} get a website that actually brings in customers — and I'd be glad to mock something up for you for free, no strings attached.`,
      "",
      "Would that be helpful?",
      "",
      "Cheers,",
      "[Your name]",
      "",
      OPT_OUT,
    ].join("\n");
  }

  return {
    brief: {
      business_name: biz,
      owner_name: lead.owner_name ?? null,
      city: lead.city ?? null,
      state: lead.state ?? null,
      category: lead.category ?? null,
      has_website: hasSite,
      website_url: lead.website_url ?? null,
      website_status: lead.website_status ?? null,
      site_quality: lead.site_quality ?? null,
    },
    to: lead.owner_email ?? null,
    subject,
    body,
    tone,
    angle: angle ?? null,
    note: "This is a first draft — personalize it before sending. The opt-out line is required; keep it.",
  };
}
