#!/usr/bin/env python3
"""Copy the Community Ops Drive folder down and the updated history files back up.

Uses the same Google service account as the Cloudflare Worker (secret GOOGLE_SA_JSON).
The service account has no storage of its own, so it only ever overwrites files that already exist.

  python drive.py pull <drops_dir> <snapshot_dir>   download the drops folder (top level) and snapshot_handover/
  python drive.py push <drops_dir> [names...]      upload the files in PUSHABLE (or just [names]) that changed since the pull
Also pulls tracker_ops/ (feedback-tracker entries added in Claude chat, one JSON file per change, plus screenshots).
"""
import hashlib, json, os, sys
from google.oauth2 import service_account
from google.auth.transport.requests import AuthorizedSession

DROPS_FOLDER = "1MM6oSIGPGcBNGA_OyC703LRl_E7bIFy4"   # "Community Ops - Reddit drops"
SNAPSHOT_FOLDER = "snapshot_handover"               # the team-site kit, inside the drops folder
TRACKER_FOLDER = "tracker_ops"                      # tracker changes from Claude chat, inside the drops folder
KEEP = (".json", ".py", ".xml", ".txt")
# Files the cloud jobs write. Everything else in the folder is read-only for them.
PUSHABLE = {"reddit_history.json", "player_counts.json", "steam_summary.json", "reviews_history.json",
            "forum_history.json", "patches.json", "trends_bundle.json", "tracker_export.json"}
FOLDER = "application/vnd.google-apps.folder"
API = "https://www.googleapis.com/drive/v3/files"


def session():
    info = json.loads(os.environ["GOOGLE_SA_JSON"])
    creds = service_account.Credentials.from_service_account_info(info, scopes=["https://www.googleapis.com/auth/drive"])
    return AuthorizedSession(creds)


def children(s, folder):
    out, token = [], None
    while True:
        r = s.get(API, params={"q": f"'{folder}' in parents and trashed = false", "pageSize": 1000, "pageToken": token,
                               "fields": "nextPageToken, files(id, name, mimeType, md5Checksum)"})
        r.raise_for_status()
        j = r.json()
        out += j.get("files", [])
        token = j.get("nextPageToken")
        if not token:
            return out


def download(s, f, path):
    r = s.get(f"{API}/{f['id']}", params={"alt": "media"})
    r.raise_for_status()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(r.content)


def pull_tree(s, folder, dest):
    n = 0
    for f in children(s, folder):
        if f["mimeType"] == FOLDER:
            if f["name"] != "__pycache__":
                n += pull_tree(s, f["id"], os.path.join(dest, f["name"]))
        else:
            download(s, f, os.path.join(dest, f["name"]))
            n += 1
    return n


def md5(path):
    with open(path, "rb") as fh:
        return hashlib.md5(fh.read()).hexdigest()


def pull(drops, snap):
    s = session()
    manifest, kit = {}, None
    for f in children(s, DROPS_FOLDER):
        if f["mimeType"] == FOLDER:
            if f["name"] == SNAPSHOT_FOLDER:
                kit = f["id"]
            elif f["name"] == TRACKER_FOLDER:
                print(f"pulled {pull_tree(s, f['id'], os.path.join(drops, TRACKER_FOLDER))} tracker files")
            continue
        if not f["name"].endswith(KEEP):
            continue
        p = os.path.join(drops, f["name"])
        download(s, f, p)
        manifest[f["name"]] = {"id": f["id"], "md5": md5(p)}
    with open(os.path.join(drops, ".manifest.json"), "w") as fh:
        json.dump(manifest, fh)
    print(f"pulled {len(manifest)} files from the drops folder")
    if kit is None:
        sys.exit("snapshot_handover folder not found in the drops folder")
    print(f"pulled {pull_tree(s, kit, snap)} team-site kit files")


def push(drops, only=None):
    s = session()
    with open(os.path.join(drops, ".manifest.json")) as fh:
        manifest = json.load(fh)
    for name in sorted(PUSHABLE & set(only) if only else PUSHABLE):
        p = os.path.join(drops, name)
        if name not in manifest:
            print(f"skip {name}: not in Drive yet (the service account can only overwrite existing files)")
            continue
        if not os.path.exists(p) or md5(p) == manifest[name]["md5"]:
            continue
        with open(p, "rb") as fh:
            r = s.patch(f"https://www.googleapis.com/upload/drive/v3/files/{manifest[name]['id']}",
                        params={"uploadType": "media"}, data=fh.read(), headers={"content-type": "application/json"})
        r.raise_for_status()
        print(f"pushed {name} ({os.path.getsize(p)} bytes)")


if __name__ == "__main__":
    if sys.argv[1:2] == ["pull"]:
        pull(sys.argv[2], sys.argv[3])
    elif sys.argv[1:2] == ["push"]:
        push(sys.argv[2], sys.argv[3:])
    else:
        sys.exit(__doc__)
