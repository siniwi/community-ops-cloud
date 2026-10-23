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
//   POST /api/tracker {action:"add", entry, by}             -> { entry }
//   POST /api/tracker {action:"update", id, set, by}        -> { entry }
//   POST /api/tracker {action:"merge", id, into, by}        -> { entry, into } folds a duplicate into #into as one more report
//
// Slack: with the secret SLACK_WEBHOOK_URL set, each new entry (not imports) is posted as its own
// message, so the team can discuss it in that message's thread. Without it nothing is sent.
// Jira: jira_key is parsed from jira_url; jira_status is reserved for the later Jira sync.

// Same vocabulary as Hirad's sheet "Aimlabs 2.0 - Post Launch Feedback and Bug Reports": "Repro?"/"Status"
// values are labels (several per entry), "Est. Priority" is priority. status is the entry's next step; the
// sheet's done checkbox (Open/Done) maps onto it with legacyStage(). The Community Taskforce sheet's
// Feedback tab (Type, Category, Platform) arrives as kind, area and platforms, parked in Backlog.
export const STATUSES = ["Triage", "Needs repro", "Needs ticket", "With dev", "Fixed, tell players", "Backlog", "Closed"];
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
  initSpent = 4;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS tracker (id TEXT PRIMARY KEY, n INTEGER, ${TEXT_SQL}, jira_key TEXT, links TEXT,
      shots TEXT, tags TEXT, platforms TEXT, extra TEXT, added_at TEXT, added_by TEXT, updated_at TEXT, updated_by TEXT, slack TEXT)`),
    db.prepare("CREATE TABLE IF NOT EXISTS tracker_ops (op_id TEXT PRIMARY KEY, at TEXT)"),
    db.prepare("CREATE TABLE IF NOT EXISTS tracker_log (at TEXT, id TEXT, by TEXT, field TEXT, old TEXT, new TEXT)"),
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
    } else { await claim.run(); used += 1; }
  }
  const left = pending.length - i;
  if (!left) await db.prepare("INSERT INTO tracker_ops (op_id, at) VALUES (?, ?) ON CONFLICT(op_id) DO NOTHING").bind(marker, now()).run();
  return left;
}
// Read-only fallback before the D1 binding exists: replay the ops in memory.
function replay(bundle) {
  const byId = new Map(); let n = 0;
  for (const op of bundle.ops || []) {
    if (op.type === "add" && op.entry && !byId.has(op.entry.id)) { const e = fresh(op.entry, op.by || "Claude (chat)", op.at || ""); e.n = ++n; byId.set(e.id, e); }
    else if (op.type === "update") {
      const e = op.id ? byId.get(op.id) : [...byId.values()].find((x) => x.n === +op.n);
      if (e) for (const [f, v] of Object.entries(op.set || {})) if (EDITABLE.has(f)) {
        e[f] = clean(f, v); e.jira_key = jiraKey(e.jira, e.jira_url);
        if (e.status === "Open" || e.status === "Done") e.status = legacyStage(e);
      }
    }
  }
  return [...byId.values()];
}

const json = (o, status = 200) => Response.json(o, { status, headers: { "cache-control": "no-store" } });
const meta = (env) => ({ statuses: STATUSES, stage_hints: STAGE_HINTS, kinds: KINDS, platforms: PLATFORMS, priorities: PRIORITIES, labels: LABELS, sources: SOURCES, jira_base: JIRA_BASE,
  slack: env.SLACK_WEBHOOK_URL ? "on" : "off" });

export async function onRequestGet(ctx) {
  const { env, request } = ctx;
  const bundle = await readOps(ctx);
  if (!env.DB) return json({ db: false, entries: replay(bundle), ...meta(env) });
  await init(env.DB);
  const logId = new URL(request.url).searchParams.get("log");
  if (logId) {
    const { results } = await env.DB.prepare("SELECT at, by, field, old, new FROM tracker_log WHERE id = ? ORDER BY at DESC LIMIT 100").bind(logId).all();
    return json({ log: results });
  }
  const pending = await applyOps(ctx, env.DB, bundle);
  const { results } = await env.DB.prepare("SELECT * FROM tracker ORDER BY n DESC").all();
  return json({ db: true, pending, entries: results.map(fromRow), ...meta(env) });
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
  if (body.action === "merge") {
    const dup = await getOne(env.DB, clip(body.id, 64));
    const into = String(body.into ?? "").replace(/^#/, "");
    const row = /^\d+$/.test(into) ? await env.DB.prepare("SELECT id FROM tracker WHERE n = ?").bind(+into).first() : { id: into };
    const target = row && (await getOne(env.DB, row.id));
    if (!dup || !target) return json({ error: "Entry not found. Check the # number." }, 404);
    if (dup.id === target.id) return json({ error: "An entry can't be merged into itself." }, 400);
    const links = [...new Set([...(target.links || []), dup.url || "", ...(dup.links || [])].filter((l) => l && l !== target.url))];
    const tags = [...new Set([...(target.tags || []).filter((t) => t !== "Single report"), "Multiple reports"])];
    const note = `Merged #${dup.n}: ${dup.title}`;
    await update(env.DB, target.id, { links, tags, notes: [target.notes, note].filter(Boolean).join("\n\n") }, by, at);
    // Report count lives in extra.reports when some reports have no link (rows folded together at import).
    const extra = { ...target.extra, reports: reportsOf(target) + reportsOf(dup) };
    await env.DB.prepare("UPDATE tracker SET extra = ? WHERE id = ?").bind(JSON.stringify(extra), target.id).run();
    const t2 = await getOne(env.DB, target.id);
    const d2 = await update(env.DB, dup.id, { status: "Closed", dup_of: target.id, tags: [...new Set([...(dup.tags || []), "Duplicate"])] }, by, at);
    return json({ entry: d2, into: t2 });
  }
  return json({ error: "unknown action" }, 400);
}
