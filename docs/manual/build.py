#!/usr/bin/env python3
"""Builds manual/index.html: every source file side by side with a note per block.

Run it from anywhere:   python3 manual/build.py

Notes live in manual/notas/*.json, one file per source file:
  { "file": "bot.ts",
    "blocks": [ { "from": 1, "to": 5, "note": "what this chunk is for" }, ... ],
    "lines":  { "7": "what this single line does", ... } }

Every line of every listed file must be covered by exactly one block, and every
line that holds real code needs its own entry in "lines". Blank lines get nothing
and a lone closing bracket is labelled automatically. The build refuses to write
the page when a block is missing, and prints how many line notes are still owed.
"""
import html
import json
import re
import urllib.parse
import os
import sys

MANUAL = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(MANUAL))    # o manual mora em docs/manual: a raiz do projeto fica dois níveis acima

# the groups and order of the sidebar, matching the floorplan map
GROUPS = [
    ("Slack door", ["bot.ts"]),
    ("The brain", ["harness/agente.ts", "harness/agentes.ts"]),
    ("Tool menu", ["harness/ferramentas.ts"]),
    ("Answer checker", ["harness/verificador.ts"]),
    ("The outside world", ["voos.ts", "planilha.ts"]),
    ("Storage", ["harness/dados.ts"]),
    ("Price watcher", ["harness/monitor.ts"]),
    ("Black box", ["harness/rastreio.ts"]),
    ("Quality harness", ["teste.ts", "harness/avaliar.ts", "harness/cenarios.ts",
                         "harness/comparar.ts", "harness/aprender.ts"]),
    ("Learning exercises", ["grafo.ts", "ola.ts"]),
]


def load_notes():
    notes = {}
    folder = os.path.join(MANUAL, "notas")
    for name in sorted(os.listdir(folder)):
        if not name.endswith(".json"):
            continue
        data = json.load(open(os.path.join(folder, name), encoding="utf8"))
        notes[data["file"]] = (
            sorted(data["blocks"], key=lambda b: b["from"]),
            {int(k): v for k, v in data.get("lines", {}).items()},
        )
    return notes


def fecha(lines, n):
    """A lone closing bracket: say which line opened the block, found by indent."""
    text = lines[n - 1]
    indent = len(text) - len(text.lstrip())
    for i in range(n - 2, -1, -1):
        other = lines[i]
        if not other.strip():
            continue
        if len(other) - len(other.lstrip()) == indent:
            return f"ends what line {i + 1} opened"
        if len(other) - len(other.lstrip()) < indent:
            break
    return ""


SO_FECHA = re.compile(r"^[})\];,]+$")


def line_note(lines, n, written):
    """The note under one line: hand written, automatic for a bracket, or none."""
    if n in written:
        return written[n]
    text = lines[n - 1].strip()
    if not text:
        return ""
    if SO_FECHA.match(text):
        return fecha(lines, n)
    return ""


def check(path, blocks, lines):
    """Every line covered exactly once, no overlap, nothing past the end."""
    problems = []
    expected = 1
    for b in blocks:
        if b["from"] != expected:
            problems.append(f"{path}: lines {expected}-{b['from'] - 1} have no note"
                            if b["from"] > expected else
                            f"{path}: block at line {b['from']} overlaps the one before it")
        expected = b["to"] + 1
    if expected != lines + 1:
        problems.append(f"{path}: lines {expected}-{lines} have no note"
                        if expected <= lines else
                        f"{path}: a note runs past the end of the file ({lines} lines)")
    return problems


