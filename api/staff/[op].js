// Staff API proxy: signed-in staff -> this function -> n8n (/webhook/avenso/v1/staff/...).
// Role and clinic are read from the database for the signed-in user (see _staffauth.js), then sent to n8n
// as trusted_actor together with the staff webhook key, which only this server knows.
import { str, uuid, date, iso, bool, phone, email, clean, readBody, rateLimited, clientIp, sameOrigin, callN8n, send } from "../_lib.js";
import { getActor } from "../_staffauth.js";

const W = ["receptionist", "manager", "admin"];
const ALL = ["viewer", ...W];
const patient = (p) => (p && typeof p === "object" ? clean({ full_name: str(p.full_name, 120), phone_e164: phone(p.phone_e164 ?? p.phone), email: email(p.email) }) : {});
const override = (b, role) => (["manager", "admin"].includes(role) && b.override === true
  ? { override: true, override_reason: str(b.override_reason, 300) } : {});

// op -> [roles, n8n path, payload builder]
const OPS = {
  "dashboard":          [ALL, "console", (b) => clean({ date: date(b.date) })],
  "timeline":           [W, "console", (b) => clean({ appointment_id: uuid(b.appointment_id) })],
  "patient-search":     [W, "console", (b) => clean({ query: str(b.query, 80) })],
  "patient-update":     [W, "console", (b) => clean({ patient_id: uuid(b.patient_id), full_name: str(b.full_name, 120), phone_e164: str(b.phone_e164, 32), email: str(b.email, 200) })],
  "task-update":        [W, "console", (b) => clean({ task_id: uuid(b.task_id), status: str(b.status, 20), note: str(b.note, 1000) })],
  "appointment-status": [W, "console", (b) => clean({ appointment_id: uuid(b.appointment_id), status: str(b.status, 20) })],
  "ops-queue":          [W, "ops-queue", () => ({})],
  "availability":       [W, "availability", (b) => clean({ service: str(b.service, 60), date: date(b.date), doctor: str(b.doctor, 60) })],
  "book":               [W, "book", (b, r) => clean({ service: str(b.service, 60), starts_at: iso(b.starts_at), doctor: str(b.doctor, 60), patient: patient(b.patient), ...override(b, r) })],
  "hold":               [W, "hold", (b, r) => clean({ service: str(b.service, 60), starts_at: iso(b.starts_at), doctor: str(b.doctor, 60), ...override(b, r) })],
  "commit-hold":        [W, "commit-hold", (b) => clean({ operation_id: uuid(b.operation_id), hold_token: uuid(b.hold_token), patient: patient(b.patient) })],
  "release-hold":       [W, "release-hold", (b) => clean({ operation_id: uuid(b.operation_id), hold_token: uuid(b.hold_token), reason: "staff_released" })],
  "find":               [W, "find", (b) => clean({ appointment_id: uuid(b.appointment_id) })],
  "cancel-preview":     [W, "cancel-preview", (b) => clean({ appointment_id: uuid(b.appointment_id) })],
  "cancel-commit":      [W, "cancel-commit", (b) => clean({ confirmation_token: uuid(b.confirmation_token), explicit_confirm: bool(b.explicit_confirm) })],
  "reschedule":         [W, "reschedule", (b, r) => clean({ appointment_id: uuid(b.appointment_id), new_starts_at: iso(b.new_starts_at), explicit_confirm: bool(b.explicit_confirm), ...override(b, r) })],
  "message":            [W, "message", (b) => clean({ name: str(b.name, 120), phone: phone(b.phone), email: email(b.email), message: str(b.message, 1000) })]
};
const WRITES = new Set(["patient-update", "task-update", "appointment-status", "book", "hold", "commit-hold", "release-hold", "cancel-preview", "cancel-commit", "reschedule", "message"]);

export default async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("allow", "POST"); return send(res, 405, { success: false, status: "method_not_allowed" }); }
  if (!sameOrigin(req)) return send(res, 403, { success: false, status: "forbidden_origin" });
  const op = String(req.query?.op || "").toLowerCase();
  const spec = OPS[op];
  if (!spec) return send(res, 404, { success: false, status: "unsupported_operation" });
  if (rateLimited(`staff:${clientIp(req)}`, 300, 60000)) return send(res, 429, { success: false, status: "rate_limited" });

  const a = await getActor(req, res);
  if (a.error) return send(res, a.code, { success: false, status: a.error });
  const actor = a.actor;
  if (!spec[0].includes(actor.role)) return send(res, 403, { success: false, status: "forbidden_for_role", role: actor.role });

  let b; try { b = await readBody(req); } catch { return send(res, 400, { success: false, status: "invalid_json" }); }
  if (!b || typeof b !== "object" || Array.isArray(b)) return send(res, 400, { success: false, status: "invalid_json" });
  if (spec[2] === undefined) return send(res, 500, { success: false, status: "internal_error" });

  const requestId = uuid(b.request_id) || crypto.randomUUID();
  const trusted_actor = { role: actor.role, user_id: actor.user_id, clinic_slug: actor.clinic_slug };
  const payload = spec[2](b, actor.role);
  const body = spec[1] === "console"
    ? { request_id: requestId, operation: op, trusted_actor, payload }
    : { request_id: requestId, trusted_actor, payload };

  const out = await callN8n({ channel: "staff", op: spec[1], headerName: "x-avenso-staff-key", secret: process.env.AVENSO_STAFF_KEY, body });
  if (out.status !== 200 && WRITES.has(op)) out.json = { success: false, status: "uncertain", request_id: requestId };
  return send(res, out.status, { ...out.json, request_id: requestId });
}
