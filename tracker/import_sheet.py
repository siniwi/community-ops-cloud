#!/usr/bin/env python3
"""One-off import of Hirad's sheet "Aimlabs 2.0 - Post Launch Feedback and Bug Reports" (.xlsx export) into tracker ops.

  python import_sheet.py <sheet.xlsx> <out.json>

Writes one op file ({"ops": [...]}) to upload into the Drive folder tracker_ops/. Ids come from sheet and row
(s-bugs-12), so importing the same sheet again changes nothing that is already in the tracker. Needs openpyxl.
"""
import datetime, json, re, sys
import openpyxl

LABELS = ["Needs repro", "Reproduceable", "No Repro", "Needs testing", "Needs Ticket", "Known Issue",
          "Single report", "Multiple reports", "Video provided", "Unsure", "Fixed"]
PRIORITIES = ["6 - Critical", "5 - Very High", "4 - High", "3 - Medium", "2 - Low", "1 - Very Low"]
URL = re.compile(r"https?://\S+")


def source_of(urls, where):
    u = " ".join(urls).lower()
    for dom, name in (("discord.com", "Discord"), ("reddit.com", "Reddit"), ("steamcommunity.com/app/714010/reviews", "Steam review"),
                      ("steamcommunity.com", "Steam forum"), ("zendesk.com", "Support"), ("slack.com", "Slack")):
        if dom in u:
            return name
    w = where.lower()
    if w.startswith("cn"):
        return "CN community"
    if "steam review" in w:
        return "Steam review"
    if "dm" in w.split() or w.startswith("dm") or "discord dm" in w:
        return "DM"
    if "discord" in w:
        return "Discord"
    return "Other" if where and where != "-" else ""


def title_of(text):
    t = " ".join(text.split())
    if len(t) <= 160:
        return t, ""
    m = re.match(r"(.{40,157}?[.!?])\s", t)
    return (m.group(1) if m else t[:157].rstrip() + "…"), text.strip()


def main(path, out):
    wb = openpyxl.load_workbook(path)
    now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    ops = []
    for ws, kind in ((wb["Bugs"], "Bug"), (wb["Feedback"], "Feedback")):
        for r in ws.iter_rows(min_row=2):
            v = [c.value for c in r]
            text = str(v[3] or "").strip()
            if not text:
                continue
            link_cell = str(v[5] or "").strip()
            urls = URL.findall(link_cell)
            if r[5].hyperlink and r[5].hyperlink.target and r[5].hyperlink.target not in urls:
                urls.insert(0, r[5].hyperlink.target)
            where = URL.sub("", link_cell).strip()
            labels = []
            for t in str(v[6] or "").split(","):
                t = t.strip()
                if t:
                    labels.append(next((l for l in LABELS if l.lower() == t.lower()), t))
            notes = [str(v[7] or "").strip()] + [str(x).strip() for x in v[9:] if x not in (None, "") and str(x).strip() != "Notes"]
            prio = str(v[2] or "").strip()
            done = v[0] is True or prio.startswith("0")
            posted = v[4].date().isoformat() if isinstance(v[4], datetime.datetime) else ""
            jira = str(v[8] or "").strip()
            if jira == "-":
                jira = ""
            title, summary = title_of(text)
            eid = f"s-{ws.title.lower()}-{r[0].row}"
            entry = {"id": eid, "kind": kind, "priority": prio if prio in PRIORITIES else "", "title": title, "summary": summary,
                     "source": source_of(urls, where), "where": where if where != "-" else "", "url": urls[0] if urls else "",
                     "links": urls[1:], "posted_at": posted, "status": "Done" if done else "Open", "tags": labels,
                     "jira": jira, "jira_url": r[8].hyperlink.target if r[8].hyperlink else "",
                     "notes": "\n\n".join(n for n in notes if n and n != "-"),
                     "added_at": now, "added_by": "Imported from the sheet", "updated_at": (posted + "T12:00:00Z") if posted else now,
                     "extra": {"sheet": ws.title, "row": r[0].row}}
            ops.append({"op_id": "import-sheet-" + eid, "type": "add", "at": now, "by": "Imported from the sheet", "notify": False, "entry": entry})
    with open(out, "w", encoding="utf-8") as fh:
        json.dump({"ops": ops}, fh, ensure_ascii=False)
    print(f"{len(ops)} entries")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