def render_file(path, blocks, source, written):
    lines = source.split("\n")
    absolute = os.path.join(ROOT, path)
    # the project folder has spaces and <> in its name, so the link needs encoding
    link = "vscode://file" + urllib.parse.quote(absolute, safe="/:")
    rows = []
    for b in blocks:
        code = []
        for n in range(b["from"], b["to"] + 1):
            text = html.escape(lines[n - 1]) or "&nbsp;"
            code.append(
                f'<div class="ln"><a class="n" href="{link}:{n}" '
                f'title="open line {n} in VS Code">{n}</a><code>{text}</code></div>'
            )
            note = line_note(lines, n, written)
            if note:
                code.append(f'<div class="lnote">{html.escape(note)}</div>')
        rows.append(
            f'<div class="blk" id="{html.escape(path)}-{b["from"]}">'
            f'<div class="note">{html.escape(b["note"])}</div>'
            f'<div class="code">{"".join(code)}</div></div>'
        )
    return (
        f'<section class="file" id="f-{html.escape(path)}" hidden>'
        f'<header class="fh"><h2>{html.escape(path)}</h2>'
        f'<a class="vs" href="{link}:1">Open in VS Code</a>'
        f'<span class="cnt">{len(lines)} lines, {len(blocks)} blocks</span></header>'
        f'{"".join(rows)}</section>'
    )


CSS = """
/* the Floorplan palette, so the manual and the map look like one thing */
:root{--bg:#0f0f0f;--surface:#191919;--surface-hover:#1e1e1e;--raise:#232323;
--hair:rgba(255,255,255,.06);--hair-2:rgba(255,255,255,.1);--well:rgba(0,0,0,.3);
--text:#ececec;--text-2:#b4b4b4;--text-3:#8b8b8b;--text-4:#5c5c5c;--accent:#b49cff;
--mono:"JetBrains Mono",ui-monospace,"Cascadia Code","SF Mono",Consolas,monospace;
--sans:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
--r-card:20px;--r-ctl:12px;color-scheme:dark}
:root[data-theme=light]{--bg:#f3f3f1;--surface:#fff;--surface-hover:#fbfbfa;--raise:#ebebe8;
--hair:rgba(0,0,0,.09);--hair-2:rgba(0,0,0,.15);--well:rgba(0,0,0,.06);
--text:#161616;--text-2:#3f3f3f;--text-3:#595959;--text-4:#666;--accent:#5b3fd6;color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14.5px/1.65 var(--sans);
-webkit-font-smoothing:antialiased}
#wrap{display:grid;grid-template-columns:272px minmax(0,1fr);min-height:100vh}
#side{border-right:1px solid var(--hair);background:var(--surface);padding:20px 0 48px;
position:sticky;top:0;height:100vh;overflow:auto}
#side h1{font-size:15px;margin:0 18px 5px;letter-spacing:-.01em}
#side p{margin:0 18px 14px;font-size:12.5px;color:var(--text-3);line-height:1.5}
#q{width:calc(100% - 36px);margin:0 18px 10px;padding:8px 11px;font:13px var(--sans);
border:1px solid var(--hair-2);border-radius:var(--r-ctl);background:var(--well);color:var(--text)}
#q:focus{outline:none;border-color:var(--accent)}
#theme{margin:0 18px 4px;font:12.5px var(--sans);color:var(--text-2);background:var(--surface);
cursor:pointer;border:1px solid var(--hair-2);padding:4px 11px;border-radius:999px}
#theme:hover{color:var(--accent);border-color:var(--accent)}
.grp{font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--text-4);
margin:18px 18px 6px}
#side a.f{display:flex;justify-content:space-between;gap:8px;padding:6px 18px;
font:13px var(--mono);color:var(--text-2);text-decoration:none}
#side a.f:hover{background:var(--surface-hover);color:var(--text)}
#side a.f.on{color:var(--accent);background:var(--surface-hover);box-shadow:inset 2px 0 var(--accent)}
#side a.f span{color:var(--text-4);font-size:11.5px}
main{padding:0 0 60vh}
.fh{position:sticky;top:0;z-index:2;background:rgba(15,15,15,.92);backdrop-filter:blur(8px);
border-bottom:1px solid var(--hair);padding:17px 26px;display:flex;gap:14px;
align-items:center;flex-wrap:wrap}
:root[data-theme=light] .fh{background:rgba(243,243,241,.92)}
.fh h2{font:600 16px/1.3 var(--mono);margin:0;letter-spacing:-.01em}
.vs{font:12.5px var(--sans);color:var(--text-2);text-decoration:none;border:1px solid var(--hair-2);
padding:4px 11px;border-radius:999px;background:var(--surface)}
.vs:hover{color:var(--accent);border-color:var(--accent)}
.cnt{font-size:12px;color:var(--text-4);margin-left:auto}
.blk{display:grid;grid-template-columns:minmax(0,36%) minmax(0,64%);gap:22px;
padding:18px 26px;border-bottom:1px solid var(--hair);align-items:start}
.blk:target .code{box-shadow:0 0 0 1px var(--accent)}
.note{font-size:13.5px;line-height:1.7;color:var(--text-2);position:sticky;top:70px}
.code{background:var(--surface);border:1px solid var(--hair);border-radius:var(--r-card);
padding:10px 0;overflow-x:auto;box-shadow:0 12px 32px -20px rgba(0,0,0,.95)}
.ln{display:flex;font:12.5px/1.7 var(--mono);white-space:pre}
.ln:hover{background:var(--surface-hover)}
a.n{flex:0 0 50px;text-align:right;padding-right:14px;color:var(--text-4);text-decoration:none;
user-select:none;font-variant-numeric:tabular-nums}
a.n:hover{color:var(--accent)}
.code code{color:var(--text);padding-right:18px;tab-size:4}
.lnote{font:11.5px/1.6 var(--sans);color:var(--text-3);padding:2px 18px 7px 64px;
max-width:78ch;white-space:normal}
.lnote::before{content:"↳ ";color:var(--text-4)}
#hint{padding:30px 26px;color:var(--text-3);font-size:13.5px;max-width:62ch}
@media(max-width:860px){#wrap{grid-template-columns:1fr}
#side{position:static;height:auto;border-right:0;border-bottom:1px solid var(--hair)}
.blk{grid-template-columns:1fr;gap:12px}.note{position:static}}
"""

