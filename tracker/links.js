// Ties the tracker to Trends and the Inbox: which Trends theme each entry belongs to, how many negative Steam
// reviews that theme drew in the last 30 days, what that costs the review score, and which reviews and posts
// are linked to an entry directly. Runs in the browser on all three pages; no Claude, no extra data files.
// The theme matching is a copy of the Trends page's own (compileRules / tagThemes), so the numbers agree.
(function () {
  const DAY = 864e5, WIN = 30, FIX_DAYS = 14;
  const LKEY = { schinese: "zh", tchinese: "zh", russian: "ru", ukrainian: "ru", spanish: "es", latam: "es", brazilian: "pt", portuguese: "pt", german: "de", french: "fr", turkish: "tr", polish: "pl", koreana: "ko", japanese: "ja" };

  // ---------- Theme matching (same as Trends): NFKC + lowercase; reviews use English plus their own language,
  // everything else uses every language; whole words for Latin and Cyrillic (trailing * = prefix), substrings for CJK
  function compileRules(rules) {
    const cjk = /[぀-ヿ㐀-鿿가-힯]/, q = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const mk = (p, f) => { try { return new RegExp(p, f); } catch (_) { try { return new RegExp(p, f.replace("u", "")); } catch (_) { return null; } } };
    return (Array.isArray(rules) ? rules : []).filter((r) => r && r.theme).map((r) => {
      const by = {};
      Object.entries(r.keywords || {}).forEach(([lg, list]) => {
        const kws = (Array.isArray(list) ? list : []).map((k) => String(k).normalize("NFKC").toLowerCase().trim()).filter(Boolean);
        const lat = kws.filter((k) => !cjk.test(k)).map((k) => (k.endsWith("*") ? q(k.slice(0, -1)) + "[\\p{L}\\p{N}]*" : q(k)));
        const cj = kws.filter((k) => cjk.test(k)).map(q);
        by[lg] = [lat.length ? mk(`(?<![\\p{L}\\p{N}])(?:${lat.join("|")})(?![\\p{L}\\p{N}])`, "iu") : null, cj.length ? mk(cj.join("|"), "iu") : null].filter(Boolean);
      });
      const rx = (Array.isArray(r.regex) ? r.regex : []).map((p) => mk(String(p), "iu")).filter(Boolean);
      return { name: String(r.theme).replace(/^New theme: /, ""), by, rx };
    });
  }
  function tagThemes(R, text, lang) {
    const out = []; if (!text) return out;
    const s = String(text).normalize("NFKC").toLowerCase();
    const sets = lang === undefined ? null : ["en", LKEY[lang]].filter(Boolean);
    R.forEach((r, k) => { const res = sets ? sets.flatMap((l) => r.by[l] || []) : Object.values(r.by).flat(); if (res.some((re) => re.test(s)) || r.rx.some((re) => re.test(s))) out.push(k); });
    return out;
  }

  // One key per player post, whatever the link looks like, so a tracker link, a review and an Inbox item can meet
  function keyOf(u) {
    u = String(u || ""); let m;
    if ((m = u.match(/steamcommunity\.com\/(?:profiles|id)\/([^/?#]+)\/recommended\/714010/i))) return "review:" + m[1];
    if ((m = u.match(/steamcommunity\.com\/app\/714010\/discussions\/\d+\/(\d+)/i))) return "forum:" + m[1];
    if ((m = u.match(/reddit\.com\/r\/\w+\/comments\/(\w+)/i) || u.match(/redd\.it\/(\w+)/i))) return "reddit:" + m[1].toLowerCase();
    if ((m = u.match(/discord\.com\/channels\/\d+\/(\d+)(?:\/(\d+))?/i))) return "discord:" + (m[2] || m[1]);
    return "";
  }
  // Inbox and Trends post ids: r_<reddit id>, s_<forum thread id>
  const keyOfItem = (id) => { const m = String(id || "").match(/^([rs])_(.+)$/); return m ? (m[1] === "r" ? "reddit:" + m[2].toLowerCase() : "forum:" + m[2]) : ""; };

  // When an entry's own words match no theme, its area points at the likeliest one
  const AREA_THEMES = {
    "Crashes & performance": "Crashes / Freezes & Performance Bugs", "Account & profile": "Account Creation & Login Walls",
    "Game profiles & sens": "Game Profiles & Sens Conversion Accuracy", "Controller": "Controller & Gamepad Support", "PvP & 1v1": "Multiplayer / PvP",
    "Benchmarks & ranked": "Benchmarks / Ranks & Competitive System", "Leaderboards": "Benchmarks / Ranks & Competitive System",
    "Creator Studio": "Creator Studio & Scenario Creation", "Training programs": "Training Programs", "Audio": "Audio & Sound Effects",
    "Settings & visuals": "Visuals / Lighting & Scenery", "Coach & AI": "AI / Generative Chatbots & Slop", "Store & Aimlabs+": "Aimlabs Pro / Aimlabs+ & Subscriptions",
    "UI & navigation": "UI / UX & Menu Complexity",
  };
  const GENERIC = /^Aimlabs 2\.0/; // "the update" matches almost everything; only kept when nothing more specific does

  // One theme per entry, so an entry is never counted against several themes at once. A match in the title beats one in
  // the description, a longer (more specific) keyword beats a short one, and the entry's area breaks ties.
  function entryThemes(R, members, area) {
    const pickd = members[0].theme ?? (members[0].extra && members[0].extra.theme);
    if (pickd) { const k = R.findIndex((r) => r.name === pickd); return { th: k >= 0 ? [k] : [], auto: false }; }
    const gen = R.findIndex((r) => GENERIC.test(r.name)), areaK = R.findIndex((r) => r.name === AREA_THEMES[area]);
    const best = (text, lang) => { const s = String(text || "").normalize("NFKC").toLowerCase(), out = new Map(); if (!s) return out;
      R.forEach((r, k) => { let len = 0; for (const re of [...Object.values(r.by).flat(), ...r.rx]) { const m = s.match(re); if (m) len = Math.max(len, m[0].length); } if (len) out.set(k, len); });
      return out; };
    const score = new Map(), add = (k, v) => score.set(k, (score.get(k) || 0) + v);
    // only the fields (and lengths) /api/tracker?lite=1 sends, so every page files an entry the same way
    const root = members[0], cut = (t, n) => String(t || "").slice(0, n);
    best(root.title).forEach((len, k) => add(k, 1000 + Math.min(len, 40)));
    best(cut(root.summary, 400)).forEach((len, k) => add(k, 100 + Math.min(len, 40)));
    members.slice(1).forEach((m) => best([m.title, cut(m.summary, 400)].join(" \n")).forEach((len, k) => add(k, 40)));
    if (!score.size) best(members.map((m) => cut(m.notes, 300)).join(" \n")).forEach((len, k) => add(k, 10 + Math.min(len, 40)));
    if (areaK >= 0) add(areaK, score.size ? 60 : 1);
    if (score.has(gen)) score.set(gen, score.get(gen) / 10);
    const top = [...score.entries()].sort((a, b) => b[1] - a[1])[0];
    return { th: top ? [top[0]] : [], auto: true };
  }
  function memberKeys(members) {
    const ks = new Set();
    for (const m of members) for (const u of [m.url, ...(m.links || []), ...((m.more || (m.extra && m.extra.more) || []).map((x) => (typeof x === "string" ? x : x.u)))]) { const k = keyOf(u); if (k) ks.add(k); }
    return ks;
  }

  // Reports one entry stands for, as the tracker counts them (a repeat by the same player counts 0)
  const reportsOf = (m, child) => {
    if (child && (m.same ?? (m.extra && m.extra.same))) return 0;
    const more = m.more || (m.extra && m.extra.more) || [], mu = new Set(more.map((x) => (typeof x === "string" ? x : x.u)).filter(Boolean));
    return Math.max(1 + more.length + (m.links || []).filter((l) => l && l !== m.url && !mu.has(l)).length, +(m.reports ?? (m.extra && m.extra.reports)) || 0);
  };
  // Score points a set of negative reviews costs: the 30-day rating with and without them
  const costOf = (pos, neg, n) => (pos + neg - n > 0 && pos + neg > 0 ? (pos / (pos + neg - n) - pos / (pos + neg)) * 100 : 0);
  const tierOf = (cost) => (cost >= 2 ? "high" : cost >= 0.8 ? "medium" : "low");

  function prep(d) {
    const R = compileRules(d.rules), langs = Array.isArray(d.langs) ? d.langs : [];
    const rev = (d.reviews || []).map((r) => { const lang = langs[r[3]] || "other"; return { c: r[0] * 1000, up: r[2] === 1, lang, a: String(r[7] || ""), th: null, t: String(r[8] || "") }; });
    const end = Math.max(0, ...rev.map((r) => r.c));
    // only reviews from the last 120 days get their themes worked out: the 30-day window, the one before, and fix checks
    const recent = rev.filter((r) => r.c >= end - 120 * DAY);
    recent.forEach((r) => (r.th = tagThemes(R, r.t, r.lang)));
    return { R, rev, end, recent };
  }
  // d: trends_data.json; entries: tracker entries (full or ?lite=1); areaOf: the tracker's area guess (optional)
  function build(d, entries, areaOf) {
    // the reviews are tagged once per data file; linking entries again after an edit is cheap
    const { R, rev, end, recent } = d.__tl || (d.__tl = prep(d));
    const start = end - WIN * DAY, pstart = start - WIN * DAY;
    const win = recent.filter((r) => r.c > start), pos = win.filter((r) => r.up).length, neg = win.length - pos;
    const negWin = win.filter((r) => !r.up);
    const themes = R.map((r, k) => {
      const n = negWin.filter((x) => x.th.includes(k));
      const lc = {}; n.forEach((x) => (lc[x.lang] = (lc[x.lang] || 0) + 1));
      return { k, name: r.name, neg: n.length, pos: win.filter((x) => x.up && x.th.includes(k)).length,
        negPrev: recent.filter((x) => !x.up && x.c > pstart && x.c <= start && x.th.includes(k)).length,
        cost: costOf(pos, neg, n.length), langs: Object.entries(lc).sort((a, b) => b[1] - a[1]), roots: [] };
    });
    const byAuthor = new Map(rev.map((r) => [r.a, r]));
    const byId = new Map(entries.map((e) => [e.id, e])), kids = new Map();
    const isChild = (e) => !!(e.dup_of && e.dup_of !== e.id && byId.has(e.dup_of));
    for (const e of entries) if (isChild(e)) { if (!kids.has(e.dup_of)) kids.set(e.dup_of, []); kids.get(e.dup_of).push(e); }
    const byKey = new Map(), entry = new Map();
    for (const e of entries) {
      if (isChild(e)) continue;
      const ms = [e, ...(kids.get(e.id) || [])];
      const keys = memberKeys(ms);
      keys.forEach((k) => byKey.set(k, e.id));
      const { th, auto } = entryThemes(R, ms, e.area || (areaOf ? areaOf(e) : ""));
      const hit = new Set(); th.forEach((k) => negWin.forEach((x, i) => { if (x.th.includes(k)) hit.add(i); }));
      const direct = { neg: 0, pos: 0, posts: 0, negWin: 0 };
      keys.forEach((k) => {
        if (!k.startsWith("review:")) { direct.posts++; return; }
        const r = byAuthor.get(k.slice(7)); if (!r) { direct.posts++; return; }
        r.up ? direct.pos++ : (direct.neg++, r.c > start && direct.negWin++);
      });
      let fix = null;
      const F = Date.parse(e.fixed_at || "");
      if (!isNaN(F) && th.length && /^(Fixed|Closed)/.test(e.status || "")) { // reopened entries drop the fix check
        const about = (x) => !x.up && th.some((k) => x.th.includes(k));
        const after = Math.min(FIX_DAYS, (end - F) / DAY);
        const b = recent.filter((x) => x.c >= F - FIX_DAYS * DAY && x.c < F && about(x)).length;
        const a = after > 0 ? recent.filter((x) => x.c >= F && x.c < F + FIX_DAYS * DAY && about(x)).length : 0;
        fix = { at: e.fixed_at, days: Math.round(after * 10) / 10, before: b / FIX_DAYS, after: after >= 3 ? a / after : null };
      }
      const cost = costOf(pos, neg, hit.size);
      const info = { th, auto, neg: hit.size, cost, tier: tierOf(cost), direct, fix, reports: ms.reduce((n, m) => n + reportsOf(m, m !== e), 0) };
      entry.set(e.id, info);
      th.forEach((k) => themes[k].roots.push(e));
    }
    return { R, end, start, rating: { pos, neg, pct: pos + neg ? (pos / (pos + neg)) * 100 : null }, themes, entry, byKey, keyOf, keyOfItem, tagThemes: (t, lang) => tagThemes(R, t, lang) };
  }

  // ---------- Shared view: themes ranked by the review score they cost, and how far the tracker covers them ----------
  const OPEN = (e) => !["Closed", "Fixed, tell players"].includes(e.status);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmtPts = (x) => (x >= 10 ? Math.round(x) : Math.round(x * 10) / 10).toLocaleString("en-GB");
  const fmtPct = (x) => (Math.round(x * 10) / 10).toLocaleString("en-GB");
  const fmtDay = (ms) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const rate = (x) => (x == null ? "–" : (Math.round(x * 10) / 10).toLocaleString("en-GB"));
  const LANG_NAME = { english: "English", schinese: "Chinese", tchinese: "Chinese (trad.)", russian: "Russian", ukrainian: "Ukrainian", spanish: "Spanish", latam: "Spanish (LatAm)",
    brazilian: "Portuguese (BR)", portuguese: "Portuguese", german: "German", french: "French", turkish: "Turkish", polish: "Polish", koreana: "Korean", japanese: "Japanese" };
  const langName = (l) => LANG_NAME[l] || (l ? l[0].toUpperCase() + l.slice(1) : "Other");
  const CSS = `
.tl-wrap{display:grid;gap:10px}
.tl-score{color:var(--muted);font-size:14px;line-height:1.45;margin:0}
.tl-score b{color:var(--ink)}
.tl-row{display:grid;gap:10px;padding:12px 14px;border-radius:12px;background:var(--surface-2);box-shadow:inset 0 0 0 1px var(--line)}
.tl-top{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(120px,.8fr) minmax(0,1fr);gap:6px 18px;align-items:start}
.tl-th{display:flex;flex-direction:column;gap:3px;min-width:0}
.tl-name{font-weight:700;color:var(--ink);font-size:15px;text-align:left;background:none;border:0;padding:0;font-family:inherit;cursor:pointer;text-decoration:none}
.tl-name:hover{color:var(--teal-ink)}
.tl-sub{color:var(--muted);font-size:13px}
.tl-num{display:flex;flex-direction:column;gap:5px}
.tl-pts{font-weight:800;font-size:18px;color:var(--down);font-variant-numeric:tabular-nums}
.tl-pts small{font-size:13px;font-weight:600;color:var(--muted);margin-left:4px}
.tl-bar{height:6px;border-radius:3px;background:var(--fill);overflow:hidden}.tl-bar i{display:block;height:100%;background:var(--down);border-radius:3px}
.tl-cov{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:13px;color:var(--muted);min-width:0}
.tl-tag{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:6px;font-size:12px;font-weight:700;background:var(--fill);color:var(--muted);white-space:nowrap}
.tl-tag.gap{background:rgb(255 143 126/.14);color:var(--down)}.tl-tag.ok{background:var(--teal-wash);color:var(--teal-ink)}
.tl-list{display:grid;gap:4px}
.tl-li{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;gap:10px;align-items:center;min-height:32px;padding:4px 10px;border-radius:8px;background:var(--fill);color:var(--ink);font-size:13px;text-decoration:none}
.tl-li:hover{background:var(--fill-hover)}
.tl-li b{color:var(--teal-ink);font-variant-numeric:tabular-nums}.tl-li .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tl-li .st{color:var(--muted);white-space:nowrap}.tl-li .j{color:var(--teal-ink);font-weight:700;white-space:nowrap}.tl-li .nj{color:var(--down);font-weight:700;white-space:nowrap}
.tl-e{display:inline-flex;align-items:center;gap:6px;max-width:100%;min-height:28px;padding:3px 9px;border-radius:8px;background:var(--fill);color:var(--ink);font-size:13px;text-decoration:none;box-shadow:inset 0 0 0 1px var(--line)}
.tl-e:hover{background:var(--fill-hover)}
.tl-e b{color:var(--teal-ink);font-variant-numeric:tabular-nums}.tl-e .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px}
.tl-e .j{color:var(--teal-ink);font-weight:700;white-space:nowrap}.tl-e .nj{color:var(--down);font-weight:700;white-space:nowrap}
.tl-more{font-size:13px;color:var(--teal-ink);text-decoration:none;font-weight:700;align-self:center}
.tl-fix{grid-column:1/-1;font-size:13px;color:var(--muted)}.tl-fix b{color:var(--ink)}
.tl-tog{display:inline-flex;gap:2px;padding:3px;border-radius:10px;background:var(--tray);box-shadow:inset 0 0 0 1px var(--line)}
.tl-tog button{height:30px;padding:0 10px;border:0;border-radius:8px;background:none;color:var(--muted);font:700 13px var(--font-sans,system-ui);cursor:pointer}
.tl-tog button[aria-pressed="true"]{background:var(--fill-hover);color:var(--ink)}
.tl-foot{color:var(--muted);font-size:13px;margin:2px 0 0}
.tl-empty{color:var(--muted);font-size:14px;padding:6px 2px}
@media (max-width:760px){.tl-top{grid-template-columns:minmax(0,1fr) auto}.tl-cov{grid-column:1/-1}.tl-num{min-width:96px}.tl-li{grid-template-columns:auto minmax(0,1fr) auto}.tl-li .st{display:none}.tl-e .t{max-width:180px}}
`;
  function css() { if (document.getElementById("tl-css")) return; const st = document.createElement("style"); st.id = "tl-css"; st.textContent = CSS; document.head.appendChild(st); }

  // rows: themes that drew negative reviews or hold tracker entries, most costly first
  function themeRows(M) {
    return M.themes.map((t) => {
      const open = t.roots.filter(OPEN), tick = open.filter((e) => e.jira_key);
      const fixed = t.roots.filter((e) => M.entry.get(e.id).fix);
      return { ...t, open, tick, fixed, gap: t.neg > 0 && open.length > 0 && !tick.length, none: t.neg > 0 && !open.length };
    }).filter((t) => t.neg > 0 || t.open.length).sort((a, b) => b.cost - a.cost || b.open.length - a.open.length);
  }
  // opts: limit, gaps (only themes with no ticket), themeLink(t) -> {href} | {data}, entryHref(e)
  function impactHtml(M, opts = {}) {
    css();
    let rows = themeRows(M);
    if (opts.gaps) rows = rows.filter((t) => t.gap || t.none);
    const all = rows.length;
    if (opts.limit) rows = rows.slice(0, opts.limit);
    const maxCost = Math.max(0.1, ...M.themes.map((t) => t.cost));
    const href = opts.entryHref || ((e) => "/tracker/#" + encodeURIComponent(e.id));
    const tlink = (t) => (opts.themeAttr ? `<button class="tl-name" ${opts.themeAttr(t)}>${esc(t.name)}</button>` : `<a class="tl-name" href="${esc(opts.themeHref ? opts.themeHref(t) : "/trends/#theme=" + encodeURIComponent(t.name))}">${esc(t.name)}</a>`);
    const r = M.rating;
    const head = r.pct == null ? "" : `<p class="tl-score">30-day Steam review score <b>${rate(r.pct)}%</b> (${r.pos.toLocaleString("en-GB")} of ${(r.pos + r.neg).toLocaleString("en-GB")} recommend). Each theme shows how much higher the score would be if none of its negative reviews had been written.</p>`;
    const body = rows.map((t) => {
      const ch = t.negPrev ? Math.round(((t.neg - t.negPrev) / t.negPrev) * 100) : null;
      const trend = ch == null ? "" : ` · <span style="color:var(${ch > 0 ? "--down" : "--up"})">${ch > 0 ? "▲" : "▼"} ${Math.abs(ch)}% ${ch > 0 ? "more" : "fewer"}</span> than the 30 days before`;
      const langs = t.langs.slice(0, 3).map(([l, n]) => `${langName(l)} ${n}`).join(", ");
      // entries still being worked on first, then the ones with the most reports
      const es = [...t.open].sort((a, b) => (a.status === "Backlog") - (b.status === "Backlog") || M.entry.get(b.id).reports - M.entry.get(a.id).reports || b.n - a.n);
      const nc = opts.chips || 3;
      const chips = es.slice(0, nc).map((e) => { const n = M.entry.get(e.id).reports;
        return `<a class="tl-li" href="${esc(href(e))}" title="${esc(e.title)}"><b>#${esc(e.n)}</b><span class="t">${esc(e.title)}${n > 1 ? ` <span class="st">×${n}</span>` : ""}</span><span class="st">${esc(e.status)}</span>${e.jira_key ? `<span class="j">${esc(e.jira_key)}</span>` : `<span class="nj">No ticket</span>`}</a>`; }).join("");
      const more = es.length > nc ? `<a class="tl-more" href="/tracker/#theme=${encodeURIComponent(t.name)}">All ${es.length} entries in this theme</a>` : "";
      const fx = t.fixed.map((e) => { const f = M.entry.get(e.id).fix;
        return `#${esc(e.n)} marked fixed ${esc(fmtDay(Date.parse(f.at)))}: <b>${rate(f.before)}</b> negative reviews a day in the ${FIX_DAYS} days before, ${f.after == null ? "too early to compare" : `<b>${rate(f.after)}</b> a day since (${f.days} days)`}`; }).join("<br>");
      return `<div class="tl-row">
        <div class="tl-top">
          <div class="tl-th">${tlink(t)}<span class="tl-sub">${t.neg} negative review${t.neg === 1 ? "" : "s"} in 30 days${trend}</span>${langs ? `<span class="tl-sub">${esc(langs)}</span>` : ""}</div>
          <div class="tl-num"><span class="tl-pts">${t.neg ? "+" + fmtPts(t.cost) : "0"}<small>pts</small></span><span class="tl-bar"><i style="width:${Math.round((t.cost / maxCost) * 100)}%"></i></span></div>
          <div class="tl-cov">${t.open.length ? `${t.open.length} open in the tracker` : `<span class="tl-tag gap">Not in the tracker yet</span>`}${t.tick.length ? ` <span class="tl-tag ok">${t.tick.length} with a Jira ticket</span>` : t.open.length && t.neg ? ` <span class="tl-tag gap">No ticket yet</span>` : ""}${t.fixed.length ? ` · ${t.fixed.length} fixed` : ""}</div>
        </div>
        ${chips ? `<div class="tl-list">${chips}</div>` : ""}${more}
        ${fx ? `<div class="tl-fix">${fx}</div>` : ""}
      </div>`;
    }).join("");
    return `<div class="tl-wrap">${head}${body || `<div class="tl-empty">${opts.gaps ? "Every costly theme has a ticket in the tracker." : "No negative reviews matched a theme in the last 30 days."}</div>`}
      ${opts.limit && all > rows.length ? `<p class="tl-foot">${all - rows.length} more theme${all - rows.length === 1 ? "" : "s"}${opts.moreHref ? ` · <a class="tl-more" href="${esc(opts.moreHref)}">See all</a>` : ""}</p>` : ""}
      <p class="tl-foot">Themes are the same keyword themes as on Trends; each tracker entry is filed under one of them. Points overlap when a review mentions several themes. Updated every time the page loads.</p></div>`;
  }

  // ---------- Page hooks ----------
  const getJson = async (u) => { const r = await fetch(u, { cache: "no-store", credentials: "same-origin" }); if (!r.ok) throw new Error(u + " " + r.status); return r.json(); };
  const waitFor = (test, ms = 30000) => new Promise((ok, no) => { const t0 = Date.now(); (function poll() { let v; try { v = test(); } catch (_) {} if (v) ok(v); else if (Date.now() - t0 > ms) no(new Error("timeout")); else setTimeout(poll, 250); })(); });

  // Trends: a card on Overview (top themes) and one on Themes (all of them), both with the tracker's coverage
  async function mountTrends() {
    let d, entries;
    try {
      d = await waitFor(() => (typeof D !== "undefined" && D && D.rules ? D : null));
      entries = (await getJson("/api/tracker?lite=1")).entries || [];
    } catch (_) { return; }
    const M = build(d, entries);
    const ov = document.getElementById("v-overview"), thv = document.getElementById("v-themes");
    const S = { gaps: false };
    const card = (id, title) => { const c = document.createElement("div"); c.className = "card"; c.id = id;
      c.innerHTML = `<div class="meta"><h2 data-ic="wrench">${title}</h2><div class="r"><span class="tl-tog" role="group" aria-label="Show"><button data-tlg="" aria-pressed="true">All</button><button data-tlg="1" aria-pressed="false">No ticket yet</button></span></div></div><div class="cbody"></div>`;
      return c; };
    const attr = (t) => `data-tlth="${t.k}"`;
    const paint = () => {
      const a = document.getElementById("tl-ov"), b = document.getElementById("tl-th");
      if (a) a.querySelector(".cbody").innerHTML = impactHtml(M, { limit: 5, gaps: S.gaps, themeAttr: attr });
      if (b) b.querySelector(".cbody").innerHTML = impactHtml(M, { gaps: S.gaps, themeAttr: attr, chips: 4 });
      document.querySelectorAll("[data-tlg]").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.tlg === (S.gaps ? "1" : ""))));
    };
    if (ov) { const c = card("tl-ov", "What costs the review score, and is it in the tracker?"); const k = document.getElementById("kpis"); k && k.nextSibling ? ov.insertBefore(c, k.nextSibling) : ov.appendChild(c); }
    if (thv) { const c = card("tl-th", "Themes in the feedback tracker"); const first = thv.querySelector(".card"); first && first.nextSibling ? thv.insertBefore(c, first.nextSibling) : thv.appendChild(c); }
    if (typeof hydrateIcons === "function") hydrateIcons();
    document.addEventListener("click", (ev) => {
      const g = ev.target.closest("[data-tlg]"); if (g) { S.gaps = !!g.dataset.tlg; paint(); return; }
      const t = ev.target.closest("[data-tlth]"); if (t && typeof goTheme === "function") goTheme(+t.dataset.tlth, "reviews");
    });
    paint();
    const fromHash = () => { const m = location.hash.match(/^#theme=(.+)$/); if (!m || typeof goTheme !== "function") return; const k = M.R.findIndex((r) => r.name === decodeURIComponent(m[1])); if (k >= 0) goTheme(k, "reviews"); };
    fromHash(); window.addEventListener("hashchange", fromHash);
  }

  // Inbox: each post says whether the tracker already has it, or which theme it falls under, with a one-tap Add
  async function mountInbox() {
    let rules, entries;
    try { [rules, entries] = await Promise.all([getJson("/tracker/rules.json"), getJson("/api/tracker?lite=1").then((x) => x.entries || [])]); } catch (_) { return; }
    css();
    const M = build({ rules, reviews: [] }, entries), byId = new Map(entries.map((e) => [e.id, e]));
    const list = document.getElementById("list"); if (!list) return;
    const items = () => (typeof S !== "undefined" && S && Array.isArray(S.items) ? S.items : []);
    const deco = () => {
      list.querySelectorAll("article.card[data-id]").forEach((c) => {
        if (c.querySelector(".tl-in")) return;
        const id = c.dataset.id, it = items().find((x) => String(x.id) === id) || {};
        const a = c.querySelector(".title a"), title = it.title || (a ? a.textContent : ""), url = it.url || (a ? a.href : "");
        const hit = M.byKey.get(keyOfItem(id) || keyOf(url));
        let h;
        if (hit && byId.has(hit)) { const e = byId.get(hit);
          h = `<a class="tl-e" href="/tracker/#${encodeURIComponent(e.id)}"><b>#${esc(e.n)}</b><span class="t">${esc(e.title)}</span><span class="${e.jira_key ? "j" : "nj"}">${esc(e.jira_key || e.status)}</span></a>`;
        } else {
          const th = M.tagThemes([title, it.excerpt].join(" \n"))[0], t = th == null ? null : M.themes[th];
          const open = t ? t.roots.filter(OPEN) : [];
          const add = "/tracker/#add=" + encodeURIComponent(JSON.stringify({ t: title, u: url, d: String(it.created || "").slice(0, 10), s: it.source === "reddit" ? "Reddit" : "Steam forum" }));
          h = `${t ? `<span class="tl-sub">${esc(t.name)}: ${open.length ? `<a class="tl-more" href="/tracker/#theme=${encodeURIComponent(t.name)}">${open.length} in the tracker</a>` : "nothing in the tracker yet"}</span>` : ""}<a class="tl-more" href="${esc(add)}">Add to tracker</a>`;
        }
        const div = document.createElement("div"); div.className = "tl-in"; div.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px";
        div.innerHTML = h;
        const acts = c.querySelector(".acts"); acts ? c.insertBefore(div, acts) : c.appendChild(div);
      });
    };
    new MutationObserver(deco).observe(list, { childList: true });
    deco();
  }

  window.TrackerLinks = { compileRules, tagThemes, keyOf, keyOfItem, build, costOf, tierOf, fmtPts, fmtPct, langName, css, impactHtml, themeRows, OPEN, mountTrends, mountInbox, WIN, FIX_DAYS };
})();
