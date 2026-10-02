// Public booking flow: emergency check -> treatment/date -> slot hold (countdown) -> details -> confirm.
(function () {
  "use strict";
  var A = window.AV, $ = A.$;
  var cat = null, tz = "UTC", held = null, timerId = null, booked = null;
  var commitRid = null; // one request id per confirm attempt; reused on retry

  function go(n) { A.step("b", n); }
  document.addEventListener("click", function (e) {
    var g = e.target.closest("[data-goto]"); if (g) { go(g.getAttribute("data-goto")); }
    var h = e.target.closest("[data-href]"); if (h) { location.href = h.getAttribute("data-href"); }
  });

  // ---------- catalog ----------
  async function loadCatalog() {
    cat = await A.getCatalog();
    if (!cat || !cat.success) { A.show("resumeMsg", "err", A.say(cat && cat.status)); return false; }
    tz = cat.clinic.timezone; A.applyBranding(cat.clinic.name);
    $("tzName").textContent = tz.replace(/_/g, " ");
    var sel = $("service"); sel.innerHTML = "";
    cat.services.forEach(function (s) {
      var o = document.createElement("option"); o.value = s.key;
      o.textContent = s.name + (s.bookable ? (s.duration_minutes ? " (" + s.duration_minutes + " min)" : "") : " — call to arrange");
      sel.appendChild(o);
    });
    var today = A.localToday(tz);
    $("date").min = today; $("date").max = A.addDays(today, cat.booking.horizon_days);
    $("date").value = A.addDays(today, 1);
    $("wFrom").min = today; $("wTo").min = today;
    fillDoctors();
    return true;
  }
  function service() { return cat.services.find(function (s) { return s.key === $("service").value; }); }
  function fillDoctors() {
    var s = service(), d = $("doctor"), keep = d.value;
    d.innerHTML = '<option value="">Any available doctor</option>';
    (s ? s.doctors : []).forEach(function (k) {
      var doc = cat.doctors.find(function (x) { return x.key === k; });
      if (doc) { var o = document.createElement("option"); o.value = doc.key; o.textContent = doc.name; d.appendChild(o); }
    });
    if ([].some.call(d.options, function (o) { return o.value === keep; })) d.value = keep;
  }
  $("service").addEventListener("change", function () { fillDoctors(); $("slots").innerHTML = ""; A.show("slotsMsg", "", ""); });

  // ---------- step 1 ----------
  $("notEmergency").addEventListener("click", function () { go(2); });
  $("isEmergency").addEventListener("click", function () { go("1e"); });
  $("emergencyForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var name = $("eName").value.trim(), phone = $("ePhone").value.trim(), msg = $("eMsg").value.trim();
    if (!name || !phone || !msg) { A.show("eOut", "err", "Please fill in all three boxes so the clinic can call you."); return; }
    A.busy($("eSend"), true, "Sending…");
    var r = await A.api("emergency", { name: name, phone: phone, message: msg });
    A.busy($("eSend"), false);
    if (r.success) {
      A.show("eOut", "ok", r.status === "use_approved_emergency_policy" && r.approved_script
        ? r.approved_script
        : "Thank you. Your request is marked URGENT and the clinic will call you back as soon as possible. If things get worse, call your local emergency number.");
      $("eSend").disabled = true;
    } else A.show("eOut", "err", A.say(r.status));
  });

  // ---------- step 2: availability ----------
  async function findTimes(date, auto) {
    var s = service(); if (!s) return;
    if (!s.bookable) { go("2m"); return; }
    $("slots").innerHTML = ""; $("nextDay").hidden = true; $("toWaitlist").hidden = true;
    A.show("slotsMsg", "", "Looking for free times…");
    // "Any doctor": ask for every doctor who offers the treatment and merge the free times.
    var docs = $("doctor").value ? [$("doctor").value] : (s.doctors.length ? s.doctors : [undefined]);
    var all = await Promise.all(docs.map(function (d) { return A.api("availability", { service: s.key, date: date, doctor: d }); }));
    var good = all.filter(function (x) { return x && x.success; });
    if (!good.length) { A.show("slotsMsg", "err", A.say(all[0] && all[0].status)); $("toWaitlist").hidden = false; return false; }
    var r = { success: true, slots: [].concat.apply([], good.map(function (x) { return x.slots || []; }))
      .sort(function (a, b) { return Date.parse(a.start_at) - Date.parse(b.start_at) || String(a.doctor_name).localeCompare(b.doctor_name); }) };
    if (!r.slots || !r.slots.length) {
      if (!auto) A.show("slotsMsg", "warn", "No free times on " + A.fmtDate(date + "T12:00:00Z", "UTC") + ".");
      $("nextDay").hidden = false; $("toWaitlist").hidden = false; return false;
    }
    A.show("slotsMsg", "ok", A.fmtDate(r.slots[0].start_at, tz) + " — choose a time:");
    r.slots.forEach(function (sl) {
      var b = document.createElement("button"); b.type = "button"; b.className = "slot"; b.setAttribute("role", "listitem");
      b.innerHTML = "<b>" + A.esc(A.fmtTime(sl.start_at, tz)) + "</b><span>" + A.esc(sl.doctor_name) + "</span>";
      b.addEventListener("click", function () { hold(sl, s, b); });
      $("slots").appendChild(b);
    });
    $("toWaitlist").hidden = false;
    return true;
  }
  $("find").addEventListener("click", async function () {
    if (!$("date").value) { A.show("slotsMsg", "err", "Please choose a date."); return; }
    A.busy($("find"), true, "Searching…"); await findTimes($("date").value); A.busy($("find"), false);
  });
  $("nextDay").addEventListener("click", async function () {
    var btn = $("nextDay"); A.busy(btn, true, "Searching the next 14 days…");
    var d = $("date").value || A.localToday(tz);
    for (var i = 1; i <= 14; i++) {
      var next = A.addDays(d, i); if (next > $("date").max) break;
      $("date").value = next;
      if (await findTimes(next, true)) { A.busy(btn, false); btn.hidden = true; return; }
    }
    A.busy(btn, false); A.show("slotsMsg", "warn", "No free times in the next two weeks. Join the waiting list and we'll offer you the first opening.");
  });
  $("toWaitlist").addEventListener("click", function () { go(5); });

  // ---------- step 3: hold + details ----------
  async function hold(slot, s, btn) {
    A.busy(btn, true, "Holding…");
    var r = await A.api("hold", { service: s.key, starts_at: slot.start_at, doctor: slot.doctor_key });
    A.busy(btn, false);
    if (!r.success || r.status !== "held") {
      if (r.status === "slot_taken") {
        await findTimes($("date").value);
        A.show("slotsMsg", "err", A.say("slot_taken") + " The list below has been refreshed.");
      } else A.show("slotsMsg", "err", A.say(r.status));
      return;
    }
    held = { op: r.operation_id, token: r.hold_token, exp: Date.parse(r.expires_at), slot: slot, service: s };
    commitRid = A.uuid();
    $("heldSummary").innerHTML = summary(s.name, slot.doctor_name, slot.start_at);
    A.show("confirmMsg", "", "");
    go(3); startTimer();
  }
  function summary(serviceName, doctorName, startIso) {
    return "<div><span>Treatment</span><span>" + A.esc(serviceName) + "</span></div>" +
      "<div><span>Doctor</span><span>" + A.esc(doctorName) + "</span></div>" +
      "<div><span>Date</span><span>" + A.esc(A.fmtDate(startIso, tz)) + "</span></div>" +
      "<div><span>Time</span><span>" + A.esc(A.fmtTime(startIso, tz)) + "</span></div>";
  }
  function startTimer() {
    clearInterval(timerId);
    var tick = function () {
      var left = Math.max(0, Math.round((held.exp - Date.now()) / 1000));
      $("timer").textContent = Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0");
      if (left <= 0) {
        clearInterval(timerId);
        A.show("confirmMsg", "err", A.say("hold_expired")); $("confirm").disabled = true;
      }
    };
    $("confirm").disabled = false; tick(); timerId = setInterval(tick, 1000);
  }
  $("releaseBack").addEventListener("click", async function () {
    clearInterval(timerId);
    if (held) A.api("release-hold", { operation_id: held.op, hold_token: held.token });
    held = null; go(2); findTimes($("date").value);
  });
  $("detailsForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    if (!held) return;
    var name = $("pName").value.trim(), phone = $("pPhone").value.trim(), email = $("pEmail").value.trim();
    if (name.length < 2) { A.show("confirmMsg", "err", "Please enter your full name."); $("pName").focus(); return; }
    if (!/^\+?[0-9 ()-]{7,20}$/.test(phone)) { A.show("confirmMsg", "err", "Please enter a valid mobile number, including the country code (e.g. +1 868…)."); $("pPhone").focus(); return; }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { A.show("confirmMsg", "err", "Please check your email address."); $("pEmail").focus(); return; }
    A.busy($("confirm"), true, "Confirming…");
    var r = await A.api("commit-hold", { operation_id: held.op, hold_token: held.token,
      patient: { full_name: name, phone_e164: phone, email: email || undefined } }, commitRid);
    A.busy($("confirm"), false);
    if (r.success && r.status === "confirmed") {
      clearInterval(timerId);
      booked = { start: r.starts_at || held.slot.start_at, end: r.ends_at || held.slot.end_at, service: held.service.name, doctor: held.slot.doctor_name };
      $("doneSummary").innerHTML = summary(booked.service, booked.doctor, booked.start) +
        "<div><span>Name</span><span>" + A.esc(name) + "</span></div>";
      held = null; go(4);
    } else if (r.status === "uncertain") {
      clearInterval(timerId); $("confirm").disabled = true;
      A.show("confirmMsg", "warn", A.say("uncertain"));
    } else {
      A.show("confirmMsg", "err", A.say(r.status));
      if (["hold_expired", "hold_not_active", "hold_not_found"].indexOf(r.status) >= 0) { clearInterval(timerId); $("confirm").disabled = true; }
    }
  });
  window.addEventListener("pagehide", function () {
    if (held && navigator.sendBeacon) {
      navigator.sendBeacon("/api/public/release-hold", new Blob([JSON.stringify({ operation_id: held.op, hold_token: held.token, request_id: A.uuid() })], { type: "application/json" }));
    }
  });
  $("addCal").addEventListener("click", function () {
    if (booked) A.icsDownload(booked.service + " — " + (A.CFG.clinicName || (cat && cat.clinic.name) || "Clinic"), booked.start, booked.end, A.CFG.clinicName || (cat && cat.clinic.name));
  });

  // ---------- 2m: call-back request ----------
  $("msgForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var s = service();
    var name = $("mName").value.trim(), phone = $("mPhone").value.trim(), email = $("mEmail").value.trim();
    if (!name || (!phone && !email)) { A.show("mOut", "err", A.say("contact_required")); return; }
    A.busy($("mSend"), true, "Sending…");
    var r = await A.api("message", { name: name, phone: phone || undefined, email: email || undefined,
      message: "Call-back request (" + (s ? s.name : "treatment") + "): " + ($("mText").value.trim() || "Please call me to arrange.") });
    A.busy($("mSend"), false);
    A.show("mOut", r.success ? "ok" : "err", r.success ? "Thank you. The clinic will call you to arrange this." : A.say(r.status));
    if (r.success) $("mSend").disabled = true;
  });

  // ---------- 5: waiting list ----------
  $("wlForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var s = service();
    var body = { full_name: $("wName").value.trim(), phone: $("wPhone").value.trim() || undefined, email: $("wEmail").value.trim() || undefined,
      service: s && s.key, doctor: $("doctor").value || undefined,
      earliest_date: $("wFrom").value || undefined, latest_date: $("wTo").value || undefined,
      consent_to_contact: $("wConsent").checked === true };
    if (!body.consent_to_contact) { A.show("wOut", "err", A.say("consent_required")); return; }
    if (!body.full_name || (!body.phone && !body.email)) { A.show("wOut", "err", A.say("contact_required")); return; }
    A.busy($("wSend"), true, "Saving…");
    var r = await A.api("waitlist-join", body);
    A.busy($("wSend"), false);
    if (r.success) { A.show("wOut", "ok", r.status === "waitlist_updated" ? "Your waiting-list preferences were updated." : "You're on the waiting list. We'll message you if an earlier time frees up."); $("wSend").disabled = true; }
    else A.show("wOut", "err", A.say(r.status));
  });

  // ---------- start ----------
  (async function init() {
    var ok = await loadCatalog(); if (!ok) return;
    var token = new URLSearchParams(location.search).get("resume");
    if (token) {
      var r = await A.api("continuity-resume", { continuation_token: token });
      if (r.success && r.context) {
        var c = r.context;
        if (c.service && cat.services.some(function (s) { return s.key === c.service; })) { $("service").value = c.service; fillDoctors(); }
        if (c.doctor) $("doctor").value = c.doctor;
        if (c.date && /^\d{4}-\d{2}-\d{2}$/.test(c.date)) $("date").value = c.date;
        if (c.full_name || c.name) { $("pName").value = c.full_name || c.name; $("wName").value = c.full_name || c.name; }
        if (c.phone) { $("pPhone").value = c.phone; $("wPhone").value = c.phone; }
        history.replaceState(null, "", location.pathname);
        go(2); A.show("slotsMsg", "ok", "Welcome back — we've filled in what you told us on the phone."); findTimes($("date").value, true);
      } else A.show("resumeMsg", "warn", A.say(r.status || "continuation_invalid_or_expired"));
    }
  })();
})();
