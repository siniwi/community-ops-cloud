// Feedback and bug tracker API for the team site (aimlabs-dash). Runs behind the password gate
// (functions/_middleware.js). Data lives in the D1 table `tracker`; bind the community-ops D1 database
// to this Pages project as DB (Settings > Bindings). Without the binding the page still shows the
// entries from /tracker/ops.json, read-only.
//
// Entries added in Claude chat arrive as op files in the Drive folder tracker_ops/. Each hourly
// Actions run bundles them into /tracker/ops.json; this function applies any op it has not seen yet,
// once (tracker_ops table), so team edits made on the page are never overwritten.
//
//   GET  /api/tracker               -> { db, pending, entries, statuses, kinds, priorities, labels, sources, jira_base, slack }
//   GET  /api/tracker?log=<id>      -> { log: [...] } change history of one entry
//   GET  /api/tracker?lite=1        -> { db, entries } only what Trends and the Inbox need to link to entries
//   POST /api/tracker {action:"add", entry, by}             -> { entry }
//   POST /api/tracker {action:"update", id, set, by}        -> { entry }
//   POST /api/tracker {action:"group", id, into, same, by}  -> { entry, into, moved } puts the report under #into's group
//   POST /api/tracker {action:"ungroup", id, by}            -> { entry }  takes it out of its group again
//   POST /api/tracker {action:"same", id, same, by}         -> { entry }  same player twice (counts once) or another player
//   POST /api/tracker {action:"theme", id, theme, by}       -> { entry }  files the entry under a Trends theme ("" = guess again, "none")
//   POST /api/tracker {action:"suggest_add", sids, entry, by}    -> { entry, done }  Suggested reports become a new entry
//   POST /api/tracker {action:"suggest_merge", sids, into, by}   -> { into, done }   ... or extra reports on #into
//   POST /api/tracker {action:"suggest_dismiss", sids, by}       -> { done }
//
// Groups: a report about the same thing as another entry keeps its own row, date, text and link, with dup_of
// pointing at the group's first entry (one level, never a chain). The group moves through the stages as one
// and counts one report per player: extra.same marks the same player logging it twice. Extra reports that
// have no row of their own (folded in at import, +1s from Suggested) sit in extra.more as {d, t, o, u, src, lang, same}.
//
// Trends: each entry is filed under one Trends theme (guessed from its words by /tracker/links.js, or picked by the
// team: extra.theme), so Trends, the Inbox and the tracker can show what a theme costs the review score and which
// entries cover it. fixed_at (when an entry last moved to "Fixed, tell players") lets them compare before and after.
//
// Suggested: the weekday morning run sorts new Steam reviews, Reddit posts and Steam forum threads
// into bug / feedback / request with an English translation, and drops them in tracker_ops/ as
// {"op_id", "type": "suggest", "at", "item": {...}} ops. They wait in tracker_suggest until someone
// on the team adds, merges or dismisses them on the page; nothing reaches the tracker on its own.
//
// Slack: with the secret SLACK_WEBHOOK_URL set, each new entry (not imports) is posted as its own
// message, so the team can discuss it in that message's thread. Without it nothing is sent.
// Jira: jira_key is parsed from jira_url; jira_status is reserved for the later Jira sync.

// Same vocabulary as Hirad's sheet "Aimlabs 2.0 - Post Launch Feedback and Bug Reports": "Repro?"/"Status"
// values are labels (several per entry), "Est. Priority" is priority. status is the entry's next step; the
// sheet's done checkbox (Open/Done) maps onto it with legacyStage(). The Community Taskforce sheet's
// Feedback tab (Type, Category, Platform) arrives as kind, area and platforms, parked in Backlog.
export const STATUSES = ["Triage", "Needs repro", "Needs ticket", "With dev", "Fixed, tell players", "Backlog", "Closed"];
const FIXED = "Fixed, tell players"; // the stage that means a fix shipped (fixed_at)
const STAGE_HINTS = {
  "Triage": "Decide what it is and how bad",
  "Needs repro": "Try it, or ask the player for details",
  "Needs ticket": "Write the Jira ticket",
  "With dev": "Ticketed, waiting on a fix",
  "Fixed, tell players": "Let the reporters know, then close",
  "Backlog": "Logged idea; add reports as players ask, pitch it when it comes up often",
  "Closed": "Done, duplicate or won't fix",
};
export const KINDS = ["Bug", "Feedback", "Request"];
export const PLATFORMS = ["Steam", "Epic", "Xbox", "PlayStation", "Android", "iOS"];
export const PRIORITIES = ["6 - Critical", "5 - Very High", "4 - High", "3 - Medium", "2 - Low", "1 - Very Low"];
export const LABELS = ["Needs repro", "Reproduceable", "No Repro", "Needs testing", "Needs Ticket", "Known Issue",
  "Single report", "Multiple reports", "Video provided", "Unsure", "Fixed", "Duplicate", "Won't fix"];
