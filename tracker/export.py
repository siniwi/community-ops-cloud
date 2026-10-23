#!/usr/bin/env python3
"""Turn the team site's /api/tracker answer into tracker_export.json for Drive.  export.py <api.json> <out.json>"""
import datetime, json, sys

d = json.load(open(sys.argv[1], encoding="utf-8"))
d["generated_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
with open(sys.argv[2], "w", encoding="utf-8") as fh:
    json.dump(d, fh, ensure_ascii=False)
print(f"tracker: {len(d.get('entries', []))} entries, database {'on' if d.get('db') else 'not connected'}")
