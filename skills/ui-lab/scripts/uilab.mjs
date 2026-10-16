#!/usr/bin/env node
// UI Lab CLI — sets up and tears down a local-only UI lab in a web app repo.
// Nothing it creates is ever tracked by git: every path goes into .git/info/exclude
// (a local, uncommitted ignore list) and any edit to a tracked file is hidden with
// skip-worktree and wrapped in @uilab markers so it can be stripped exactly.
//
// Usage: node uilab.mjs <command> [--app <dir>] [--port <n>]
//   install         set up the lab in this app (safe to re-run; also updates the runtime)
//   status          health check: is it installed, is anything at risk of being committed
//   list            print every lab with its ready-to-open link
//   new <name> --page </path>   create an empty lab file to fill in
//   import <file> [--as <name>] add a lab file someone sent you
//   protect <file>  hide local @uilab edits in a tracked file from git (Plan B pages)
//   uninstall [--purge]          remove the lab; --purge also deletes lab files

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_SRC = path.join(HERE, "..", "runtime", "runtime.js");
const TEMPLATE_SRC = path.join(HERE, "..", "templates", "lab.example.json");
const MARK = "@uilab";
const LAB_DIR_REL = "public/__uilab__";

const C = process.stdout.isTTY && !process.env.NO_COLOR
  ? { g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` }
  : { g: (s) => s, y: (s) => s, r: (s) => s, b: (s) => s };
const ok = (m) => console.log(C.g("  ok   ") + m);
const warn = (m) => console.log(C.y("  warn ") + m);
const bad = (m) => console.log(C.r("  FAIL ") + m);
const die = (m) => { console.error(C.r("uilab: ") + m); process.exit(1); };

// ---------- args ----------
const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i > 0 ? argv[i + 1] : undefined; };
const flag = (name) => argv.includes(`--${name}`);
const positional = argv.slice(1).filter((a, i, all) => !a.startsWith("--") && !(i > 0 && all[i - 1].startsWith("--") && !["--purge"].includes(all[i - 1])));

// ---------- helpers ----------
function git(args, cwd, allowFail = false) {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch (e) { if (allowFail) return null; throw new Error(`git ${args.join(" ")} failed: ${e.stderr || e.message}`); }
}
const posix = (p) => p.split(path.sep).join("/");
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const exists = (p) => fs.existsSync(p);

function findApp(start) {
  let dir = path.resolve(start);
  const tryDir = (d) => {
    const pj = path.join(d, "package.json");
    if (!exists(pj)) return null;
    const p = readJson(pj);
    const deps = { ...p.dependencies, ...p.devDependencies };
    if (deps.next) return { dir: d, kind: "next", version: deps.next };
    if (deps.vite) return { dir: d, kind: "vite", version: deps.vite };
    if (deps["react-scripts"]) return { dir: d, kind: "cra", version: deps["react-scripts"] };
    return null;
  };
  for (let d = dir; ; d = path.dirname(d)) {
    const hit = tryDir(d);
    if (hit) return hit;
    if (path.dirname(d) === d) break;
  }
  // Monorepo-ish layout: look one level down (e.g. ./frontend, ./web).
  for (const sub of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!sub.isDirectory() || sub.name.startsWith(".") || sub.name === "node_modules") continue;
    const hit = tryDir(path.join(dir, sub.name));
    if (hit) return hit;
  }
  return null;
}

function ctx() {
  const app = findApp(opt("app") || process.cwd());
  if (!app) die("no web app found here. Run this inside the frontend folder, or pass --app <folder>.");
  const top = git(["rev-parse", "--show-toplevel"], app.dir, true);
  if (!top) die(`${app.dir} is not inside a git repo — UI Lab needs git to keep its files out of commits.`);
  const gitDir = path.resolve(app.dir, git(["rev-parse", "--git-common-dir"], app.dir));
  const labRoot = path.join(app.dir, LAB_DIR_REL);
  const statePath = path.join(labRoot, "install.json");
  const state = { protected: [], created: [], edited: [], ...(exists(statePath) ? readJson(statePath) : {}) };
  const relTop = (p) => posix(path.relative(top, p));
  return { app, top: path.resolve(top), gitDir, labRoot, statePath, state, relTop };
}
function saveState(c) {
  fs.mkdirSync(c.labRoot, { recursive: true });
  fs.writeFileSync(c.statePath, JSON.stringify(c.state, null, 2) + "\n");
}

function addExclude(c, rel) {
  const file = path.join(c.gitDir, "info", "exclude");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const cur = exists(file) ? fs.readFileSync(file, "utf8") : "";
  const line = "/" + rel;
  if (cur.split(/\r?\n/).includes(line)) return;
  fs.appendFileSync(file, (cur && !cur.endsWith("\n") ? "\n" : "") + (cur.includes("# uilab") ? "" : "# uilab — local UI lab files, never commit\n") + line + "\n");
}

function removeExclude(c, rel) {
  const file = path.join(c.gitDir, "info", "exclude");
  if (!exists(file)) return;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l !== "/" + rel);
  fs.writeFileSync(file, lines.join("\n"));
}

function isTracked(c, abs) {
  return git(["ls-files", "--error-unmatch", c.relTop(abs)], c.top, true) !== null;
}

function protect(c, abs) {
  const rel = c.relTop(abs);
  git(["update-index", "--skip-worktree", rel], c.top);
  if (!c.state.protected.includes(rel)) c.state.protected.push(rel);
}

function stripMarkers(text) {
  // Block form: lines between "@uilab:begin" and "@uilab:end" (inclusive).
  let out = text.replace(/^[^\n]*@uilab:begin[^\n]*\n[\s\S]*?^[^\n]*@uilab:end[^\n]*\n?/gm, "");
  // Single-line form: any line carrying "@uilab".
  out = out.split("\n").filter((l) => !l.includes(MARK)).join("\n");
  return out;
}

// ---------- loader injection ----------
function nextMajorMinor(v) {
  const m = String(v).match(/(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
}

function installLoader(c) {
  const { app } = c;
  const runtimeAbs = path.join(c.labRoot, "runtime.js");

  if (app.kind === "next") {
    const [maj, min] = nextMajorMinor(app.version);
    const base = exists(path.join(app.dir, "src", "app")) || exists(path.join(app.dir, "src", "pages")) ? path.join(app.dir, "src") : app.dir;
    const existing = ["instrumentation-client.ts", "instrumentation-client.js", "instrumentation-client.tsx"].map((f) => path.join(base, f)).find(exists);
    let spec = posix(path.relative(base, runtimeAbs));
    if (!spec.startsWith(".")) spec = "./" + spec;
    const line = `import "${spec}"; // ${MARK} local UI lab — never commit`;

    if (maj > 15 || (maj === 15 && min >= 3)) {
      if (!existing) {
        const f = path.join(base, "instrumentation-client.ts");
        fs.writeFileSync(f, `// ${MARK} — created by UI Lab, git-excluded, local only. Delete with: uilab uninstall\n${line}\n`);
        addExclude(c, c.relTop(f));
        if (!c.state.created.includes(c.relTop(f))) c.state.created.push(c.relTop(f));
        return `created ${c.relTop(f)} (git-excluded)`;
      }
      const cur = fs.readFileSync(existing, "utf8");
      if (!cur.includes(MARK)) fs.writeFileSync(existing, line + "\n" + cur);
      if (isTracked(c, existing)) { protect(c, existing); return `added one marked line to ${c.relTop(existing)} (hidden from git)`; }
      if (!c.state.edited.includes(c.relTop(existing))) c.state.edited.push(c.relTop(existing));
      return `added one marked line to ${c.relTop(existing)} — this file is new and uncommitted; run 'uilab uninstall' before committing it`;
    }
    // Older Next: one marked <Script> in the root layout.
    const layout = ["app/layout.tsx", "app/layout.jsx", "app/layout.js"].map((f) => path.join(base, f)).find(exists);
    if (!layout) die(`Next ${app.version} (< 15.3) without app/layout — add <script src="/__uilab__/runtime.js"></script> to your document head manually, then run: uilab protect <that file>`);
    let cur = fs.readFileSync(layout, "utf8");
    if (!cur.includes(MARK)) {
      cur = cur.replace(/<head([^>]*)>/, `<head$1>{/* ${MARK} */}<script src="/__uilab__/runtime.js" />{/* ${MARK} */}`);
      if (!cur.includes(MARK)) cur = cur.replace(/<body([^>]*)>/, `<body$1>\n        {/* ${MARK}:begin */}<script src="/__uilab__/runtime.js" />{/* ${MARK}:end */}`);
      if (!cur.includes(MARK)) die(`could not find <head> or <body> in ${c.relTop(layout)} — add the script tag manually.`);
      fs.writeFileSync(layout, cur);
    }
    protect(c, layout);
    return `added one marked line to ${c.relTop(layout)} (hidden from git)`;
  }

  if (app.kind === "vite" || app.kind === "cra") {
    const html = [path.join(app.dir, "index.html"), path.join(app.dir, "public", "index.html")].find(exists);
    if (!html) die("index.html not found — add <script src=\"/__uilab__/runtime.js\"></script> to your HTML head manually.");
    let cur = fs.readFileSync(html, "utf8");
    if (!cur.includes(MARK)) {
      cur = cur.replace(/<head([^>]*)>/i, `<head$1>\n    <script src="/__uilab__/runtime.js"></script><!-- ${MARK} -->`);
      fs.writeFileSync(html, cur);
    }
    if (isTracked(c, html)) protect(c, html);
    else if (!c.state.edited.includes(c.relTop(html))) c.state.edited.push(c.relTop(html));
    return `added one marked line to ${c.relTop(html)} (hidden from git)`;
  }
  die(`unsupported app type ${app.kind}`);
}

