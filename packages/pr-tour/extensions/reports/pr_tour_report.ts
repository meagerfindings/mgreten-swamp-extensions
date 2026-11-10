/**
 * `@mgreten/pr-tour-report` renders a `@mgreten/pr-tour` tour as one
 * self-contained HTML page and writes it to the model's `pagesDir`, as
 * `<pr>-<sha12>.html` for each head SHA and `<pr>.html` for the latest.
 * Serve that directory with any static file server to open tours in a
 * browser.
 *
 * Layout: side by side. Each stop's narrative and review checks stay pinned
 * on the left while its diff pieces scroll on the right. Pieces are real
 * line ranges of the PR's hunks, so one file can appear at several stops;
 * each such piece links to the other stops with an "also at N" chip.
 *
 * Theme: Synthwave '84 when dark (the default); light mode is a neutral
 * GitHub-style white with blue accents. The model's `theme` setting
 * overrides any CSS custom property per mode, and `themeStorageKey` names
 * the localStorage key that remembers the mode, so other pages can share
 * it. Reviewed stops persist per PR and head SHA.
 *
 * The client script below is a String.raw template, so it uses no template
 * literals or backticks of its own (the inline-code regex spells the
 * backtick as \x60).
 *
 * @module
 */

import {
  expandHome,
  type ReportSettings,
  ReportSettingsSchema,
  type Tour,
} from "../models/pr_tour.ts";

