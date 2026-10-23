// Shared-password gate for the whole snapshot site (Cloudflare Pages Function, runs before every file).
// Repo copy of the team-site kit's gate; run.sh puts it over the kit's one (adds the tracker export key).
// The password lives in the Pages secret SITE_PASSWORD (set with: npx wrangler pages secret put SITE_PASSWORD --project-name <name>).
// A correct password sets a signed cookie for 7 days. Changing the secret signs everyone out. With no secret set, the site stays closed.
const COOKIE = "snap_auth";
const DAYS = 7;
const enc = new TextEncoder();
const NOINDEX = "noindex, nofollow, noarchive, nosnippet";

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
function same(a, b) { // constant-time string compare
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function passwordOk(env, given) {
  // compare HMACs of both strings so length and content never leak through timing
  const [x, y] = await Promise.all([hmac(env.SITE_PASSWORD, "pw:" + given), hmac(env.SITE_PASSWORD, "pw:" + env.SITE_PASSWORD)]);
  return same(x, y);
}
async function makeCookie(env) {
  const exp = Date.now() + DAYS * 864e5;
  return `${exp}.${await hmac(env.SITE_PASSWORD, "exp:" + exp)}`;
}
async function cookieOk(env, header) {
  const m = (header || "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "="));
  if (!m) return false;
  const [exp, sig] = m.slice(COOKIE.length + 1).split(".");
  if (!/^\d{10,16}$/.test(exp || "") || Number(exp) < Date.now() || !sig) return false;
  return same(sig, await hmac(env.SITE_PASSWORD, "exp:" + exp));
}
function safeNext(n) { return typeof n === "string" && /^\/(?!\/|\\)[\w\-./]*$/.test(n) ? n : "/"; }
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function page(next, msg, status) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="${NOINDEX}"><title>Sign in</title>
<link href="https://fonts.googleapis.com/css2?family=Tomorrow:wght@600;700&family=Play:wght@400;700&display=swap" rel="stylesheet">
<style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:#070b15;color:#eef2fb;font:15px/1.5 Play,system-ui,sans-serif}
form{width:100%;max-width:380px;background:#0d1322;border:1px solid #26324f;border-radius:18px;padding:22px;display:grid;gap:12px}
h1{margin:0;font:700 22px Tomorrow,system-ui,sans-serif}p{margin:0;color:#9ba6c2}
input{min-height:44px;border-radius:12px;border:1px solid #5a6a94;background:#111a2d;color:#eef2fb;padding:0 14px;font:inherit}
input:focus-visible,button:focus-visible{outline:2px solid #47d8d7;outline-offset:2px}
button{min-height:44px;border:0;border-radius:12px;background:#47d8d7;color:#083d3d;font:700 15px Play,system-ui,sans-serif;cursor:pointer}
.err{color:#ff8f7e}</style></head><body>
<form method="post" action="/__login"><h1>Community snapshot</h1><p>Read-only view for the team. Enter the shared password.</p>
<input type="hidden" name="next" value="${esc(next)}">
<input type="password" name="password" autocomplete="current-password" aria-label="Password" required autofocus>
${msg ? `<p class="err" role="alert">${esc(msg)}</p>` : ""}<button type="submit">Open</button></form></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": NOINDEX } });
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  if (!env.SITE_PASSWORD || String(env.SITE_PASSWORD).length < 8) {
    return new Response("Snapshot is closed: the password has not been set.", { status: 503, headers: { "x-robots-tag": NOINDEX, "cache-control": "no-store" } });
  }
  if (url.pathname === "/__login" && request.method === "POST") {
    let form;
    try { form = await request.formData(); } catch (_) { return page("/", "Try again.", 400); }
    const nxt = safeNext(form.get("next"));
    if (await passwordOk(env, String(form.get("password") || ""))) {
      return new Response(null, { status: 303, headers: {
        location: nxt, "cache-control": "no-store", "x-robots-tag": NOINDEX,
        "set-cookie": `${COOKIE}=${await makeCookie(env)}; Path=/; Max-Age=${DAYS * 86400}; HttpOnly; Secure; SameSite=Lax` } });
    }
    await new Promise((r) => setTimeout(r, 1200)); // slow down guessing
    return page(nxt, "That password is not right.", 401);
  }
  // The hourly GitHub Actions job reads the tracker (to mirror it to Drive for Claude and the Inbox) with a
  // key instead of the password. Read-only, this one path only.
  if (url.pathname === "/api/tracker" && request.method === "GET" && env.TRACKER_KEY && String(env.TRACKER_KEY).length >= 32
      && same(request.headers.get("x-tracker-key") || "", env.TRACKER_KEY)) {
    const res = await next();
    const out = new Response(res.body, res);
    out.headers.set("cache-control", "no-store");
    out.headers.set("x-robots-tag", NOINDEX);
    return out;
  }
  if (await cookieOk(env, request.headers.get("cookie"))) {
    const res = await next();
    const out = new Response(res.body, res);
    out.headers.set("cache-control", "private, no-cache");
    out.headers.set("x-robots-tag", NOINDEX);
    return out;
  }
  return page(safeNext(url.pathname + (url.pathname.endsWith("/") ? "" : "")), "", 401);
}
