// Waiting-list offer link: /offer.html?token=<offer_token>[&starts=<iso>] (starts is display-only).
(function () {
  "use strict";
  var A = window.AV, $ = A.$;
  var q = new URLSearchParams(location.search), token = q.get("token"), starts = q.get("starts");
  var rid = A.uuid(), tz = "UTC";
  document.addEventListener("click", function (e) { var h = e.target.closest("[data-href]"); if (h) location.href = h.getAttribute("data-href"); });
  A.getCatalog().then(function (c) {
    if (c && c.success) { tz = c.clinic.timezone; A.applyBranding(c.clinic.name); }
    if (starts && !isNaN(Date.parse(starts))) $("offerWhen").textContent = "A time has become free on " + A.fmtDate(starts, tz) + " at " + A.fmtTime(starts, tz) + ". Offers last 15 minutes and go to the first person who accepts.";
  });
  if (!token || !/^[0-9a-f-]{36}$/i.test(token)) { $("accept").disabled = true; A.show("oMsg", "err", A.say("offer_invalid_or_expired")); return; }
  $("accept").addEventListener("click", async function () {
    A.busy($("accept"), true, "Booking…");
    var r = await A.api("waitlist-accept", { offer_token: token }, rid);
    A.busy($("accept"), false);
    if (r.success && r.status === "confirmed") {
      $("oSummary").innerHTML = "<div><span>Date</span><span>" + A.esc(A.fmtDate(r.starts_at, tz)) + "</span></div><div><span>Time</span><span>" + A.esc(A.fmtTime(r.starts_at, tz)) + "</span></div>";
      history.replaceState(null, "", location.pathname);
      A.step("o", 2);
    } else if (r.status === "uncertain") A.show("oMsg", "warn", A.say("uncertain"));
    else { $("accept").disabled = true; A.show("oMsg", "err", A.say(r.status === "slot_taken" ? "offer_invalid_or_expired" : r.status)); }
  });
})();
