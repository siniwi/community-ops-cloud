#!/usr/bin/env python3
"""One-off import of the Feedback tab of "Community Taskforce Dashboard Sheet" (.xlsx export) into tracker ops.

  python import_feedback_tab.py <sheet.xlsx> <tracker_seed.json> <out.json>
  python import_feedback_tab.py --details <sheet.xlsx> <tracker_seed.json> <out.json>

--details writes "more" ops instead: the date, text and link of each row folded into an entry, so the tracker can
list every report on its own. A row with the same link, or the same day and wording, as an earlier row of its
entry is marked same (the same player logged twice; counted once).

Columns: Type (Feedback / Feature Request), Summary, Platform, Category, Date, Link. Type becomes kind, Category
becomes area, Platform becomes platforms. Every entry lands in Backlog. Rows with the same link or the same summary
become one entry with the other rows as extra reports. A row whose link is already in the tracker (tracker_seed.json,
the first sheet's import) only adds its platforms and area to that entry. Undated Discord rows take the date from
the message link (Discord ids carry their timestamp). Ids come from the row (f-feedback-12), so importing again
changes nothing. Needs openpyxl.
"""
import datetime, json, re, sys
import openpyxl

from import_sheet import URL, source_of, title_of

KIND = {"Feature Request": "Request", "Feedback": "Feedback", "Bug": "Bug"}
PLATFORM = {"steam": "Steam", "epic": "Epic", "xbox": "Xbox", "playstation": "PlayStation", "android": "Android", "ios": "iOS"}
# Category -> tracker area (same names as AREAS in tracker/index.html). "General" is left empty so the page guesses.
AREA = {
    "Settings": "Settings & visuals", "Player Avatars": "Account & profile", "Profile": "Account & profile",
    "Game Profile Request": "Game profiles & sens", "Sens Finder": "Game profiles & sens",
    "Benchmarks": "Benchmarks & ranked", "Ranked": "Benchmarks & ranked", "Leaderboards": "Leaderboards", "1v1": "PvP & 1v1",
    "Gameplay": "Gameplay & weapons", "Weapon Customization": "Gameplay & weapons", "Skins": "Gameplay & weapons", "Bot Behavior": "Gameplay & weapons",
    "Training Programs": "Training programs", "Academy": "Training programs",
    "Playlists": "Playlists & tasks", "Custom Tasks": "Playlists & tasks", "Training Browser": "Playlists & tasks",
    "Discovery": "Playlists & tasks", "Adaptive Tasks": "Playlists & tasks",
    "Creator Studio": "Creator Studio", "Task Tuning": "Creator Studio",
    "Results Screen": "Results & replays", "Watch Tab": "Results & replays", "Replays": "Results & replays",
    "Aimlabs+": "Store & Aimlabs+", "Shop": "Store & Aimlabs+", "Battle Pass": "Store & Aimlabs+", "Aimlabs+ Chat": "Coach & AI",
    "UI": "UI & navigation", "Performance": "Crashes & performance", "Controller": "Controller",
    "Aimlabs vs Kovaaks": "Other", "Aimlabs Mobile": "Other", "General": "",
}
BY = "Imported from the Feedback tab"
# Game profile requests for the same game are one entry with several reports.
ASKS_PROFILE = re.compile(r"\b(profiles?|presets?|conversion)\b", re.I)
GAMES = [("Delta Force", r"delta ?force"), ("Roblox Rivals", r"roblox\W*rivals|rivals\W*\(?roblox|roblox game \(rivals"),
         ("Deadlock", r"deadlock"), ("Arena Breakout", r"arena breakout"), ("Blood Strike", r"blood ?strike"),
         ("FragPunk", r"frag ?punk"), ("The Finals", r"the finals"), ("Strinova", r"strinova"), ("Battlefield", r"battlefield|\bbf6\b"),
         ("Marvel Rivals", r"marvel rivals"), ("Overwatch 2", r"overwatch"), ("Valorant Mobile", r"valorant mobile"),
         ("Stalcraft", r"stalcraft"), ("Murder Duels", r"murder\w* duels"),
         ("Black Ops 6", r"black ops 6|\bbo6\b"), ("Sniper Duels", r"sniper duels")]


