// Public booking API proxy: browser -> this function -> n8n (/webhook/avenso/v1/public/<op>).
// The public webhook key never reaches the browser. Only allow-listed operations and fields pass.
import { str, uuid, date, iso, bool, phone, email, clean, readBody, rateLimited, clientIp, sameOrigin, callN8n, send } from "../_lib.js";

const patient = (p) => (p && typeof p === "object"
  ? clean({ full_name: str(p.full_name, 120), phone_e164: phone(p.phone_e164 ?? p.phone), email: email(p.email) })
  : {});

// op -> [payload builder, requests per minute per IP, isWrite]
const OPS = {
  "catalog":            [() => ({}), 60, false],
  "availability":       [(b) => clean({ service: str(b.service, 60), date: date(b.date), doctor: str(b.doctor, 60) }), 60, false],
  "hold":               [(b) => clean({ service: str(b.service, 60), starts_at: iso(b.starts_at), doctor: str(b.doctor, 60) }), 20, true],
  "commit-hold":        [(b) => clean({ operation_id: uuid(b.operation_id), hold_token: uuid(b.hold_token), patient: patient(b.patient) }), 20, true],
  "release-hold":       [(b) => clean({ operation_id: uuid(b.operation_id), hold_token: uuid(b.hold_token), reason: "patient_cancelled_before_confirm" }), 20, true],
  "verification-start": [(b) => clean({ phone: phone(b.phone), email: email(b.email), purpose: "manage" }), 5, true],
  "verification-check": [(b) => clean({ challenge_id: uuid(b.challenge_id), code: /^\d{6}$/.test(String(b.code || "")) ? String(b.code) : undefined }), 10, true],
  "find":               [(b) => clean({ appointment_id: uuid(b.appointment_id), verification_session: uuid(b.verification_session) }), 30, false],
  "cancel-preview":     [(b) => clean({ appointment_id: uuid(b.appointment_id), verification_session: uuid(b.verification_session) }), 20, true],
  "cancel-commit":      [(b) => clean({ confirmation_token: uuid(b.confirmation_token), verification_session: uuid(b.verification_session), explicit_confirm: bool(b.explicit_confirm) }), 10, true],
  "reschedule":         [(b) => clean({ appointment_id: uuid(b.appointment_id), new_starts_at: iso(b.new_starts_at), verification_session: uuid(b.verification_session), explicit_confirm: bool(b.explicit_confirm) }), 10, true],
  "message":            [(b) => clean({ name: str(b.name, 120), phone: phone(b.phone), email: email(b.email), message: str(b.message, 1000) }), 5, true],
  "emergency":          [(b) => clean({ name: str(b.name, 120), phone: phone(b.phone), message: str(b.message, 1000) }), 5, true],
  "continuity-resume":  [(b) => clean({ continuation_token: uuid(b.continuation_token) }), 20, false],
  "waitlist-accept":    [(b) => clean({ offer_token: uuid(b.offer_token) }), 10, true],
  "confirm-attendance": [(b) => clean({ token: typeof b.token === "string" && /^[A-Za-z0-9_-]{20,100}$/.test(b.token) ? b.token : undefined }), 20, true],
  "health":             [() => ({}), 30, false],
  "waitlist-join":      [(b) => clean({
                            full_name: str(b.full_name, 120), phone: phone(b.phone), email: email(b.email),
                            service: str(b.service, 60), doctor: str(b.doctor, 60),
                            earliest_date: date(b.earliest_date), latest_date: date(b.latest_date),
                            preferred_days: Array.isArray(b.preferred_days) ? b.preferred_days.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7).slice(0, 7) : undefined,
                            consent_to_contact: bool(b.consent_to_contact) }), 5, true]
};

// Optional: AVENSO_CLINIC_SLUG pins this site to one clinic. Unset = the database's default clinic.
const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;
const clinicSlug = () => { const s = String(process.env.AVENSO_CLINIC_SLUG || "").trim().toLowerCase(); return SLUG.test(s) ? s : undefined; };

// Uptime monitors call GET/HEAD /api/public/health. 200 = website, n8n and database all answer; 503 = something is down.
// Answers are reused for 30 s so several monitor locations checking every minute cost at most 2 n8n runs a minute.
let lastHealth = { at: 0, out: null };
async function health(req, res) {
  const ttl = Number(process.env.AVENSO_HEALTH_CACHE_MS ?? 30000);
  const fresh = lastHealth.out && Date.now() - lastHealth.at < ttl;
  const out = fresh ? lastHealth.out : await callN8n({ channel: "public", op: "health", headerName: "x-avenso-public-key", secret: process.env.AVENSO_PUBLIC_KEY,
    body: clean({ request_id: crypto.randomUUID(), session_id: "health", clinic_slug: clinicSlug(), payload: {} }), timeoutMs: 10000 });
  if (!fresh) lastHealth = { at: Date.now(), out };
  const ok = out.status === 200 && out.json?.success === true && out.json?.clinic_ready === true;
  if (req.method === "HEAD") { res.statusCode = ok ? 200 : 503; res.setHeader("cache-control", "no-store"); return res.end(); }
  return send(res, ok ? 200 : 503, ok ? { ok: true, status: "ok", time: out.json.time } : { ok: false, status: out.json?.status === "ok" ? "clinic_not_ready" : (out.json?.status || "service_unavailable") });
}

export default async function handler(req, res) {
  const op = String(req.query?.op || "").toLowerCase();
  if (op === "health" && (req.method === "GET" || req.method === "HEAD")) {
    if (rateLimited(`${clientIp(req)}:health`, 30, 60000)) return send(res, 429, { ok: false, status: "rate_limited" });
    return health(req, res);
  }
  if (req.method !== "POST") { res.setHeader("allow", "POST"); return send(res, 405, { success: false, status: "method_not_allowed" }); }
  if (!sameOrigin(req)) return send(res, 403, { success: false, status: "forbidden_origin" });

  const spec = OPS[op];
  if (!spec) return send(res, 404, { success: false, status: "unsupported_operation" });

  const ip = clientIp(req);
  if (rateLimited(`${ip}:${op}`, spec[1], 60000) || rateLimited(`${ip}:*`, 120, 60000)) {
    res.setHeader("retry-after", "60");
    return send(res, 429, { success: false, status: "rate_limited" });
  }

  let body;
  try { body = await readBody(req); } catch (e) { return send(res, e.code === 413 ? 413 : 400, { success: false, status: "invalid_json" }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return send(res, 400, { success: false, status: "invalid_json" });

  const payload = spec[0](body);
  if (op === "health") return health(req, res);
  // A malformed confirmation link can never match, so answer without a round trip.
  if (op === "confirm-attendance" && !payload.token) return send(res, 200, { success: false, status: "invalid_token" });
  // Same request_id on retry = the booking core replays the original answer instead of acting twice.
  const requestId = uuid(body.request_id) || crypto.randomUUID();
  const upstreamBody = op === "waitlist-accept"
    ? { request_id: requestId, offer_token: payload.offer_token }
    : { request_id: requestId, session_id: "web", payload };
  if (clinicSlug()) upstreamBody.clinic_slug = clinicSlug();

  const out = await callN8n({
    channel: "public", op, headerName: "x-avenso-public-key",
    secret: process.env.AVENSO_PUBLIC_KEY, body: upstreamBody
  });
  if (out.status !== 200 && spec[2]) {
    // A write may or may not have happened. Never tell the browser it failed or succeeded.
    out.json = { success: false, status: "uncertain", request_id: requestId };
  }
  return send(res, out.status, { ...out.json, request_id: requestId });
}