const STYLE = String.raw`
:root{color-scheme:dark;
  --bg:#241b2f;--panel:#2a2139;--code:#1d1628;--line:#3b2f55;--ink:#f8f4ff;--muted:#b2a8cc;--dim:#6d6290;
  --accent:#ff7edb;--accent2:#36f9f6;--add:#72f1b8;--del:#fe4450;
  --add-bg:rgb(114 241 184 / .09);--del-bg:rgb(254 68 80 / .11);
  --high:#fe4450;--medium:#fede5d;--low:#72f1b8;--on-done:#241b2f;
  --kw:#fede5d;--st:#ff8b39;--sy:#ff7edb;--co:#36f9f6;--nu:#f97e72;--iv:#ff7edb;--fn:#fede5d;--cm:#848bbd;
  --code-ink:#36f9f6;--code-bg:rgb(54 249 246 / .10);
  --check-bg:color-mix(in srgb,#36f9f6 7%,#2a2139);--check-ring:rgb(54 249 246 / .28);
  --glow:0 0 2px rgb(255 255 255 / .25),0 0 12px rgb(255 126 219 / .75);
  --bg-image:radial-gradient(120% 70% at 50% -10%,rgb(114 54 168 / .45),transparent 60%);
  --font-ui:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  --font-code:"JetBrains Mono",ui-monospace,"SF Mono",Menlo,monospace;
  --radius:8px}
:root[data-theme="light"]{color-scheme:light;
  --bg:#ffffff;--panel:#f6f8fa;--code:#ffffff;--line:#d8dee4;--ink:#1f2328;--muted:#59636e;--dim:#8c959f;
  --accent:#2f5bd3;--accent2:#9a6700;--add:#1a7f37;--del:#cf222e;
  --add-bg:#e6ffec;--del-bg:#ffebe9;
  --high:#cf222e;--medium:#9a6700;--low:#1a7f37;--on-done:#ffffff;
  --kw:#cf222e;--st:#0a3069;--sy:#0550ae;--co:#953800;--nu:#0550ae;--iv:#116329;--fn:#8250df;--cm:#6e7781;
  --code-ink:#1f2328;--code-bg:#eff2f5;
  --check-bg:#fff8c5;--check-ring:#eac54f;
  --glow:none;
  --bg-image:none}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{background:var(--bg-image),var(--bg);background-attachment:fixed;color:var(--ink);font:13px/1.5 var(--font-ui)}
button{font:inherit;color:inherit}
a{color:inherit}
code{font:.9em var(--font-code);padding:1px 4px;border-radius:4px;color:var(--code-ink);background:var(--code-bg);overflow-wrap:anywhere}
.app{display:grid;grid-template-rows:auto minmax(0,1fr);height:100vh;height:100dvh}
.top{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;padding:10px 18px;border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--panel) 85%,transparent);min-width:0}
.title{min-width:0;flex:1 1 260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;text-decoration:none}
.title .num{font-family:var(--font-code);color:var(--accent);margin-right:8px;text-shadow:var(--glow)}
@media (hover:hover){a.title:hover .t{text-decoration:underline}}
.meta{font:11px var(--font-code);color:var(--muted);white-space:nowrap}
.add{color:var(--add)}.del{color:var(--del)}
.segs{display:inline-flex;gap:3px;vertical-align:middle;margin-right:6px}
.segs i{width:12px;height:4px;border-radius:2px;background:var(--line)}
.segs i.on{background:var(--accent)}
kbd{font:inherit;padding:0 4px;border:1px solid var(--line);border-radius:4px}
.theme{cursor:pointer;font:11px var(--font-code);padding:3px 9px;border-radius:999px;border:1px solid var(--line);background:transparent;color:var(--muted)}
@media (hover:hover){.theme:hover{color:var(--ink);border-color:var(--muted)}}
.body{display:grid;grid-template-columns:56px minmax(0,1fr);min-height:0}
.rail{overflow-y:auto;overflow-x:hidden;border-right:1px solid var(--line);padding:12px 10px;display:grid;align-content:start;gap:4px}
.r-item{all:unset;box-sizing:border-box;display:grid;grid-template-columns:26px;gap:10px;align-items:center;padding:4px;border-radius:var(--radius);cursor:pointer;color:var(--muted)}
.r-num{display:grid;place-items:center;width:26px;height:26px;border-radius:50%;font:11px var(--font-code);box-shadow:inset 0 0 0 1px var(--line)}
.r-t{display:none;font-size:12px;line-height:1.35;text-wrap:pretty}
.r-item.done .r-num{color:var(--on-done);background:var(--low);box-shadow:none}
.r-item.active .r-num{color:var(--accent);box-shadow:inset 0 0 0 1.5px var(--accent);text-shadow:var(--glow)}
.r-item.active .r-t{color:var(--ink)}
.r-item.active.done .r-num{color:var(--on-done);background:var(--accent);text-shadow:none}
@media (hover:hover){.r-item:hover .r-num{box-shadow:inset 0 0 0 1px var(--muted)}.r-item:hover .r-t{color:var(--ink)}}
.r-item:focus-visible,.btn:focus-visible,.check-item:focus-visible,.also:focus-visible,.ov-stop:focus-visible,.theme:focus-visible{outline:2px solid var(--accent2);outline-offset:1px}
.main{overflow:auto;position:relative;padding:0 22px 50vh;scroll-behavior:smooth}
@media (prefers-reduced-motion:reduce){.main{scroll-behavior:auto}}
.stop{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,8fr);gap:24px;align-items:start;padding:24px 0 32px}
.stop+.stop{border-top:1px solid var(--line)}
.narr-col{position:sticky;top:18px;min-width:0;max-height:calc(100dvh - 90px);overflow:auto;padding-right:4px}
.code-col{min-width:0;display:grid;gap:14px}
.stop-head{display:flex;align-items:center;gap:10px}
.stop-num{font:500 28px/1 var(--font-code);color:var(--accent);text-shadow:var(--glow);letter-spacing:-.02em}
.stop-of{font:11px var(--font-code);color:var(--dim)}
.risk{margin-left:auto;font:10px var(--font-code);padding:1px 7px;border-radius:999px;border:1px solid currentColor}
.risk.high{color:var(--high)}.risk.medium{color:var(--medium)}.risk.low{color:var(--low)}
.stop-title{margin:12px 0 8px;font:500 17px/1.35 var(--font-ui);text-wrap:balance}
.narr{margin:0 0 16px;font-size:14px;line-height:1.65;color:color-mix(in srgb,var(--ink) 88%,var(--muted));text-wrap:pretty;overflow-wrap:anywhere;max-width:68ch}
.checks-label{font:11px var(--font-code);color:var(--accent2);margin-bottom:6px}
.checks{list-style:none;margin:0 0 16px;padding:0;display:grid;gap:6px}
.check-item{all:unset;box-sizing:border-box;display:block;cursor:pointer;padding:8px 10px;border-radius:var(--radius);background:var(--check-bg);box-shadow:inset 0 0 0 1px var(--check-ring);font-size:13px;line-height:1.5;text-wrap:pretty;overflow-wrap:anywhere}
.check-item .where{font:11px var(--font-code);color:var(--accent2);margin-right:6px}
@media (hover:hover){.check-item:hover{box-shadow:inset 0 0 0 1px var(--accent2)}}
.piece{border-radius:var(--radius);overflow:hidden;box-shadow:0 0 0 1px var(--line);background:var(--code);scroll-margin-top:16px}
.piece.flash{box-shadow:0 0 0 2px var(--accent2)}
.p-head{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;padding:7px 10px;background:var(--panel);border-bottom:1px solid var(--line);font:11.5px var(--font-code)}
.p-path{min-width:0;overflow-wrap:anywhere}
.p-path .dir{color:var(--dim)}
.p-range{color:var(--muted)}
.p-tag{font-size:10px;padding:0 6px;border-radius:999px;border:1px solid currentColor}
.p-tag.new{color:var(--add)}.p-tag.gone{color:var(--del)}.p-tag.checks{color:var(--accent2)}
.also{all:unset;cursor:pointer;font-size:10px;padding:0 6px;border-radius:999px;color:var(--accent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--accent) 55%,transparent)}
@media (hover:hover){.also:hover{box-shadow:inset 0 0 0 1px var(--accent)}}
.p-note{padding:7px 10px;border-bottom:1px solid var(--line);color:var(--muted);font-size:12.5px;line-height:1.5;background:var(--panel);text-wrap:pretty}
.p-scroll{overflow-x:auto}
.p-lines{display:grid;grid-template-columns:auto auto 14px 1fr;min-width:max-content;font:12px/1.6 var(--font-code);padding:4px 0}
.p-lines>span{white-space:pre}
.p-lines .ln{color:var(--dim);text-align:right;padding:0 6px 0 10px;user-select:none}
.p-lines .ln+.ln{padding-left:2px}
.p-lines .mk{text-align:center;user-select:none}
.p-lines .cd{padding-right:18px;color:color-mix(in srgb,var(--ink) 85%,var(--muted))}
.p-lines .a{background:var(--add-bg)}.p-lines .r{background:var(--del-bg)}
.p-lines .mk.a{color:var(--add)}.p-lines .mk.r{color:var(--del)}
.p-empty{padding:10px;color:var(--muted);font:12px var(--font-code)}
.kw{color:var(--kw)}.st{color:var(--st)}.sy{color:var(--sy)}.co{color:var(--co)}.nu{color:var(--nu)}.iv{color:var(--iv)}.fn{color:var(--fn)}.cm{color:var(--cm);font-style:italic}
.foot{display:flex;flex-wrap:wrap;gap:8px}
.btn{cursor:pointer;padding:6px 12px;border-radius:var(--radius);border:1px solid var(--line);background:var(--panel);font-size:12px}
.btn.primary{border-color:var(--accent);color:var(--accent);text-shadow:var(--glow)}
.btn.isdone{border-color:var(--low);color:var(--low)}
.btn:active{transform:scale(.97)}
@media (hover:hover){.btn:hover{border-color:var(--muted)}.btn.primary:hover{background:color-mix(in srgb,var(--accent) 12%,var(--panel))}}
.ov-stops{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.ov-stop{all:unset;box-sizing:border-box;cursor:pointer;display:grid;grid-template-columns:30px minmax(0,1fr) auto;gap:10px;align-items:baseline;width:100%;padding:10px 12px;border-radius:var(--radius);background:var(--panel);box-shadow:inset 0 0 0 1px var(--line)}
.ov-stop .n{font:13px var(--font-code);color:var(--accent)}
.ov-stop .t{text-wrap:pretty}
.ov-stop .f{font:11px var(--font-code);color:var(--muted);white-space:nowrap}
.ov-stop.done .n{color:var(--low)}
@media (hover:hover){.ov-stop:hover{box-shadow:inset 0 0 0 1px var(--accent)}}
.ov-meta{font:11px var(--font-code);color:var(--dim);margin:0 0 4px;overflow-wrap:anywhere}
@media (min-width:1000px){.body{grid-template-columns:250px minmax(0,1fr)}.r-item{grid-template-columns:26px minmax(0,1fr)}.r-t{display:block}}
@media (max-width:700px){
  .body{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr)}
  .rail{display:flex;overflow-x:auto;overflow-y:hidden;border-right:0;border-bottom:1px solid var(--line);padding:6px 10px}
  .main{padding:0 14px 40vh}
  .stop{grid-template-columns:minmax(0,1fr);gap:16px}
  .narr-col{position:static;max-height:none;overflow:visible;padding-right:0}
  .keys{display:none}
}
`;