JS = """
const files=[...document.querySelectorAll('section.file')];
const links=[...document.querySelectorAll('#side a.f')];
function show(id){
 files.forEach(f=>f.hidden=f.id!=='f-'+id);
 links.forEach(a=>a.classList.toggle('on',a.dataset.f===id));
 document.getElementById('hint').hidden=true;
 try{localStorage.setItem('manual-file',id)}catch(e){}
}
links.forEach(a=>a.onclick=e=>{e.preventDefault();show(a.dataset.f);scrollTo(0,0);
 history.replaceState(null,'','#'+a.dataset.f)});
document.getElementById('q').oninput=e=>{
 const t=e.target.value.toLowerCase();
 links.forEach(a=>a.hidden=!a.dataset.f.toLowerCase().includes(t));
};
// the theme follows the floorplan's own choice, kept under the same key
const T=document.getElementById('theme');
function theme(v){document.documentElement.dataset.theme=v;T.textContent=v==='light'?'Dark':'Light';
 try{localStorage.setItem('fp-theme',v)}catch(e){}}
let saved='dark';try{saved=localStorage.getItem('fp-theme')||'dark'}catch(e){}
theme(saved);
T.onclick=()=>theme(document.documentElement.dataset.theme==='light'?'dark':'light');
addEventListener('hashchange',()=>{const h=decodeURIComponent(location.hash.slice(1));
 if(files.some(f=>f.id==='f-'+h))show(h)});
let start=decodeURIComponent(location.hash.slice(1));
if(!files.some(f=>f.id==='f-'+start)){try{start=localStorage.getItem('manual-file')||''}catch(e){start=''}}
if(files.some(f=>f.id==='f-'+start))show(start);
"""



FLOORPLAN = os.path.join(ROOT, "floorplan")
MARK = "<!-- manual-link -->"

