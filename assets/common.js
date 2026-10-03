// Shared browser helpers for the AVENSO v2 portal. No secrets here: all calls go to /api/public/*.
(function () {
  "use strict";
  var CFG = window.AVENSO_CONFIG || {};

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15);
      return (c === "x" ? r : (r & 3) | 8).toString(16);
    });
  }

  // Calls the server proxy. requestId must stay the same when retrying the same action,
  // so the booking core replays the first answer instead of acting twice.
  async function api(op, body, requestId) {
    body = Object.assign({}, body || {}, { request_id: requestId || uuid() });
    var attempt = 0;
    while (true) {
      attempt++;
      try {
        var r = await fetch("/api/public/" + op, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        });
        var j = await r.json().catch(function () { return { success: false, status: "service_unavailable" }; });
        if (r.status === 429) return { success: false, status: "rate_limited" };
        if ((j.status === "uncertain" || j.status === "timeout" || j.status === "service_unavailable") && attempt < 3) {
          await new Promise(function (ok) { setTimeout(ok, 1500 * attempt); });
          continue; // safe: same request_id
        }
        offline(OFFLINE.indexOf(j.status) >= 0 || (j.status === "uncertain" && r.status >= 500));
        return j;
      } catch (e) {
        if (attempt < 3) { await new Promise(function (ok) { setTimeout(ok, 1500 * attempt); }); continue; }
        return { success: false, status: "network_error" };
      }
    }
  }

  // Plain-language text for every status the booking core can return.
  var TEXT = {
    no_slots: "There are no free times on that day.",
    slot_taken: "Someone has just taken that time. Please choose another.",
    hold_expired: "Your reserved time ran out before it was confirmed. Please choose a time again.",
    hold_not_active: "That reserved time is no longer held. Please choose a time again.",
    hold_not_found: "That reserved time is no longer held. Please choose a time again.",
    outside_booking_horizon: "That date can't be booked online. Please choose a date in the allowed range.",
    in_past: "That time has already passed.",
    clinic_closed: "The clinic is closed at that time.",
    doctor_unavailable: "That doctor isn't working at that time.",
    doctor_not_eligible: "That doctor doesn't offer this treatment. Please choose 'Any doctor'.",
    service_unknown: "We couldn't recognise that treatment.",
    needs_clarification: "We couldn't recognise that treatment.",
    service_requires_configuration: "This treatment can't be booked online yet. Please leave a message and the clinic will call you.",
    verification_required: "Please confirm it's you first.",
    verification_failed: "That code is not right. Please check and try again.",
    verification_invalid_or_expired: "That code has expired. Please ask for a new one.",
    verification_locked: "Too many attempts. Please ask for a new code.",
    verification_delivery_unavailable: "We have no way to send you a code. Please contact the clinic.",
    confirmation_invalid_or_expired: "That confirmation has expired. Please start the cancellation again.",
    explicit_confirmation_required: "Please confirm to continue.",
    not_found: "We couldn't find a matching upcoming appointment.",
    offer_invalid_or_expired: "This offer has expired or has already been accepted. If you accepted it, you will find it under Manage my booking.",
    continuation_invalid_or_expired: "This link has expired. Please start a new booking below.",
    consent_required: "Please tick the box so the clinic may contact you about free times.",
    contact_required: "Please give your name and a phone number or email.",
    invalid_date: "Please check the dates.",
    invalid_date_range: "The 'until' date must be after the 'from' date.",
    waitlist_limit_reached: "You're already on the waiting list for several treatments.",
    rate_limited: "Too many requests. Please wait a minute and try again.",
    uncertain: "We couldn't confirm the result because of a connection problem. Please don't book again. We are checking and will contact you; you can also check under 'Manage my booking'.",
    network_error: "No connection. Please check your internet and try again.",
    service_unavailable: "Online booking is temporarily offline. Please try again in a few minutes, or call the clinic.",
    timeout: "Online booking is temporarily offline. Please try again in a few minutes, or call the clinic.",
    invalid_token: "This link isn't valid. Please use the newest reminder we sent you, or call the clinic.",
    appointment_not_active: "This appointment is no longer active (it was cancelled or has already passed). You can book a new time below.",
    appointment_changed: "Your appointment time has changed since this reminder was sent. Please check the new time under 'Manage my booking'.",
    server_not_configured: "Online booking is temporarily unavailable. Please call the clinic.",
    server_auth_failed: "Online booking is temporarily unavailable. Please call the clinic.",
    invalid_input: "Some details were not valid. Please check and try again.",
    internal_error: "Something went wrong on our side. Please try again or call the clinic.",
    patient_name_required: "Please enter your full name."
  };
  // Banner shown on every page while the booking system can't be reached; it disappears on the next good answer.
  var OFFLINE = ["service_unavailable", "timeout", "server_not_configured", "server_auth_failed"];
  function offline(on, text) {
    var b = document.getElementById("avOffline");
    if (!on) { if (b) b.hidden = true; return; }
    if (!b) {
      b = document.createElement("div"); b.id = "avOffline"; b.className = "offline"; b.setAttribute("role", "alert");
      var host = document.querySelector(".wrap, .shell") || document.body;
      host.insertBefore(b, host.firstChild);
    }
    b.textContent = text || ("Online booking is temporarily offline. Appointments you already have are safe. Please try again in a few minutes" +
      (CFG.clinicPhone ? ", or call " + CFG.clinicPhone + "." : ", or call the clinic."));
    b.hidden = false;
  }

  function say(status) { return TEXT[status] || "Something went wrong. Please try again."; }

  var catalog = null;
  async function getCatalog() {
    if (catalog) return catalog;
    var c = await api("catalog", {});
    if (c && c.success) catalog = c;
    return c;
  }

  function fmtTime(isoStr, tz) {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(isoStr));
  }
  function fmtDate(isoStr, tz) {
    return new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: tz }).format(new Date(isoStr));
  }
  function localToday(tz) {
    var p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    var g = function (t) { return p.find(function (x) { return x.type === t; }).value; };
    return g("year") + "-" + g("month") + "-" + g("day");
  }
  function addDays(ymd, n) {
    var d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  function $(id) { return document.getElementById(id); }
  function show(id, cls, text) { var el = $(id); el.className = "msg " + (cls || ""); el.textContent = text || ""; }
  function step(prefix, n) {
    document.querySelectorAll("." + prefix).forEach(function (s) { s.classList.remove("on"); });
    var el = $(prefix + n); el.classList.add("on");
    var h = el.querySelector("h2"); if (h) { h.setAttribute("tabindex", "-1"); h.focus(); }
  }
  function busy(btn, on, label) {
    if (!btn) return;
    if (on) { btn.dataset.label = btn.textContent; btn.disabled = true; btn.textContent = label || "Please wait…"; }
    else { btn.disabled = false; if (btn.dataset.label) btn.textContent = btn.dataset.label; }
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  // .ics file so patients can add the appointment to their own calendar.
  function icsDownload(title, startIso, endIso, location) {
    var f = function (d) { return new Date(d).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); };
    var body = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//AVENSO//Reception OS//EN", "BEGIN:VEVENT",
      "UID:" + uuid() + "@avenso", "DTSTAMP:" + f(Date.now()), "DTSTART:" + f(startIso), "DTEND:" + f(endIso),
      "SUMMARY:" + String(title).replace(/[,;\n]/g, " "), location ? "LOCATION:" + String(location).replace(/[,;\n]/g, " ") : "",
      "END:VEVENT", "END:VCALENDAR"].filter(Boolean).join("\r\n");
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([body], { type: "text/calendar" }));
    a.download = "appointment.ics"; document.body.appendChild(a); a.click(); a.remove();
  }

  function applyBranding(name) {
    var n = CFG.clinicName || name;
    if (n) { document.querySelectorAll("[data-clinic-name]").forEach(function (e) { e.textContent = n; }); document.title = document.title.replace("Clinic", n); }
    document.querySelectorAll("[data-clinic-phone]").forEach(function (e) {
      if (CFG.clinicPhone) { e.innerHTML = '<a href="tel:' + esc(CFG.clinicPhone.replace(/[^+\d]/g, "")) + '">' + esc(CFG.clinicPhone) + "</a>"; }
      else { e.textContent = "the clinic"; }
    });
    document.querySelectorAll("[data-emergency-number]").forEach(function (e) {
      e.textContent = CFG.emergencyNumber ? CFG.emergencyNumber : "your local emergency number";
    });
  }

  window.AV = { api: api, say: say, uuid: uuid, getCatalog: getCatalog, fmtTime: fmtTime, fmtDate: fmtDate,
    localToday: localToday, addDays: addDays, $: $, show: show, step: step, busy: busy, esc: esc,
    icsDownload: icsDownload, applyBranding: applyBranding, CFG: CFG, offline: offline, OFFLINE: OFFLINE };
})();
