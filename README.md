# mahinatar-mcp

An **Elite-tier** MCP server that connects Claude Code (or any MCP client) to a
[Mahinatar](https://mahinatar.com) account and runs **pipeline outreach** — list
leads, draft cold outreach offering a website, and send it (safely).

It authenticates as **your own Mahinatar user** against Mahinatar's Supabase
backend using the public anon key, so every read and write runs under **your Row
Level Security** — your data only. It never uses a service-role key.

**Two ways to connect** (pick one):

1. **Access token (recommended — required for Google-login users with no
   password).** Set `MAHINATAR_ACCESS_TOKEN` to your own Supabase user JWT. See
   [Token connect](#token-connect) below.
2. **Email + password.** Set `MAHINATAR_EMAIL` + `MAHINATAR_PASSWORD`. Only works
   if your account actually has a password.

Token auth is preferred whenever `MAHINATAR_ACCESS_TOKEN` is set.

> **Outreach is an Elite feature.** Accounts on `elite` / `admin` / `enterprise`
> / `agency` plans (or an owner email) are authorized. Everyone else can call
> `mahinatar_whoami`, but the outreach tools refuse with an upgrade message.

---

## Tools

| Tool | Gate | What it does |
|------|------|--------------|
| `mahinatar_whoami` | none | Connected email, user_id, plan, `auth_method` (`token`/`password`), `authorized` (Elite gate), `live_send_enabled`. |
| `mahinatar_list_leads` | Elite | List leads. Args: `status?`, `hasEmail?`, `limit?` (default 25, max 100). |
| `mahinatar_lead_detail` | Elite | Full row for one lead. Args: `id`. |
| `mahinatar_draft_outreach` | Elite | Structured brief + a sendable first-draft email (no LLM call). Args: `id`, `tone?`, `angle?`. Always includes an opt-out line. |
| `mahinatar_send_outreach` | Elite | Send or **dry-run** an email. Args: `id`, `subject`, `body`, `to?`. |
| `mahinatar_mark_contacted` | Elite | Mark a lead contacted + optional note. Args: `id`, `note?`. Thin wrapper over `update_lead`. |
| `mahinatar_pipeline_summary` | Elite | Situational awareness: counts by status, total leads, #with email, #contacted, #sold, total revenue (if `sale_amount` exists). No args. |
| `mahinatar_search_leads` | Elite | Targeted lead search. Args: `query?`, `status?`, `hasEmail?`, `hasWebsite?`, `city?`, `limit?` (default 25, max 100). |
| `mahinatar_next_actions` | Elite | **"What should I do to make money right now."** Ranked to-do list: high-value (no site + has email) → uncontacted-ready → stale follow-ups. Returns lead id, business, why-now. Args: `limit?` (default 15). |
| `mahinatar_update_lead` | Elite | Generalized update: set `status?` and/or `stage?` (outreach_status) and/or append a timestamped `note?`. Defensive about columns. Args: `id`, `status?`, `stage?`, `note?`. |
| `mahinatar_bulk_draft_outreach` | Elite | Personalized drafts for many leads in one call (does **not** send). Args: `ids?` OR `filter?` (`status`,`hasEmail`,`limit`), `tone?`. Capped at 25. |
| `mahinatar_due_followups` | Elite | Leads contacted > N days ago, not replied/closed. Args: `days?` (default 5). |
| `mahinatar_list_sites` | Elite | Your generated websites (id, business, url, status) to reference when pitching. Args: `status?`, `limit?`. |

---

## Safety model (read this)

This server is built to make accidental mass-emailing **impossible**:

- **Dry-run by default.** `mahinatar_send_outreach` returns
  `{ sent:false, dryRun:true, preview:{...} }` and sends *nothing* unless live
  mode is fully configured.
- **Live send requires ALL of:** `MAHINATAR_OUTREACH_LIVE="true"` **and**
  `RESEND_API_KEY` set **and** `MAHINATAR_FROM_EMAIL` set. Missing any one keeps
  you in dry-run.
- **Throttle:** at most **20 live sends per server run** (in-memory counter).
- **Suppression:** leads flagged `do_not_contact` / `unsubscribed` are skipped
  (checked defensively — only if those columns exist).
- **Opt-out line** is baked into every generated draft (CAN-SPAM friendly).
- **Never bulk-send** without the live flag; the gate is enforced in
  `src/email.ts` (`canSendLive()`), the single source of truth.

For live send to actually deliver, you also need a **warmed sending domain**
verified in Resend and a `from` address on that domain. Cold email to a fresh
domain will land in spam — warm it first.

---

## Setup

Requires **Node 20+**.

```bash
npm install
npm run build      # tsc → dist/
```

Configure via environment variables (see `.env.example`):

| Var | Required | Notes |
|-----|----------|-------|
| `MAHINATAR_SUPABASE_URL` | yes | Defaults to the EZUG project URL. |
| `MAHINATAR_SUPABASE_ANON_KEY` | yes | Anon/publishable key (never service-role). |
| `MAHINATAR_ACCESS_TOKEN` | one-of | **Recommended.** Your Supabase user JWT. Preferred when set. |
| `MAHINATAR_REFRESH_TOKEN` | no | Optional refresh token paired with the access token (lets the session refresh). |
| `MAHINATAR_EMAIL` | one-of | Your Mahinatar login email (password method). |
| `MAHINATAR_PASSWORD` | one-of | Your Mahinatar password (password method). |
| `RESEND_API_KEY` | no | Required for live send only. |
| `MAHINATAR_OUTREACH_LIVE` | no | `"true"` to enable live send. Default dry-run. |
| `MAHINATAR_FROM_EMAIL` | no | Verified Resend sender. Live send only. |

"one-of" = provide **either** `MAHINATAR_ACCESS_TOKEN` **or**
`MAHINATAR_EMAIL`+`MAHINATAR_PASSWORD`.

---

## Token connect

Google-login accounts have **no password**, so use your own Supabase session
token instead. It's *your* session — the same credential your browser already
holds — and it's scoped to your account by RLS exactly like password login.

1. Log in to [mahinatar.com](https://mahinatar.com) in your browser.
2. Open DevTools → Console and run:
   ```js
   const k = Object.keys(localStorage).find(k => k.endsWith('-auth-token'));
   const s = JSON.parse(localStorage.getItem(k));
   console.log('ACCESS_TOKEN=', s.access_token);
   console.log('REFRESH_TOKEN=', s.refresh_token);
   ```
3. Set `MAHINATAR_ACCESS_TOKEN` (and optionally `MAHINATAR_REFRESH_TOKEN`) in
   your MCP env.
4. Run `mahinatar_whoami` — it should report your email, plan, and
   `auth_method: "token"`.

Access tokens expire (typically ~1h). Providing the refresh token lets the
session refresh itself; otherwise re-grab the access token when it expires.

How it works internally: the server attaches the token as
`Authorization: Bearer <token>` on every Supabase request **and** calls
`auth.setSession()` so `getUser()` resolves you — so RLS applies as your user and
the Elite/plan gate works under either auth path. No service-role key, ever.

---

## Add to Claude Code

### Option A — `claude mcp add`

```bash
# Token method (recommended — works for Google-login users):
claude mcp add mahinatar -- node /Users/adamnottea/mahinatar-mcp/dist/index.js \
  -e MAHINATAR_SUPABASE_URL=https://ezugxjvjjqiccxocsojw.supabase.co \
  -e MAHINATAR_SUPABASE_ANON_KEY=your-anon-key \
  -e MAHINATAR_ACCESS_TOKEN=your-supabase-access-token \
  -e MAHINATAR_REFRESH_TOKEN=your-supabase-refresh-token

# Or password method:
#   -e MAHINATAR_EMAIL=you@example.com -e MAHINATAR_PASSWORD=your-password
```

(Add `-e MAHINATAR_OUTREACH_LIVE=true -e RESEND_API_KEY=... -e MAHINATAR_FROM_EMAIL=...`
only when you're ready to send for real.)

### Option B — `.mcp.json` / `claude_desktop_config.json`

```json
{
  "mcpServers": {
    "mahinatar": {
      "command": "node",
      "args": ["/Users/adamnottea/mahinatar-mcp/dist/index.js"],
      "env": {
        "MAHINATAR_SUPABASE_URL": "https://ezugxjvjjqiccxocsojw.supabase.co",
        "MAHINATAR_SUPABASE_ANON_KEY": "your-anon-key",
        "MAHINATAR_EMAIL": "you@example.com",
        "MAHINATAR_PASSWORD": "your-password",
        "MAHINATAR_OUTREACH_LIVE": "false"
      }
    }
  }
}
```

---

## Typical flow

1. `mahinatar_whoami` → confirm `authorized` + `auth_method`, check `live_send_enabled`.
2. `mahinatar_pipeline_summary` → situational awareness.
3. `mahinatar_next_actions` → the ranked "what makes money right now" list.
4. `mahinatar_search_leads { hasEmail: true, status: "new", limit: 25 }` (or
   `mahinatar_due_followups { days: 5 }` for follow-ups).
5. `mahinatar_bulk_draft_outreach { filter: { hasEmail: true, limit: 10 } }` →
   personalize the drafts.
6. `mahinatar_send_outreach { id, subject, body }` → dry-run preview first;
   enable live mode only when the copy and domain are ready.
7. `mahinatar_update_lead { id, status: "called", note: "..." }` (or
   `mahinatar_mark_contacted`) to log the touch.
8. `mahinatar_list_sites` → grab an already-built site URL to show in a pitch.

## Development

```bash
npm run dev    # tsx, no build step
```

The server starts even with placeholder creds — auth happens on the first tool
call and reports a clear error if credentials are wrong, rather than crashing.