function installHook(c) {
  const hooksPath = git(["config", "core.hooksPath"], c.top, true);
  if (hooksPath) return `git hooks are managed by ${hooksPath} (husky?) — skipped; the exclude list still keeps lab files out`;
  const hook = path.join(c.gitDir, "hooks", "pre-commit");
  const guard = [
    `# ${MARK}:begin — UI Lab guard (local hook, not committed)`,
    `if git diff --cached --name-only | grep -q "__uilab__"; then echo "UI Lab: lab files are staged. Run: git restore --staged <file>"; exit 1; fi`,
    `if git diff --cached -U0 | grep -q "^+.*${MARK}"; then echo "UI Lab: a staged change contains ${MARK}. Remove the lab line before committing."; exit 1; fi`,
    `# ${MARK}:end`,
  ].join("\n");
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  let cur = exists(hook) ? fs.readFileSync(hook, "utf8") : "#!/bin/sh\n";
  if (cur.includes(MARK)) return "pre-commit guard already present";
  // Put the guard right after the shebang so an `exec` later in the hook cannot skip it.
  const lines = cur.split("\n");
  const at = lines[0].startsWith("#!") ? 1 : 0;
  lines.splice(at, 0, guard);
  fs.writeFileSync(hook, lines.join("\n"));
  try { fs.chmodSync(hook, 0o755); } catch {}
  return "pre-commit guard installed in .git/hooks (local only)";
}