const SCRIPT = String.raw`
(function () {
  var DATA = JSON.parse(document.getElementById("tour-data").textContent);
  var HUNK = {};
  DATA.hunks.forEach(function (h) { HUNK[h.id] = h; });
  var N = DATA.stops.length;
  var STORE = "pr-tour:" + DATA.prNumber + ":" + DATA.headSha.slice(0, 12) + ":reviewed";
  var reviewed = (function () {
    try { return new Set(JSON.parse(localStorage.getItem(STORE) || "[]")); } catch (e) { return new Set(); }
  })();
  var current = 0;
  var $ = function (id) { return document.getElementById(id); };

  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function md(s) { return esc(s).replace(/\x60([^\x60]+)\x60/g, "<code>$1</code>"); }
  function base(p) { return p.split("/").pop(); }
  function pad(n) { return String(n).padStart(2, "0"); }
  function save() { try { localStorage.setItem(STORE, JSON.stringify(Array.from(reviewed))); } catch (e) {} }

  var pathStops = {};
  DATA.stops.forEach(function (s, i) {
    s.pieces.forEach(function (p) {
      var path = HUNK[p.hunkId].path;
      (pathStops[path] = pathStops[path] || []);
      if (pathStops[path].indexOf(i + 1) < 0) pathStops[path].push(i + 1);
    });
  });

  function pieceLines(h, from, to) {
    var o = h.oldStart, n = h.newStart;
    return (h.patch ? h.patch.split("\n") : []).map(function (text) {
      var c = text[0];
      if (c === "+") return { kind: "a", text: text, old: null, nu: n++ };
      if (c === "-") return { kind: "r", text: text, old: o++, nu: null };
      if (c === "\\") return { kind: "", text: text, old: null, nu: null };
      return { kind: "", text: text, old: o++, nu: n++ };
    }).slice(from - 1, to);
  }

  var TOK = /(#(?!\{).*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(@{1,2}\w+)|((?<![:\w]):[a-zA-Z_]\w*[?!]?|\b[a-z_]\w*:(?!:))|(\b[A-Z]\w*)|(\b\d[\d_]*(?:\.\d+)?\b)|(\b(?:def|end|do|if|else|elsif|unless|return|class|module|then|nil|true|false|self|rescue|ensure|begin|yield|when|case|and|or|not|new|const|let|var|function|import|export|from|async|await|null|undefined)\b)|(\b(?:describe|context|it|expect|to|eq|before|subject|include|be|not_to|match_array)\b)/g;
  var CLS = ["cm", "st", "iv", "sy", "co", "nu", "kw", "fn"];
  function hl(code) {
    var out = "", last = 0;
    code.replace(TOK, function () {
      var m = arguments[0], off = arguments[9], idx = 0;
      for (var g = 1; g <= 8; g++) if (arguments[g] !== undefined) { idx = g - 1; break; }
      out += esc(code.slice(last, off)) + '<span class="' + CLS[idx] + '">' + esc(m) + "</span>";
      last = off + m.length;
      return m;
    });
    return out + esc(code.slice(last));
  }

  function pieceHtml(p, stopIdx, k, stop) {
    var h = HUNK[p.hunkId];
    var lines = pieceLines(h, p.from, p.to);
    var nums = lines.map(function (l) { return l.nu != null ? l.nu : l.old; }).filter(function (x) { return x != null; });
    var range = nums.length ? "L" + Math.min.apply(null, nums) + "–" + Math.max.apply(null, nums) : "";
    var adds = lines.filter(function (l) { return l.kind === "a"; }).length;
    var dels = lines.filter(function (l) { return l.kind === "r"; }).length;
    // A file placed only in skim appears at no stop.
    var others = (pathStops[h.path] || []).filter(function (s) { return s !== stopIdx; });
    var checks = stop.reviewFocus.filter(function (f) { return f.piece === k + 1; }).length;
    var dir = h.path.indexOf("/") >= 0 ? h.path.slice(0, h.path.lastIndexOf("/") + 1) : "";
    var rows = lines.map(function (l) {
      var mark = l.kind === "a" ? "+" : l.kind === "r" ? "−" : "";
      return '<span class="ln ' + l.kind + '">' + (l.old != null ? l.old : "") + "</span>" +
        '<span class="ln ' + l.kind + '">' + (l.nu != null ? l.nu : "") + "</span>" +
        '<span class="mk ' + l.kind + '">' + mark + "</span>" +
        '<span class="cd ' + l.kind + '">' + (hl(l.text.slice(1)) || " ") + "</span>";
    }).join("");
    var body = lines.length
      ? '<div class="p-scroll"><div class="p-lines">' + rows + "</div></div>"
      : '<div class="p-empty">' + (h.status === "renamed" ? "Renamed from " + esc(h.oldPath) : esc(h.status) + " file, no text lines") + "</div>";
    return '<div class="piece" data-piece="' + stopIdx + "-" + (k + 1) + '">' +
      '<div class="p-head">' +
      '<span class="p-path"><span class="dir">' + esc(dir) + "</span>" + esc(base(h.path)) + "</span>" +
      '<span class="p-range">' + range + "</span>" +
      (h.status === "added" ? '<span class="p-tag new">new file</span>' : "") +
      (h.status === "deleted" ? '<span class="p-tag gone">deleted</span>' : "") +
      '<span><span class="add">+' + adds + '</span> <span class="del">−' + dels + "</span></span>" +
      (checks ? '<span class="p-tag checks">' + checks + (checks === 1 ? " check" : " checks") + "</span>" : "") +
      others.map(function (s) { return '<button class="also" data-goto="' + s + '" title="This file also appears at stop ' + s + '">also at ' + s + "</button>"; }).join("") +
      "</div>" +
      (p.note ? '<div class="p-note">' + md(p.note) + "</div>" : "") +
      body + "</div>";
  }

  function stopHtml(i) {
    var s = DATA.stops[i - 1];
    var checks = s.reviewFocus.length
      ? '<div class="checks-label">Check here</div><ol class="checks">' + s.reviewFocus.map(function (f) {
        var p = s.pieces[f.piece - 1], h = HUNK[p.hunkId];
        var first = pieceLines(h, p.from, p.to).filter(function (l) { return l.nu != null || l.old != null; })[0];
        var where = esc(base(h.path)) + (first ? ":" + (first.nu != null ? first.nu : first.old) : "");
        return '<li><button class="check-item" data-target="' + i + "-" + f.piece + '"><span class="where">' + where + "</span>" + md(f.note) + "</button></li>";
      }).join("") + "</ol>"
      : "";
    var mark = reviewed.has(i)
      ? '<button class="btn isdone" data-toggle="' + i + '">Reviewed</button>'
      : '<button class="btn primary" data-toggle="' + i + '">' + (i < N ? "Mark reviewed, next stop" : "Mark reviewed") + "</button>";
    return '<section class="stop" data-stop="' + i + '" id="stop-' + i + '">' +
      '<div class="narr-col">' +
      '<div class="stop-head"><span class="stop-num">' + pad(i) + '</span><span class="stop-of">of ' + pad(N) + '</span><span class="risk ' + s.risk + '">' + s.risk + " risk</span></div>" +
      '<h2 class="stop-title">' + md(s.title) + "</h2>" +
      '<p class="narr">' + md(s.narrative) + "</p>" + checks +
      '<div class="foot">' + mark + "</div></div>" +
      '<div class="code-col">' + s.pieces.map(function (p, k) { return pieceHtml(p, i, k, s); }).join("") + "</div></section>";
  }

  function overviewHtml() {
    var built = new Date(DATA.builtAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    var pieces = DATA.stops.reduce(function (n, s) { return n + s.pieces.length; }, 0);
    var list = DATA.stops.map(function (s, k) {
      var files = {};
      s.pieces.forEach(function (p) { files[HUNK[p.hunkId].path] = 1; });
      var nf = Object.keys(files).length;
      return '<li><button class="ov-stop' + (reviewed.has(k + 1) ? " done" : "") + '" data-goto="' + (k + 1) + '"><span class="n">' + pad(k + 1) + '</span><span class="t">' + md(s.title) +
        '</span><span class="f">' + s.pieces.length + " pieces · " + nf + (nf === 1 ? " file" : " files") + "</span></button></li>";
    }).join("");
    var skim = DATA.skim.pieces.length
      ? '<p class="ov-meta">Skim: ' + DATA.skim.pieces.length + " pieces. " + md(DATA.skim.reason) + "</p>"
      : "";
    return '<section class="stop" data-stop="0" id="stop-0"><div class="narr-col">' +
      '<div class="stop-head"><span class="stop-num">00</span><span class="stop-of">overview</span></div>' +
      '<h2 class="stop-title">' + md(DATA.title) + "</h2>" +
      '<p class="narr">' + md(DATA.summary) + "</p>" +
      '<p class="ov-meta">' + N + " stops, " + pieces + " pieces from " + DATA.hunks.length + " hunks</p>" + skim +
      '<p class="ov-meta">Built ' + esc(built) + " for " + DATA.headSha.slice(0, 7) + " by " + esc(DATA.model) + "</p>" +
      '<div class="foot"><button class="btn primary" data-goto="1">Start tour</button></div>' +
      '</div><div class="code-col"><ol class="ov-stops">' + list + "</ol></div></section>";
  }

  function skimHtml() {
    if (!DATA.skim.pieces.length) return "";
    var s = { reviewFocus: [] };
    return '<section class="stop" data-stop="' + (N + 1) + '" id="stop-skim"><div class="narr-col">' +
      '<div class="stop-head"><span class="stop-num">~~</span><span class="stop-of">skim</span></div>' +
      '<h2 class="stop-title">Skim</h2><p class="narr">' + md(DATA.skim.reason) + "</p></div>" +
      '<div class="code-col">' + DATA.skim.pieces.map(function (p, k) { return pieceHtml(p, N + 1, k, s); }).join("") + "</div></section>";
  }

  function railHtml() {
    function item(i, num, title) {
      return '<button class="r-item' + (i === current ? " active" : "") + (reviewed.has(i) ? " done" : "") + '" data-goto="' + i + '" title="' + esc(title) + '">' +
        '<span class="r-num">' + num + '</span><span class="r-t">' + md(title) + "</span></button>";
    }
    return item(0, "≡", "Overview") + DATA.stops.map(function (s, k) { return item(k + 1, k + 1, s.title); }).join("");
  }

  function isLight() { return document.documentElement.dataset.theme === "light"; }

  function topHtml() {
    var segs = DATA.stops.map(function (_, k) { return '<i class="' + (reviewed.has(k + 1) ? "on" : "") + '"></i>'; }).join("");
    return '<a class="title" href="' + esc(DATA.url) + '" target="_blank" rel="noopener"><span class="num">#' + DATA.prNumber + '</span><span class="t">' + esc(DATA.title) + "</span></a>" +
      '<span class="meta">' + esc(DATA.author) + "</span>" +
      '<span class="meta"><span class="add">+' + DATA.additions + '</span> <span class="del">−' + DATA.deletions + "</span></span>" +
      '<span class="meta">' + DATA.headSha.slice(0, 7) + "</span>" +
      '<span class="meta"><span class="segs">' + segs + "</span>" + reviewed.size + "/" + N + " reviewed</span>" +
      '<span class="meta keys"><kbd>j</kbd> <kbd>k</kbd> stops <kbd>r</kbd> reviewed</span>' +
      '<button class="theme" id="theme">' + (isLight() ? "Dark" : "Light") + "</button>";
  }

  function render(focusSel) {
    var main = $("main"), keep = main.scrollTop;
    $("top").innerHTML = topHtml();
    $("rail").innerHTML = railHtml();
    main.innerHTML = overviewHtml() + DATA.stops.map(function (_, k) { return stopHtml(k + 1); }).join("") + skimHtml();
    main.style.scrollBehavior = "auto";
    main.scrollTop = keep;
    main.style.scrollBehavior = "";
    if (focusSel) { var el = document.querySelector(focusSel); if (el) el.focus({ preventScroll: true }); }
  }

  function setActive() {
    Array.prototype.forEach.call($("rail").querySelectorAll(".r-item"), function (el) {
      el.classList.toggle("active", Number(el.dataset.goto) === current);
    });
  }

  function goTo(i, smooth) {
    current = Math.max(0, Math.min(N, i));
    setActive();
    try { history.replaceState(null, "", "#stop-" + current); } catch (e) {}
    var sec = $("main").querySelector('[data-stop="' + current + '"]');
    if (sec) $("main").scrollTo({ top: sec.offsetTop, behavior: smooth === false ? "instant" : "smooth" });
  }

  function toggleReviewed(i) {
    if (i < 1 || i > N) return;
    if (reviewed.has(i)) { reviewed.delete(i); save(); render('[data-toggle="' + i + '"]'); return; }
    reviewed.add(i); save(); render();
    if (i < N) goTo(i + 1); else render('[data-toggle="' + i + '"]');
  }

  document.addEventListener("click", function (e) {
    var t = e.target.closest("button");
    if (!t) return;
    if (t.id === "theme") {
      var light = !isLight();
      if (light) document.documentElement.dataset.theme = "light"; else delete document.documentElement.dataset.theme;
      try { if (light) localStorage.setItem(DATA.themeStorageKey, "light"); else localStorage.removeItem(DATA.themeStorageKey); } catch (err) {}
      t.textContent = light ? "Dark" : "Light";
      return;
    }
    if (t.dataset.goto !== undefined) { goTo(Number(t.dataset.goto)); return; }
    if (t.dataset.toggle !== undefined) { toggleReviewed(Number(t.dataset.toggle)); return; }
    if (t.dataset.target) {
      var piece = $("main").querySelector('[data-piece="' + t.dataset.target + '"]');
      if (!piece) return;
      var main = $("main");
      main.scrollTo({ top: piece.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop - 16, behavior: "smooth" });
      piece.classList.add("flash");
      setTimeout(function () { piece.classList.remove("flash"); }, 1400);
    }
  });

  document.addEventListener("keydown", function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey || /input|textarea|select/i.test(e.target.tagName)) return;
    if (e.key === "j") { goTo(current + 1); e.preventDefault(); }
    else if (e.key === "k") { goTo(current - 1); e.preventDefault(); }
    else if (e.key === "r") { toggleReviewed(current); e.preventDefault(); }
  });

  $("main").addEventListener("scroll", function () {
    var main = $("main"), cur = 0;
    Array.prototype.forEach.call(main.querySelectorAll("[data-stop]"), function (sec) {
      if (sec.offsetTop - 60 <= main.scrollTop) cur = Math.min(N, Number(sec.dataset.stop));
    });
    if (cur !== current) { current = cur; setActive(); }
  });

  render();
  var m = /^#stop-(\d+)$/.exec(location.hash);
  if (m) goTo(Number(m[1]), false);
})();
`;

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** CSS that applies the `theme` setting's overrides on top of the built-in themes. */
export function themeOverrideCss(theme: ReportSettings["theme"]): string {
  const block = (selector: string, tokens: Record<string, string>) => {
    const decls = Object.entries(tokens).map(([name, value]) =>
      `${name.startsWith("--") ? name : `--${name}`}:${value}`
    );
    return decls.length ? `${selector}{${decls.join(";")}}\n` : "";
  };
  return block(":root", theme.dark) +
    block(':root[data-theme="light"]', theme.light);
}

