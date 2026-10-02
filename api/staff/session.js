// Staff session: POST {action:"login",email,password} | {action:"logout"} | {action:"switch",clinic_slug}; GET = who am I.
import { readBody, rateLimited, clientIp, sameOrigin, send, email as cleanEmail, str } from "../_lib.js";
import { passwordLogin, logout, getActor, setSession, clearSession, parseCookies } from "../_staffauth.js";

// Failed-login counter (per server instance; Supabase Auth adds its own limits on top).
const fails = new Map(), WINDOW = 15 * 60000;
function tooManyFails(key, limit) { const f = fails.get(key); if (!f) return false; if (Date.now() > f.reset) { fails.delete(key); return false; } return f.n >= limit; }
function bump(key) { const now = Date.now(); const f = fails.get(key); if (!f || now > f.reset) fails.set(key, { n: 1, reset: now + WINDOW }); else f.n += 1; if (fails.size > 5000) fails.clear(); }
function addFail(ip, em) { bump(`ip:${ip}`); if (em) bump(`em:${em}`); }

export default async function handler(req, res) {
  if (!sameOrigin(req)) return send(res, 403, { success: false, status: "forbidden_origin" });

  if (req.method === "GET") {
    const a = await getActor(req, res);
    if (a.error) return send(res, a.code, { success: false, status: a.error });
    return send(res, 200, { success: true, status: "signed_in", user: a.actor, memberships: a.memberships });
  }
  if (req.method !== "POST") return send(res, 405, { success: false, status: "method_not_allowed" });

  let b; try { b = await readBody(req); } catch { return send(res, 400, { success: false, status: "invalid_json" }); }
  const ip = clientIp(req);

  if (b.action === "login") {
    const em = cleanEmail(b.email), pw = typeof b.password === "string" ? b.password : "";
    // Only FAILED attempts count, so a busy front desk sharing one internet connection never locks itself out.
    if (tooManyFails(`ip:${ip}`, 10) || (em && tooManyFails(`em:${em}`, 5))) {
      res.setHeader("retry-after", "900");
      return send(res, 429, { success: false, status: "rate_limited" });
    }
    if (!em || pw.length < 8 || pw.length > 200) { addFail(ip, em); return send(res, 401, { success: false, status: "invalid_login" }); }
    const r = await passwordLogin(em, pw);
    if (!r.ok && r.status === "invalid_login") addFail(ip, em);
    if (r.ok) fails.delete(`em:${em}`);
    if (!r.ok) return send(res, r.status === "rate_limited" ? 429 : r.status === "server_not_configured" ? 500 : 401, { success: false, status: r.status });
    setSession(res, r.at, r.rt, r.expiresIn);
    // Check clinic access straight away so people without a role get a clear message.
    req.headers.cookie = `av_at=${encodeURIComponent(r.at)}; av_rt=${encodeURIComponent(r.rt)}`;
    const a = await getActor(req, res);
    if (a.error) { await logout(r.at); clearSession(res); return send(res, a.code, { success: false, status: a.error }); }
    setSession(res, r.at, r.rt, r.expiresIn, a.actor.clinic_slug);
    return send(res, 200, { success: true, status: "signed_in", user: a.actor, memberships: a.memberships });
  }

  if (b.action === "switch") {
    const want = str(b.clinic_slug, 80);
    const a = await getActor(req, res, want);
    if (a.error) return send(res, a.code, { success: false, status: a.error });
    if (a.actor.clinic_slug !== want) return send(res, 403, { success: false, status: "no_clinic_access" });
    const ck = parseCookies(req);
    setSession(res, ck.av_at, ck.av_rt, 3600, want);
    return send(res, 200, { success: true, status: "switched", user: a.actor });
  }

  if (b.action === "logout") {
    await logout(parseCookies(req).av_at);
    clearSession(res);
    return send(res, 200, { success: true, status: "signed_out" });
  }
  return send(res, 400, { success: false, status: "unsupported_action" });
}