# Injected into floorplan/index.html: it turns the "N lines" stat on a file card into a
# button that opens this manual in a dialog over the map, so there is one interface and
# the map keeps its state. It matches on the file paths it is given rather than on the
# viewer's own markup, so a floorplan update cannot break it quietly. Rerun this build
# after every floorplan rebuild, since that rewrites index.html.
INJECT = MARK + """<style>
#manual{border:0;padding:0;width:min(1180px,94vw);height:92vh;max-width:none;max-height:none;
 background:var(--modal-bg);color:var(--text);border-radius:var(--r-panel);overflow:hidden;
 box-shadow:0 40px 90px -40px rgba(0,0,0,.9)}
#manual::backdrop{background:var(--scrim-2);backdrop-filter:blur(4px)}
#manual .bar{display:flex;align-items:center;gap:14px;height:42px;padding:0 16px;
 border-bottom:1px solid var(--hair);font:12.5px/1 var(--mono);color:var(--text-3)}
#manual .bar b{color:var(--text);font-weight:500}
#manual .bar .sp{margin-left:auto}
#manual .bar a,#manual .bar button{color:var(--text-3);background:none;border:0;padding:0;
 font:inherit;cursor:pointer;text-decoration:none}
#manual .bar a:hover,#manual .bar button:hover{color:var(--accent)}
#manual iframe{display:block;width:100%;height:calc(92vh - 43px);border:0;background:var(--bg)}
</style>
<script>
(() => {
  const FILES = __FILES__;
  let dlg;
  // the manual opens over the map instead of replacing it, so the map keeps its state
  const open = (path) => {
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'manual';
      dlg.innerHTML = '<div class="bar"><b></b><span>line by line, every block explained</span>'
        + '<span class="sp"></span><a target="_blank" rel="noreferrer">new tab</a>'
        + '<button aria-label="close">close</button></div>'
        + '<iframe title="code manual"></iframe>';
      dlg.querySelector('button').onclick = () => dlg.close();
      dlg.onclick = (e) => { if (e.target === dlg) dlg.close(); };
      document.body.appendChild(dlg);
    }
    const href = 'manual.html#' + encodeURIComponent(path);
    dlg.querySelector('b').textContent = path;
    dlg.querySelector('a').href = href;
    // reloading beats poking the frame's hash: it also works when opened straight from disk
    dlg.querySelector('iframe').src = href;
    if (!dlg.open) dlg.showModal();
  };
  const NODES = __NODES__;
  // the panel never prints a path, so the file is read off the markup: the panel's own
  // path box first, then its file rows, then the module rows of a group panel
  const pick = (panel) => {
    const own = panel.querySelector('[data-copy]');
    if (own && FILES.includes(own.dataset.copy)) return own.dataset.copy;
    for (const row of panel.querySelectorAll('[data-go^="f:"]')) {
      const path = row.dataset.go.slice(2);
      if (FILES.includes(path)) return path;
    }
    for (const row of panel.querySelectorAll('[data-go^="n:"]')) {
      const path = NODES[row.dataset.go.slice(2)];
      if (path) return path;
    }
    return '';
  };
  const wire = () => {
    for (const stat of document.querySelectorAll('.stats div')) {
      if (stat.dataset.manual) continue;
      const label = stat.querySelector('span');
      if (!label || label.textContent !== 'lines') continue;
      // the overview stat belongs to no panel: it opens the manual at its first file
      const panel = stat.closest('#panel');
      const path = panel ? pick(panel) : FILES[0];
      if (!path) continue;
      stat.dataset.manual = path;
      stat.style.cursor = 'pointer';
      stat.title = 'Open the code of this part, line by line, with a note on every line';
      stat.querySelector('b').style.color = 'var(--k-call)';
      label.textContent = 'lines, explained';
      stat.onclick = () => open(path);
    }
  };
  new MutationObserver(wire).observe(document.body, { childList: true, subtree: true });
  wire();
})();
</script>
"""


