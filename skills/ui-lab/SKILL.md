---
name: ui-lab
description: Preview any page of a local web app in any data state — empty, flooded, very long text, error, loading, slow, or a hand-made scenario — by adding ?uilab= to the URL. Fake data comes in through the network layer, so existing pages work with zero code changes; every write is blocked and nothing is ever committed to git. Use when someone wants to mock a page with fake data, test UI edge cases, reproduce a layout bug that needs specific data, check how a page looks with lots or no data, or hand QA a reproducible UI state. Works for non-developers.
---

# UI Lab

The **real page**, fed different data, with a floating bar to switch states. No database
seeding, no separate test route, no edits to the app's code in the normal case.

CLI = `node "${CLAUDE_SKILL_DIR}/scripts/uilab.mjs"` (`${CLAUDE_SKILL_DIR}` is this skill's folder; if it shows up unexpanded, use the folder this SKILL.md was loaded from).

## Who you are talking to

Often a QA tester or someone non-technical, running the app on their own machine.

- You run every command yourself. Never ask them to edit code or JSON.
- Speak in outcomes: "Open this link", not "the fetch interceptor is patched".
- Finish with clickable links and one line on what each shows.

## Iron rules

1. **Nothing UI Lab creates is ever committed.** The CLI keeps every lab file in
   `.git/info/exclude` and hides any edit to a tracked file with skip-worktree. Never
   `git add` anything under `__uilab__/` or any line containing `@uilab`. End every
   session with `uilab status`, which must print `Safe: nothing from UI Lab can be committed.`
2. **Mock the real page.** Never build a separate `/lab` route or a harness that
   re-imports components. A parallel harness is not what ships, so layout bugs do not
   reproduce in it.
3. **Never use real personal data in a lab file you write.** Use plainly fake names
   (`Asha Test`, `Acme Test Pvt Ltd`), `@example.com` emails and `+91 90000 00000` phones.
   Recorded files come from the tester's own local data: say so, and tell them to
   check them before sharing.
4. **Do not touch the user's dev server.** Do not start or restart it, and do not build. Tell them when
   a restart is needed.

## Turn budget

The whole job takes **under 8 tool calls**. One batched investigation, at most one
`AskUserQuestion` (only if the page or the goal is unclear), then build, then hand over links.

## Flow

### 1. Install (once per app, ~1 call)

```bash
node "${CLAUDE_SKILL_DIR}/scripts/uilab.mjs" install --app <frontend folder>
```
It finds the app (Next.js, Vite or CRA) and copies the runtime to `public/__uilab__/`.
It adds one loader line, either as a new git-excluded file or as a marked line hidden
from git, and adds a local pre-commit guard. It is safe to re-run, and re-running also
updates the runtime. Tell the user to **restart the dev server once**.

### 2. Pick the cheapest mode that answers the question

| Need | Mode | Code written |
|---|---|---|
| "How does this page look with lots / no / long data?" | **Live stress**: `?uilab=-,flood=30`, `-,empty`, `-,long`, `-,fail`, `-,loading`, `-,latency=3000` on the tester's real local data | none |
| A specific state the local DB doesn't have | **Lab file**: write `public/__uilab__/labs/<name>.json` (format below) | one JSON file |
| Capture real shapes, then edit | **Record**: open `?uilab=<name>,record`, click around, press *Save lab file*, then `uilab import ~/Downloads/<name>.json` | none |
| Page loads its data on the **server** (Next.js Server Component, `getServerSideProps`) | **Plan B**: read `reference/plan-b-server-data.md` | ~10 marked lines |

Narrow any mode to one API with `only=<text>`, for example `?uilab=-,flood=50,only=/slots`.
This keeps the login and user calls untouched.

**How to tell server vs browser data:** grep the page's route folder. Is it
`"use client"` with `fetch`, axios, TanStack Query or a store loading on mount? Then it's
browser data, and every mode works. Is it an `async` page or layout component awaiting
data, or `getServerSideProps`? Then it's server data, so use Plan B. For a quick check,
open `?uilab=-,record`. If the bar captures 0 responses after load, the data came from
the server.

### 3. Writing a lab file

One investigation pass, batched in parallel: the page's route file, the service or API
module it calls, and the response types. Then write the JSON in one go. Mirror the real
response shapes field-for-field, because a missing field breaks a component and you
"find" a bug you made yourself.

```json
{
  "lab": "booking",
  "page": "/candidate/schedule",
  "notes": "Interview slot picker states",
  "routes": {
    "GET /api/v1/schedule/slots*": { "body": { "dates": [ { "date": "2026-10-20", "slots": ["10:00", "11:30"] } ] } },
    "GET /api/v1/schedule/context": { "body": { "candidate_name": "Asha Test", "job_title": "Backend Engineer" } }
  },
  "scenarios": {
    "empty":     { "note": "no slots offered", "flags": { "empty": true } },
    "thirty":    { "note": "30 dates, stresses the date strip", "flags": { "flood": 30 } },
    "expired":   { "note": "link expired", "routes": { "GET /api/v1/schedule/context": { "status": 410, "body": { "detail": "Link expired" } } } }
  },
  "allowWrites": []
}
```

- Route key = `METHOD /path`. `*` matches anything. Without `?`, the query string is
  ignored. The host is ignored, so the lab works whatever port the API runs on.
- A response is `{ "status": 200, "body": ..., "headers": {}, "delay": ms }`, and only `body` is required.
- Requests that match no route **pass through to the real API**. Mock only what the
  scenario needs, and let auth and user calls stay real.
- A scenario's `routes` override base routes, and its `flags` apply any stress flag.
- Every POST/PUT/PATCH/DELETE is **blocked** and answered `200 {"ok":true}`, or with a
  matching route if you defined one. Only add to `allowWrites` (e.g. `"POST /api/auth/refresh*"`)
  when the page cannot work without that call, and never for anything that sends email
  or messages, or creates records.
- Derive scenarios from what the data really can do. Always offer: typical, empty,
  flooded, long text, error. Add domain ones (expired, permission variant, single item).

### 4. Hand over

Run `node "${CLAUDE_SKILL_DIR}/scripts/uilab.mjs" list` and paste the links. Then tell the user
in plain words:

- **The yellow bar** (bottom-right): switch scenario, toggle Empty / Long text / Loading / Error,
  drag *Lists ×* and *Delay*. Each change reloads the page in the new state.
- **The verdict line** flags sideways scrolling, an action pushed below the fold, or cut-off text. *Highlight problems* outlines the culprits in red.
- **Phone / Tablet / Laptop** open the same state at that size.
- **Copy bug report** copies the link, viewport, metrics and verdict, ready for a ticket.
- **Writes are blocked**: nothing they click is saved or sent.
- `?uilab=off` or *Exit lab* returns to normal.

To share a lab with a teammate, send them the `.json` file from
`public/__uilab__/labs/`. They run `uilab import <file>`.

### 5. Close out

Run `uilab status`. Paste its last line. If it reports a problem, fix it before
doing anything else. To remove the lab completely, run `uilab uninstall` (lab files are
kept) or `uilab uninstall --purge`.

## Layout traps worth checking once the lab works

- A horizontally scrolling row needs `min-w-0` on **every** flex ancestor. Otherwise it
  stretches the page instead of scrolling, and the verdict line shows sideways overflow.
- Elements duplicated across breakpoints: render one and reposition it, rather than rendering two and hiding one.
- Popovers and dropdowns clip at the viewport edge only in the states the lab makes reachable. Give them collision padding.

## Troubleshooting

| Symptom | Fix |
|---|---|
| No yellow bar | The dev server was not restarted after install. Or the host is not local (the runtime only runs on localhost, `*.local` or a private IP). Or the URL has no `?uilab=` |
| Bar says "lab file … not found" | Name typo. Run `uilab list` for exact links |
| Data unchanged | The page fetches on the server, so use Plan B. Or the route key doesn't match: compare it with the Network tab path |
| Page logs out in the lab | The token refresh is a POST and got blocked. Add it to `allowWrites` |
| `git pull` says a file "would be overwritten" | `uilab uninstall`, then pull, then `uilab install` |
| Anything else odd | `uilab status` |
