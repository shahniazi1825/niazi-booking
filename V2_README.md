# AVENSO Reception OS v2 — public portal (branch `v2-portal`)

The live site on `main` (legacy booking pages) is untouched. This branch is the v2 portal and deploys as a Vercel **Preview** until the Day 10 cut-over.

## Pages
| Page | What patients do |
|---|---|
| `/` (index.html) | Emergency check, then choose treatment/doctor/date. The chosen time is held for 2 minutes with a countdown while they enter details, then confirmed. Also: next free day, waiting list (explicit consent), call-back request for treatments that can't be booked online, "Add to my calendar". `/?resume=<token>` continues a phone call. |
| `/manage.html` | Confirm identity with a 6-digit code. See upcoming appointments, move one (the old time stays booked until the new one is confirmed) or cancel one (needs a second, explicit confirmation). |
| `/offer.html?token=…&starts=…` | Accept a waiting-list offer (15 minutes, first person to accept gets it). |

## Server proxy `api/public/[op].js`
- Only these operations are allowed: catalog, availability, hold, commit-hold, release-hold, verification-start/check, find, cancel-preview/commit, reschedule, message, emergency, continuity-resume, waitlist-accept, waitlist-join.
- Every field is allow-listed and validated. Role, override, clinic and actor fields are never forwarded.
- Same-origin only. Body limit is 16 KB. A per-IP rate limit applies, with code requests limited to 5 per minute.
- One `request_id` per user action is reused on retry, so a network failure never books twice. If a write's result is unknown, the patient is told "don't book again, we're checking", never "booked" or "failed".
- `debug_code` (the staging code shortcut) is removed unless `AVENSO_EXPOSE_DEBUG_CODE=1`. Never set that on Production.
- Security headers in `vercel.json`: strict CSP (no inline scripts), HSTS, no framing, no referrer.

## Vercel environment variables (Settings → Environment Variables)
| Name | Preview | Production |
|---|---|---|
| `AVENSO_N8N_BASE_URL` | n8n base URL (no trailing slash) | same (production n8n) |
| `AVENSO_PUBLIC_KEY` | value of n8n credential AVENSO_PUBLIC_WEBHOOK_AUTH | production value |
| `AVENSO_EXPOSE_DEBUG_CODE` | `1` only while testing with mock notifications | **never** |

## Clinic display settings
`assets/config.js`: clinic name override, clinic phone, local emergency number, privacy link. Not secret.

## Tests
34 automated browser checks (Playwright against a local copy of the database and the same proxy code) cover:
- booking, hold countdown, two-person race, hold release
- emergency, call-back, waiting list consent
- verification, reschedule, cancel, waiting-list offer
- proxy security: cross-site blocked, field stripping, rate limit, CSP, no console errors
