# mahinatar-mcp

An **Elite-tier** MCP server that connects Claude Code (or any MCP client) to a
[Mahinatar](https://mahinatar.com) account and runs **pipeline outreach** — list
leads, draft cold outreach offering a website, and send it (safely).

It authenticates as **your own Mahinatar user** (email + password) against
Mahinatar's Supabase backend using the public anon key, so every read and write
runs under **your Row Level Security** — your data only. It never uses a
service-role key.

> **Outreach is an Elite feature.** Accounts on `elite` / `admin` / `enterprise`
> / `agency` plans (or an owner email) are authorized. Everyone else can call
> `mahinatar_whoami`, but the outreach tools refuse with an upgrade message.

---

## Tools

| Tool | Gate | What it does |
|------|------|--------------|
| `mahinatar_whoami` | none | Connected email, user_id, plan, `authorized` (Elite gate), `live_send_enabled`. |
| `mahinatar_list_leads` | Elite | List leads. Args: `status?`, `hasEmail?`, `limit?` (default 25, max 100). |
| `mahinatar_lead_detail` | Elite | Full row for one lead. Args: `id`. |
| `mahinatar_draft_outreach` | Elite | Structured brief + a sendable first-draft email (no LLM call). Args: `id`, `tone?`, `angle?`. Always includes an opt-out line. |
| `mahinatar_send_outreach` | Elite | Send or **dry-run** an email. Args: `id`, `subject`, `body`, `to?`. |
| `mahinatar_mark_contacted` | Elite | Mark a lead contacted + optional note. Args: `id`, `note?`. |

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
| `MAHINATAR_EMAIL` | yes | Your Mahinatar login email. |
| `MAHINATAR_PASSWORD` | yes | Your Mahinatar password. |
| `RESEND_API_KEY` | no | Required for live send only. |
| `MAHINATAR_OUTREACH_LIVE` | no | `"true"` to enable live send. Default dry-run. |
| `MAHINATAR_FROM_EMAIL` | no | Verified Resend sender. Live send only. |

---

## Add to Claude Code

### Option A — `claude mcp add`

```bash
claude mcp add mahinatar -- node /Users/adamnottea/mahinatar-mcp/dist/index.js \
  -e MAHINATAR_SUPABASE_URL=https://ezugxjvjjqiccxocsojw.supabase.co \
  -e MAHINATAR_SUPABASE_ANON_KEY=your-anon-key \
  -e MAHINATAR_EMAIL=you@example.com \
  -e MAHINATAR_PASSWORD=your-password
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

1. `mahinatar_whoami` → confirm you're `authorized` and check `live_send_enabled`.
2. `mahinatar_list_leads { hasEmail: true, status: "new", limit: 25 }`.
3. `mahinatar_draft_outreach { id, tone: "friendly" }` → personalize the draft.
4. `mahinatar_send_outreach { id, subject, body }` → dry-run preview first;
   enable live mode only when the copy and domain are ready.
5. `mahinatar_mark_contacted { id, note }` as needed.

## Development

```bash
npm run dev    # tsx, no build step
```

The server starts even with placeholder creds — auth happens on the first tool
call and reports a clear error if credentials are wrong, rather than crashing.