export const SOURCES = ["Discord", "Reddit", "Steam forum", "Steam review", "CN community", "Support", "Slack", "DM", "Other"];
// Jira site for ORB-1234 style keys (link = JIRA_BASE/browse/KEY). Empty = show keys without a link.
const JIRA_BASE = "https://anthic.atlassian.net";
const TEXT = ["kind", "priority", "title", "summary", "source", "where", "url", "posted_at", "status", "jira", "jira_url", "jira_status", "notes",
  "area", "dup_of"];
const ADDED_LATER = ["area", "dup_of", "platforms"]; // columns added after the first release (ALTER TABLE on older databases)
const LISTS = ["links", "shots", "tags", "platforms"]; // tags = labels
const EDITABLE = new Set([...TEXT, ...LISTS]);
const COLS = ["id", "n", ...TEXT, "jira_key", ...LISTS, "extra", "added_at", "added_by", "updated_at", "updated_by", "slack"];
const qc = (c) => `"${c}"`; // quoted: "where" is an SQL keyword
const TEXT_SQL = TEXT.map((c) => `${qc(c)} TEXT`).join(", ");

let ready = false, initSpent = 0; // queries used by setup, taken off the next request's op budget
async function init(db) {
  if (ready) return;
  initSpent = 5;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS tracker (id TEXT PRIMARY KEY, n INTEGER, ${TEXT_SQL}, jira_key TEXT, links TEXT,
      shots TEXT, tags TEXT, platforms TEXT, extra TEXT, added_at TEXT, added_by TEXT, updated_at TEXT, updated_by TEXT, slack TEXT)`),
    db.prepare("CREATE TABLE IF NOT EXISTS tracker_ops (op_id TEXT PRIMARY KEY, at TEXT)"),
    db.prepare("CREATE TABLE IF NOT EXISTS tracker_log (at TEXT, id TEXT, by TEXT, field TEXT, old TEXT, new TEXT)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS tracker_suggest (sid TEXT PRIMARY KEY, at TEXT, data TEXT, state TEXT, "into" TEXT, by TEXT, done_at TEXT)`),
  ]);
  const { results } = await db.prepare("PRAGMA table_info(tracker)").all();
  const have = new Set(results.map((r) => r.name));
  for (const c of ADDED_LATER) if (!have.has(c)) { await db.prepare(`ALTER TABLE tracker ADD COLUMN ${qc(c)} TEXT`).run(); initSpent++; }
  initSpent += await migrateStages(db);
  ready = true;
}

