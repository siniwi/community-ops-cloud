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
//
// Slack: with the secret SLACK_WEBHOOK_URL set, each new entry (not imports) is posted as its own
// message, so the team can discuss it in that message's thread. Without it nothing is sent.
// Jira: jira_key is parsed from jira_url; jira_status is reserved for the later Jira sync.

// Same vocabulary as Hirad's sheet "Aimlabs 2.0 - Post Launch Feedback and Bug Reports": the done checkbox is
// status Open/Done, "Repro?"/"Status" values are labels (several per entry), "Est. Priority" is priority.
export const STATUSES = ["Open", "Done"];
export const KINDS = ["Bug", "Feedback"];
export const PRIORITIES = ["6 - Critical", "5 - Very High", "4 - High", "3 - Medium", "2 - Low", "1 - Very Low"];
export const LABELS = ["Needs repro", "Reproduceable", "No Repro", "Needs testing", "Needs Ticket", "Known Issue",
  "Single report", "Multiple reports", "Video provided", "Unsure", "Fixed"];
export const SOURCES = ["Discord", "Reddit", "Steam forum", "Steam review", "CN community", "Support", "Slack", "DM", "Other"];
// Jira site for ORB-1234 style keys (link = JIRA_BASE/browse/KEY). Empty = show keys without a link.
const JIRA_BASE = "https://anthic.atlassian.net";
const TEXT = ["kind", "priority", "title", "summary", "source", "where", "url", "posted_at", "status", "jira", "jira_url", "jira_status", "notes"];
const LISTS = ["links", "shots", "tags"]; // tags = labels
const EDITABLE = new Set([...TEXT, ...LISTS]);
const COLS = ["id", "n", ...TEXT, "jira_key", ...LISTS, "extra", "added_at", "added_by", "updated_at", "updated_by", "slack"];
const qc = (c) => `"${c}"`; // quoted: "where" is an SQL keyword
const TEXT_SQL = TEXT.map((c) => `${qc(c)} TEXT`).join(", ");

let ready = false;
async function init(db) {
  if (ready) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS tracker (id TEXT PRIMARY KEY, n INTEGER, ${TEXT_SQL}, jira_key TEXT, links TEXT,
      shots TEXT, tags TEXT, extra TEXT, added_at TEXT, added_by TEXT, updated_at TEXT, updated_by TEXT, slack TEXT)`),
    db.prepare("CREATE TABLE IF NOT EXISTS tracker_ops (op_id TEXT PRIMARY KEY, at TEXT)"),
    db.prepare("CREATE TABLE IF NOT EXISTS tracker_log (at TEXT, id TEXT, by TEXT, field TEXT, old TEXT, new TEXT)"),
  ]);
  ready = true;
}

const clip = (v, n) => String(v ?? "").trim().slice(0, n);
const jiraKey = (...xs) => xs.map((u) => (String(u || "").match(/\b([A-Z][A-Z0-9]+-\d+)\b/) || [])[1]).find(Boolean) || "";
const newId = () => "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
function clean(field, v) {
  if (LISTS.includes(field)) return (Array.isArray(v) ? v : []).map((x) => clip(x, 1000)).filter(Boolean).slice(0, 50);
  if (field === "status") return STATUSES.includes(v) ? v : "Open";
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
  if (!input.status) e.status = "Open";
  e.jira_key = jiraKey(e.jira, e.jira_url);
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
  let used = 1, i = 0;
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
      if (e) for (const [f, v] of Object.entries(op.set || {})) if (EDITABLE.has(f)) { e[f] = clean(f, v); e.jira_key = jiraKey(e.jira, e.jira_url); }
    }
  }
  return [...byId.values()];
}

const json = (o, status = 200) => Response.json(o, { status, headers: { "cache-control": "no-store" } });
const meta = (env) => ({ statuses: STATUSES, kinds: KINDS, priorities: PRIORITIES, labels: LABELS, sources: SOURCES, jira_base: JIRA_BASE,
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
  return json({ error: "unknown action" }, 400);
}
