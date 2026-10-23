#!/usr/bin/env python3
"""Put the same page menu at the top of every team-site page, so Trends, Inbox and Tracker are one tap apart.

  python site_nav.py <site_dir>

Runs after the site is built (run.sh). The Trends and Inbox pages come from the Drive kit and the tracker
from this repo; each gets the menu inserted before its first layout block, with the page itself marked as
current. The old one-off "Trends" / "Inbox" links in those page headers are taken out. Running it twice
changes nothing. A page that is missing or has an unexpected layout is skipped with a warning.
"""
import os, re, sys

# (label, path, icon) in menu order. Icons are Phosphor bold paths (256 viewBox), same set as the pages use.
PAGES = [
    ("Trends", "/trends/", "M236,208a12,12,0,0,1-12,12H32a12,12,0,0,1-12-12V48a12,12,0,0,1,24,0v99l43.51-43.52a12,12,0,0,1,17,0L128,127l43-43H160a12,12,0,0,1,0-24h40a12,12,0,0,1,12,12v40a12,12,0,0,1-24,0V101l-51.51,51.52a12,12,0,0,1-17,0L96,129,44,181v15H224A12,12,0,0,1,236,208Z"),
    ("Inbox", "/inbox/", "M208,28H48A20,20,0,0,0,28,48V208a20,20,0,0,0,20,20H208a20,20,0,0,0,20-20V48A20,20,0,0,0,208,28Zm-4,24v92H179.31a19.86,19.86,0,0,0-14.14,5.86L147,168H109L90.83,149.86A19.86,19.86,0,0,0,76.69,144H52V52ZM52,204V168H75l18.14,18.14A19.86,19.86,0,0,0,107.31,192h41.38a19.86,19.86,0,0,0,14.14-5.86L181,168h23v36Z"),
    ("Tracker", "/tracker/", "M230.47,67.5a12,12,0,0,0-19.26-4.32L172.43,99l-12.68-2.72L157,83.57l35.79-38.78a12,12,0,0,0-4.32-19.26A76.07,76.07,0,0,0,88.41,121.64L30.92,174.18a4.68,4.68,0,0,0-.39.38,36,36,0,0,0,50.91,50.91l.38-.39,52.54-57.49A76.05,76.05,0,0,0,230.47,67.5ZM160,148a51.5,51.5,0,0,1-23.35-5.52,12,12,0,0,0-14.26,2.62L64.31,208.66a12,12,0,0,1-17-17l63.55-58.07a12,12,0,0,0,2.62-14.26A51.5,51.5,0,0,1,108,96a52.06,52.06,0,0,1,52-52h.89L135.17,71.87a12,12,0,0,0-2.91,10.65l5.66,26.35a12,12,0,0,0,9.21,9.21l26.35,5.66a12,12,0,0,0,10.65-2.91L212,95.12c0,.3,0,.59,0,.89A52.06,52.06,0,0,1,160,148Z"),
]
# page file -> the first layout block; the menu goes right before it
TARGETS = {"trends/index.html": '<div class="shell">', "inbox/index.html": '<div class="wrap">', "tracker/index.html": '<div class="wrap">'}
# header links the menu replaces (the Inbox's own Trends link stays in the page for its script, hidden by CSS)
OLD_LINKS = [r'\s*<a class="qlink" href="\.\./inbox/">Inbox</a>']
# small layout fixes per page: the Inbox grid let wide rows push the page past a phone screen
FIXES = {"inbox/index.html": "<style>.wrap{grid-template-columns:minmax(0,1fr)}.navrow .tabs{min-width:0;max-width:100%;overflow-x:auto;scrollbar-width:none}</style>"}
MARK = "<!--sitenav-->"
CSS = """<style>
.sitenav{display:flex;justify-content:center;margin:0 auto 14px;padding:8px 12px 0}
.sitenav .sn{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:2px;width:min(420px,100%);padding:3px;border-radius:13px;
  background:#0a0f1d;box-shadow:0 0 0 1px #26324f,0 6px 18px -6px rgb(0 0 0/.7)}
.sitenav a{height:38px;display:inline-flex;align-items:center;justify-content:center;gap:7px;border-radius:10px;color:#9ba6c2;text-decoration:none;
  font:700 14px "Play",ui-sans-serif,system-ui,sans-serif;transition:background-color 150ms ease,color 150ms ease}
.sitenav a svg{flex:none;color:#5fe1e0}
.sitenav a[aria-current="page"]{background:#1f2a45;color:#eef2fb;box-shadow:inset 0 0 0 1px #5a6a94}
.sitenav a:focus-visible{outline:2px solid #47d8d7;outline-offset:2px}
#trends-link{display:none!important}
@media (hover:hover) and (pointer:fine){.sitenav a:not([aria-current]):hover{color:#eef2fb;background:#172036}}
@media (prefers-reduced-motion:reduce){.sitenav a{transition:none}}
</style>"""


def nav(current):
    here = ' aria-current="page"'
    links = "".join(
        f'<a href="{path}"{here if path == current else ""}>'
        f'<svg width="16" height="16" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="{icon}"/></svg>{label}</a>'
        for label, path, icon in PAGES)
    return f'{MARK}{CSS}<nav class="sitenav" aria-label="Team site pages"><div class="sn">{links}</div></nav>\n'


def main(site):
    for rel, anchor in TARGETS.items():
        p = os.path.join(site, rel)
        try:
            with open(p, encoding="utf-8") as fh:
                html = fh.read()
        except OSError:
            print(f"::warning::site_nav: {rel} not found; no menu there")
            continue
        if MARK in html:
            continue
        if anchor not in html:
            print(f"::warning::site_nav: {rel} has no {anchor}; no menu there")
            continue
        for rx in OLD_LINKS:
            html = re.sub(rx, "", html, count=1)
        html = html.replace(anchor, nav("/" + rel.split("/")[0] + "/") + FIXES.get(rel, "") + anchor, 1)
        with open(p, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(html)
        print(f"site_nav: menu added to {rel}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
