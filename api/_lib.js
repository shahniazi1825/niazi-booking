// Shared server-side helpers for the AVENSO v2 portal proxies (Vercel Node functions).
// Secrets live only in Vercel environment variables. Nothing here is sent to the browser.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);
const uuid = (v) => (typeof v === "string" && UUID.test(v) ? v.toLowerCase() : undefined);
const date = (v) => (typeof v === "string" && DATE.test(v) ? v : undefined);
const iso = (v) => (typeof v === "string" && ISO.test(v) && !isNaN(Date.parse(v)) ? v : undefined);
const bool = (v) => v === true;
const phone = (v) => {
  const s = str(v, 32);
  return s && /^\+?[0-9 ()-]{7,20}$/.test(s) ? s : undefined;
};
const email = (v) => {
  const s = str(v, 200);
  return s && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) ? s.toLowerCase() : undefined;
};
const clean = (o) => {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
};

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 16384) throw Object.assign(new Error("too_large"), { code: 413 });
  }
  return raw ? JSON.parse(raw) : {};
}

// Best-effort per-instance limiter. For production also enable Vercel WAF rate limiting.
const buckets = new Map();
function rateLimited(key, limit, windowMs) {
  const now = Date.now();
  const b = buckets.get(key) || { n: 0, reset: now + windowMs };
  if (now > b.reset) { b.n = 0; b.reset = now + windowMs; }
  b.n += 1;
  buckets.set(key, b);
  if (buckets.size > 5000) buckets.clear();
  return b.n > limit;
}

function clientIp(req) {
  const xf = String(req.headers["x-forwarded-for"] || "");
  return xf.split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser callers (server-to-server, curl) carry no Origin
  try {
    const o = new URL(origin);
    const host = String(req.headers["x-forwarded-host"] || req.headers.host || "");
    return o.host === host;
  } catch { return false; }
}

const INTERNAL_FIELDS = ["debug_code", "error_code", "operation", "hold_secs"];

async function callN8n({ channel, op, headerName, secret, body, timeoutMs = 15000 }) {
  const base = (process.env.AVENSO_N8N_BASE_URL || "").replace(/\/+$/, "");
  if (!base || !secret) return { status: 500, json: { success: false, status: "server_not_configured" } };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}/webhook/avenso/v1/${channel}/${op}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [headerName]: secret,
        "x-request-id": body.request_id || "",
        "ngrok-skip-browser-warning": "1"
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    if (!r.ok || !json || typeof json !== "object") {
      return { status: 502, json: { success: false, status: r.status === 403 ? "server_auth_failed" : "service_unavailable" } };
    }
    const exposeDebug = process.env.AVENSO_EXPOSE_DEBUG_CODE === "1";
    for (const f of INTERNAL_FIELDS) if (!(f === "debug_code" && exposeDebug)) delete json[f];
    return { status: 200, json };
  } catch (e) {
    return { status: 504, json: { success: false, status: "timeout" } };
  } finally {
    clearTimeout(t);
  }
}

function send(res, status, json) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(JSON.stringify(json));
}

export { str, uuid, date, iso, bool, phone, email, clean, readBody, rateLimited, clientIp, sameOrigin, callN8n, send, UUID };