def game_of(text):
    if not ASKS_PROFILE.search(text):
        return ""
    return next((g for g, rx in GAMES if re.search(rx, text, re.I)), "")


def norm_url(u):
    return u.strip().rstrip("/").replace("://old.reddit.com", "://www.reddit.com").lower()


def discord_date(urls):
    for u in urls:
        m = re.search(r"discord\.com/channels/\d+/\d+/(\d{17,20})", u)
        if m:
            ms = (int(m.group(1)) >> 22) + 1420070400000
            return datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).date().isoformat()
    return ""


def read_rows(path):
    ws = openpyxl.load_workbook(path)["Feedback"]
    rows = []
    for r in ws.iter_rows(min_row=2):
        v = [c.value for c in r]
        text = " ".join(str(v[1] or "").split())
        link_cell = str(v[5] or "").strip()
        if not text or "fakelink" in link_cell:
            continue
        urls = URL.findall(link_cell)
        if r[5].hyperlink and r[5].hyperlink.target and r[5].hyperlink.target not in urls:
            urls.insert(0, r[5].hyperlink.target)
        where = URL.sub("", link_cell).strip()
        cats = [c.strip() for c in str(v[3] or "").split(",") if c.strip()]
        plats = []
        for p in str(v[2] or "").split(","):
            p = PLATFORM.get(p.strip().lower())
            if p and p not in plats:
                plats.append(p)
        posted, from_link = "", False
        if isinstance(v[4], datetime.datetime):
            posted = v[4].date().isoformat()
        elif discord_date(urls):
            posted, from_link = discord_date(urls), True
        rows.append({"row": r[0].row, "kind": KIND.get(str(v[0] or "").strip(), "Feedback"), "text": text, "urls": urls,
                     "where": where, "cats": cats, "plats": plats, "posted": posted, "from_link": from_link})
    return rows