/**
 * Render a tour as one self-contained HTML page. Settings default to the
 * built-in themes and the `pr-tour:theme` storage key.
 */
export function renderTourPage(
  tour: Tour,
  settings: Partial<ReportSettings> = {},
): string {
  const { theme, themeStorageKey } = ReportSettingsSchema.parse(settings);
  const data = {
    themeStorageKey,
    prNumber: tour.prNumber,
    title: tour.title,
    url: tour.url,
    author: tour.author,
    headSha: tour.headSha,
    additions: tour.additions,
    deletions: tour.deletions,
    builtAt: tour.builtAt,
    model: tour.model,
    summary: tour.summary,
    stops: tour.stops,
    skim: tour.skim,
    hunks: tour.hunks.map((
      { id, path, oldPath, status, oldStart, newStart, patch },
    ) => ({
      id,
      path,
      oldPath,
      status,
      oldStart,
      newStart,
      patch,
    })),
  };
  // "<" is escaped so no "</script>" inside the data can close its tag.
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tour #${tour.prNumber}: ${escHtml(tour.title)}</title>
<script>try{if(localStorage.getItem(${
    JSON.stringify(themeStorageKey).replace(/</g, "\\u003c")
  })==="light")document.documentElement.dataset.theme="light"}catch(e){}</script>
<style>${STYLE}${themeOverrideCss(theme)}</style>
</head>
<body>
<div class="app">
<header class="top" id="top"></header>
<div class="body">
<nav class="rail" id="rail" aria-label="Tour stops"></nav>
<main class="main" id="main"></main>
</div>
</div>
<script type="application/json" id="tour-data">${json}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

/** Where a tour's pages go: one per head SHA, plus a per-PR copy of the latest. */
export function tourPagePaths(
  settings: Pick<ReportSettings, "pagesDir" | "pageBaseUrl">,
  tour: Pick<Tour, "prNumber" | "headSha">,
): { dir: string; versioned: string; latest: string; url: string } {
  const dir = expandHome(settings.pagesDir).replace(/\/+$/, "");
  const sha = tour.headSha.slice(0, 12);
  const latest = `${dir}/${tour.prNumber}.html`;
  const base = settings.pageBaseUrl.replace(/\/+$/, "");
  return {
    dir,
    versioned: `${dir}/${tour.prNumber}-${sha}.html`,
    latest,
    url: base ? `${base}/${tour.prNumber}.html` : `file://${latest}`,
  };
}

/** The parts of swamp's method report context this report uses. */
type ReportContext = {
  modelType: string;
  modelId: string;
  globalArgs: Record<string, unknown>;
  dataHandles?: Array<{ specName: string; name: string; version: number }>;
  dataRepository: {
    getContent: (
      type: string,
      model: string,
      name: string,
      version?: number,
    ) => Promise<Uint8Array | null>;
  };
  logger?: { info?: (msg: string, props?: Record<string, unknown>) => void };
};

/** The `@mgreten/pr-tour-report` report: writes the page for the tour a `build` run stored. */
export const report = {
  name: "@mgreten/pr-tour-report",
  description:
    "Render a @mgreten/pr-tour tour as a self-contained side-by-side HTML page (Synthwave dark, GitHub-style light, both restylable) in the model's pagesDir",
  scope: "method" as const,
  labels: ["pr-tour"],
  execute: async (
    context: ReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    const handle = (context.dataHandles ?? []).find((h) =>
      h.specName === "tour"
    );
    if (!handle) {
      return {
        markdown: "No tour was written by this run.",
        json: { written: false },
      };
    }
    const raw = await context.dataRepository.getContent(
      context.modelType,
      context.modelId,
      handle.name,
      handle.version,
    );
    if (!raw) {
      return {
        markdown: `Tour ${handle.name} has no content.`,
        json: { written: false },
      };
    }
    const tour = JSON.parse(new TextDecoder().decode(raw)) as Tour;

    const settings = ReportSettingsSchema.parse(context.globalArgs);
    const paths = tourPagePaths(settings, tour);
    const html = renderTourPage(tour, settings);
    await Deno.mkdir(paths.dir, { recursive: true });
    await Deno.writeTextFile(paths.versioned, html);
    await Deno.writeTextFile(paths.latest, html);
    context.logger?.info?.("Wrote tour page for #{pr} to {path}", {
      pr: tour.prNumber,
      path: paths.latest,
    });

    return {
      markdown:
        `# Tour of #${tour.prNumber}\n\n${tour.stops.length} stops. Open ${paths.url}\n\nWritten to \`${paths.versioned}\`.\n`,
      json: {
        written: true,
        prNumber: tour.prNumber,
        headSha: tour.headSha,
        ...paths,
      },
    };
  },
};
