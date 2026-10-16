/* eslint-disable */
// @ts-nocheck
/*
 * UI Lab runtime — LOCAL ONLY. Never commit this file.
 * Installed by `uilab install` into public/__uilab__/runtime.js (git-excluded).
 *
 * Off unless the URL carries ?uilab=... AND the host is local.
 * When on: serves mock API responses from a lab file, applies stress transforms
 * (empty / flood / long / error / loading / latency) to real responses, blocks every
 * write request, and floats a control bar that measures layout defects.
 *
 * URL format:  ?uilab=<lab>[.<scenario>][,flag[=value]]...
 *   ?uilab=booking                 lab "booking", base data
 *   ?uilab=booking.empty           lab "booking", scenario "empty"
 *   ?uilab=-,flood=30              no lab file: real local data, every list x30
 *   ?uilab=booking,record          record real responses into a new lab file
 *   ?uilab=off                     leave the lab
 * Flags: empty  flood=N  long  fail=500  loading  latency=ms  only=<text>  record
 */
(function () {
  "use strict";
  var VERSION = "1.0.0";
  if (typeof window === "undefined" || window.__UILAB__) return;

  // ---- Gate 1: local hosts only. A copy that leaks into a deploy stays inert. ----
  var h = location.hostname;
  var isLocal =
    /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|::1)$/.test(h) ||
    /\.(local|localhost|test)$/.test(h) ||
    /^(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(h);
  if (!isLocal) return;

  // ---- Gate 2: explicit opt-in via URL, remembered for this tab only. ----
  var KEY = "uilab:state";
  var store = {
    get: function () { try { return JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch (e) { return null; } },
    set: function (v) { try { sessionStorage.setItem(KEY, JSON.stringify(v)); } catch (e) {} },
    clear: function () { try { sessionStorage.removeItem(KEY); } catch (e) {} },
  };
  var qp = new URLSearchParams(location.search).get("uilab");
  var state = store.get();
  function readCookie() { var m = document.cookie.match(/(?:^|; )uilab=([^;]*)/); return m ? decodeURIComponent(m[1]) : null; }
  function writeCookie(v) {
    document.cookie = "uilab=" + (v ? encodeURIComponent(v) : "") + "; path=/; SameSite=Lax" + (v ? "" : "; max-age=0");
  }
  if (qp !== null) {
    if (qp === "off" || qp === "0" || qp === "") { store.clear(); if (readCookie()) writeCookie(null); return; }
    state = parseSpec(qp);
    store.set(state);
  }
  if (!state) { if (readCookie()) writeCookie(null); return; }
  // Mirror the state into a cookie so server-rendered pages (Plan B) can see it too.
  // If the server rendered this page without it, reload once so it can.
  var spec = toSpec(state);
  if (readCookie() !== spec) {
    writeCookie(spec);
    if (readCookie() === spec && sessionStorage.getItem("uilab:reloaded") !== spec) {
      sessionStorage.setItem("uilab:reloaded", spec);
      location.reload();
      return;
    }
  }

  window.__UILAB__ = { version: VERSION, state: state };

  function parseSpec(spec) {
    var parts = spec.split(",");
    var head = parts.shift().split(".");
    var s = { lab: head[0] || "-", scenario: head.slice(1).join(".") || "", flags: {} };
    parts.forEach(function (p) {
      if (!p) return;
      var i = p.indexOf("=");
      if (i < 0) s.flags[p] = true;
      else s.flags[p.slice(0, i)] = decodeURIComponent(p.slice(i + 1));
    });
    return s;
  }
  function toSpec(s) {
    var out = (s.lab || "-") + (s.scenario ? "." + s.scenario : "");
    Object.keys(s.flags).forEach(function (k) {
      var v = s.flags[k];
      if (v === false || v === "" || v === null || v === undefined || v === "0") return;
      out += "," + (v === true ? k : k + "=" + encodeURIComponent(v));
    });
    return out;
  }
  function labUrl(s) {
    var u = new URL(location.href);
    u.searchParams.set("uilab", toSpec(s));
    return u.toString();
  }

  var F = state.flags;
  var flood = Math.max(0, Math.min(500, Number(F.flood) || 0));
  var latency = Math.max(0, Math.min(30000, Number(F.latency) || 0));
  var recording = !!F.record;

  // ---- Lab file ----
  var realFetch = window.fetch.bind(window);
  var RealXHR = window.XMLHttpRequest;
  var lab = { routes: {}, scenarios: {}, allowWrites: [] };
  var labError = null;
  var ready =
    state.lab === "-"
      ? Promise.resolve()
      : realFetch("/__uilab__/labs/" + encodeURIComponent(state.lab) + ".json", { cache: "no-store" })
          .then(function (r) {
            if (!r.ok) throw new Error("lab file /__uilab__/labs/" + state.lab + ".json not found (" + r.status + ")");
            return r.json();
          })
          .then(function (j) { lab = Object.assign(lab, j); })
          .catch(function (e) {
            if (recording) return; // recording a brand-new lab: no file yet is normal
            labError = String(e.message || e);
            console.warn("[uilab]", labError);
          });

  // ---- Route matching ----
  function globToRe(g) {
    return new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, "\\?") + "$");
  }
  function matchKey(key, method, url) {
    var sp = key.indexOf(" ");
    var m = sp > 0 ? key.slice(0, sp).toUpperCase() : "GET";
    var pat = sp > 0 ? key.slice(sp + 1).trim() : key.trim();
    if (m !== "*" && m !== method) return false;
    var target = /^https?:/.test(pat) ? url.href : pat.indexOf("?") >= 0 ? url.pathname + url.search : url.pathname;
    return globToRe(pat).test(target);
  }
  function findRoute(map, method, url) {
    if (!map) return null;
    var keys = Object.keys(map);
    for (var i = 0; i < keys.length; i++) if (matchKey(keys[i], method, url)) return map[keys[i]];
    return null;
  }
  function resolveMock(method, url) {
    var sc = state.scenario && lab.scenarios && lab.scenarios[state.scenario];
    return (sc && findRoute(sc.routes || sc, method, url)) || findRoute(lab.routes, method, url);
  }
  function scenarioFlags() {
    var sc = state.scenario && lab.scenarios && lab.scenarios[state.scenario];
    return (sc && sc.flags) || {};
  }
  function inScope(url) {
    if (!F.only) return true;
    return (url.pathname + url.search).indexOf(F.only) >= 0;
  }
  function isAsset(url) {
    return /^\/(_next|__nextjs|__uilab__|@vite|@fs|node_modules|src\/)/.test(url.pathname) ||
      /\.(js|mjs|css|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|mp4|webm|html?)$/i.test(url.pathname) ||
      url.searchParams.has("_rsc");
  }

  // ---- Transforms (pure functions on JSON) ----
  var ID_KEY = /(^id$|_id$|Id$|^uuid$|_uuid$|^key$|^slug$)/;
  var HUMAN = /(name|title|label|company|city|location|designation|subject|description|summary|message|text|note|address|headline|bio|comment)$/i;
  var NO_LONG = /(id$|uuid|key|slug|url|href|src|email|status|type|role|code|kind|variant|state|currency|token|date|time|_at$|At$|color|icon|lang|locale|mime|phone)/i;
  var LOREM = " — an unusually long value that keeps going to test wrapping, truncation and overflow handling in tight layouts";
  function transform(data, flags) {
    var f = Object.assign({}, flags);
    var n = Number(f.flood) || 0;
    function walk(v, key) {
      if (Array.isArray(v)) {
        var objs = v.length > 0 && v.every(function (x) { return x && typeof x === "object" && !Array.isArray(x); });
        if (objs && f.empty) return [];
        var arr = v.map(function (x) { return walk(x, key); });
        if (objs && n > 0 && arr.length > 0) {
          var out = [];
          for (var i = 0; i < n; i++) out.push(i < arr.length ? arr[i] : cloneWithNewIds(arr[i % arr.length], Math.floor(i / arr.length)));
          return out;
        }
        return arr;
      }
      if (v && typeof v === "object") {
        var o = {};
        Object.keys(v).forEach(function (k) {
          var x = v[k];
          // Keep totals honest when lists were flooded or emptied.
          if ((n > 0 || f.empty) && /^(total|count|total_count|totalCount|total_items|totalItems)$/.test(k) && typeof x === "number") {
            var list = Object.keys(v).map(function (kk) { return v[kk]; }).filter(Array.isArray)[0];
            if (list) { o[k] = f.empty ? 0 : Math.max(x, n); return; }
          }
          o[k] = walk(x, k);
        });
        return o;
      }
      if (typeof v === "string" && f.long && key && v.length > 0 && v.length < 400) {
        if (HUMAN.test(key) || (!NO_LONG.test(key) && /\s/.test(v))) return v + LOREM;
      }
      return v;
    }
    return walk(data, "");
  }
  function cloneWithNewIds(obj, round) {
    var c = JSON.parse(JSON.stringify(obj));
    Object.keys(c).forEach(function (k) {
      if (!ID_KEY.test(k)) return;
      if (typeof c[k] === "number") c[k] = c[k] + 100000 * round;
      else if (typeof c[k] === "string") c[k] = c[k] + "-lab" + round;
    });
    return c;
  }

  // ---- Activity log (shown in the bar) ----
  var log = { blocked: [], mocked: 0, transformed: 0, recorded: {} };
  function note(arr, msg) { arr.unshift(msg); if (arr.length > 6) arr.pop(); render && render(); }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function never() { return new Promise(function () {}); }
  function jsonResponse(status, body, headers) {
    var hdr = Object.assign({ "content-type": "application/json", "x-uilab": "mock" }, headers || {});
    var text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
    return new Response(status === 204 ? null : text, { status: status, statusText: status < 400 ? "OK" : "UI Lab", headers: hdr });
  }

  // ---- Core: decide what happens to one request ----
  function handle(method, url, doReal) {
    method = (method || "GET").toUpperCase();
    return ready.then(function () {
      var flags = Object.assign({}, scenarioFlags(), F);
      var fl = Math.max(0, Number(flags.flood) || 0);
      var lat = Math.max(0, Number(flags.latency) || 0);
      var fail = flags.fail ? (Number(flags.fail) > 99 ? Number(flags.fail) : 500) : 0;
      var asset = isAsset(url);
      var scoped = !asset && inScope(url);
      var mock = asset ? null : resolveMock(method, url);
      var delay = (mock && mock.delay) || (scoped ? lat : 0);
      var wait = delay ? sleep(delay) : Promise.resolve();

      var isWrite = !/^(GET|HEAD|OPTIONS)$/.test(method);
      if (isWrite && !asset) {
        var allowed = (lab.allowWrites || []).some(function (k) { return matchKey(k, method, url); });
        if (!allowed) {
          note(log.blocked, method + " " + url.pathname + (mock ? " (mocked)" : " (blocked)"));
          return wait.then(function () {
            return mock ? jsonResponse(mock.status || 200, mock.body, mock.headers) : jsonResponse(200, { ok: true, uilab: "write blocked" });
          });
        }
      }

      if (scoped && flags.loading && !isWrite) return never();
      if (scoped && fail && !isWrite) {
        return wait.then(function () { return jsonResponse(fail, { detail: "UI Lab simulated error " + fail, message: "UI Lab simulated error " + fail }); });
      }

      if (mock) {
        log.mocked++;
        return wait.then(function () {
          var body = mock.body;
          if (body && typeof body === "object") body = transform(body, { flood: fl, empty: flags.empty, long: flags.long });
          return jsonResponse(mock.status || 200, body, mock.headers);
        });
      }

      // Pass-through: real request, JSON optionally transformed / recorded.
      return wait.then(doReal).then(function (res) {
        var ct = (res.headers.get("content-type") || "").toLowerCase();
        if (asset || ct.indexOf("json") < 0 || method !== "GET") return res;
        var wantT = scoped && (fl > 0 || flags.empty || flags.long);
        if (!wantT && !recording) return res;
        return res.clone().text().then(function (txt) {
          var data;
          try { data = JSON.parse(txt); } catch (e) { return res; }
          if (recording && res.ok) {
            // Path only, so the lab works whatever port or host the API runs on.
            var key = "GET " + url.pathname + (url.search ? "*" : "");
            log.recorded[key] = { status: res.status, body: data };
            render && render();
          }
          if (!wantT) return res;
          log.transformed++;
          var hdrs = {};
          res.headers.forEach(function (v, k) { if (!/content-(length|encoding)/i.test(k)) hdrs[k] = v; });
          hdrs["x-uilab"] = "transformed";
          return jsonResponse(res.status, transform(data, { flood: fl, empty: flags.empty, long: flags.long }), hdrs);
        });
      });
    });
  }

  // ---- Patch fetch ----
  window.fetch = function (input, init) {
    var req = input instanceof Request ? input : null;
    var method = (init && init.method) || (req && req.method) || "GET";
    var url;
    try { url = new URL(req ? req.url : String(input), location.href); } catch (e) { return realFetch(input, init); }
    if (!/^https?:$/.test(url.protocol)) return realFetch(input, init);
    return handle(method, url, function () { return realFetch(input, init); });
  };

  // ---- Patch XMLHttpRequest (axios etc.) by routing it through fetch ----
  function LabXHR() {
    this._h = {}; this._l = {}; this.readyState = 0; this.status = 0; this.statusText = "";
    this.response = null; this.responseText = ""; this.responseType = ""; this.responseURL = "";
    this.timeout = 0; this.withCredentials = false; this._resHeaders = null; this._ctrl = null;
    this.upload = { addEventListener: function () {}, removeEventListener: function () {} };
  }
  LabXHR.UNSENT = 0; LabXHR.OPENED = 1; LabXHR.HEADERS_RECEIVED = 2; LabXHR.LOADING = 3; LabXHR.DONE = 4;
  LabXHR.prototype.open = function (m, u) { this._m = m; this._u = u; this._set(1); };
  LabXHR.prototype.setRequestHeader = function (k, v) { this._h[k] = v; };
  LabXHR.prototype.overrideMimeType = function () {};
  LabXHR.prototype.getResponseHeader = function (k) { return this._resHeaders ? this._resHeaders.get(k) : null; };
  LabXHR.prototype.getAllResponseHeaders = function () {
    if (!this._resHeaders) return "";
    var s = ""; this._resHeaders.forEach(function (v, k) { s += k + ": " + v + "\r\n"; }); return s;
  };
  LabXHR.prototype.addEventListener = function (t, fn) { (this._l[t] = this._l[t] || []).push(fn); };
  LabXHR.prototype.removeEventListener = function (t, fn) { this._l[t] = (this._l[t] || []).filter(function (f) { return f !== fn; }); };
  LabXHR.prototype._emit = function (t) {
    var ev = { type: t, target: this, currentTarget: this, loaded: 0, total: 0, lengthComputable: false };
    if (typeof this["on" + t] === "function") this["on" + t](ev);
    (this._l[t] || []).slice().forEach(function (fn) { fn.call(this, ev); }, this);
  };
  LabXHR.prototype._set = function (s) { this.readyState = s; this._emit("readystatechange"); };
  LabXHR.prototype.abort = function () {
    if (this._ctrl) this._ctrl.abort();
    this._done = true; this.status = 0; this._set(4); this._emit("abort"); this._emit("loadend");
  };
  LabXHR.prototype.send = function (body) {
    var x = this;
    x._ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var init = { method: x._m, headers: x._h, body: body === undefined ? null : body, credentials: x.withCredentials ? "include" : "same-origin", signal: x._ctrl && x._ctrl.signal };
    if (/^(GET|HEAD)$/i.test(x._m)) delete init.body;
    var timer = x.timeout ? setTimeout(function () { if (x._ctrl) x._ctrl.abort(); x._done = true; x._set(4); x._emit("timeout"); x._emit("loadend"); }, x.timeout) : null;
    x._emit("loadstart");
    window.fetch(x._u, init).then(function (res) {
      if (x._done) return;
      x.status = res.status; x.statusText = res.statusText; x.responseURL = res.url || String(x._u); x._resHeaders = res.headers;
      x._set(2); x._set(3);
      var rt = x.responseType;
      var p = rt === "blob" ? res.blob() : rt === "arraybuffer" ? res.arrayBuffer() : res.text();
      return p.then(function (data) {
        if (x._done) return;
        if (timer) clearTimeout(timer);
        if (rt === "" || rt === "text") { x.responseText = data; x.response = data; }
        else if (rt === "json") { try { x.response = JSON.parse(data); } catch (e) { x.response = null; } }
        else x.response = data;
        x._done = true; x._set(4); x._emit("load"); x._emit("loadend");
      });
    }).catch(function () {
      if (x._done) return;
      if (timer) clearTimeout(timer);
      x._done = true; x.status = 0; x._set(4); x._emit("error"); x._emit("loadend");
    });
  };
  window.XMLHttpRequest = LabXHR;

  // ---- Layout metrics (generic, read from the live DOM) ----
  var highlight = false;
  var ACTION = "main button:not([disabled]), main [role=button], main a[href], [role=main] button:not([disabled])";
  function measure() {
    var vw = document.documentElement.clientWidth, vh = window.innerHeight;
    var docW = document.documentElement.scrollWidth, docH = document.documentElement.scrollHeight;
    var offenders = [], clipped = 0, firstAction = null;
    var all = document.body ? document.body.querySelectorAll("*") : [];
    for (var i = 0; i < all.length && i < 8000; i++) {
      var el = all[i];
      if (el.tagName === "UILAB-BAR") continue;
      var r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > vw + 1 && getComputedStyle(el).position !== "fixed" && !hasScrollParent(el)) offenders.push(el);
      if (el.scrollWidth > el.clientWidth + 1 && el.children.length === 0 && /hidden|clip/.test(getComputedStyle(el).overflowX)) clipped++;
      if (!firstAction && el.matches(ACTION) && r.top + window.scrollY > 0) {
        firstAction = Math.round(r.top + window.scrollY);
      }
    }
    // Keep only the outermost offenders so the count means something.
    offenders = offenders.filter(function (el) { return !offenders.some(function (o) { return o !== el && o.contains(el); }); });
    document.querySelectorAll("[data-uilab-offender]").forEach(function (el) { el.removeAttribute("data-uilab-offender"); });
    if (highlight) offenders.forEach(function (el) { el.setAttribute("data-uilab-offender", ""); });
    return { vw: vw, vh: vh, overflowX: Math.max(0, docW - vw), offenders: offenders.length, clipped: clipped, screens: +(docH / vh).toFixed(1), firstAction: firstAction };
  }
  function hasScrollParent(el) {
    for (var p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      var o = getComputedStyle(p).overflowX;
      if (o === "auto" || o === "scroll" || o === "hidden" || o === "clip") return true;
    }
    return false;
  }

  // ---- Control bar (shadow DOM, isolated from app styles) ----
  var render = null;
  function mount() {
    if (document.querySelector("uilab-bar")) return;
    var hostEl = document.createElement("uilab-bar");
    var root = hostEl.attachShadow({ mode: "open" });
    document.body.appendChild(hostEl);
    var pageStyle = document.createElement("style");
    pageStyle.setAttribute("data-uilab", "");
    pageStyle.textContent = "[data-uilab-offender]{outline:2px solid #ff3b5c!important;outline-offset:-2px!important;background-image:repeating-linear-gradient(45deg,rgba(255,59,92,.08) 0 6px,transparent 6px 12px)!important}";
    document.head.appendChild(pageStyle);
    var open = sessionStorage.getItem("uilab:open") !== "0";
    var last = null;

    function set(patch) {
      var next = { lab: state.lab, scenario: state.scenario, flags: Object.assign({}, state.flags) };
      if ("scenario" in patch) next.scenario = patch.scenario;
      Object.keys(patch.flags || {}).forEach(function (k) { next.flags[k] = patch.flags[k]; });
      store.set(next);
      location.href = labUrl(next);
    }
    function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
    function verdict(m) {
      if (m.overflowX > 0) return ["bad", "Page scrolls sideways by " + m.overflowX + "px — " + m.offenders + " element(s) stick out"];
      if (m.firstAction !== null && m.firstAction > m.vh) return ["warn", "First action is " + m.firstAction + "px down, past the fold (" + m.vh + "px)"];
      if (m.clipped > 0) return ["warn", m.clipped + " text element(s) are cut off"];
      return ["ok", "No layout problems detected"];
    }
    function report() {
      var m = last || measure();
      return [
        "UI Lab repro",
        "Link: " + labUrl(state),
        "Lab: " + state.lab + (state.scenario ? " / " + state.scenario : "") + "  Flags: " + (toSpec({ lab: "", scenario: "", flags: state.flags }).replace(/^-?,?/, "") || "none"),
        "Viewport: " + m.vw + "x" + m.vh + "  Page height: " + m.screens + " screens",
        "Sideways overflow: " + m.overflowX + "px (" + m.offenders + " elements)  Cut-off text: " + m.clipped,
        "First action at: " + (m.firstAction === null ? "n/a" : m.firstAction + "px"),
        "Verdict: " + verdict(m)[1],
        "Browser: " + navigator.userAgent,
        "Time: " + new Date().toISOString(),
      ].join("\n");
    }

    render = function () {
      var m = last || { vw: 0, vh: 0, overflowX: 0, offenders: 0, clipped: 0, screens: 0, firstAction: null };
      var v = verdict(m);
      var scenarios = Object.keys(lab.scenarios || {});
      var recCount = Object.keys(log.recorded).length;
      var flags = state.flags;
      root.innerHTML =
        "<style>" +
        ":host{all:initial}" +
        ".w{position:fixed;right:16px;bottom:16px;z-index:2147483647;font:12px/1.4 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;color:#e8e8ef;max-width:calc(100vw - 32px)}" +
        ".p{width:300px;max-width:100%;background:#15151c;border:1px solid #3a3a4a;border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,.45);overflow:hidden}" +
        ".hd{display:flex;align-items:center;gap:8px;padding:8px 10px;background:repeating-linear-gradient(135deg,#f5c400 0 10px,#15151c 10px 20px);}" +
        ".tag{background:#15151c;padding:2px 8px;border-radius:4px;font-weight:700;letter-spacing:.06em}" +
        ".bd{padding:10px;display:grid;gap:8px;max-height:70vh;overflow:auto}" +
        "label{display:flex;align-items:center;gap:6px;cursor:pointer}" +
        ".row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}" +
        "button,select,input{font:inherit;color:inherit}" +
        "button{background:#2a2a36;border:1px solid #444457;border-radius:6px;padding:4px 8px;cursor:pointer}" +
        "button:hover{background:#363648}" +
        "select{background:#2a2a36;border:1px solid #444457;border-radius:6px;padding:3px 6px;flex:1}" +
        "input[type=range]{flex:1}" +
        ".k{color:#9a9ab0}.ok{color:#4ade80}.warn{color:#facc15}.bad{color:#ff5c7a}" +
        ".v{padding:6px 8px;border-radius:6px;background:#1f1f29}" +
        ".log{font:11px/1.4 ui-monospace,Consolas,monospace;color:#c9c9d6;white-space:pre-wrap;word-break:break-all}" +
        ".pill{position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#f5c400;color:#15151c;font:700 12px system-ui;padding:6px 10px;border-radius:999px;border:0;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.35)}" +
        "hr{border:0;border-top:1px solid #2e2e3c;margin:2px 0}" +
        "</style>" +
        (!open
          ? "<button class='pill' data-a='open'>UI LAB" + (v[0] !== "ok" ? " · " + (v[0] === "bad" ? "!" : "?") : "") + "</button>"
          : "<div class='w'><div class='p'>" +
            "<div class='hd'><span class='tag'>UI LAB · FAKE DATA</span><span style='flex:1'></span><button data-a='close'>–</button></div>" +
            "<div class='bd'>" +
            (labError ? "<div class='v bad'>" + esc(labError) + "</div>" : "") +
            "<div class='row'><span class='k'>Lab</span><b>" + esc(state.lab === "-" ? "live local data" : state.lab) + "</b></div>" +
            (scenarios.length
              ? "<div class='row'><span class='k'>Scenario</span><select data-a='scenario'><option value=''>base</option>" +
                scenarios.map(function (s) { var d = lab.scenarios[s] && lab.scenarios[s].note; return "<option value='" + esc(s) + "'" + (s === state.scenario ? " selected" : "") + ">" + esc(s + (d ? " — " + d : "")) + "</option>"; }).join("") +
                "</select></div>"
              : "") +
            "<div class='row'>" +
            "<label><input type='checkbox' data-f='empty'" + (flags.empty ? " checked" : "") + ">Empty</label>" +
            "<label><input type='checkbox' data-f='long'" + (flags.long ? " checked" : "") + ">Long text</label>" +
            "<label><input type='checkbox' data-f='loading'" + (flags.loading ? " checked" : "") + ">Loading</label>" +
            "<label><input type='checkbox' data-f='fail'" + (flags.fail ? " checked" : "") + ">Error</label>" +
            "</div>" +
            "<div class='row'><span class='k' style='width:58px'>Lists ×" + (flood || "—") + "</span><input type='range' min='0' max='100' step='5' value='" + flood + "' data-r='flood'></div>" +
            "<div class='row'><span class='k' style='width:58px'>Delay " + (latency ? (latency / 1000).toFixed(1) + "s" : "—") + "</span><input type='range' min='0' max='5000' step='250' value='" + latency + "' data-r='latency'></div>" +
            "<hr>" +
            "<div class='v " + v[0] + "'>" + esc(v[1]) + "</div>" +
            "<div class='log'>Screen " + m.vw + "×" + m.vh + " · page " + m.screens + " screens · first action " + (m.firstAction === null ? "n/a" : m.firstAction + "px") + "</div>" +
            "<div class='row'><label><input type='checkbox' data-a='hl'" + (highlight ? " checked" : "") + ">Highlight problems</label></div>" +
            "<div class='row'><span class='k'>Try size</span><button data-vp='360x780'>Phone</button><button data-vp='768x1024'>Tablet</button><button data-vp='1280x800'>Laptop</button></div>" +
            "<hr>" +
            "<div class='log'>Mocked " + log.mocked + " · changed " + log.transformed + " · writes blocked " + log.blocked.length + "</div>" +
            (log.blocked.length ? "<div class='log'>" + log.blocked.map(esc).join("\n") + "</div>" : "") +
            (recording ? "<div class='v warn'>Recording: " + recCount + " response(s) captured. Click around the page, then save.</div><div class='row'><button data-a='save'>Save lab file</button></div>" : "") +
            "<div class='row'><button data-a='copy'>Copy bug report</button><button data-a='reset'>Reset</button><button data-a='exit'>Exit lab</button></div>" +
            "<div class='k' style='font-size:10px'>Writes are blocked — nothing you click here is saved. v" + VERSION + "</div>" +
            "</div></div></div>");
    };

    root.addEventListener("click", function (e) {
      var t = e.target.closest ? e.target.closest("[data-a],[data-vp]") : null;
      if (!t) return;
      var a = t.getAttribute("data-a"), vp = t.getAttribute("data-vp");
      if (a === "open" || a === "close") { open = a === "open"; sessionStorage.setItem("uilab:open", open ? "1" : "0"); render(); }
      if (a === "copy") {
        var txt = report();
        (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(function () { t.textContent = "Copied!"; }, function () { prompt("Copy this:", txt); });
      }
      if (a === "reset") set({ scenario: "", flags: { empty: false, long: false, loading: false, fail: false, flood: 0, latency: 0 } });
      if (a === "exit") { store.clear(); writeCookie(null); var u = new URL(location.href); u.searchParams.delete("uilab"); location.href = u.toString(); }
      if (a === "save") {
        var name = state.lab === "-" ? "recorded" : state.lab;
        var file = { lab: name, page: location.pathname, notes: "Recorded from local data on " + new Date().toISOString().slice(0, 10) + ". Review for personal data before sharing.", routes: Object.assign({}, lab.routes, log.recorded), scenarios: lab.scenarios || {} };
        var blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
        var link = document.createElement("a");
        link.href = URL.createObjectURL(blob); link.download = name + ".json"; link.click();
        t.textContent = "Saved to Downloads";
      }
      if (vp) {
        var wh = vp.split("x");
        window.open(location.href, "uilab-" + vp, "width=" + wh[0] + ",height=" + wh[1]);
      }
    });
    root.addEventListener("change", function (e) {
      var t = e.target;
      if (t.getAttribute("data-a") === "scenario") return set({ scenario: t.value });
      if (t.getAttribute("data-a") === "hl") { highlight = t.checked; last = measure(); render(); return; }
      var f = t.getAttribute("data-f");
      if (f) { var p = {}; p[f] = t.checked ? (f === "fail" ? "500" : true) : false; return set({ flags: p }); }
      var r = t.getAttribute("data-r");
      if (r) { var q = {}; q[r] = Number(t.value) ? String(t.value) : false; return set({ flags: q }); }
    });

    var pending = null;
    function remeasure() {
      if (pending) return;
      pending = setTimeout(function () { pending = null; last = measure(); render(); }, 400);
    }
    new MutationObserver(function (muts) {
      if (muts.every(function (mu) { return mu.target === hostEl || hostEl.contains(mu.target); })) return;
      remeasure();
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    window.addEventListener("resize", remeasure);
    ready.then(function () { last = measure(); render(); });
    render();
  }

  function whenReady() {
    // Mount after hydration so React never sees the bar during its first pass.
    setTimeout(mount, 600);
  }
  if (document.readyState === "complete") whenReady();
  else window.addEventListener("load", whenReady);
  console.info("%c[uilab] ON — " + toSpec(state) + " · writes blocked · ?uilab=off to leave", "background:#f5c400;color:#111;padding:2px 6px;border-radius:3px");
})();