def group(rows):
    """Union rows that share a link, the exact same summary or a game profile request; first row (earliest date) leads."""
    parent = list(range(len(rows)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    seen = {}
    for i, r in enumerate(rows):
        keys = [("u", norm_url(u)) for u in r["urls"]] + [("t", r["text"].lower())]
        if game_of(r["text"]):
            keys.append(("g", game_of(r["text"])))
        for key in keys:
            if key in seen:
                parent[find(i)] = find(seen[key])
            else:
                seen[key] = i
    groups = {}
    for i in range(len(rows)):
        groups.setdefault(find(i), []).append(rows[i])
    return [sorted(g, key=lambda r: (r["posted"] or "9999", r["row"])) for g in groups.values()]


def main(path, seed_path, out):
    now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    seed = json.load(open(seed_path, encoding="utf-8"))["ops"]
    known = {}
    for op in seed:
        e = op["entry"]
        for u in [e.get("url")] + (e.get("links") or []):
            if u:
                known[norm_url(u)] = e["id"]
    ops, merged, updated = [], 0, 0
    for g in group(read_rows(path)):
        lead = g[0]
        urls = []
        for r in g:
            for u in r["urls"]:
                if norm_url(u) not in {norm_url(x) for x in urls}:
                    urls.append(u)
        plats = [p for p in PLATFORM.values() if any(p in r["plats"] for r in g)]
        area = next((AREA.get(c, "") for c in lead["cats"] if AREA.get(c, "")), "")
        hit = next((known[norm_url(u)] for u in urls if norm_url(u) in known), None)
        if hit:
            ops.append({"op_id": f"import-feedback-tab-{lead['row']}", "type": "update", "at": now, "by": BY, "id": hit,
                        "set": {k: v for k, v in (("platforms", plats), ("area", area)) if v}})
            updated += 1
            continue
        merged += len(g) - 1
        title, summary = title_of(lead["text"])
        game = game_of(lead["text"])
        if game and len(g) > 1:
            title, summary, area = f"{game} game profile request", lead["text"], "Game profiles & sens"
        notes = []
        if len(lead["cats"]) > 1 or (lead["cats"] and not area):
            notes.append("Category in the Feedback tab: " + ", ".join(lead["cats"]))
        if len(g) > 1:
            notes.append(f"{len(g)} rows of the Feedback tab (rows {', '.join(str(r['row']) for r in g)}).")
            other = sorted({r["text"] for r in g[1:]} - {lead["text"]})
            if other:
                notes.append("Also logged as:\n" + "\n".join("- " + t for t in other))
        if lead["from_link"]:
            notes.append("Date taken from the Discord message link.")
        eid = f"f-feedback-{lead['row']}"
        entry = {"id": eid, "kind": lead["kind"], "priority": "", "title": title, "summary": summary,
                 "source": source_of(urls[:1], lead["where"]), "where": lead["where"], "url": urls[0] if urls else "", "links": urls[1:],
                 "posted_at": lead["posted"], "status": "Backlog", "area": area, "platforms": plats,
                 "tags": ["Multiple reports"] if len(urls) > 1 or len(g) > 1 else ["Single report"],
                 "notes": "\n\n".join(notes), "added_at": now, "added_by": BY,
                 "updated_at": (lead["posted"] + "T12:00:00Z") if lead["posted"] else now,
                 "extra": {"sheet": "Community Taskforce / Feedback", "rows": [r["row"] for r in g], "category": lead["cats"],
                           "reports": len(g)}}
        ops.append({"op_id": "import-feedback-tab-" + eid, "type": "add", "at": now, "by": BY, "notify": False, "entry": entry})
    with open(out, "w", encoding="utf-8") as fh:
        json.dump({"ops": ops}, fh, ensure_ascii=False)
    adds = sum(o["type"] == "add" for o in ops)
    print(f"{adds} new entries ({merged} rows folded in as extra reports), {updated} existing entries updated")


def similar(a, b):
    wa, wb = set(re.findall(r"\w{3,}", a.lower())), set(re.findall(r"\w{3,}", b.lower()))
    return bool(wa and wb) and len(wa & wb) / len(wa | wb) >= 0.8


def details(path, seed_path, out):
    seed = json.load(open(seed_path, encoding="utf-8"))["ops"]
    known = {norm_url(u) for op in seed for u in [op["entry"].get("url")] + (op["entry"].get("links") or []) if u}
    now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    ops = []
    for g in group(read_rows(path)):
        if len(g) < 2 or any(norm_url(u) in known for r in g for u in r["urls"]):
            continue
        more = []
        for i, r in enumerate(g[1:], 1):
            prev = g[:i]
            same = any({norm_url(u) for u in r["urls"]} & {norm_url(u) for u in p["urls"]} for p in prev) \
                or any(r["posted"] and r["posted"] == p["posted"] and similar(r["text"], p["text"]) for p in prev) \
                or any(r["text"].lower() == p["text"].lower() and (not r["posted"] or r["posted"] == p["posted"]) for p in prev)
            more.append({"d": r["posted"], "t": r["text"], "u": r["urls"][0] if r["urls"] else "",
                         "src": source_of(r["urls"][:1], r["where"]), **({"same": True} if same else {})})
        ops.append({"op_id": f"feedback-tab-details-f-feedback-{g[0]['row']}", "type": "more", "at": now,
                    "id": f"f-feedback-{g[0]['row']}", "more": more})
    with open(out, "w", encoding="utf-8") as fh:
        json.dump({"ops": ops}, fh, ensure_ascii=False)
    n = sum(len(o["more"]) for o in ops)
    print(f"{len(ops)} entries get report details ({n} rows, {sum(m.get('same', False) for o in ops for m in o['more'])} same player)")


if __name__ == "__main__":
    if len(sys.argv) == 5 and sys.argv[1] == "--details":
        details(*sys.argv[2:])
    elif len(sys.argv) == 4:
        main(*sys.argv[1:])
    else:
        sys.exit(__doc__)
