#!/usr/bin/env bash
# Community Ops cloud job: the GitHub Actions version of the PC's run_quick.cmd / run_full.cmd + refresh_snapshot.py.
# Usage: run.sh hourly|daily
#   hourly: reddit_history, steam_summary, player_counts (the PC ran these every 10 min)
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

HIST="reddit_history.py steam_summary.py player_counts.py"
[ "$JOB" = "daily" ] && HIST="reddit_history.py reviews_history.py forum_history.py steam_news.py steam_summary.py player_counts.py trends_bundle.py"
for h in $HIST; do
  if [ "$h" = "reviews_history.py" ]; then step python3 -I "$DROPS/$h" --full "$DROPS"; else step python3 -I "$DROPS/$h" "$DROPS"; fi
done

if [ "${PUSH:-0}" = "1" ]; then step python3 "$ROOT/drive.py" push "$DROPS"; else echo "PUSH is off: history files not written back to Drive"; fi

# Team site. Inbox data comes from the cloud Worker's digest (digest_cloud.json), not the PC's digest.json.
cd "$SNAP"
OUT="$(python3 -I export_snapshot.py --drops "$DROPS" --digest "$DROPS/digest_cloud.json" --out "$SNAP/site")" || { echo "$OUT"; echo "::error::team-site build failed"; exit 1; }
echo "$OUT" | tail -1
case "${DEPLOY:-off}" in
  off) echo "DEPLOY is off: site built, not published" ;;
  preview|production)
    BRANCH=main; [ "$DEPLOY" = "preview" ] && BRANCH=cloud-test
    # Same safety checks as refresh_snapshot.py: never publish without the password gate.
    [ -e site/_worker.js ] && { echo "::error::site/_worker.js would bypass the password gate"; exit 1; }
    [ -f functions/_middleware.js ] || { echo "::error::functions/_middleware.js (the password gate) is missing"; exit 1; }
    npx --yes wrangler@4 pages secret list --project-name aimlabs-dash 2>&1 | grep -q SITE_PASSWORD \
      || { echo "::error::SITE_PASSWORD is not set on aimlabs-dash (or the Cloudflare token can't read it)"; exit 1; }
    npx --yes wrangler@4 pages deploy site --project-name aimlabs-dash --branch "$BRANCH" --commit-dirty=true || exit 1 ;;
esac
exit $fail
