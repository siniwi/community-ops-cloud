#!/usr/bin/env python3
"""Suggested tab of the feedback tracker: new player reports waiting to be sorted, and the sorted ones.

  python intake.py <drops_dir> <out_ops_dir>

Free part, every Actions run (no Claude here):
- Candidates: Steam reviews (trends_bundle.json -> reviews_history.json, with the author's review link), Reddit posts
  and Steam forum threads (digest_cloud.json) from the last WINDOW_DAYS days. Posts by Hirad or the team are left out.
- <drops_dir>/tracker_intake_todo.json: the candidates from the last TODO_DAYS days that have no label yet, newest
  first, at most TODO_CAP. The weekday morning Claude run reads it, sorts and translates each one, and saves its
  answers as tracker_ops/labels-<when>.json on Drive (format below).
- <out_ops_dir>/suggest.json: one "suggest" op per labelled report that is a bug, feedback or request, joined
  with the candidate's text, link and stats. build_ops.py bundles it; functions/api/tracker.js stores it once.

Labels file: a JSON list (or {"labels": [...]}) of
  {"sid", "skip": true}                                           not a bug, feedback or request
  {"sid", "kind": "Bug"|"Feedback"|"Request", "area", "issue", "en", "sent", "part"?}
issue = a short neutral English line, worded the same for reports about the same thing; en = English translation
("" when the text is English); sent = positive|neutral|negative; part = 2, 3... when one post holds several issues
(en only needed on the first part); lang = the post's language for Reddit / forum posts that aren't in English.
"""
import datetime, glob, json, os, sys

WINDOW_DAYS, TODO_DAYS, TODO_CAP = 10, 4, 150
REVIEW_URL = "https://steamcommunity.com/profiles/{a}/recommended/714010/"
KINDS = ("Bug", "Feedback", "Request")


def load(path, default=None):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def iso(ts):
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).isoformat(timespec="minutes")


def parse(s):
    try:
        t = datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
        return t if t.tzinfo else t.replace(tzinfo=datetime.timezone.utc)
    except ValueError:
        return None


def candidates(drops, since):
    out = []
    bundle = load(os.path.join(drops, "trends_bundle.json"), {}) or {}
    hist = (bundle.get("files") or {}).get("reviews_history.json") or load(os.path.join(drops, "reviews_history.json"), {}) or {}
    for r in hist.get("reviews", []):
        text = (r.get("t") or "").strip()
        if r.get("c", 0) < since.timestamp() or len(text) < 15:
            continue
        out.append({"sid": f"steam-review-{r['id']}", "source": "Steam review", "url": REVIEW_URL.format(a=r["a"]) if r.get("a") else "",
                    "posted_at": iso(r["c"]), "lang": r.get("lang", ""), "text": text[:1500], "voted_up": bool(r.get("up")),
                    "playtime_h": r.get("pt"), "platforms": ["Steam"]})
    digest = load(os.path.join(drops, "digest_cloud.json"), {}) or {}
    for p in digest.get("reddit", []):
        t = parse(p.get("created"))
        if not t or t < since or p.get("revived") or p.get("team_op"):
            continue
        out.append({"sid": f"reddit-{p['id']}", "source": "Reddit", "url": p.get("url", ""), "posted_at": t.isoformat(timespec="minutes"),
                    "lang": "", "title": p.get("title", ""), "author": p.get("author", ""),
                    "text": "\n".join(x for x in (p.get("title"), p.get("excerpt")) if x)[:1500]})
    for p in digest.get("steam_forum", []):
        t = parse(p.get("created"))
        if not t or t < since or p.get("revived") or p.get("team_op"):
            continue
        out.append({"sid": f"steam-forum-{p['id']}", "source": "Steam forum", "url": p.get("url", ""), "posted_at": t.isoformat(timespec="minutes"),
                    "lang": "", "title": p.get("title", ""), "author": p.get("author", ""), "platforms": ["Steam"],
                    "text": "\n".join(x for x in (p.get("title"), p.get("excerpt")) if x)[:1500]})
    team = {str(x).lower() for x in ((digest.get("team") or {}).get("reddit") or []) + ["syntensity"]}
    return [c for c in out if (c.get("author") or "").lower() not in team]


def labels(drops):
    got = {}
    for p in sorted(glob.glob(os.path.join(drops, "tracker_ops", "labels-*.json"))):
        d = load(p)
        rows = d.get("labels", []) if isinstance(d, dict) else d if isinstance(d, list) else []
        if d is None:
            print(f"::warning::{os.path.basename(p)} is not valid JSON; skipped")
        for x in rows:
            if isinstance(x, dict) and x.get("sid"):
                got.setdefault(x["sid"], []).append(x)
    return got


def main(drops, out_dir):
    now = datetime.datetime.now(datetime.timezone.utc)
    cands = {c["sid"]: c for c in candidates(drops, now - datetime.timedelta(days=WINDOW_DAYS))}
    lab = labels(drops)
    ops, missing = [], 0
    for sid, rows in lab.items():
        c = cands.get(sid)
        if not c:
            missing += 1  # older than the window: stored already on an earlier run
            continue
        en = next((x.get("en") for x in rows if x.get("en")), "")
        for x in rows:
            if x.get("skip") or x.get("kind") not in KINDS:
                continue
            part = int(x.get("part") or 1)
            item = dict(c, sid=sid if part == 1 else f"{sid}#{part}", kind=x["kind"], area=x.get("area", ""), lang=c.get("lang") or x.get("lang", ""),
                        issue=x.get("issue", ""), english=x.get("en") or en, sentiment=x.get("sent", "neutral"))
            ops.append({"op_id": "suggest-" + item["sid"], "type": "suggest", "at": c["posted_at"], "item": item})
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "suggest.json"), "w", encoding="utf-8") as fh:
        json.dump({"ops": ops}, fh, ensure_ascii=False)
    cutoff = (now - datetime.timedelta(days=TODO_DAYS)).isoformat(timespec="minutes")
    todo = sorted((c for c in cands.values() if c["sid"] not in lab and c["posted_at"] >= cutoff), key=lambda c: c["posted_at"], reverse=True)
    left = max(0, len(todo) - TODO_CAP)
    keep = ("sid", "source", "posted_at", "lang", "title", "text", "voted_up", "playtime_h")
    with open(os.path.join(drops, "tracker_intake_todo.json"), "w", encoding="utf-8") as fh:
        json.dump({"generated_at": now.isoformat(timespec="minutes"), "left_for_next_run": left,
                   "items": [{k: c[k] for k in keep if c.get(k) not in (None, "")} for c in todo[:TODO_CAP]]}, fh, ensure_ascii=False)
    print(f"intake: {len(cands)} recent reports, {len(lab)} labelled, {len(ops)} suggestions, {min(len(todo), TODO_CAP)} to sort"
          + (f" (+{left} next run)" if left else ""))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(*sys.argv[1:])
