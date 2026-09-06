// Vercel serverless function.
// The browser talks to this. This talks to n8n.
// The n8n secret lives here, never in the page.

const ROUTES = {
  availability: "/webhook/calendar-availability",
  book:         "/webhook/book-appointment",
  summary:      "/webhook/vapi-post-call",
  find:         "/webhook/find-appointment",
  cancel:       "/webhook/cancel-appointment"
};

// Anything in this list needs the staff PIN. The public page never sends one.
const STAFF_ONLY = ["find", "cancel"];

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "POST only" });

  const base   = process.env.N8N_BASE;    // https://your-host  (no trailing slash)
  const secret = process.env.N8N_SECRET;  // must match the n8n Header Auth credential
  if (!base || !secret) {
    return res.status(500).json({ error: "Server not configured" });
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const { action, payload, pin } = body || {};

  const path = ROUTES[action];
  if (!path) return res.status(400).json({ error: "Unknown action" });

  // Staff gate. An override is a staff power even on the shared book action.
  const staffPin = process.env.STAFF_PIN;
  const wantsStaff = STAFF_ONLY.includes(action) || payload?.override === true;
  if (wantsStaff) {
    if (!staffPin || pin !== staffPin) {
      return res.status(401).json({ error: "Staff PIN required" });
    }
  }

  // A booking created here is a real calendar event, so refuse obvious junk
  if (action === "book") {
    const name  = String(payload?.patient_name  || "").trim();
    const phone = String(payload?.patient_phone || "").replace(/\D/g, "");
    if (name.length < 2 || phone.length < 7) {
      return res.status(400).json({ error: "Name and phone are required" });
    }
  }

  try {
    const upstream = await fetch(base + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-portal-key": secret
      },
      body: JSON.stringify(
        action === "summary"
          ? {
              message: {
                type: "end-of-call-report",
                endedReason: "web-booking",
                durationSeconds: 0,
                call: {
                  id: "web_" + Math.random().toString(36).slice(2, 10),
                  customer: { number: payload.patient_phone || "" }
                },
                artifact: {
                  transcript: "",
                  structuredOutputs: {
                    o1: { name: "Web booking", result: payload }
                  }
                },
                analysis: { summary: "Booked through the website." }
              }
            }
          : { args: payload }
      )
    });

    const text = await upstream.text();

    // The summary endpoint returns nothing useful. Just report success.
    if (action === "summary") return res.status(200).json({ ok: upstream.ok });

    // Unwrap the Vapi results[] envelope so the page gets plain JSON
    let out = {};
    try {
      const j = JSON.parse(text);
      const r = j?.results?.[0]?.result;
      out = typeof r === "string" ? JSON.parse(r) : (r || j);
    } catch {
      return res.status(502).json({ error: "Bad response from booking system" });
    }
    return res.status(200).json(out);

  } catch (err) {
    return res.status(502).json({ error: "Booking system unreachable" });
  }
}
