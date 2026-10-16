# UI Lab — Setup

Written so a person **or Claude Code** can follow it top to bottom. Every step ends
with a check. Don't move on until the check passes.

> **To a human:** open Claude Code in your app's frontend folder and paste:
>
> `Set up UI Lab for this app by following https://github.com/jatinaesc/UI-Lab-Skill/blob/main/SETUP.md exactly.`

---

## For Claude Code: rules while doing this setup

- Run every command yourself. Ask the user only to restart their dev server or Claude Code.
- **Do not** start, stop or build the user's app. They run the dev server.
- **Do not** `git add`, commit or push anything in the user's app repo. UI Lab is local-only.
- Report each step's check result in one line. If a check fails, use the Troubleshooting
  table at the bottom, and stop if it doesn't cover the failure.

## Requirements

| Need | Check | Pass when |
|---|---|---|
| Node 18+ | `node --version` | `v18` or higher |
| git | `git --version` | any version |
| Claude Code | `claude --version` | any version (2.1.275+ for the one-step install) |
| A web app in a git repo | `git -C <app folder> rev-parse --show-toplevel` | prints a path |
| App type | `package.json` has `next`, `vite` or `react-scripts` | one is present |

---

## Step 1: Install the skill (once per machine)

Choose **A**. Use **B** only if plugins are unavailable, for example because of company policy or an old Claude Code version.

### A. As a Claude Code plugin (recommended, easy updates)

Run in a terminal (not inside a Claude Code prompt):

```bash
claude plugin marketplace add jatinaesc/UI-Lab-Skill
claude plugin install ui-lab@ui-lab --scope user
```

On Claude Code 2.1.275+ this one line does both:

```bash
claude plugin install ui-lab --marketplace jatinaesc/UI-Lab-Skill
```

Inside a Claude Code prompt the equivalent is:

```
/plugin marketplace add jatinaesc/UI-Lab-Skill
/plugin install ui-lab@ui-lab
/reload-plugins
```

**Check:** `claude plugin list` shows `ui-lab`. In Claude Code, `/ui-lab:ui-lab` autocompletes.
Plugin skills are namespaced, so the command is `/ui-lab:ui-lab`. Plain requests like
"mock this page with 50 rows" also trigger it.

**Update later:** `claude plugin marketplace update ui-lab`, then `/reload-plugins`.

### B. As a plain skill (no plugin system)

Works the same on Windows, macOS and Linux. No symlinks, no admin rights.

```bash
git clone https://github.com/jatinaesc/UI-Lab-Skill.git ~/ui-lab-skill
node -e "const fs=require('fs'),p=require('path'),d=p.join(require('os').homedir(),'.claude','skills','ui-lab');fs.rmSync(d,{recursive:true,force:true});fs.cpSync(p.join(require('os').homedir(),'ui-lab-skill','skills','ui-lab'),d,{recursive:true});console.log('installed to',d)"
```

**Check:** `~/.claude/skills/ui-lab/SKILL.md` exists. Restart Claude Code, and `/ui-lab` autocompletes.

**Update later:** `git -C ~/ui-lab-skill pull`, then run the same `node -e` line again.

### Where is the CLI?

Steps 2–4 run the UI Lab CLI. Set `UILAB` to its path:

| Installed via | `UILAB` path |
|---|---|
| A (plugin) | Inside a skill run: `${CLAUDE_SKILL_DIR}/scripts/uilab.mjs`. From a plain terminal, search for it: `find ~/.claude/plugins -name uilab.mjs` (Windows PowerShell: `Get-ChildItem $HOME\.claude\plugins -Recurse -Filter uilab.mjs`) |
| B (plain skill) | `~/.claude/skills/ui-lab/scripts/uilab.mjs` |

**Check:** `node "$UILAB"` prints the command list.

---

## Step 2: Add UI Lab to the app (once per app clone)