// The sheet's Open/Done becomes a next step, read from the labels and the Jira ticket.
const has = (e, ...ls) => ls.some((l) => (e.tags || []).includes(l));
function legacyStage(e) {
  if (e.status === "Done") return has(e, "Fixed") ? "Fixed, tell players" : "Closed";
  if (e.jira_key || e.jira_url) return "With dev";
  if (e.kind === "Bug") {
    if (has(e, "Needs Ticket", "Reproduceable")) return "Needs ticket";
    if (has(e, "Needs repro", "Needs testing", "Unsure", "Video provided", "No Repro")) return "Needs repro";
    if (has(e, "Known Issue")) return "Needs ticket";
  } else if (has(e, "Known Issue", "Multiple reports")) return "Needs ticket";
  return "Triage";
}
async function migrateStages(db) {
  const { results } = await db.prepare("SELECT id, kind, status, tags, jira_key, jira_url FROM tracker WHERE status IN ('Open', 'Done')").all();
  if (!results.length) return 1;
  const by = {};
  for (const r of results) (by[legacyStage(fromRow(r))] ||= []).push(r.id);
  const stmts = [];
  for (const [stage, ids] of Object.entries(by))
    for (let i = 0; i < ids.length; i += 90)
      stmts.push(db.prepare(`UPDATE tracker SET status = ? WHERE id IN (${ids.slice(i, i + 90).map(() => "?").join(", ")})`).bind(stage, ...ids.slice(i, i + 90)));
  await db.batch(stmts);
  return 1 + stmts.length;
}

const clip = (v, n) => String(v ?? "").trim().slice(0, n);
const jiraKey = (...xs) => xs.map((u) => (String(u || "").match(/\b([A-Z][A-Z0-9]+-\d+)\b/) || [])[1]).find(Boolean) || "";
const reportsOf = (e) => Math.max(1 + (e.links || []).length, +(e.extra && e.extra.reports) || 0);
const newId = () => "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
function clean(field, v) {
  if (field === "platforms") return (Array.isArray(v) ? v : []).filter((x) => PLATFORMS.includes(x));
  if (LISTS.includes(field)) return (Array.isArray(v) ? v : []).map((x) => clip(x, 1000)).filter(Boolean).slice(0, 50);
  if (field === "status") return STATUSES.includes(v) || v === "Open" || v === "Done" ? v : "Triage";
  if (field === "kind") return KINDS.includes(v) ? v : "Feedback";
  if (field === "priority") return PRIORITIES.includes(v) ? v : "";
  return clip(v, field === "summary" || field === "notes" ? 8000 : 1000);
}
function toRow(e) {
  const o = {};
  for (const c of COLS) o[c] = LISTS.includes(c) || c === "extra" ? JSON.stringify(e[c] ?? (c === "extra" ? {} : [])) : e[c] ?? "";
  return o;
}
function fromRow(r) {
  const e = { ...r };
  for (const c of [...LISTS, "extra"]) { try { e[c] = JSON.parse(r[c] || (c === "extra" ? "{}" : "[]")); } catch { e[c] = c === "extra" ? {} : []; } }
  return e;
}
function fresh(input, by, at) {
  const e = { id: clip(input.id, 64) || newId(), added_at: clip(input.added_at, 40) || at, added_by: clip(input.added_by || by, 80),
    updated_at: clip(input.updated_at, 40) || at, updated_by: clip(input.updated_by || by, 80), slack: "", extra: input.extra && typeof input.extra === "object" ? input.extra : {} };
  for (const f of EDITABLE) e[f] = clean(f, input[f]);
  e.jira_key = jiraKey(e.jira, e.jira_url);
  if (!input.status) e.status = "Triage";
  else if (e.status === "Open" || e.status === "Done") e.status = legacyStage(e);
  return e;
}

