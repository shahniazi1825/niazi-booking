// Manage booking: verify by code -> list upcoming -> cancel (two-step) or reschedule (two-step).
(function () {
  "use strict";
  var A = window.AV, $ = A.$;
  var cat = null, tz = "UTC", session = null, challenge = null, current = null, newSlot = null;
  var cancelPreview = null, cancelRid = null, moveRid = null;
  var KEY = "avenso_manage_session";

  function go(n) { A.step("m", n); }
  document.addEventListener("click", function (e) {
    var g = e.target.closest("[data-goto]"); if (g) go(g.getAttribute("data-goto"));
  });
  function saveSession(s) { session = s; try { sessionStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {} }
  function loadSession() {
    try { var s = JSON.parse(sessionStorage.getItem(KEY) || "null"); if (s && Date.parse(s.expires_at) > Date.now() + 30000) return s; } catch (e) {}
    return null;
  }
  function expired(status) {
    if (status === "verification_required") {
      try { sessionStorage.removeItem(KEY); } catch (e) {}
      session = null; go(1); A.show("m1Msg", "warn", "For your security, please confirm it's you again.");
      return true;
    }
    return false;
  }

  $("startForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var phone = $("vPhone").value.trim(), email = $("vEmail").value.trim();
    if (!phone && !email) { A.show("m1Msg", "err", "Please enter your mobile number or email."); return; }
    A.busy($("sendCode"), true, "Sending…");
    var r = await A.api("verification-start", { phone: phone || undefined, email: email || undefined });
    A.busy($("sendCode"), false);
    if (!r.success) { A.show("m1Msg", "err", A.say(r.status)); return; }
    challenge = r.challenge_id || null; // absent when no match: we don't reveal whether a patient exists
    $("vCode").value = r.debug_code || ""; // staging only (mock delivery); never present in production
    A.show("m2Msg", r.debug_code ? "warn" : "", r.debug_code ? "Test mode: the code has been filled in for you." : "");
    go(2);
  });

  $("codeForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var code = $("vCode").value.trim();
    if (!/^\d{6}$/.test(code)) { A.show("m2Msg", "err", "Please enter the 6-digit code."); return; }
    if (!challenge) { A.show("m2Msg", "err", A.say("verification_failed")); return; }
    A.busy($("checkCode"), true, "Checking…");
    var r = await A.api("verification-check", { challenge_id: challenge, code: code });
    A.busy($("checkCode"), false);
    if (!r.success) { A.show("m2Msg", "err", A.say(r.status)); return; }
    saveSession({ token: r.verification_session, expires_at: r.expires_at });
    await list();
  });

  async function list() {
    go(3); $("list").innerHTML = '<p class="spin">Loading…</p>'; A.show("m3Msg", "", "");
    var r = await A.api("find", { verification_session: session.token });
    if (expired(r.status)) return;
    $("list").innerHTML = "";
    if (!r.success || !r.appointments || !r.appointments.length) {
      A.show("m3Msg", "warn", "You have no upcoming appointments."); return;
    }
    r.appointments.forEach(function (a) {
      var d = document.createElement("div"); d.className = "appt";
      d.innerHTML = "<b>" + A.esc(A.fmtDate(a.starts_at, tz)) + " at " + A.esc(A.fmtTime(a.starts_at, tz)) + "</b>" +
        '<div class="muted">' + A.esc(a.service_name || "Appointment") + " with " + A.esc(a.doctor_name) + "</div>" +
        '<div class="actions"><button type="button" class="ghost" data-act="move">Change time</button><button type="button" class="ghost" data-act="cancel">Cancel</button></div>';
      d.querySelector('[data-act="cancel"]').addEventListener("click", function () { startCancel(a, this); });
      d.querySelector('[data-act="move"]').addEventListener("click", function () { startMove(a); });
      $("list").appendChild(d);
    });
  }
  function sum(a, startIso) {
    return "<div><span>Treatment</span><span>" + A.esc(a.service_name || "Appointment") + "</span></div>" +
      "<div><span>Doctor</span><span>" + A.esc(a.doctor_name) + "</span></div>" +
      "<div><span>Date</span><span>" + A.esc(A.fmtDate(startIso, tz)) + "</span></div>" +
      "<div><span>Time</span><span>" + A.esc(A.fmtTime(startIso, tz)) + "</span></div>";
  }

  // ----- cancel: preview gives a one-time confirmation token; commit needs explicit_confirm=true
  async function startCancel(a, btn) {
    A.busy(btn, true, "…");
    var r = await A.api("cancel-preview", { appointment_id: a.appointment_id, verification_session: session.token });
    A.busy(btn, false);
    if (expired(r.status)) return;
    if (!r.success) { A.show("m3Msg", "err", A.say(r.status)); return; }
    current = a; cancelPreview = r; cancelRid = A.uuid();
    $("cancelSummary").innerHTML = sum(a, a.starts_at); A.show("m4Msg", "", ""); $("cancelYes").disabled = false;
    go(4);
  }
  $("cancelYes").addEventListener("click", async function () {
    A.busy(this, true, "Cancelling…");
    var r = await A.api("cancel-commit", { confirmation_token: cancelPreview.confirmation_token, verification_session: session.token, explicit_confirm: true }, cancelRid);
    A.busy(this, false);
    if (expired(r.status)) return;
    if (r.success && r.status === "cancelled") { this.disabled = true; A.show("m4Msg", "ok", "Your appointment has been cancelled. Thank you for letting us know."); setTimeout(list, 2500); }
    else A.show("m4Msg", r.status === "uncertain" ? "warn" : "err", A.say(r.status));
  });

  // ----- reschedule: original stays booked until the new time is committed
  function keyFor(list, name) { var x = (list || []).find(function (i) { return i.name === name; }); return x && x.key; }
  function startMove(a) {
    current = a; newSlot = null;
    $("reSummary").innerHTML = sum(a, a.starts_at); $("reSlots").innerHTML = ""; A.show("m5Msg", "", "");
    var today = A.localToday(tz); $("reDate").min = today; $("reDate").max = A.addDays(today, cat.booking.horizon_days);
    $("reDate").value = A.addDays(today, 1);
    go(5);
  }
  $("reFind").addEventListener("click", async function () {
    var service = keyFor(cat.services, current.service_name), doctor = keyFor(cat.doctors, current.doctor_name);
    if (!service) { A.show("m5Msg", "err", "Please call the clinic to move this appointment."); return; }
    A.busy(this, true, "Searching…"); $("reSlots").innerHTML = "";
    var r = await A.api("availability", { service: service, date: $("reDate").value, doctor: doctor });
    A.busy(this, false);
    if (!r.success) { A.show("m5Msg", "err", A.say(r.status)); return; }
    if (!r.slots.length) { A.show("m5Msg", "warn", A.say("no_slots")); return; }
    A.show("m5Msg", "ok", "Choose a new time with " + current.doctor_name + ":");
    r.slots.forEach(function (sl) {
      var b = document.createElement("button"); b.type = "button"; b.className = "slot";
      b.innerHTML = "<b>" + A.esc(A.fmtTime(sl.start_at, tz)) + "</b><span>" + A.esc(A.fmtDate(sl.start_at, tz).split(",")[0]) + "</span>";
      b.addEventListener("click", function () {
        newSlot = sl; moveRid = A.uuid();
        $("moveSummary").innerHTML = "<div><span>From</span><span>" + A.esc(A.fmtDate(current.starts_at, tz)) + ", " + A.esc(A.fmtTime(current.starts_at, tz)) + "</span></div>" +
          "<div><span>To</span><span>" + A.esc(A.fmtDate(sl.start_at, tz)) + ", " + A.esc(A.fmtTime(sl.start_at, tz)) + "</span></div>";
        A.show("m6Msg", "", ""); $("moveYes").disabled = false; go(6);
      });
      $("reSlots").appendChild(b);
    });
  });
  $("moveYes").addEventListener("click", async function () {
    A.busy(this, true, "Moving…");
    var r = await A.api("reschedule", { appointment_id: current.appointment_id, new_starts_at: newSlot.start_at, verification_session: session.token, explicit_confirm: true }, moveRid);
    A.busy(this, false);
    if (expired(r.status)) return;
    if (r.success) { this.disabled = true; A.show("m6Msg", "ok", "Done — your appointment has been moved."); setTimeout(list, 2500); }
    else A.show("m6Msg", r.status === "uncertain" ? "warn" : "err", A.say(r.status) + (r.status === "slot_taken" ? " Your original appointment is unchanged." : ""));
  });

  (async function init() {
    cat = await A.getCatalog();
    if (cat && cat.success) { tz = cat.clinic.timezone; A.applyBranding(cat.clinic.name); }
    var s = loadSession(); if (s) { session = s; await list(); }
  })();
})();
