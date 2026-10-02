// AVENSO v2 staff portal. Talks only to /api/staff/* (cookie session) and /api/public/catalog.
(function () {
  "use strict";
  var A = window.AV, $ = A.$;
  var me = null, cat = null, tz = "UTC", refreshTimer = null, bookSel = null;
  var STATUS = {
    forbidden_for_role: "Your role can't do this.", not_signed_in: "Please sign in again.", no_clinic_access: "This account has no access to a clinic yet. Ask the clinic admin.",
    invalid_login: "Email or password is wrong.", phone_belongs_to_another_patient: "That phone number belongs to another patient record.",
    email_belongs_to_another_patient: "That email belongs to another patient record.", note_required: "Please add a short note.",
    already_closed: "This task was already closed.", visit_not_started: "You can only mark this after the appointment time.",
    not_confirmed: "This appointment is no longer confirmed.", query_too_short: "Type at least 3 characters.",
    override_reason_required: "A reason is required for an override.", unchanged: "Nothing changed."
  };
  var say = function (s) { return STATUS[s] || A.say(s); };
  var writer = function () { return me && me.role !== "viewer"; };
  var manager = function () { return me && (me.role === "manager" || me.role === "admin"); };

  async function call(path, body, method) {
    try {
      var r = await fetch(path, { method: method || "POST", headers: { "content-type": "application/json" }, credentials: "same-origin",
        body: method === "GET" ? undefined : JSON.stringify(Object.assign({ request_id: A.uuid() }, body || {})) });
      var j = await r.json().catch(function () { return { success: false, status: "service_unavailable" }; });
      if (r.status === 401 && path.indexOf("/session") < 0) { showLogin("Your session ended. Please sign in again."); }
      return j;
    } catch (e) { return { success: false, status: "network_error" }; }
  }
  var api = function (op, body) { return call("/api/staff/" + op, body); };

  function show(view) { document.querySelectorAll(".v").forEach(function (s) { s.classList.remove("on"); }); $(view).classList.add("on"); }
  function showLogin(msg) { me = null; clearInterval(refreshTimer); $("nav").hidden = true; $("who").textContent = "Staff sign-in"; show("login"); A.show("lMsg", msg ? "warn" : "", msg || ""); }
  function signedIn(user, memberships) {
    me = user; tz = user.timezone || tz;
    $("who").textContent = user.email + " · " + user.role; $("nav").hidden = false;
    document.querySelectorAll("[data-clinic-name]").forEach(function (e) { e.textContent = user.clinic_name || "Front desk"; });
    var sw = $("clinicSwitch"); sw.innerHTML = "";
    (memberships || []).forEach(function (m) { var o = document.createElement("option"); o.value = m.clinic_slug; o.textContent = m.clinic_name + " (" + m.role + ")"; sw.appendChild(o); });
    sw.value = user.clinic_slug; sw.hidden = !memberships || memberships.length < 2;
    document.querySelectorAll(".writer").forEach(function (e) { e.hidden = !writer(); });
    $("bOverride").hidden = !manager();
    $("insightsLink").hidden = !manager();
    show("app"); $("dDate").value = A.localToday(tz); loadDashboard();
    clearInterval(refreshTimer); refreshTimer = setInterval(function () { if (!document.hidden && $("t-today").classList.contains("on")) loadDashboard(true); }, 60000);
  }

  // ---------- session ----------
  $("loginForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var em = $("lEmail").value.trim(), pw = $("lPass").value;
    if (!em || !pw) { A.show("lMsg", "err", "Enter your email and password."); return; }
    A.busy($("lBtn"), true, "Signing in…");
    var r = await call("/api/staff/session", { action: "login", email: em, password: pw });
    A.busy($("lBtn"), false); $("lPass").value = "";
    if (r.success) signedIn(r.user, r.memberships); else A.show("lMsg", "err", say(r.status));
  });
  $("logout").addEventListener("click", async function (e) { e.preventDefault(); await call("/api/staff/session", { action: "logout" }); showLogin("You are signed out."); });
  $("clinicSwitch").addEventListener("change", async function () {
    var r = await call("/api/staff/session", { action: "switch", clinic_slug: this.value });
    if (r.success) { var m = await call("/api/staff/session", null, "GET"); if (m.success) signedIn(m.user, m.memberships); } else alert(say(r.status));
  });

  // ---------- tabs ----------
  document.querySelectorAll(".tab").forEach(function (t) {
    t.addEventListener("click", function () {
      document.querySelectorAll(".tab").forEach(function (x) { x.classList.remove("on"); });
      document.querySelectorAll(".pane").forEach(function (x) { x.classList.remove("on"); });
      t.classList.add("on"); $("t-" + t.dataset.tab).classList.add("on");
      if (t.dataset.tab === "book") initBook();
      if (t.dataset.tab === "today") loadDashboard();
    });
  });

  // ---------- dialog ----------
  function dialog(html) { $("dlgBody").innerHTML = html; $("dlg").showModal(); return $("dlgBody"); }
  $("dlgClose").addEventListener("click", function () { $("dlg").close(); });
  function confirmBox(title, html, okText, danger) {
    return new Promise(function (resolve) {
      var b = dialog("<h2>" + A.esc(title) + "</h2>" + html + '<button type="button" id="cOk" class="' + (danger ? "danger" : "") + '">' + A.esc(okText) + "</button>");
      b.querySelector("#cOk").addEventListener("click", function () { $("dlg").close(); resolve(true); });
      $("dlg").addEventListener("close", function h() { $("dlg").removeEventListener("close", h); resolve(false); });
    });
  }
  function promptBox(title, label) {
    return new Promise(function (resolve) {
      var b = dialog("<h2>" + A.esc(title) + '</h2><label for="pIn">' + A.esc(label) + '</label><textarea id="pIn" maxlength="1000"></textarea><button type="button" id="pOk">Save</button>');
      b.querySelector("#pOk").addEventListener("click", function () { var v = b.querySelector("#pIn").value.trim(); $("dlg").close(); resolve(v || null); });
      $("dlg").addEventListener("close", function h() { $("dlg").removeEventListener("close", h); resolve(null); });
    });
  }

  // ---------- Today ----------
  function badge(s, extra) { return '<span class="badge ' + A.esc(s) + '">' + A.esc(extra || s.replace("_", " ")) + "</span>"; }
  async function loadDashboard(quiet) {
    if (!quiet) A.show("dMsg", "", "Loading…");
    var r = await api("dashboard", { date: $("dDate").value });
    if (!r.success) { A.show("dMsg", "err", say(r.status)); return; }
    A.show("dMsg", "", ""); tz = r.timezone || tz;
    var k = r.kpi, al = r.alerts, money = function (v) { return Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: 0 }); };
    $("kpis").innerHTML = [
      [k.bookings_today, "booked today"], [k.bookings_7d, "booked in 7 days"],
      [k.bookings_7d ? Math.round(100 * k.online_or_voice_7d / k.bookings_7d) + "%" : "–", "booked online/phone AI"],
      [k.cancellations_7d, "cancellations (7 days)"], [k.slots_refilled_30d, "slots refilled from waitlist (30 days)"],
      k.revenue_values_configured ? [money(k.revenue_recovered_30d), "revenue recovered from the waitlist (30 days)"] : ["–", "revenue recovered (ask your admin to add treatment prices)"],
      [k.no_shows_30d, "no-shows (30 days)"], [r.waitlist.active, "on waiting list"]
    ].map(function (x) { return '<div class="kpi"><b>' + A.esc(x[0]) + "</b><span>" + A.esc(x[1]) + "</span></div>"; }).join("");
    var warn = [];
    if (al.uncertain_operations) warn.push(al.uncertain_operations + " booking(s) being double-checked by the system — don't rebook them manually.");
    if (al.failed_notifications) warn.push(al.failed_notifications + " message(s) failed to send.");
    (al.open_incidents || []).filter(function (i) { return i.severity === "critical"; }).forEach(function (i) { warn.push("System alert: " + i.summary); });
    $("alerts").innerHTML = warn.map(function (w) { return '<div class="alert small">' + A.esc(w) + "</div>"; }).join("");

    $("appts").innerHTML = r.appointments.length ? "" : '<p class="empty">No appointments on this day.</p>';
    r.appointments.forEach(function (a) {
      var d = document.createElement("div"); d.className = "item";
      var started = Date.parse(a.starts_at) <= Date.now();
      d.innerHTML = '<div class="main"><b>' + A.esc(A.fmtTime(a.starts_at, tz)) + "</b> " + A.esc(a.patient_name) + badge(a.status) + (a.from_waitlist ? badge("wl", "from waitlist") : "") +
        '<div class="muted">' + A.esc(a.service_name || "") + " · " + A.esc(a.doctor_name) + " · " + A.esc(a.phone || a.email || "") + " · via " + A.esc(a.source_channel) + "</div></div>" +
        '<div class="acts"></div>';
      var acts = d.querySelector(".acts");
      var add = function (label, fn, cls) { var b = document.createElement("button"); b.type = "button"; b.className = cls || "ghost"; b.textContent = label; b.addEventListener("click", fn); acts.appendChild(b); };
      if (writer()) {
        add("History", function () { timeline(a.appointment_id); });
        if (a.status === "confirmed" && started) {
          add("Completed", function () { setStatus(a, "completed"); });
          add("No-show", function () { setStatus(a, "no_show"); });
        }
        if (a.status === "confirmed" && !started) {
          add("Move", function () { moveAppt(a); });
          add("Cancel", function () { cancelAppt(a); });
        }
      }
      $("appts").appendChild(d);
    });

    $("tasks").innerHTML = r.tasks.length ? "" : '<p class="empty">No open call-backs.</p>';
    var TASK_LIMIT = 8;
    r.tasks.forEach(function (t, i) {
      var d = document.createElement("div"); d.className = "item";
      if (i >= TASK_LIMIT && !showAllTasks) d.hidden = true;
      d.innerHTML = '<div class="main"><b>' + A.esc(t.name || "Unknown caller") + "</b>" + badge(t.priority === "urgent" ? "urgent" : t.status, t.priority === "urgent" ? "URGENT" : t.status.replace("_", " ")) +
        '<div class="muted">' + A.esc(t.phone || t.email || "") + " · " + A.esc(new Date(t.created_at).toLocaleString()) + " · via " + A.esc(t.source_channel) + "</div>" +
        (t.message ? "<div>" + A.esc(t.message) + "</div>" : "") + '</div><div class="acts"></div>';
      if (writer()) {
        var acts = d.querySelector(".acts");
        [["Working on it", "in_progress"], ["Done", "done"], ["Not needed", "cancelled"]].forEach(function (x) {
          if (x[1] === "in_progress" && t.status === "in_progress") return;
          var b = document.createElement("button"); b.type = "button"; b.className = "ghost"; b.textContent = x[0];
          b.addEventListener("click", async function () {
            var note = x[1] === "in_progress" ? null : await promptBox(x[0], "What happened? (saved with your name)");
            if (x[1] !== "in_progress" && !note) return;
            var res = await api("task-update", { task_id: t.task_id, status: x[1], note: note || undefined });
            if (!res.success) alert(say(res.status)); loadDashboard(true);
          });
          acts.appendChild(b);
        });
      }
      $("tasks").appendChild(d);
    });
    if (r.tasks.length > TASK_LIMIT && !showAllTasks) {
      var more = document.createElement("button"); more.type = "button"; more.className = "ghost";
      more.textContent = "Show all " + r.tasks.length + " call-backs";
      more.addEventListener("click", function () { showAllTasks = true; more.remove(); Array.prototype.forEach.call($("tasks").querySelectorAll(".item[hidden]"), function (x) { x.hidden = false; }); });
      $("tasks").appendChild(more);
    }
  }
  var showAllTasks = false;
  $("dRefresh").addEventListener("click", function () { loadDashboard(); });
  $("dDate").addEventListener("change", function () { loadDashboard(); });

  async function setStatus(a, st) {
    if (!(await confirmBox(st === "no_show" ? "Mark as no-show?" : "Mark as completed?", "<p>" + A.esc(a.patient_name) + " — " + A.esc(A.fmtTime(a.starts_at, tz)) + "</p>", "Yes", st === "no_show"))) return;
    var r = await api("appointment-status", { appointment_id: a.appointment_id, status: st });
    if (!r.success) alert(say(r.status)); loadDashboard(true);
  }
  async function timeline(id) {
    var b = dialog('<p class="spin">Loading history…</p>');
    var r = await api("timeline", { appointment_id: id });
    if (!r.success) { b.innerHTML = '<p class="msg err">' + A.esc(say(r.status)) + "</p>"; return; }
    var people = r.people || {};
    var who = function (type, id) {
      if (type === "staff_user") return people[id] || "Staff member";
      if (type === "public_proxy") return "Patient (online)";
      if (type === "voice_agent" || type === "voice") return "Phone assistant";
      if (type === "waitlist_offer") return "Waiting list";
      if (type === "system") return "System";
      return type ? String(type).replace(/_/g, " ") : "";
    };
    var OPS = { book: "Booking", cancel: "Cancellation", reschedule: "Move", hold: "Time held" };
    var STATES = { confirmed: "done", failed: "failed", rejected: "not allowed", uncertain: "being double-checked", held: "held", cancelled: "released", pending: "in progress" };
    var EVENTS = { appointment_confirmed: "Appointment confirmed", appointment_cancelled: "Appointment cancelled", appointment_rescheduled: "Appointment moved",
      appointment_no_show: "Marked as no-show", appointment_completed: "Marked as completed" };
    var TPL = { booking_confirmed: "Confirmation message", appointment_cancelled: "Cancellation message", verification_code: "Verification code",
      waitlist_slot_offer: "Waiting-list offer", appointment_rescheduled: "New-time message", reminder: "Reminder" };
    var NST = { queued: "waiting to send", sent: "sent", delivered: "delivered", failed: "failed", mock: "test mode (not really sent)" };
    var rows = [];
    r.operations.forEach(function (o) {
      var DONE = { book: "Booked", cancel: "Cancelled", reschedule: "Moved", hold: "Time held" };
      rows.push([o.created_at, o.state === "confirmed" && DONE[o.action] ? DONE[o.action] : (OPS[o.action] || o.action) + " " + (STATES[o.state] || o.state), [who(o.actor_type, o.actor_id), o.channel ? "via " + o.channel : "", o.error_code ? "reason: " + say(o.error_code) : ""].filter(Boolean).join(" · ")]);
    });
    r.events.forEach(function (e) { rows.push([e.occurred_at, EVENTS[e.event_type] || e.event_type.replace(/_/g, " "), who(e.actor_type, e.actor_id)]); });
    r.notifications.forEach(function (n) { rows.push([n.created_at, (TPL[n.template_key] || n.template_key.replace(/_/g, " ")) + " (" + n.channel + ")", (NST[n.status] || n.status) + (n.last_error ? " · " + n.last_error : "")]); });
    rows.sort(function (x, y) { return Date.parse(x[0]) - Date.parse(y[0]); });
    b.innerHTML = "<h2>Booking history</h2>" + (rows.length ? rows.map(function (x) { return '<div class="tl"><b>' + A.esc(x[1]) + "</b><br><small>" + A.esc(new Date(x[0]).toLocaleString()) + (x[2] ? " · " + A.esc(x[2]) : "") + "</small></div>"; }).join("") : '<p class="empty">No history recorded.</p>');
  }
  async function cancelAppt(a) {
    var p = await api("cancel-preview", { appointment_id: a.appointment_id });
    if (!p.success) { alert(say(p.status)); return; }
    if (!(await confirmBox("Cancel this appointment?", "<p>" + A.esc(a.patient_name) + " — " + A.esc(A.fmtDate(a.starts_at, tz)) + ", " + A.esc(A.fmtTime(a.starts_at, tz)) + "</p><p class='muted'>The time will be offered to the waiting list automatically.</p>", "Yes, cancel", true))) return;
    var r = await api("cancel-commit", { confirmation_token: p.confirmation_token, explicit_confirm: true });
    if (!r.success) alert(say(r.status)); refreshViews();
  }
  // After a change, refresh the day list AND any open patient search, so no screen shows stale appointments.
  function refreshViews() {
    loadDashboard(true);
    if ($("t-patients").classList.contains("on") && $("pQ").value.trim().length >= 3) $("pSearch").requestSubmit();
  }
  async function moveAppt(a) {
    var b = dialog('<h2>Move appointment</h2><p>' + A.esc(a.patient_name) + '</p><label for="mvDate">New date</label><input id="mvDate" type="date"><button type="button" id="mvFind" class="ghost">Show free times</button><div id="mvSlots" class="slots"></div><p id="mvMsg" class="msg"></p>');
    b.querySelector("#mvDate").value = A.localToday(tz);
    b.querySelector("#mvFind").addEventListener("click", async function () {
      var r = await api("availability", { service: a.service_key, doctor: a.doctor_key, date: b.querySelector("#mvDate").value });
      var box = b.querySelector("#mvSlots"); box.innerHTML = "";
      if (!r.success || !r.slots.length) { b.querySelector("#mvMsg").className = "msg warn"; b.querySelector("#mvMsg").textContent = say(r.success ? "no_slots" : r.status); return; }
      r.slots.forEach(function (sl) {
        var s = document.createElement("button"); s.type = "button"; s.className = "slot"; s.innerHTML = "<b>" + A.esc(A.fmtTime(sl.start_at, tz)) + "</b>";
        s.addEventListener("click", async function () {
          var rid = A.uuid();
          if (!(await confirmBox("Move appointment?", "<p>" + A.esc(a.patient_name) + "</p><p>From " + A.esc(A.fmtDate(a.starts_at, tz)) + ", " + A.esc(A.fmtTime(a.starts_at, tz)) + "<br>To " + A.esc(A.fmtDate(sl.start_at, tz)) + ", " + A.esc(A.fmtTime(sl.start_at, tz)) + "</p>", "Yes, move it"))) return;
          var res = await api("reschedule", { request_id: rid, appointment_id: a.appointment_id, new_starts_at: sl.start_at, explicit_confirm: true });
          if (!res.success) alert(say(res.status) + (res.status === "slot_taken" ? " The original time is unchanged." : "")); refreshViews();
        });
        box.appendChild(s);
      });
    });
  }

  // ---------- Book ----------
  function toClinicIso(local) { // "YYYY-MM-DDTHH:MM" in clinic timezone -> ISO with offset
    var guess = new Date(local + ":00Z");
    var parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(guess);
    var g = function (t) { return Number(parts.find(function (p) { return p.type === t; }).value); };
    var asTz = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"));
    return new Date(guess.getTime() - (asTz - guess.getTime())).toISOString();
  }
  async function initBook() {
    if (!cat) {
      var r = await fetch("/api/public/catalog", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then(function (x) { return x.json(); }).catch(function () { return {}; });
      if (!r.success) { A.show("bMsg", "err", say(r.status)); return; }
      cat = r; var sel = $("bService"); sel.innerHTML = "";
      cat.services.forEach(function (s) { var o = document.createElement("option"); o.value = s.key; o.textContent = s.name + (s.bookable ? " (" + s.duration_minutes + " min)" : " — needs set-up"); o.disabled = !s.bookable; sel.appendChild(o); });
      sel.value = (cat.services.find(function (s) { return s.bookable; }) || {}).key; fillDocs();
      $("bDate").value = A.localToday(tz);
    }
  }
  function svc() { return cat.services.find(function (s) { return s.key === $("bService").value; }); }
  function fillDocs() {
    var d = $("bDoctor"); d.innerHTML = '<option value="">Any available doctor</option>';
    (svc() ? svc().doctors : []).forEach(function (k) { var x = cat.doctors.find(function (y) { return y.key === k; }); if (x) { var o = document.createElement("option"); o.value = x.key; o.textContent = x.name; d.appendChild(o); } });
  }
  $("bService").addEventListener("change", fillDocs);
  $("bFind").addEventListener("click", async function () {
    var s = svc(); if (!s) return; $("bForm").hidden = true; $("bSlots").innerHTML = "";
    var docs = $("bDoctor").value ? [$("bDoctor").value] : s.doctors;
    A.busy(this, true, "Searching…");
    var all = await Promise.all(docs.map(function (d) { return api("availability", { service: s.key, doctor: d, date: $("bDate").value }); }));
    A.busy(this, false);
    var slots = [].concat.apply([], all.filter(function (x) { return x.success; }).map(function (x) { return x.slots; })).sort(function (a, b) { return Date.parse(a.start_at) - Date.parse(b.start_at); });
    if (!slots.length) { A.show("bMsg", "warn", say(all[0] && !all[0].success ? all[0].status : "no_slots")); return; }
    A.show("bMsg", "ok", "Choose a time:");
    slots.forEach(function (sl) {
      var b = document.createElement("button"); b.type = "button"; b.className = "slot"; b.innerHTML = "<b>" + A.esc(A.fmtTime(sl.start_at, tz)) + "</b><span>" + A.esc(sl.doctor_name) + "</span>";
      b.addEventListener("click", function () { pick({ starts_at: sl.start_at, doctor: sl.doctor_key, doctor_name: sl.doctor_name }); });
      $("bSlots").appendChild(b);
    });
  });
  $("oOn").addEventListener("change", function () { $("oFields").hidden = !this.checked; });
  $("oUse").addEventListener("click", function () {
    var when = $("oWhen").value, reason = $("oReason").value.trim(), d = $("bDoctor").value;
    if (!when || reason.length < 5 || !d) { A.show("bMsg", "err", "For an override choose a doctor, a date/time and a reason (at least 5 characters)."); return; }
    pick({ starts_at: toClinicIso(when), doctor: d, doctor_name: $("bDoctor").selectedOptions[0].textContent, override: true, override_reason: reason });
  });
  function pick(sel) {
    bookSel = sel; bookSel.rid = A.uuid();
    $("bSummary").innerHTML = "<div><span>Treatment</span><span>" + A.esc(svc().name) + "</span></div><div><span>Doctor</span><span>" + A.esc(sel.doctor_name) + "</span></div><div><span>When</span><span>" + A.esc(A.fmtDate(sel.starts_at, tz)) + ", " + A.esc(A.fmtTime(sel.starts_at, tz)) + "</span></div>" + (sel.override ? "<div><span>Override</span><span>" + A.esc(sel.override_reason) + "</span></div>" : "");
    $("bForm").hidden = false; A.show("bOut", "", ""); $("bBook").disabled = false; $("bName").focus();
  }
  $("bForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var name = $("bName").value.trim(), ph = $("bPhone").value.trim(), em = $("bEmail").value.trim();
    if (name.length < 2 || !/^\+?[0-9 ()-]{7,20}$/.test(ph)) { A.show("bOut", "err", "Enter the patient's full name and a valid mobile number."); return; }
    A.busy($("bBook"), true, "Booking…");
    var r = await api("book", { request_id: bookSel.rid, service: svc().key, starts_at: bookSel.starts_at, doctor: bookSel.doctor,
      patient: { full_name: name, phone_e164: ph, email: em || undefined }, override: bookSel.override === true, override_reason: bookSel.override_reason });
    A.busy($("bBook"), false);
    if (r.success && r.status === "confirmed") { $("bBook").disabled = true; A.show("bOut", "ok", "Booked. If this is an existing patient whose details differ, a task was created to check them."); $("bSlots").innerHTML = ""; }
    else A.show("bOut", r.status === "uncertain" ? "warn" : "err", say(r.status));
  });

  // ---------- Patients ----------
  $("pSearch").addEventListener("submit", async function (e) {
    e.preventDefault();
    var r = await api("patient-search", { query: $("pQ").value.trim() });
    $("pResults").innerHTML = "";
    if (!r.success) { A.show("pMsg", "err", say(r.status)); return; }
    A.show("pMsg", r.patients.length ? "" : "warn", r.patients.length ? "" : "No patients found.");
    r.patients.forEach(function (p) {
      var d = document.createElement("div"); d.className = "item";
      d.innerHTML = '<div class="main"><form class="editgrid" novalidate>' +
        '<div><label>Full name</label><input name="full_name" value="' + A.esc(p.full_name) + '"></div>' +
        '<div><label>Mobile</label><input name="phone_e164" value="' + A.esc(p.phone || "") + '"></div>' +
        '<div><label>Email</label><input name="email" value="' + A.esc(p.email || "") + '"></div>' +
        '<div><label>&nbsp;</label><button type="submit" class="ghost">Save details</button></div></form><p class="msg"></p>' +
        '<div class="upc"></div></div>';
      var f = d.querySelector("form"), m = d.querySelector(".msg");
      f.addEventListener("submit", async function (ev) {
        ev.preventDefault();
        var res = await api("patient-update", { patient_id: p.patient_id, full_name: f.full_name.value.trim(), phone_e164: f.phone_e164.value.trim(), email: f.email.value.trim() });
        m.className = "msg " + (res.success ? "ok" : "err"); m.textContent = res.success ? (res.status === "unchanged" ? "Nothing changed." : "Saved (" + (res.changed || []).join(", ") + "). The change is recorded with your name.") : say(res.status);
      });
      var up = d.querySelector(".upc");
      up.innerHTML = p.upcoming.length ? "<b>Upcoming</b>" : '<p class="empty">No upcoming appointments.</p>';
      p.upcoming.forEach(function (u) {
        var a = Object.assign({ patient_name: p.full_name }, u);
        var row = document.createElement("div"); row.className = "item";
        row.innerHTML = '<div class="main">' + A.esc(A.fmtDate(u.starts_at, tz)) + ", " + A.esc(A.fmtTime(u.starts_at, tz)) + '<div class="muted">' + A.esc(u.service_name || "") + " · " + A.esc(u.doctor_name) + '</div></div><div class="acts"></div>';
        var acts = row.querySelector(".acts");
        [["History", function () { timeline(u.appointment_id); }], ["Move", function () { moveAppt(a); }], ["Cancel", function () { cancelAppt(a); }]].forEach(function (x) {
          var b = document.createElement("button"); b.type = "button"; b.className = "ghost"; b.textContent = x[0]; b.addEventListener("click", x[1]); acts.appendChild(b);
        });
        up.appendChild(row);
      });
      $("pResults").appendChild(d);
    });
  });

  // ---------- start ----------
  (async function () {
    var r = await call("/api/staff/session", null, "GET");
    if (r.success) signedIn(r.user, r.memberships); else showLogin(r.status === "no_clinic_access" ? say(r.status) : "");
  })();
})();