async function getOne(db, id) {
  const r = await db.prepare("SELECT * FROM tracker WHERE id = ?").bind(id).first();
  return r ? fromRow(r) : null;
}
async function update(db, id, set, by, at) {
  const cur = await getOne(db, id);
  if (!cur) return null;
  const changes = [];
  for (const [f, v] of Object.entries(set || {})) {
    if (!EDITABLE.has(f)) continue;
    const nv = clean(f, v);
    if (JSON.stringify(nv) === JSON.stringify(cur[f])) continue;
    changes.push([f, cur[f], nv]);
    cur[f] = nv;
  }
  if (!changes.length) return cur;
  cur.jira_key = jiraKey(cur.jira, cur.jira_url);
  const st = changes.find((c) => c[0] === "status");
  if (st && (cur.status === "Open" || cur.status === "Done")) st[2] = cur.status = legacyStage(cur);
  cur.updated_at = at; cur.updated_by = clip(by, 80);
  const r = toRow(cur);
  const cols = [...changes.map((c) => c[0]), "jira_key", "updated_at", "updated_by"];
  const uniq = [...new Set(cols)];
  await db.batch([
    db.prepare(`UPDATE tracker SET ${uniq.map((c) => `${qc(c)} = ?`).join(", ")} WHERE id = ?`).bind(...uniq.map((c) => r[c]), id),
    ...changes.map(([f, o, n]) => db.prepare("INSERT INTO tracker_log (at, id, by, field, old, new) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(at, id, cur.updated_by, f, JSON.stringify(o), JSON.stringify(n))),
  ]);
  return cur;
}

const jiraLink = (e) => e.jira_url || (JIRA_BASE && e.jira_key ? `${JIRA_BASE}/browse/${e.jira_key}` : "");
async function notifySlack(env, e, origin) {
  if (!env.SLACK_WEBHOOK_URL) return "";
  const icon = { Bug: ":beetle:", Feedback: ":speech_balloon:" }[e.kind] || ":memo:";
  const lines = [`${icon} *New ${e.kind.toLowerCase()} #${e.n || ""}:* ${e.url ? `<${e.url}|${e.title}>` : e.title}`];
  const jl = jiraLink(e);
  const meta = [e.priority, e.source, e.posted_at && `posted ${e.posted_at.slice(0, 10)}`, (e.tags || []).join(", "),
    e.jira_key && (jl ? `<${jl}|${e.jira_key}>` : e.jira_key)].filter(Boolean);
  if (meta.length) lines.push(meta.join(" · "));
  if (e.summary) lines.push(`>${e.summary.slice(0, 600).replace(/\n/g, "\n>")}`);
  lines.push(`<${origin}/tracker/#${e.id}|Open in the tracker> · added by ${e.added_by || "someone"}`);
  try {
    const r = await fetch(env.SLACK_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: lines.join("\n") }) });
    return r.ok ? "sent " + new Date().toISOString() : "failed " + r.status;
  } catch (err) { return "failed"; }
}

async function readOps(ctx) {
  try {
    const r = await ctx.env.ASSETS.fetch(new URL("/tracker/ops.json", ctx.request.url));
    return r.ok ? await r.json() : { version: "", ops: [] };
  } catch { return { version: "", ops: [] }; }
}
// Apply chat/import ops once each. Free-plan Functions get ~50 D1 queries per request, so each request
// applies a slice and reports how many are left; the page and the hourly export call again until 0.
const QUERY_BUDGET = 36;
// One suggested report, as written by the morning run. Unknown fields are dropped.
const SUGGEST_SOURCES = ["Steam review", "Steam forum", "Reddit"];
function cleanSuggest(it) {
  const num = (v) => (Number.isFinite(+v) ? +v : null);
  return {
    sid: clip(it.sid, 120), source: SUGGEST_SOURCES.includes(it.source) ? it.source : "Other",
    url: /^https?:\/\//i.test(it.url || "") ? clip(it.url, 1000) : "", posted_at: clip(it.posted_at, 40), lang: clip(it.lang, 40),
    title: clip(it.title, 300), author: clip(it.author, 80), text: clip(it.text, 2000), english: clip(it.english, 2000),
    kind: KINDS.includes(it.kind) ? it.kind : "Feedback", area: clip(it.area, 60), issue: clip(it.issue, 160) || clip(it.title || it.text, 120),
    sentiment: ["positive", "neutral", "negative"].includes(it.sentiment) ? it.sentiment : "neutral",
    voted_up: typeof it.voted_up === "boolean" ? it.voted_up : null, playtime_h: num(it.playtime_h),
    platforms: (Array.isArray(it.platforms) ? it.platforms : []).filter((x) => PLATFORMS.includes(x)),
  };
}
async function openSuggestions(db, sids) {
  const ids = [...new Set((Array.isArray(sids) ? sids : []).map((x) => clip(x, 120)).filter(Boolean))].slice(0, 60);
  if (!ids.length) return [];
  const { results } = await db.prepare(`SELECT sid, data FROM tracker_suggest WHERE state = 'new' AND sid IN (${ids.map(() => "?").join(", ")})`).bind(...ids).all();
  return results.map((r) => JSON.parse(r.data));
}
const closeSuggestions = (db, items, state, into, by, at) => db.prepare(`UPDATE tracker_suggest SET state = ?, "into" = ?, by = ?, done_at = ?
  WHERE state = 'new' AND sid IN (${items.map(() => "?").join(", ")})`).bind(state, into, by, at, ...items.map((x) => x.sid));