def publish(page, listed):
    """Copy the page next to the floorplan and link the map's line counts to it."""
    if not os.path.isdir(FLOORPLAN):
        return "no floorplan/ folder, so only manual/index.html was written"
    open(os.path.join(FLOORPLAN, "manual.html"), "w", encoding="utf8").write(page)
    index = os.path.join(FLOORPLAN, "index.html")
    if not os.path.exists(index):
        return "floorplan/index.html missing: run the floorplan build, then this one again"
    arch = json.load(open(os.path.join(FLOORPLAN, "architecture.json"), encoding="utf8"))
    nodes = {}
    for node in arch["nodes"]:
        own = [p for p in node.get("paths", []) if p in listed]
        if own:
            nodes[node["id"]] = own[0]
    html = open(index, encoding="utf8").read().split(MARK)[0]
    script = (INJECT.replace("__FILES__", json.dumps(listed))
                    .replace("__NODES__", json.dumps(nodes)))
    open(index, "w", encoding="utf8").write(html + script)
    return "floorplan/manual.html written, and the map's line counts now open it in place"


def main():
    notes = load_notes()
    listed = [p for _, paths in GROUPS for p in paths]
    missing = [p for p in listed if p not in notes]
    if missing:
        sys.exit("no notes for: " + ", ".join(missing))

    problems, sections, sidebar = [], [], []
    owed, done = 0, 0
    for group, paths in GROUPS:
        sidebar.append(f'<div class="grp">{html.escape(group)}</div>')
        for path in paths:
            source = open(os.path.join(ROOT, path), encoding="utf8").read().rstrip("\n")
            lines = source.split("\n")
            total = len(lines)
            blocks, written = notes[path]
            problems += check(path, blocks, total)
            for n in range(1, total + 1):
                text = lines[n - 1].strip()
                if not text or SO_FECHA.match(text):
                    continue
                owed += 1
                done += 1 if n in written else 0
            sections.append(render_file(path, blocks, source, written))
            sidebar.append(
                f'<a class="f" href="#{html.escape(path)}" data-f="{html.escape(path)}">'
                f'{html.escape(path)}<span>{total}</span></a>'
            )

    if problems:
        print("\n".join(problems))
        sys.exit(f"\n{len(problems)} gap(s): every line needs exactly one note. Page not written.")

    page = f"""<!doctype html>
<html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Code manual</title>
<style>{CSS}</style>
<body><div id="wrap">
<nav id="side"><h1>Code manual</h1>
<p>Bot de Passagens, line by line. Click a line number to open it in VS Code.</p>
<input id="q" placeholder="filter files" autocomplete="off">
<button id="theme">Light</button>
{''.join(sidebar)}</nav>
<main><div id="hint">Pick a file on the left. Each block of code sits next to a note
saying what it does, why it is there, and where the names it uses are defined.</div>
{''.join(sections)}</main>
</div><script>{JS}</script></body></html>"""

    out = os.path.join(MANUAL, "index.html")
    open(out, "w", encoding="utf8").write(page)
    blocks = sum(len(notes[p][0]) for p in listed)
    total_lines = sum(len(open(os.path.join(ROOT, p), encoding="utf8").read().rstrip("\n").split("\n")) for p in listed)
    print(f"wrote {out}\n{len(listed)} files, {total_lines} lines, {blocks} block notes")
    if done == owed:
        print(f"every one of the {owed} code lines has its own note too")
    else:
        print(f"line notes: {done} of {owed} written, {owed - done} still owed")
        for group, paths in GROUPS:
            for path in paths:
                src = open(os.path.join(ROOT, path), encoding="utf8").read().rstrip("\n").split("\n")
                left = [n for n in range(1, len(src) + 1)
                        if src[n - 1].strip() and not SO_FECHA.match(src[n - 1].strip())
                        and n not in notes[path][1]]
                if left:
                    print(f"  {path}: {len(left)} lines, first at {left[0]}")
    print(publish(page, listed))


if __name__ == "__main__":
    main()
