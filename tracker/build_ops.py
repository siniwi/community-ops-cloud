#!/usr/bin/env python3
"""Bundle the tracker changes made in Claude chat into the team site.

  python build_ops.py <tracker_ops_dir> <site_tracker_dir> [more op dirs...]

<tracker_ops_dir> is the Drive folder tracker_ops/ as pulled by drive.py: one JSON file per change
({"ops": [...]}, or a single op), plus screenshots. The extra dirs hold op files kept in this repo
(tracker/seed/: the one-off import of Hirad's sheet). Writes <site_tracker_dir>/ops.json and copies the
screenshots to <site_tracker_dir>/shots/. functions/api/tracker.js applies each op once (by op_id).

An op is {"op_id", "type": "add"|"update", "at", "by", "entry": {...}} or {..., "id"|"n", "set": {...}};
"notify": false skips the Slack post (imports).
"""
import hashlib, json, os, shutil, sys

IMAGES = (".png", ".jpg", ".jpeg", ".webp", ".gif")


def main(dest, *srcs):
    ops, bad = [], 0
    os.makedirs(os.path.join(dest, "shots"), exist_ok=True)
    walk = [w for src in srcs if os.path.isdir(src) for w in os.walk(src)]
    for root, _, files in walk:
        for name in sorted(files):
            p = os.path.join(root, name)
            if name.lower().endswith(IMAGES):
                shutil.copyfile(p, os.path.join(dest, "shots", name))
            elif name.endswith(".json"):
                try:
                    with open(p, encoding="utf-8") as fh:
                        d = json.load(fh)
                except ValueError:
                    print(f"::warning::tracker op file {name} is not valid JSON; skipped")
                    bad += 1
                    continue
                for op in d.get("ops", [d]) if isinstance(d, dict) else d:
                    if isinstance(op, dict) and op.get("op_id") and op.get("type") in ("add", "update"):
                        ops.append(op)
                    else:
                        bad += 1
    ops.sort(key=lambda o: (o.get("at") or "", o["op_id"]))
    body = json.dumps(ops, ensure_ascii=False, sort_keys=True)
    out = {"version": hashlib.sha1(body.encode()).hexdigest()[:16] if ops else "", "ops": ops}
    with open(os.path.join(dest, "ops.json"), "w", encoding="utf-8", newline="\n") as fh:
        json.dump(out, fh, ensure_ascii=False)
    print(f"tracker: {len(ops)} chat ops bundled" + (f", {bad} skipped" if bad else ""))


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    main(sys.argv[2], sys.argv[1], *sys.argv[3:])
