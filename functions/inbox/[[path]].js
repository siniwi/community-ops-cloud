// Live team Inbox. The static /inbox/ page is rebuilt hourly by GitHub Actions; this function swaps
// its item list for the cloud Worker's copy, which is refreshed every 10 minutes. The password gate
// (functions/_middleware.js) runs before this. If the Worker can't be reached, or TEAM_KEY isn't set,
// the hourly static page is served unchanged.
const WORKER = "https://community-ops-pull.sini-4b4.workers.dev/team-items";
const MARK = "<script>window.__SNAP=";

export async function onRequestGet(ctx) {
  const res = await ctx.next();
  const path = ctx.params.path || [];
  const isPage = path.length === 0 || (path.length === 1 && (path[0] === "" || path[0] === "index.html"));
  if (!isPage || !res.ok || !ctx.env.TEAM_KEY || !(res.headers.get("content-type") || "").includes("text/html")) return res;
  let html = null;
  try {
    const r = await fetch(WORKER, { headers: { "x-team-key": ctx.env.TEAM_KEY }, signal: AbortSignal.timeout(4000) });
    if (!r.ok) return res;
    const live = await r.json();
    if (!live || !live.items || !Object.keys(live.items).length) return res;
    html = await res.text();
    const a = html.indexOf(MARK), b = a < 0 ? -1 : html.indexOf(";</script>", a);
    if (b < 0) return new Response(html, res);
    const snap = JSON.parse(html.slice(a + MARK.length, b));
    snap.collections.items = live.items;
    if (live.daily && Object.keys(live.daily).length) snap.collections.daily = live.daily;
    const blob = JSON.stringify(snap).replace(/<\//g, "<\\/");
    const headers = new Headers(res.headers);
    headers.delete("content-length"); headers.delete("etag");
    headers.set("cache-control", "no-cache");
    headers.set("x-inbox-data", "live " + (live.generated_at || ""));
    return new Response(html.slice(0, a) + MARK + blob + html.slice(b), { status: 200, headers });
  } catch (e) {
    return html === null ? res : new Response(html, res);
  }
}
