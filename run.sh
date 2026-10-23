#!/usr/bin/env bash
# Community Ops cloud job: the GitHub Actions version of the PC's run_quick.cmd / run_full.cmd + refresh_snapshot.py.
# Usage: run.sh hourly|daily
#   hourly: reddit_history, steam_summary, player_counts (the PC ran these every 10 min), then trends_bundle
#   daily:  + reviews_history --full, forum_history, steam_news, trends_bundle (the PC's 08:15 full pull)
# Both then rebuild the team site. Env (repository variables):
#   PUSH=1          write the updated history files back to Drive (otherwise they stay in this run only)
#   DEPLOY=off|preview|production   publish the team site (preview = the cloud-test branch URL)
# The Python scripts are the PC's own, downloaded fresh from the Drive folder on every run.
set -uo pipefail
JOB="${1:-hourly}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
DROPS="$ROOT/work/drops"; SNAP="$ROOT/work/snapshot"
rm -rf "$ROOT/work"; mkdir -p "$DROPS" "$SNAP"
fail=0
step() { echo "::group::$*"; "$@"; local rc=$?; echo "::endgroup::"; [ $rc -ne 0 ] && { echo "::warning::$* exited $rc"; fail=1; }; return 0; }

python3 "$ROOT/drive.py" pull "$DROPS" "$SNAP" || exit 1
cp -a "$DROPS" "$ROOT/work/pulled"

# A script that fails (e.g. a Steam API hiccup) must not overwrite the good copy in Drive:
# put its output file back to what was pulled, so push sees it unchanged and skips it.
out_of() { case "$1" in steam_news.py) echo patches.json ;; *) echo "${1%.py}.json" ;; esac; }
hist() {
  local h="$1"; shift
  echo "::group::$h"; python3 -I "$DROPS/$h" "$@" "$DROPS"; local rc=$?; echo "::endgroup::"
  if [ $rc -ne 0 ]; then
    local o; o="$(out_of "$h")"
    if [ -f "$ROOT/work/pulled/$o" ]; then cp -a "$ROOT/work/pulled/$o" "$DROPS/$o"; else rm -f "$DROPS/$o"; fi
    echo "::warning::$h exited $rc; kept the previous $o"; fail=1
  fi
}

HIST="reddit_history.py steam_summary.py player_counts.py trends_bundle.py"
[ "$JOB" = "daily" ] && HIST="reddit_history.py reviews_history.py forum_history.py steam_news.py steam_summary.py player_counts.py trends_bundle.py"
for h in $HIST; do
  if [ "$h" = "reviews_history.py" ]; then hist "$h" --full; else hist "$h"; fi
done

if [ "${PUSH:-0}" = "1" ]; then step python3 "$ROOT/drive.py" push "$DROPS"; else echo "PUSH is off: history files not written back to Drive"; fi

# Team site. Inbox data comes from the cloud Worker's digest (digest_cloud.json), not the PC's digest.json.
cd "$SNAP"
OUT="$(python3 -I export_snapshot.py --drops "$DROPS" --digest "$DROPS/digest_cloud.json" --out "$SNAP/site")" || { echo "$OUT"; echo "::error::team-site build failed"; exit 1; }
echo "$OUT" | tail -1
python3 -I - "$SNAP/site/trends/trends_data.json" <<'PY' || true
import json, sys, datetime
d = json.load(open(sys.argv[1], encoding="utf-8"))
newest = lambda xs: datetime.datetime.fromtimestamp(max([p["c"] for p in xs if p.get("c")] or [0])).isoformat(timespec="minutes")
print("trends data:", {k: d.get(k) for k in ("reviews_at", "forum_at", "reddit_at")}, "newest review", newest([{"c": r[0]} for r in d.get("reviews", [])]),
      "newest forum", newest(d.get("forum", [])), "newest reddit", newest(d.get("reddit", [])), "reviews", len(d.get("reviews", [])))