// One extra report without a row of its own: date, English text, original, link, source, language.
const cleanMore = (m) => ({ d: clip(m && m.d, 40), t: clip(m && m.t, 600), o: clip(m && m.o, 600), u: /^https?:\/\//i.test((m && m.u) || "") ? clip(m.u, 1000) : "",
  src: clip(m && m.src, 40), lang: clip(m && m.lang, 40), ...(m && m.same ? { same: true } : {}) });
const moreOf = (x) => cleanMore({ d: x.posted_at, t: x.english || x.text, o: x.english ? x.text : "", u: x.url, src: x.source, lang: x.lang });
async function setExtra(db, id, extra) { await db.prepare("UPDATE tracker SET extra = ? WHERE id = ?").bind(JSON.stringify(extra), id).run(); }
async function rootOf(db, into) {
  const key = String(into ?? "").replace(/^#/, "");
  const row = /^\d+$/.test(key) ? await db.prepare("SELECT id FROM tracker WHERE n = ?").bind(+key).first() : { id: key };
  let e = row && (await getOne(db, row.id));
  if (e && e.dup_of) e = (await getOne(db, e.dup_of)) || e; // grouping into a member joins its group
  return e;
}

function insertStmt(db, e) {
  const r = toRow(e);
  const cols = COLS.filter((c) => c !== "n");
  return db.prepare(`INSERT INTO tracker (n, ${cols.map(qc).join(", ")}) VALUES ((SELECT COALESCE(MAX(n), 0) + 1 FROM tracker), ${cols.map(() => "?").join(", ")})
    ON CONFLICT(id) DO NOTHING`).bind(...cols.map((c) => r[c]));
}
async function applyOps(ctx, db, bundle) {
  if (!bundle.version || !bundle.ops?.length) return 0;
  const marker = "bundle:" + bundle.version;
  const { results } = await db.prepare("SELECT op_id FROM tracker_ops").all();
  const done = new Set(results.map((r) => r.op_id));
  if (done.has(marker)) return 0;
  const pending = bundle.ops.filter((op) => op.op_id && !done.has(op.op_id));
  const origin = new URL(ctx.request.url).origin;
  const now = () => new Date().toISOString();
  let used = 1 + initSpent, i = 0;
  initSpent = 0;
  for (; i < pending.length && used < QUERY_BUDGET; i++) {
    const op = pending[i], at = op.at || now();
    const claim = db.prepare("INSERT INTO tracker_ops (op_id, at) VALUES (?, ?) ON CONFLICT(op_id) DO NOTHING").bind(op.op_id, now());
    if (op.type === "add" && op.entry) {
      const e = fresh(op.entry, op.by || "Claude (chat)", at);
      const [, ins] = await db.batch([claim, insertStmt(db, e)]);
      used += 2;
      if (ins.meta.changes > 0 && op.notify !== false && ctx.env.SLACK_WEBHOOK_URL) {
        const s = await notifySlack(ctx.env, await getOne(db, e.id), origin);
        await db.prepare("UPDATE tracker SET slack = ? WHERE id = ?").bind(s, e.id).run();
        used += 2;
      }
    } else if (op.type === "update" && (op.id || op.n)) {
      const id = op.id || (await db.prepare("SELECT id FROM tracker WHERE n = ?").bind(+op.n).first())?.id;
      if (id) await update(db, id, op.set, op.by || "Claude (chat)", at);
      await claim.run();
      used += 4;
    } else if (op.type === "group" && op.id && op.into && op.id !== op.into) {
      // chat / one-off grouping: ids are final group roots, so no re-pointing here
      const by = clip(op.by || "Claude (chat)", 80);
      await db.batch([claim, db.prepare(`UPDATE tracker SET dup_of = ?, extra = json_set(COALESCE(NULLIF(extra, ''), '{}'), '$.same', json(?)),
        updated_at = ?, updated_by = ? WHERE id = ? AND COALESCE(dup_of, '') = ''`).bind(op.into, op.same ? "true" : "false", at, by, op.id),
        db.prepare("INSERT INTO tracker_log (at, id, by, field, old, new) VALUES (?, ?, ?, 'dup_of', '\"\"', ?)").bind(at, op.id, by, JSON.stringify(op.into))]);
      used += 3;
    } else if (op.type === "more" && op.id && Array.isArray(op.more)) {
      // per-report details (date, text, link) for reports folded into one entry
      await db.batch([claim, db.prepare(`UPDATE tracker SET extra = json_set(COALESCE(NULLIF(extra, ''), '{}'), '$.more', json(?)) WHERE id = ?`)
        .bind(JSON.stringify(op.more.map(cleanMore).slice(0, 200)), op.id)]);
      used += 2;
    } else if (op.type === "suggest" && op.item?.sid) {
      const it = cleanSuggest(op.item);
      await db.batch([claim, db.prepare("INSERT INTO tracker_suggest (sid, at, data, state) VALUES (?, ?, ?, 'new') ON CONFLICT(sid) DO NOTHING")
        .bind(it.sid, at, JSON.stringify(it))]);
      used += 2;
    } else { await claim.run(); used += 1; }
  }
  const left = pending.length - i;
  if (!left) await db.prepare("INSERT INTO tracker_ops (op_id, at) VALUES (?, ?) ON CONFLICT(op_id) DO NOTHING").bind(marker, now()).run();
  return left;
}
// Read-only fallback before the D1 binding exists: replay the ops in memory.
function replay(bundle, suggestions = []) {
  const byId = new Map(); let n = 0;
  for (const op of bundle.ops || []) {
    if (op.type === "add" && op.entry && !byId.has(op.entry.id)) { const e = fresh(op.entry, op.by || "Claude (chat)", op.at || ""); e.n = ++n; byId.set(e.id, e); }
    else if (op.type === "update") {
      const e = op.id ? byId.get(op.id) : [...byId.values()].find((x) => x.n === +op.n);
      if (e) for (const [f, v] of Object.entries(op.set || {})) if (EDITABLE.has(f)) {
        e[f] = clean(f, v); e.jira_key = jiraKey(e.jira, e.jira_url);
        if (e.status === "Open" || e.status === "Done") e.status = legacyStage(e);
        if (f === "status" && e.status === FIXED && op.at) e.fixed_at = op.at;
      }
    } else if (op.type === "group" && byId.has(op.id) && op.id !== op.into && !byId.get(op.id).dup_of) {
      const e = byId.get(op.id); e.dup_of = op.into; e.extra = { ...e.extra, same: !!op.same };
    } else if (op.type === "more" && byId.has(op.id) && Array.isArray(op.more)) {
      const e = byId.get(op.id); e.extra = { ...e.extra, more: op.more.map(cleanMore).slice(0, 200) };
    }
  }
  for (const op of bundle.ops || []) if (op.type === "suggest" && op.item?.sid) suggestions.push(cleanSuggest(op.item));
  return [...byId.values()];
}

const json = (o, status = 200) => Response.json(o, { status, headers: { "cache-control": "no-store" } });
const meta = (env) => ({ statuses: STATUSES, stage_hints: STAGE_HINTS, kinds: KINDS, platforms: PLATFORMS, priorities: PRIORITIES, labels: LABELS, sources: SOURCES, jira_base: JIRA_BASE,
  slack: env.SLACK_WEBHOOK_URL ? "on" : "off" });

export async function onRequestGet(ctx) {
  const { env, request } = ctx;
  const bundle = await readOps(ctx);
  const q = new URL(request.url).searchParams, lite = !!q.get("lite");
  if (!env.DB) { const suggestions = [], entries = replay(bundle, suggestions); return json(lite ? { db: false, entries: entries.map(liteOf) } : { db: false, entries, suggestions, ...meta(env) }); }
  await init(env.DB);
  const logId = q.get("log");
  if (logId) {
    const { results } = await env.DB.prepare("SELECT at, by, field, old, new FROM tracker_log WHERE id = ? ORDER BY at DESC LIMIT 100").bind(logId).all();
    return json({ log: results });
  }
  const pending = await applyOps(ctx, env.DB, bundle);
  const [{ results }, sug, fx] = await env.DB.batch([env.DB.prepare("SELECT * FROM tracker ORDER BY n DESC"),
    env.DB.prepare("SELECT data FROM tracker_suggest WHERE state = 'new' ORDER BY at DESC LIMIT 1500"),
    env.DB.prepare("SELECT id, MAX(at) AS at FROM tracker_log WHERE field = 'status' AND new = ? GROUP BY id").bind(JSON.stringify(FIXED))]);
  const fixedAt = new Map(fx.results.map((r) => [r.id, r.at]));
  const entries = results.map(fromRow).map((e) => (fixedAt.has(e.id) ? { ...e, fixed_at: fixedAt.get(e.id) } : e));
  if (lite) return json({ db: true, entries: entries.map(liteOf) });
  return json({ db: true, pending, entries, suggestions: sug.results.map((r) => JSON.parse(r.data)), ...meta(env) });
}
// The fields Trends and the Inbox use; report links, not their texts
function liteOf(e) {
  const x = e.extra || {};
  return { id: e.id, n: e.n, kind: e.kind, status: e.status, priority: e.priority, area: e.area, title: e.title, summary: clip(e.summary, 400), notes: clip(e.notes, 300),
    jira_key: e.jira_key, dup_of: e.dup_of, url: e.url, links: e.links, more: (x.more || []).map((m) => m.u || ""), same: !!x.same,
    reports: +x.reports || 0, theme: x.theme || "", posted_at: e.posted_at, fixed_at: e.fixed_at || "" };
}

export async function onRequestPost(ctx) {
  const { env, request } = ctx;
  if (!env.DB) return json({ error: "The tracker database is not connected yet, so changes can't be saved." }, 503);
  await init(env.DB);
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad request" }, 400); }
  const by = clip(body.by, 80) || "Team";
  const at = new Date().toISOString();
  if (body.action === "add") {
    if (!clip(body.entry?.title, 1000)) return json({ error: "A title is needed." }, 400);
    const e = fresh({ ...body.entry, id: "" }, by, at);
    await insertStmt(env.DB, e).run();
    const full = await getOne(env.DB, e.id);
    const s = await notifySlack(env, full, new URL(request.url).origin);
    if (s) { await env.DB.prepare("UPDATE tracker SET slack = ? WHERE id = ?").bind(s, e.id).run(); full.slack = s; }
    return json({ entry: full });
  }
  if (body.action === "update") {
    const e = await update(env.DB, clip(body.id, 64), body.set, by, at);
    return e ? json({ entry: e }) : json({ error: "not found" }, 404);
  }
  if (body.action === "group") {
    const child = await getOne(env.DB, clip(body.id, 64));
    const root = await rootOf(env.DB, body.into);
    if (!child || !root) return json({ error: "Entry not found. Check the # number." }, 404);
    if (child.id === root.id) return json({ error: "That's the same group already." }, 400);
    // the child's own group (if it led one) joins too, so groups stay one level deep
    const { results: kids } = await env.DB.prepare("SELECT id FROM tracker WHERE dup_of = ?").bind(child.id).all();
    if (kids.length) await env.DB.prepare("UPDATE tracker SET dup_of = ? WHERE dup_of = ?").bind(root.id, child.id).run();
    const e = await update(env.DB, child.id, { dup_of: root.id, status: root.status }, by, at);
    e.extra = { ...e.extra, same: !!body.same };
    await setExtra(env.DB, e.id, e.extra);
    let r = root;
    if (!body.same && !(root.tags || []).includes("Multiple reports"))
      r = await update(env.DB, root.id, { tags: [...(root.tags || []).filter((t) => t !== "Single report"), "Multiple reports"] }, by, at);
    const moved = kids.length ? (await env.DB.prepare(`SELECT * FROM tracker WHERE id IN (${kids.map(() => "?").join(", ")})`).bind(...kids.map((k) => k.id)).all()).results.map(fromRow) : [];
    return json({ entry: e, into: r, moved });
  }
  if (body.action === "theme") {
    const e = await getOne(env.DB, clip(body.id, 64));
    if (!e) return json({ error: "Entry not found." }, 404);
    const { theme, ...rest } = e.extra || {};
    e.extra = body.theme ? { ...rest, theme: clip(body.theme, 120) } : rest;
    await env.DB.batch([env.DB.prepare("UPDATE tracker SET extra = ?, updated_at = ?, updated_by = ? WHERE id = ?").bind(JSON.stringify(e.extra), at, by, e.id),
      env.DB.prepare("INSERT INTO tracker_log (at, id, by, field, old, new) VALUES (?, ?, ?, 'theme', ?, ?)").bind(at, e.id, by, JSON.stringify(theme || ""), JSON.stringify(body.theme || ""))]);
    return json({ entry: { ...e, updated_at: at, updated_by: by } });
  }
  if (body.action === "ungroup" || body.action === "same") {
    const e = await getOne(env.DB, clip(body.id, 64));
    if (!e || !e.dup_of) return json({ error: "That report isn't in a group." }, 404);
    if (body.action === "same") {
      e.extra = { ...e.extra, same: !!body.same };
      await setExtra(env.DB, e.id, e.extra);
      return json({ entry: e });
    }
    const root = await getOne(env.DB, e.dup_of);
    const e2 = await update(env.DB, e.id, { dup_of: "", ...(root ? { status: root.status } : {}) }, by, at);
    const { same, ...extra } = e2.extra || {};
    e2.extra = extra;
    await setExtra(env.DB, e2.id, extra);
    return json({ entry: e2 });
  }
  if (body.action === "suggest_add" || body.action === "suggest_merge" || body.action === "suggest_dismiss") {
    const items = await openSuggestions(env.DB, body.sids);
    if (!items.length) return json({ error: "Already handled by someone else. Reload to see the latest." }, 409);
    const done = items.map((x) => x.sid);
    if (body.action === "suggest_dismiss") {
      await closeSuggestions(env.DB, items, "dismissed", "", by, at).run();
      return json({ done });
    }
    const urls = items.map((x) => x.url).filter(Boolean);
    if (body.action === "suggest_add") {
      const input = body.entry || {};
      if (!clip(input.title, 1000)) return json({ error: "A title is needed." }, 400);
      const e = fresh({ ...input, id: "", url: input.url || urls[0] || "", links: [...new Set([...(input.links || []), ...urls.slice(1)])],
        status: input.status || "Triage", notes: [input.notes, items[0].english && items[0].text ? "Original: " + items[0].text : ""].filter(Boolean).join("\n\n"),
        extra: { ...(input.extra || {}), reports: items.length, suggested: done, more: items.slice(1).map(moreOf) } }, by, at);
      await env.DB.batch([insertStmt(env.DB, e), closeSuggestions(env.DB, items, "added", e.id, by, at)]);
      return json({ entry: await getOne(env.DB, e.id), done });
    }
    const target = await rootOf(env.DB, body.into);
    if (!target) return json({ error: "Entry not found. Check the # number." }, 404);
    const links = [...new Set([...(target.links || []), ...urls].filter((l) => l && l !== target.url))];
    const tags = [...new Set([...(target.tags || []).filter((t) => t !== "Single report"), "Multiple reports"])];
    await update(env.DB, target.id, { links, tags }, by, at);
    const extra = { ...target.extra, reports: reportsOf(target) + items.length, more: [...(target.extra?.more || []), ...items.map(moreOf)].slice(-200) };
    await env.DB.batch([env.DB.prepare("UPDATE tracker SET extra = ? WHERE id = ?").bind(JSON.stringify(extra), target.id),
      closeSuggestions(env.DB, items, "merged", target.id, by, at)]);
    return json({ into: await getOne(env.DB, target.id), done });
  }
  return json({ error: "unknown action" }, 400);
}