// ---------- commands ----------
function labUrl(c, name, page) {
  const port = opt("port") || (c.app.kind === "vite" ? "5173" : "3000");
  return `http://localhost:${port}${page || "/"}?uilab=${name}`;
}

function cmdInstall() {
  const c = ctx();
  console.log(C.b(`UI Lab install → ${c.app.dir} (${c.app.kind} ${c.app.version})`));
  if (!exists(RUNTIME_SRC)) die(`runtime missing at ${RUNTIME_SRC}`);
  fs.mkdirSync(path.join(c.labRoot, "labs"), { recursive: true });
  addExclude(c, c.relTop(c.labRoot));
  fs.copyFileSync(RUNTIME_SRC, path.join(c.labRoot, "runtime.js"));
  ok(`runtime copied to ${c.relTop(c.labRoot)}/runtime.js (git-excluded)`);
  ok(installLoader(c));
  const h = installHook(c);
  (h.startsWith("git hooks are managed") ? warn : ok)(h);
  saveState(c);
  console.log("\n" + C.b("Next:") + " restart the dev server once, then open any page with " + C.b("?uilab=-,flood=30") + " to check it works.");
  status(c, true);
}

function status(c = ctx(), quiet = false) {
  if (!quiet) console.log(C.b(`UI Lab status → ${c.app.dir}`));
  let problems = 0;
  const p = (good, msg, fix) => { if (good) { if (!quiet) ok(msg); } else { problems++; bad(msg + (fix ? `  → ${fix}` : "")); } };

  const rt = path.join(c.labRoot, "runtime.js");
  p(exists(rt), "runtime installed", "run: uilab install");
  if (exists(rt) && exists(RUNTIME_SRC)) {
    const same = fs.readFileSync(rt, "utf8") === fs.readFileSync(RUNTIME_SRC, "utf8");
    if (!same) warn("runtime is older/newer than this skill → run: uilab install");
  }
  // Nothing UI Lab owns may be tracked or staged.
  const tracked = (git(["ls-files"], c.top) || "").split("\n").filter((f) => f.includes("__uilab__"));
  p(tracked.length === 0, "no lab files tracked by git", `untrack with: git rm -r --cached ${tracked.join(" ")}`);
  const stagedMarker = (git(["diff", "--cached", "-U0"], c.top, true) || "").split("\n").some((l) => l.startsWith("+") && l.includes(MARK));
  p(!stagedMarker, `no staged change contains ${MARK}`, "unstage it: git restore --staged <file>");
  for (const rel of c.state.created) {
    p(git(["check-ignore", "-q", rel], c.top, true) !== null, `${rel} is git-excluded`, "run: uilab install");
  }
  const skipped = (git(["ls-files", "-v"], c.top) || "").split("\n").filter((l) => l.startsWith("S ")).map((l) => l.slice(2));
  for (const rel of c.state.protected) {
    p(skipped.includes(rel), `${rel} hidden from git (skip-worktree)`, `run: uilab protect ${rel}`);
  }
  // Untracked files we added a line to: committing them would carry the marker.
  for (const rel of c.state.edited) {
    const abs = path.join(c.top, rel);
    if (!exists(abs) || !fs.readFileSync(abs, "utf8").includes(MARK)) continue;
    if (git(["check-ignore", "-q", rel], c.top, true) !== null) continue;
    if (!quiet) warn(`${rel} is a new uncommitted file holding a lab line — run 'uilab uninstall' before you commit it`);
  }
  if (c.state.protected.length) {
    if (!quiet) warn(`hidden files: ${c.state.protected.join(", ")}. If 'git pull' complains about them, run: uilab uninstall, pull, then uilab install`);
  }
  // Lab edits in tracked files that are NOT hidden = will be committed by accident.
  const changed = (git(["diff", "--name-only"], c.top) || "").split("\n").filter(Boolean);
  for (const rel of changed) {
    const abs = path.join(c.top, rel);
    if (exists(abs) && fs.statSync(abs).size < 2_000_000 && fs.readFileSync(abs, "utf8").includes(MARK)) {
      p(false, `${rel} has ${MARK} edits visible to git`, `run: uilab protect ${rel}`);
    }
  }
  if (!quiet) cmdList(c);
  console.log(problems ? C.r(`\n${problems} problem(s). Fix before committing anything.`) : C.g("\nSafe: nothing from UI Lab can be committed."));
  if (problems) process.exitCode = 1;
}

