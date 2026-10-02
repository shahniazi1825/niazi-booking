// Staff authentication for the AVENSO v2 staff portal (server side only).
// Login = Supabase Auth email + password. Tokens live in HttpOnly cookies, never in page JavaScript.
// The staff role and clinic come from the clinic_members table (read with the user's own token,
// so Row Level Security applies). The browser can never choose its own role.

const AT = "av_at", RT = "av_rt", CL = "av_clinic";
const ROLES = ["viewer", "receptionist", "manager", "admin"];

function supa() {
  const url = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = process.env.SUPABASE_ANON_KEY || "";
  return url && key ? { url, key } : null;
}

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name, value, maxAge) {
  const secure = process.env.AVENSO_INSECURE_COOKIES === "1" ? "" : "; Secure";
  return `${name}=${encodeURIComponent(value)}; Path=/api/staff; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}
export function setSession(res, at, rt, expiresIn, clinic) {
  const c = [cookie(AT, at, Math.max(60, Math.min(Number(expiresIn) || 3600, 3600))), cookie(RT, rt, 12 * 3600)];
  if (clinic) c.push(cookie(CL, clinic, 12 * 3600));
  res.setHeader("set-cookie", c);
}
export function clearSession(res) {
  res.setHeader("set-cookie", [cookie(AT, "", 0), cookie(RT, "", 0), cookie(CL, "", 0)]);
}

async function sfetch(path, init = {}, timeoutMs = 10000) {
  const s = supa();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(s.url + path, { ...init, headers: { apikey: s.key, "content-type": "application/json", ...(init.headers || {}) }, signal: ctrl.signal });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, json: j };
  } finally { clearTimeout(t); }
}

export async function passwordLogin(email, password) {
  if (!supa()) return { ok: false, status: "server_not_configured" };
  const r = await sfetch("/auth/v1/token?grant_type=password", { method: "POST", body: JSON.stringify({ email, password }) });
  if (r.status !== 200 || !r.json?.access_token) return { ok: false, status: r.status === 429 ? "rate_limited" : "invalid_login" };
  return { ok: true, at: r.json.access_token, rt: r.json.refresh_token, expiresIn: r.json.expires_in };
}

export async function logout(at) {
  if (!supa() || !at) return;
  try { await sfetch("/auth/v1/logout", { method: "POST", headers: { authorization: `Bearer ${at}` } }); } catch {}
}

async function memberships(at) {
  const r = await sfetch("/rest/v1/clinic_members?select=role,active,clinics(slug,display_name,timezone)&active=eq.true", { headers: { authorization: `Bearer ${at}` } });
  if (r.status !== 200 || !Array.isArray(r.json)) return null;
  return r.json.filter((m) => m.clinics && ROLES.includes(m.role))
    .map((m) => ({ role: m.role, clinic_slug: m.clinics.slug, clinic_name: m.clinics.display_name, timezone: m.clinics.timezone }));
}

// Short cache so every click doesn't cost two Supabase round trips. Revocation still applies within 30 s.
const cache = new Map();

// Returns { actor:{user_id,email,role,clinic_slug,...}, memberships } or { error }.
export async function getActor(req, res, wantedClinic) {
  if (!supa()) return { error: "server_not_configured", code: 500 };
  const ck = parseCookies(req);
  let at = ck[AT], rt = ck[RT];
  if (!at && !rt) return { error: "not_signed_in", code: 401 };

  const hit = at && cache.get(at);
  let user = hit && hit.until > Date.now() ? hit.user : null;
  let ms = hit && hit.until > Date.now() ? hit.ms : null;

  if (!user && at) {
    const u = await sfetch("/auth/v1/user", { headers: { authorization: `Bearer ${at}` } });
    if (u.status === 200 && u.json?.id) user = u.json;
  }
  if (!user && rt) { // access token expired: refresh once
    const r = await sfetch("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: JSON.stringify({ refresh_token: rt }) });
    if (r.status === 200 && r.json?.access_token) {
      at = r.json.access_token; rt = r.json.refresh_token;
      setSession(res, at, rt, r.json.expires_in, ck[CL]);
      user = r.json.user;
    }
  }
  if (!user) { clearSession(res); return { error: "not_signed_in", code: 401 }; }
  if (!ms) ms = await memberships(at);
  if (!ms) return { error: "service_unavailable", code: 502 };
  if (!ms.length) return { error: "no_clinic_access", code: 403 };
  cache.set(at, { user, ms, until: Date.now() + 30000 });
  if (cache.size > 2000) cache.clear();

  const want = wantedClinic || ck[CL];
  const m = ms.find((x) => x.clinic_slug === want) || ms[0];
  return { actor: { user_id: user.id, email: user.email, role: m.role, clinic_slug: m.clinic_slug, clinic_name: m.clinic_name, timezone: m.timezone }, memberships: ms };
}