Run from the app's frontend folder, or pass `--app <folder>`:

```bash
node "$UILAB" install
```

This does the following, all **local and invisible to git**:
1. It copies the runtime to `public/__uilab__/runtime.js`.
2. It adds one loader:
   - Next.js 15.3+: creates `instrumentation-client.ts`, or, if one already exists, adds one marked line to it
   - older Next.js: adds one marked line in `app/layout`
   - Vite or CRA: adds one marked line in `index.html`
3. It lists the new paths in `.git/info/exclude` (git's local ignore list, never committed),
   and hides any edited tracked file with `git update-index --skip-worktree`.
4. It adds a local pre-commit guard, unless husky owns the hooks. The other guards still apply in that case.

**Check:** the output ends with `Safe: nothing from UI Lab can be committed.` and
`git status --porcelain` shows **no** UI Lab paths.

## Step 3: Restart the dev server (user does this)

Tell the user: *"Restart your dev server once (stop it and run it again), then tell me."*
This is needed because the new loader file is only picked up on start.

## Step 4: Smoke test

Ask the user to open any page of the app on their local server with `?uilab=-,flood=10`
added, for example `http://localhost:3000/<some page>?uilab=-,flood=10`.

**Check (user confirms):**
- A yellow **UI LAB · FAKE DATA** bar appears bottom-right, or a yellow `UI LAB` pill. Click it to open the bar.
- Lists on the page are longer than usual.
- The browser console shows `[uilab] ON — -,flood=10 · writes blocked`.
- `?uilab=off` returns the page to normal.

If all four pass, setup is done. Run `node "$UILAB" status` one last time and give the
user the last line plus these starter links (swap in a real page path):

```
<page>?uilab=-,flood=30     long lists
<page>?uilab=-,empty        empty state
<page>?uilab=-,long         long text
<page>?uilab=-,fail         API errors
<page>?uilab=-,loading      loading state
```

Tell the user: *"From now on just ask, e.g. 'show me the jobs page with no jobs' — the
UI Lab skill takes it from there."*

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `no web app found here` | Wrong folder | `cd` to the folder with the app's `package.json`, or pass `--app <folder>` |
| `is not inside a git repo` | App isn't a git clone | UI Lab needs git to hide its files. Run `git init` only if the user agrees |
| `Next x (< 15.3) without app/layout` | Pages Router on old Next | Add `<script src="/__uilab__/runtime.js"></script>` to `pages/_document` `<Head>` with a `{/* @uilab */}` marker on the same line, then `node "$UILAB" protect pages/_document.tsx` |
| No bar after restart | Dev server not restarted, URL lacks `?uilab=`, or host not local | Restart, check the URL. The runtime only runs on `localhost`, `127.*`, `*.local`, `*.test` or a private IP |
| Bar shows but data unchanged | Page loads data on the server (Next Server Components) | See `skills/ui-lab/reference/plan-b-server-data.md` |
| Logged out inside the lab | Token refresh is a POST and got blocked | Add the refresh path to the lab file's `allowWrites` |
| `git pull` says a file "would be overwritten" | A skip-worktree file changed upstream | `node "$UILAB" uninstall`, `git pull`, `node "$UILAB" install` |
| `status` prints `FAIL` lines | Something lab-related is visible to git | Follow the `→` fix printed on each line. Commit nothing until `status` says Safe |
| Plugin command not found | Plugins not reloaded | `/reload-plugins`, or restart Claude Code |

## Remove UI Lab from an app

```bash
node "$UILAB" uninstall          # removes runtime + loader, keeps lab files (still git-excluded)
node "$UILAB" uninstall --purge  # removes everything, including lab files
```
**Check:** `git status --porcelain` is identical to before install. Restart the dev server.

## Remove the skill

- A: `claude plugin uninstall ui-lab@ui-lab`
- B: delete `~/.claude/skills/ui-lab` and `~/ui-lab-skill`