function cmdList(c = ctx()) {
  const dir = path.join(c.labRoot, "labs");
  const files = exists(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
  console.log(C.b("\nLabs:"));
  if (!files.length) console.log("  (none yet) — quick check on real data: " + labUrl(c, "-,flood=30", "/<page>"));
  for (const f of files) {
    const name = f.replace(/\.json$/, "");
    let j = {};
    try { j = readJson(path.join(dir, f)); } catch { bad(`${f} is not valid JSON`); continue; }
    console.log(`  ${C.b(name)}${j.notes ? " — " + j.notes : ""}`);
    console.log(`    ${labUrl(c, name, j.page)}`);
    for (const [s, v] of Object.entries(j.scenarios || {})) console.log(`    ${labUrl(c, `${name}.${s}`, j.page)}${v && v.note ? "   " + v.note : ""}`);
  }
}

// Git Bash on Windows rewrites "/schedule" into "C:/Program Files/Git/schedule". Undo it.
function normPage(p) {
  if (!p) return "/";
  const m = p.match(/^[A-Za-z]:[\\/].*?[\\/]Git([\\/].*)$/);
  if (m) p = m[1].replace(/\\/g, "/");
  return p.startsWith("/") ? p : "/" + p;
}

function validName(n) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(n || "")) die(`lab name must be lowercase letters, numbers and dashes (got "${n}")`);
  return n;
}