PY
# Feedback tracker page (/tracker/) + the changes added in Claude chat (Drive tracker_ops/ -> tracker/ops.json).
mkdir -p site/tracker && cp "$ROOT/tracker/index.html" site/tracker/index.html
# One page menu (Trends, Inbox, Tracker) at the top of every page.
step python3 -I "$ROOT/site_nav.py" site
# Suggested tab: reports the morning Claude run sorted become suggestions; the rest wait in tracker_intake_todo.json.
step python3 -I "$ROOT/tracker/intake.py" "$DROPS" "$ROOT/work/intake"
[ "${PUSH:-0}" = "1" ] && [ -f "$DROPS/tracker_intake_todo.json" ] && step python3 "$ROOT/drive.py" push "$DROPS" tracker_intake_todo.json
step python3 -I "$ROOT/tracker/build_ops.py" "$DROPS/tracker_ops" site/tracker "$ROOT/tracker/seed" "$ROOT/work/intake"
# Read-only key for the tracker export below; derived from a secret this job already has, so nothing new to set up.
TRACKER_KEY="$(printf 'community-ops-tracker:%s' "${GOOGLE_SA_JSON:-}" | sha256sum | cut -c1-64)"
case "${DEPLOY:-off}" in
  off) echo "DEPLOY is off: site built, not published" ;;
  preview|production)
    BRANCH=main; [ "$DEPLOY" = "preview" ] && BRANCH=cloud-test
    # Live team Inbox: swaps in the Worker's 10-minute item list (no-op until TEAM_KEY is set on Pages).
    mkdir -p functions/inbox && cp "$ROOT/functions/inbox/[[path]].js" functions/inbox/
    # Tracker API (D1 binding DB on the Pages project) and the repo's copy of the password gate (adds the export key).
    mkdir -p functions/api && cp "$ROOT/functions/api/tracker.js" functions/api/ && cp "$ROOT/functions/_middleware.js" functions/_middleware.js
    # Same safety checks as refresh_snapshot.py: never publish without the password gate.
    [ -e site/_worker.js ] && { echo "::error::site/_worker.js would bypass the password gate"; exit 1; }
    [ -f functions/_middleware.js ] || { echo "::error::functions/_middleware.js (the password gate) is missing"; exit 1; }
    SECRETS="$(npx --yes wrangler@4 pages secret list --project-name aimlabs-dash 2>&1)"
    echo "$SECRETS" | grep -q SITE_PASSWORD \
      || { echo "::error::SITE_PASSWORD is not set on aimlabs-dash (or the Cloudflare token can't read it)"; exit 1; }
    if [ "$DEPLOY" = "production" ] && ! echo "$SECRETS" | grep -q TRACKER_KEY; then
      printf %s "$TRACKER_KEY" | npx --yes wrangler@4 pages secret put TRACKER_KEY --project-name aimlabs-dash >/dev/null 2>&1 \
        && echo "set TRACKER_KEY on aimlabs-dash" || echo "::warning::could not set TRACKER_KEY; the tracker export to Drive is skipped"
    fi
    npx --yes wrangler@4 pages deploy site --project-name aimlabs-dash --branch "$BRANCH" --commit-dirty=true || exit 1
    # Mirror the tracker to Drive (tracker_export.json) so Claude and the Inbox can read it. Each read also
    # applies pending chat changes in slices, so repeat until none are left.
    if [ "$DEPLOY" = "production" ]; then
      sleep 20  # a fresh deployment takes a few seconds to reach every edge; until then the previous one answers
      ok=0
      for i in $(seq 1 40); do
        curl -fsS --max-time 30 -H "x-tracker-key: $TRACKER_KEY" https://aimlabs-dash.pages.dev/api/tracker -o "$ROOT/work/tracker.json" || break
        left="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("pending", 0))' "$ROOT/work/tracker.json" 2>/dev/null || echo x)"
        [ "$left" = "0" ] && { ok=1; break; }
      done
      if [ $ok = 1 ]; then
        python3 -I "$ROOT/tracker/export.py" "$ROOT/work/tracker.json" "$DROPS/tracker_export.json"
        [ "${PUSH:-0}" = "1" ] && step python3 "$ROOT/drive.py" push "$DROPS" tracker_export.json
      else
        echo "::warning::tracker export failed (site not reachable with the key yet, or changes still pending)"
      fi
    fi ;;
esac
# A single failed history script (usually a Steam/Reddit hiccup) is a warning, not a red run:
# its previous file was kept and the site still published. Pull, build and deploy failures still exit 1.
[ $fail -ne 0 ] && echo "::warning::some history scripts failed this run; their previous files were kept"
exit 0
