# UI Lab

**See any page of your app in any data state, in seconds, without touching the database.**

Add `?uilab=…` to a page on your local app, and the real page shows fake or stretched
data: empty lists, 30× lists, very long names, errors, endless loading, a slow network.
A yellow bar switches states live, blocks every save or send, points out layout bugs and
copies a ready-made bug report. Everything stays on your machine. Git never sees it.


## Why

UI bugs hide in states that are slow to reach: no data, too much data, a name that's
60 characters long, a failed request. Seeding a database for each one takes hours. With
UI Lab it is a URL.

## Install the skill (once per person)

Requires [Claude Code](https://claude.com/claude-code), Node 18+ and git.

```bash
# as a plugin
/plugin marketplace add <this-repo-url>
/plugin install ui-lab

# or as a plain skill
git clone <this-repo-url> ~/.claude/ui-lab-skill
# macOS/Linux
ln -s ~/.claude/ui-lab-skill/skills/ui-lab ~/.claude/skills/ui-lab
# Windows (PowerShell, as admin or with Developer Mode on)
New-Item -ItemType SymbolicLink -Path "$HOME\.claude\skills\ui-lab" -Target "$HOME\.claude\ui-lab-skill\skills\ui-lab"
```

## Use it — QA / non-developers

Open Claude Code in your app's folder and say what you want:

> /ui-lab show me the jobs page with 50 jobs and very long titles

> /ui-lab what does the booking page look like when there are no slots?

Claude sets everything up and gives you links. Restart the dev server once when asked.
Then:

| On the yellow bar | What it does |
|---|---|
| Scenario | Switch between prepared states |
| Empty / Long text / Loading / Error | Turn on that stress |
| Lists × / Delay | Multiply every list, slow every request |
| Verdict line | Flags sideways scroll, actions below the fold, cut-off text |
| Highlight problems | Outlines the culprits in red |
| Phone / Tablet / Laptop | Same state at that size |
| Copy bug report | Link, screen size, measurements and verdict, ready for a ticket |
| Exit lab | Back to normal (or open any URL with `?uilab=off`) |

**Nothing you click is saved or sent.** Every write request is blocked while the lab is on.

## Use it without Claude

```bash
node <skill>/scripts/uilab.mjs install          # in the frontend folder, then restart dev server
node <skill>/scripts/uilab.mjs list             # links for every lab
node <skill>/scripts/uilab.mjs import file.json # add a lab a teammate sent you
node <skill>/scripts/uilab.mjs status           # "Safe: nothing from UI Lab can be committed."
node <skill>/scripts/uilab.mjs uninstall        # remove (add --purge to delete lab files)
```

Quick links that need no lab file at all, on your own local data:

```
http://localhost:3000/jobs?uilab=-,flood=50          every list ×50
http://localhost:3000/jobs?uilab=-,empty             every list empty
http://localhost:3000/jobs?uilab=-,long              long text everywhere
http://localhost:3000/jobs?uilab=-,fail              API errors
http://localhost:3000/jobs?uilab=-,loading           stuck loading
http://localhost:3000/jobs?uilab=-,latency=3000      3 s per request
http://localhost:3000/jobs?uilab=-,flood=50,only=/jobs   only the /jobs API
```

## Why it can't leak into git or production

| Guard | How |
|---|---|
| Not tracked | Every file it creates is listed in `.git/info/exclude`, git's local ignore list, which is itself never committed. `git add -A` skips them. |
| Hidden edits | When a tracked file must change (one loader line), it's marked `@uilab` and hidden with `git update-index --skip-worktree`. |
| Commit hook | A local pre-commit hook refuses staged `__uilab__` files or `@uilab` lines (skipped when husky owns the hooks; the two guards above still apply). |
| Health check | `uilab status` fails if anything lab-related is tracked, staged or visible to git. |
| Runtime gate | The runtime does nothing unless the URL has `?uilab=` **and** the host is localhost, `*.local` or a private IP. |
| CI backstop (optional) | Copy `ci/uilab-guard.yml` into an app repo's workflows to fail any PR containing lab files or markers. |

## Supported apps

| Stack | Loader | Notes |
|---|---|---|
| Next.js ≥ 15.3 | `instrumentation-client.ts` (created and excluded, or one hidden line) | best support |
| Next.js < 15.3 | one hidden `<script>` line in `app/layout` | |
| Vite, CRA | one hidden `<script>` line in `index.html` | |
| Data fetched on the server | — | `reference/plan-b-server-data.md`, ~10 marked lines |

Browser requests through `fetch` and `XMLHttpRequest` (axios, ky, TanStack Query, SWR…)
are all covered.

## Sharing a lab

Lab files live in `public/__uilab__/labs/<name>.json` in the app. Send the file; the
teammate runs `uilab import <file>`. Files recorded from your local data may contain real
names. Check them before sending, and never commit them anywhere, this repo included.

## Repo layout

```
.claude-plugin/plugin.json
skills/ui-lab/SKILL.md                      instructions Claude follows
skills/ui-lab/scripts/uilab.mjs             CLI (no dependencies)
skills/ui-lab/runtime/runtime.js            browser runtime (no dependencies)
skills/ui-lab/templates/lab.example.json    lab file starter
skills/ui-lab/reference/plan-b-server-data.md
ci/uilab-guard.yml                          optional CI backstop for app repos
```
