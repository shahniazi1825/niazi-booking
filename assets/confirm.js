// "Confirm you're coming" link from the 24-hour reminder: /confirm.html?t=<token>.
// The patient presses a button (link scanners in email apps never confirm by just opening the page).
(function () {
  "use strict";
  var A = window.AV, $ = A.$;
  var token = new URLSearchParams(location.search).get("t") || "";
  var rid = A.uuid(), appt = null;
  document.addEventListener("click", function (e) { var h = e.target.closest("[data-href]"); if (h) location.href = h.getAttribute("data-href"); });
  A.applyBranding();
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) { $("yes").disabled = true; A.show("cMsg", "err", A.say("invalid_token")); return; }

  $("yes").addEventListener("click", async function () {
    A.busy($("yes"), true, "Confirming…");
    var r = await A.api("confirm-attendance", { token: token }, rid);
    A.busy($("yes"), false);
    if (r.success && (r.status === "attendance_confirmed" || r.status === "already_confirmed")) {
      appt = r; var tz = r.timezone || "UTC";
      if (r.clinic_name) A.applyBranding(r.clinic_name);
      var row = function (k, v) { return v ? "<div><span>" + A.esc(k) + "</span><span>" + A.esc(v) + "</span></div>" : ""; };
      $("cSummary").innerHTML = row("Date", A.fmtDate(r.starts_at, tz)) + row("Time", A.fmtTime(r.starts_at, tz)) + row("Treatment", r.service_name) + row("With", r.doctor_name);
      if (r.status === "already_confirmed") $("cOk").textContent = "You've already confirmed. The clinic knows you're coming.";
      history.replaceState(null, "", location.pathname); // keep the link out of the address bar and history
      A.step("c", 2);
    } else if (r.status === "uncertain") {
      A.show("cMsg", "warn", "We couldn't reach the clinic system just now. Please try again in a few minutes. Your appointment is unchanged.");
    } else {
      if (["invalid_token", "appointment_not_active", "appointment_changed"].indexOf(r.status) >= 0) $("yes").disabled = true;
      A.show("cMsg", "err", A.say(r.status));
    }
  });
  $("cIcs").addEventListener("click", function () {
    if (appt) A.icsDownload((appt.service_name || "Appointment") + (appt.clinic_name ? " — " + appt.clinic_name : ""), appt.starts_at, appt.ends_at, appt.clinic_name);
  });
})();