function cmdNew() {
  const c = ctx();
  const name = validName(positional[0]);
  const page = normPage(opt("page"));
  const dest = path.join(c.labRoot, "labs", name + ".json");
  if (exists(dest) && !flag("force")) die(`${name} already exists (${c.relTop(dest)}). Use --force to overwrite.`);
  const t = readJson(TEMPLATE_SRC);
  t.lab = name; t.page = page;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(t, null, 2) + "\n");
  ok(`created ${c.relTop(dest)}`);
  console.log("  open: " + labUrl(c, name, page));
}

function cmdImport() {
  const c = ctx();
  const src = positional[0];
  if (!src || !exists(src)) die("give the path of the lab file, e.g. uilab import ~/Downloads/booking.json");
  let j;
  try { j = readJson(src); } catch (e) { die(`${src} is not valid JSON: ${e.message}`); }
  if (!j.routes || typeof j.routes !== "object") die(`${src} has no "routes" — not a UI Lab file`);
  const name = validName(opt("as") || j.lab || path.basename(src).replace(/\.json$/, ""));
  j.lab = name;
  const dest = path.join(c.labRoot, "labs", name + ".json");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(j, null, 2) + "\n");
  ok(`imported as ${name} → ${c.relTop(dest)}`);
  console.log("  open: " + labUrl(c, name, j.page));
}

function cmdProtect() {
  const c = ctx();
  const f = positional[0];
  if (!f) die("usage: uilab protect <file>");
  const abs = path.resolve(c.top, f);
  if (!exists(abs)) die(`${f} not found`);
  if (!isTracked(c, abs)) { addExclude(c, c.relTop(abs)); if (!c.state.created.includes(c.relTop(abs))) c.state.created.push(c.relTop(abs)); ok(`${c.relTop(abs)} is new — git-excluded`); }
  else { protect(c, abs); ok(`${c.relTop(abs)} hidden from git; lab edits must sit between // ${MARK}:begin and // ${MARK}:end`); }
  saveState(c);
}

function cmdUninstall() {
  const c = ctx();
  console.log(C.b(`UI Lab uninstall → ${c.app.dir}`));
  for (const rel of c.state.protected) {
    const abs = path.join(c.top, rel);
    git(["update-index", "--no-skip-worktree", rel], c.top, true);
    if (!exists(abs)) continue;
    fs.writeFileSync(abs, stripMarkers(fs.readFileSync(abs, "utf8")));
    const diff = git(["diff", "--ignore-cr-at-eol", "--ignore-space-at-eol", "--", rel], c.top, true);
    if (!diff) { git(["checkout", "--", rel], c.top, true); ok(`${rel} restored to the committed version`); }
    else warn(`${rel} still differs from git after removing lab lines — review with: git diff ${rel}`);
  }
  for (const rel of c.state.edited) {
    const abs = path.join(c.top, rel);
    if (exists(abs)) { fs.writeFileSync(abs, stripMarkers(fs.readFileSync(abs, "utf8"))); ok(`removed lab lines from ${rel}`); }
  }
  for (const rel of c.state.created) {
    const abs = path.join(c.top, rel);
    if (exists(abs)) { fs.rmSync(abs); ok(`deleted ${rel}`); }
    removeExclude(c, rel);
  }
  const hook = path.join(c.gitDir, "hooks", "pre-commit");
  if (exists(hook)) {
    const cur = fs.readFileSync(hook, "utf8");
    if (cur.includes(MARK)) { fs.writeFileSync(hook, stripMarkers(cur)); ok("pre-commit guard removed"); }
  }
  if (flag("purge")) { fs.rmSync(c.labRoot, { recursive: true, force: true }); removeExclude(c, c.relTop(c.labRoot)); ok(`deleted ${c.relTop(c.labRoot)} including lab files`); }
  else {
    fs.rmSync(path.join(c.labRoot, "runtime.js"), { force: true });
    fs.rmSync(c.statePath, { force: true });
    ok(`runtime removed; lab files kept in ${c.relTop(c.labRoot)}/labs (still git-excluded). --purge deletes them.`);
  }
  console.log("Restart the dev server to finish.");
}

const commands = { install: cmdInstall, status: () => status(), list: () => cmdList(), new: cmdNew, import: cmdImport, protect: cmdProtect, uninstall: cmdUninstall };
if (!commands[cmd]) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 18).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(cmd ? 1 : 0);
}
try { commands[cmd](); } catch (e) { die(e.message); }
