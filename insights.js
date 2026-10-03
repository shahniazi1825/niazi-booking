// AVENSO Insights — owner/manager analytics. Talks only to /api/staff/session and /api/staff/analytics.
// Charts are hand-built SVG (no third-party scripts: the site runs under a strict Content-Security-Policy).
(function () {
  "use strict";
  var A = window.AV, $ = A.$, esc = A.esc;
  var REDUCED = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  var TABS = ["overview", "bookings", "schedule", "frontdesk", "recovery"];
  var DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  var S = { me: null, tz: "UTC", tab: "overview", range: "30", from: null, to: null, cache: {}, data: null, timer: null, seq: 0 };

  /* ---------- small utils ---------- */
  var store = {
    get: function (k) { try { return localStorage.getItem("av-insights-" + k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem("av-insights-" + k, v); } catch (e) { /* private mode */ } }
  };
  function num(v) { return v == null || v === "" || isNaN(+v) ? null : +v; }
  function fmtInt(v) { return v == null ? "–" : Math.round(v).toLocaleString(); }
  function fmt1(v) { return v == null ? "–" : (+v).toLocaleString(undefined, { maximumFractionDigits: 1 }); }
  function money(v, cur) {
    if (v == null) return "–";
    try { if (cur) return new Intl.NumberFormat(undefined, { style: "currency", currency: cur, maximumFractionDigits: 0 }).format(v); } catch (e) {}
    return Math.round(v).toLocaleString();
  }
  function pct(a, b) { return b ? (100 * a / b) : null; }
  function el(html) { var t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; }
  function svgEl(tag, attrs) { var e = document.createElementNS("http://www.w3.org/2000/svg", tag); for (var k in attrs) e.setAttribute(k, attrs[k]); return e; }
  // Axis scale with round tick steps (1, 2, 2.5, 5 × 10^n) so labels read 0, 10, 20, 30, 40.
  function niceStep(v) { var p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; }
  function niceMax(v) { if (!v || v <= 0) return 4; var st = niceStep(v / 4); return Math.max(st, Math.ceil(v / st) * st); }
  function fmtDay(ymd, bucket) {
    var d = new Date(ymd + "T12:00:00Z");
    if (bucket === "month") return d.toLocaleDateString(undefined, { month: "short", year: "2-digit", timeZone: "UTC" });
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
  }
  // A week/month bucket that starts before the range or ends after it is only partly counted.
  function partial(t, bucket) {
    if (bucket === "day" || !S.from) return "";
    var end = bucket === "week" ? A.addDays(t, 6) : (function () { var d = new Date(t + "T12:00:00Z"); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return d.toISOString().slice(0, 10); })();
    return (t < S.from || end > S.to) ? " (partial)" : "";
  }
  function delay(node, i, step) { if (!REDUCED) node.style.animationDelay = (i * (step || 18)) + "ms"; }

  /* ---------- theme ---------- */
  function applyTheme(t) { if (t) document.documentElement.setAttribute("data-theme", t); else document.documentElement.removeAttribute("data-theme"); }
  applyTheme(store.get("theme"));
  $("themeBtn").addEventListener("click", function () {
    var cur = document.documentElement.getAttribute("data-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    var next = cur === "dark" ? "light" : "dark"; applyTheme(next); store.set("theme", next);
  });

  /* ---------- tooltip ---------- */
  var tip = $("tip");
  function showTip(evt, html) {
    tip.innerHTML = html; tip.hidden = false;
    var x = evt.clientX + 14, y = evt.clientY + 14, w = tip.offsetWidth, h = tip.offsetHeight;
    if (x + w > innerWidth - 8) x = evt.clientX - w - 14;
    if (y + h > innerHeight - 8) y = evt.clientY - h - 14;
    tip.style.left = Math.max(8, x) + "px"; tip.style.top = Math.max(8, y) + "px";
  }
  function hideTip() { tip.hidden = true; }
  function tipRows(title, rows) {
    return "<b>" + esc(title) + "</b>" + rows.map(function (r) {
      return '<div class="r"><span>' + (r.cls ? '<i class="' + r.cls + '"></i>' : "") + esc(r.k) + "</span><span>" + esc(r.v) + "</span></div>";
    }).join("");
  }
  function bindTip(node, fn) {
    node.addEventListener("pointermove", function (e) { showTip(e, fn()); });
    node.addEventListener("pointerdown", function (e) { showTip(e, fn()); });
    node.addEventListener("pointerleave", hideTip);
  }
  addEventListener("scroll", hideTip, { passive: true });

  /* ---------- API ---------- */
  async function call(path, body, method) {
    try {
      var r = await fetch(path, { method: method || "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: method === "GET" ? undefined : JSON.stringify(Object.assign({ request_id: A.uuid() }, body || {})) });
      var j = await r.json().catch(function () { return { success: false, status: "service_unavailable" }; });
      j._http = r.status; return j;
    } catch (e) { return { success: false, status: "network_error" }; }
  }

  /* ---------- range ---------- */
  function setRange(r, from, to) {
    S.range = r;
    var today = A.localToday(S.tz);
    if (r === "custom") { S.from = from; S.to = to; }
    else { S.to = today; S.from = A.addDays(today, -(+r - 1)); }
    document.querySelectorAll(".seg button").forEach(function (b) { b.classList.toggle("on", b.dataset.range === r); });
    store.set("range", r);
    var opts = { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" };
    $("period").textContent = new Date(S.from + "T12:00:00Z").toLocaleDateString(undefined, opts) + " – " +
      new Date(S.to + "T12:00:00Z").toLocaleDateString(undefined, opts) + " · compared with the previous " + (((Date.parse(S.to) - Date.parse(S.from)) / 864e5) + 1) + " days";
  }
  document.querySelectorAll(".seg button").forEach(function (b) {
    b.addEventListener("click", function () {
      if (b.dataset.range === "custom") { var f = $("customRange"); f.hidden = !f.hidden; $("cFrom").value = S.from; $("cTo").value = S.to; return; }
      $("customRange").hidden = true; setRange(b.dataset.range); load();
    });
  });
  $("customRange").addEventListener("submit", function (e) {
    e.preventDefault();
    var f = $("cFrom").value, t = $("cTo").value;
    if (!f || !t || f > t) { alert("Choose a start date before the end date."); return; }
    if ((Date.parse(t) - Date.parse(f)) / 864e5 > 366) { alert("Please choose a range of one year or less."); return; }
    $("customRange").hidden = true; setRange("custom", f, t); load();
  });
  $("refreshBtn").addEventListener("click", function () { load(true); });

  /* ---------- tabs ---------- */
  function moveInk() {
    var b = document.querySelector('.tabs button[aria-selected="true"]'), ink = document.querySelector(".tab-ink");
    if (!b) return; ink.style.width = b.offsetWidth + "px"; ink.style.transform = "translateX(" + b.offsetLeft + "px)";
  }
  function selectTab(t, noLoad) {
    if (TABS.indexOf(t) < 0) t = "overview";
    S.tab = t;
    document.querySelectorAll(".tabs button").forEach(function (b) { b.setAttribute("aria-selected", String(b.dataset.tab === t)); });
    moveInk();
    var sel = document.querySelector('.tabs button[aria-selected="true"]'); if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: "nearest", inline: "nearest" });
    history.replaceState(null, "", "#" + t);
    if (!noLoad) load();
  }
  document.querySelectorAll(".tabs button").forEach(function (b) { b.addEventListener("click", function () { selectTab(b.dataset.tab); }); });
  addEventListener("hashchange", function () { var t = location.hash.slice(1); if (S.me && TABS.indexOf(t) >= 0 && t !== S.tab) selectTab(t); });
  document.querySelector(".tabs").addEventListener("keydown", function (e) {
    var i = TABS.indexOf(S.tab);
    if (e.key === "ArrowRight") { selectTab(TABS[(i + 1) % TABS.length]); document.querySelector('.tabs button[aria-selected="true"]').focus(); }
    if (e.key === "ArrowLeft") { selectTab(TABS[(i + TABS.length - 1) % TABS.length]); document.querySelector('.tabs button[aria-selected="true"]').focus(); }
  });
  var rz; addEventListener("resize", function () { moveInk(); clearTimeout(rz); rz = setTimeout(function () { if (S.data) render(S.data, true); }, 180); });

  /* ---------- load ---------- */
  var STATUS = { forbidden_for_role: "Insights is for managers and admins.", not_signed_in: "Please sign in again.",
    range_too_long: "Please choose a range of one year or less.", invalid_range: "Please choose a start date before the end date." };
  async function load(force) {
    var key = S.tab + "|" + S.from + "|" + S.to + "|" + (S.me && S.me.clinic_slug), seq = ++S.seq;
    if (!force && S.cache[key] && Date.now() - S.cache[key].t < 120000) { render(S.cache[key].d); return; }
    skeleton(); $("refreshBtn").classList.add("spin");
    var r = await call("/api/staff/analytics", { tab: S.tab, from: S.from, to: S.to, refresh: !!force });
    if (seq !== S.seq) return;              // a newer request won
    $("refreshBtn").classList.remove("spin");
    if (r._http === 401) { gate("Your session ended", "Please sign in again on the front desk.", "Go to sign-in"); return; }
    if (!r.success) { errorView(STATUS[r.status] || "Couldn't load these figures. Check the connection and try again."); return; }
    S.cache[key] = { d: r, t: Date.now() };
    render(r);
  }
  function skeleton() {
    var v = $("view"); v.className = "view";
    v.innerHTML = '<div class="kpis">' + '<div class="sk kpi-sk"></div>'.repeat(4) + '</div><div class="grid2"><div class="sk chart-sk"></div><div class="sk chart-sk"></div></div>';
  }
  function errorView(msg) {
    var v = $("view"); v.className = "view enter";
    v.innerHTML = '<div class="error"><b>' + esc(msg) + '</b><br><button type="button" class="btn small" id="retry">Try again</button></div>';
    $("retry").addEventListener("click", function () { load(true); });
  }

  /* ---------- building blocks ---------- */
  function card(title, sub, opts) {
    opts = opts || {};
    var c = el('<section class="card"><div class="card-h"><div><h3>' + esc(title) + "</h3>" + (sub ? "<p>" + esc(sub) + "</p>" : "") +
      "</div></div><div class=\"body\"></div></section>");
    if (opts.table) {
      var tg = el('<button type="button" class="toggle" aria-pressed="false">Table</button>'), showing = false, body = c.querySelector(".body");
      tg.addEventListener("click", function () {
        showing = !showing; tg.setAttribute("aria-pressed", String(showing)); tg.textContent = showing ? "Chart" : "Table";
        body.innerHTML = ""; if (showing) body.appendChild(tableOf(opts.table)); else opts.draw(body);
      });
      c.querySelector(".card-h").appendChild(tg);
    }
    return c;
  }
  function tableOf(t) {
    var w = el('<div class="tbl-wrap"><table class="data"><thead><tr></tr></thead><tbody></tbody></table></div>');
    var hr = w.querySelector("tr");
    t.cols.forEach(function (c, i) { var th = document.createElement("th"); th.textContent = c; if (i) th.className = "n"; hr.appendChild(th); });
    var tb = w.querySelector("tbody");
    t.rows.forEach(function (r) { var tr = document.createElement("tr"); r.forEach(function (v, i) { var td = document.createElement("td"); td.textContent = v; if (i) td.className = "n"; tr.appendChild(td); }); tb.appendChild(tr); });
    return w;
  }
  function countUp(node, to, f) {
    if (to == null) { node.textContent = "–"; return; }
    if (REDUCED) { node.textContent = f(to); return; }
    var t0 = performance.now(), d = 700;
    (function step(t) { var p = Math.min(1, (t - t0) / d), e = 1 - Math.pow(1 - p, 3); node.textContent = f(to * e); if (p < 1) requestAnimationFrame(step); })(t0);
  }
  // kpi: {label, value, prev, kind:'count'|'pct'|'money'|'num', unit, better:'up'|'down', status:[cls,text], spark:[], hint, tip}
  function kpi(k) {
    var c = el('<div class="card kpi"><div class="lbl"></div><div class="val"><span class="n"></span></div><div class="meta"></div></div>');
    c.querySelector(".lbl").textContent = k.label;
    var f = k.kind === "money" ? function (v) { return money(v, S.data && S.data.currency); } : k.kind === "pct" || k.kind === "num" ? fmt1 : fmtInt;
    countUp(c.querySelector(".n"), num(k.value), f);
    if (k.unit) c.querySelector(".val").appendChild(el("<small>" + esc(k.unit) + "</small>"));
    var meta = c.querySelector(".meta"), v = num(k.value), p = num(k.prev);
    if (v != null && p != null && k.better) {
      var diff, txt;
      if (k.kind === "pct") { diff = v - p; txt = (diff > 0 ? "+" : "") + fmt1(diff) + " pts"; }
      else if (p === 0) { diff = v; txt = v ? "new" : "±0"; }
      else { diff = v - p; txt = (diff > 0 ? "+" : "") + fmt1(100 * diff / Math.abs(p)) + "%"; }
      var dir = Math.abs(diff) < 1e-9 ? "" : diff > 0 ? "up" : "down";
      var good = dir && ((dir === "up") === (k.better === "up"));
      var arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : "•";
      var d = el('<span class="delta ' + (dir ? dir + (good ? "-good" : "-bad") : "") + '"></span>');
      d.textContent = arrow + " " + txt; d.title = "vs previous period (" + f(p) + ")";
      meta.appendChild(d);
    }
    if (k.status) meta.appendChild(el('<span class="status ' + k.status[0] + '"><i></i>' + esc(k.status[1]) + "</span>"));
    if (k.hint) c.appendChild(el('<div class="hint">' + esc(k.hint) + "</div>"));
    if (k.spark && k.spark.length > 2) c.appendChild(spark(k.spark));
    if (k.tip) bindTip(c, function () { return k.tip; });
    return c;
  }
  function spark(vals) {
    var w = 84, h = 30, mx = Math.max.apply(null, vals.map(function (x) { return +x || 0; })), mn = Math.min.apply(null, vals.map(function (x) { return +x || 0; }));
    var rng = mx - mn || 1, pts = vals.map(function (v, i) { return [i * w / (vals.length - 1), h - 3 - ((+v || 0) - mn) / rng * (h - 6)]; });
    var d = pts.map(function (p, i) { return (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1); }).join(" ");
    var s = svgEl("svg", { class: "spark", viewBox: "0 0 " + w + " " + h, "aria-hidden": "true" });
    s.appendChild(svgEl("path", { class: "a", d: d + " L" + w + " " + h + " L0 " + h + " Z" }));
    var line = svgEl("path", { class: "l", d: d }); s.appendChild(line);
    if (!REDUCED) requestAnimationFrame(function () {
      var L = line.getTotalLength ? line.getTotalLength() : 200; line.style.strokeDasharray = L; line.style.strokeDashoffset = L;
      line.getBoundingClientRect(); line.style.transition = "stroke-dashoffset .9s cubic-bezier(.2,.7,.2,1)"; line.style.strokeDashoffset = "0";
    });
    return s;
  }
  function legend(keys) { return el('<div class="legend">' + keys.map(function (k) { return '<span><i class="' + k.cls + '"></i>' + esc(k.label) + "</span>"; }).join("") + "</div>"); }

  // Stacked (or single) columns. rows: [{t, ...}], keys: [{k,label,cls}]
  function columns(host, rows, keys, o) {
    o = o || {}; host.innerHTML = "";
    if (!rows.length) { host.appendChild(el('<div class="empty">No data in this period yet.</div>')); return; }
    if (keys.length > 1) host.appendChild(legend(keys));
    var W = Math.max(280, host.clientWidth || 600), H = o.h || 240, pl = 36, pr = 6, pt = 8, pb = 26;
    var tot = rows.map(function (r) { return keys.reduce(function (s, k) { return s + (+r[k.k] || 0); }, 0); });
    var mx = niceMax(Math.max.apply(null, tot)), iw = W - pl - pr, ih = H - pt - pb, n = rows.length, bw = iw / n, gap = Math.min(10, Math.max(2, bw * 0.28));
    var s = svgEl("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": o.label || "Chart" }), g = svgEl("g", { class: "grid" });
    var step = niceStep(Math.max(...tot, 1) / 4), nt = Math.round(mx / step);
    if (nt > 6) { step = mx / 4; nt = 4; }
    for (var i = 0; i <= nt; i++) {
      var y = pt + ih - ih * i / nt; g.appendChild(svgEl("line", { x1: pl, x2: W - pr, y1: y, y2: y }));
      var tx = svgEl("text", { class: "ax", x: pl - 6, y: y + 4, "text-anchor": "end" }); tx.textContent = o.yfmt ? o.yfmt(step * i) : fmt1(step * i); s.appendChild(tx);
    }
    s.insertBefore(g, s.firstChild);
    if (o.band) o.band.forEach(function (bd) { s.insertBefore(svgEl("rect", { class: "after-hours", x: pl + bd[0] * bw, y: pt, width: (bd[1] - bd[0]) * bw, height: ih }), g.nextSibling); });
    var every = Math.ceil(n / Math.max(2, Math.floor(iw / 64)));
    rows.forEach(function (r, i) {
      var x = pl + i * bw + gap / 2, w = Math.max(2, bw - gap), yb = pt + ih, col = svgEl("g", { class: "col bar-g" });
      var lastK = -1; keys.forEach(function (k, j) { if (+r[k.k]) lastK = j; });
      var firstSeg = true;
      keys.forEach(function (k, j) {
        var v = +r[k.k] || 0; if (!v) return;
        var gapPx = firstSeg ? 0 : 2, hh = Math.max(1, ih * v / mx - gapPx); yb -= ih * v / mx; firstSeg = false;
        var rect = svgEl("rect", { class: "m " + k.cls, x: x, y: yb, width: w, height: hh, rx: j === lastK ? Math.min(3, w / 3, hh / 2) : 0.5 });
        delay(rect, i, Math.min(18, 500 / n)); col.appendChild(rect);
      });
      var hit = svgEl("rect", { class: "hit", x: pl + i * bw, y: pt, width: bw, height: ih });
      col.appendChild(hit); s.appendChild(col);
      bindTip(hit, function () {
        var rr = keys.map(function (k) { return { cls: k.cls, k: k.label, v: o.vfmt ? o.vfmt(r[k.k]) : fmtInt(r[k.k]) }; });
        if (keys.length > 1) rr.push({ k: "Total", v: o.vfmt ? o.vfmt(tot[i]) : fmtInt(tot[i]) });
        return tipRows(o.xtip ? o.xtip(r) : (o.bucket === "week" ? "Week of " : "") + fmtDay(r.t, o.bucket) + partial(r.t, o.bucket), rr);
      });
      hit.addEventListener("pointerenter", function () { s.querySelectorAll(".col").forEach(function (c) { c.classList.toggle("dim", c !== col); }); });
      hit.addEventListener("pointerleave", function () { s.querySelectorAll(".col").forEach(function (c) { c.classList.remove("dim"); }); });
      if (i % every === 0) { var lx = svgEl("text", { class: "ax", x: pl + i * bw + bw / 2, y: H - 8, "text-anchor": "middle" }); lx.textContent = o.xfmt ? o.xfmt(r, i) : fmtDay(r.t, o.bucket); s.appendChild(lx); }
    });
    s.appendChild(svgEl("line", { class: "base", x1: pl, x2: W - pr, y1: pt + ih, y2: pt + ih }));
    var wrap = el('<div class="chart"></div>'); wrap.appendChild(s); host.appendChild(wrap);
  }

  // Horizontal bars. items: [{label, value, sub, max}]
  function hbars(host, items, o) {
    o = o || {}; host.innerHTML = "";
    if (!items.length) { host.appendChild(el('<div class="empty">' + esc(o.empty || "No data in this period yet.") + "</div>")); return; }
    var W = Math.max(280, host.clientWidth || 500), row = 34, H = items.length * row + 4, lw = Math.min(170, W * 0.36), vw = 64;
    var mx = o.max || Math.max.apply(null, items.map(function (x) { return +x.value || 0; })) || 1;
    var s = svgEl("svg", { viewBox: "0 0 " + W + " " + H, class: "hbar", role: "img", "aria-label": o.label || "Bar chart" });
    items.forEach(function (it, i) {
      var y = i * row + 6, bw = W - lw - vw - 8, w = Math.max(0, bw * (+it.value || 0) / mx);
      var nm = svgEl("text", { class: "lbl-name", x: 0, y: y + 15 }); nm.textContent = it.label.length > 24 ? it.label.slice(0, 23) + "…" : it.label; s.appendChild(nm);
      s.appendChild(svgEl("rect", { class: "ftrack", x: lw, y: y + 2, width: bw, height: 18, rx: 5 }));
      if (w > 0) { var r = svgEl("rect", { class: "m " + (it.cls || o.cls || "f1"), x: lw, y: y + 2, width: w, height: 18, rx: 5 }); delay(r, i, 50); s.appendChild(r); }
      var vt = svgEl("text", { class: "lbl-in", x: W, y: y + 15, "text-anchor": "end" }); vt.textContent = o.vfmt ? o.vfmt(it.value, it) : fmtInt(it.value); s.appendChild(vt);
      var hit = svgEl("rect", { class: "hit", x: 0, y: y - 2, width: W, height: row }); s.appendChild(hit);
      if (it.tip) bindTip(hit, function () { return it.tip; });
    });
    var wrap = el('<div class="chart"></div>'); wrap.appendChild(s); host.appendChild(wrap);
  }

  // Weekday x hour heatmap of how full the schedule is.
  function heatmap(host, cells) {
    host.innerHTML = "";
    if (!cells.length) { host.appendChild(el('<div class="empty">Opening hours are not set up yet, so capacity can\'t be measured.</div>')); return; }
    var hrs = cells.map(function (c) { return c.hr; }), h0 = Math.min.apply(null, hrs), h1 = Math.max.apply(null, hrs);
    var wds = []; cells.forEach(function (c) { if (wds.indexOf(c.wd) < 0) wds.push(c.wd); }); wds.sort();
    var W = Math.max(300, host.clientWidth || 700), lw = 40, top = 18, nh = h1 - h0 + 1, cw = (W - lw) / nh, ch = Math.min(40, Math.max(26, cw * 0.62)), H = top + wds.length * (ch + 4);
    var s = svgEl("svg", { viewBox: "0 0 " + W + " " + H, class: "hm", role: "img", "aria-label": "How full each hour of the week is" });
    for (var h = h0; h <= h1; h++) { if (nh > 8 && (h - h0) % 2) continue; var t = svgEl("text", { class: "ax", x: lw + (h - h0) * cw + cw / 2, y: 11, "text-anchor": "middle" }); t.textContent = (h < 10 ? "0" : "") + h + ":00"; s.appendChild(t); }
    wds.forEach(function (wd, r) { var t = svgEl("text", { class: "ax", x: 0, y: top + r * (ch + 4) + ch / 2 + 4 }); t.textContent = DAYS[wd - 1]; s.appendChild(t); });
    cells.forEach(function (c, i) {
      var r = wds.indexOf(c.wd), p = c.pct == null ? 0 : +c.pct, q = p >= 95 ? 7 : p >= 85 ? 6 : p >= 70 ? 5 : p >= 55 ? 4 : p >= 40 ? 3 : p >= 25 ? 2 : p > 0 ? 1 : 0;
      var x = lw + (c.hr - h0) * cw + 2, y = top + r * (ch + 4);
      var rect = svgEl("rect", { class: "cell q" + q, x: x, y: y, width: Math.max(4, cw - 4), height: ch, rx: 5 }); delay(rect, i, 6); s.appendChild(rect);
      if (cw > 30) { var tx = svgEl("text", { class: "v" + (q >= 5 ? " hi" : ""), x: x + (cw - 4) / 2, y: y + ch / 2 + 4, "text-anchor": "middle" }); tx.textContent = Math.round(p); s.appendChild(tx); }
      bindTip(rect, function () { return tipRows(DAYS[c.wd - 1] + " " + (c.hr < 10 ? "0" : "") + c.hr + ":00–" + (c.hr + 1 < 10 ? "0" : "") + (c.hr + 1) + ":00",
        [{ k: "Filled", v: Math.round(p) + "%" }, { k: "Booked", v: fmtInt(c.booked / 60) + " h" }, { k: "Available", v: fmtInt(c.cap / 60) + " h" }]); });
    });
    var wrap = el('<div class="chart"></div>'); wrap.appendChild(s); host.appendChild(wrap);
    host.appendChild(el('<div class="scale">Empty <i class="q1"></i><i class="q3"></i><i class="q5"></i><i class="q7"></i> Full · numbers are % of bookable time filled</div>'));
  }

  function attention(host, items) {
    host.innerHTML = "";
    if (!items.length) { host.appendChild(el('<div class="all-good">✓ Nothing needs your attention right now.</div>')); return; }
    var box = el('<div class="att"></div>');
    items.forEach(function (a, i) {
      var it = el('<div class="att-item ' + esc(a.level) + '"><div class="ic">' + (a.level === "critical" ? "!" : a.level === "warning" ? "!" : "i") +
        "</div><div><b></b><span></span></div></div>");
      it.querySelector("b").textContent = a.title; it.querySelector("span").textContent = a.detail; delay(it, i, 70);
      if (a.tab && a.tab !== S.tab) { var go = el('<button type="button">View →</button>'); go.addEventListener("click", function () { selectTab(a.tab); }); it.appendChild(go); }
      box.appendChild(it);
    });
    host.appendChild(box);
  }

  function status(v, good, warn, lowerBetter, labels) {
    if (v == null) return null;
    labels = labels || ["On target", "Watch", "Needs action"];
    if (lowerBetter) return v <= good ? ["good", labels[0]] : v <= warn ? ["warn", labels[1]] : ["bad", labels[2]];
    return v >= good ? ["good", labels[0]] : v >= warn ? ["warn", labels[1]] : ["bad", labels[2]];
  }
  function grid(cls) { return el('<div class="' + (cls || "grid2") + '"></div>'); }
  // Charts are drawn after their card is on the page, so they can measure their real width.
  var pending = [];
  function withChart(c, draw) { var b = c.querySelector(".body"); pending.push(function () { draw(b); }); return c; }

  /* ---------- tab renderers ---------- */
  var R = {};
  R.overview = function (d, v) {
    var k = d.kpi || {}, p = d.kpi_prev || {}, sp = d.spark || {}, cur = d.currency;
    var ks = el('<div class="kpis"></div>');
    ks.appendChild(kpi({ label: "Appointments", value: k.appointments, prev: p.appointments, better: "up", spark: sp.appointments, hint: "Visits scheduled in this period (not cancelled)" }));
    ks.appendChild(kpi({ label: "Schedule filled", value: k.fill_rate, prev: p.fill_rate, kind: "pct", unit: "%", better: "up", spark: sp.fill_rate,
      status: status(num(k.fill_rate), 85, 70, false, ["Healthy", "Room to grow", "Low"]), hint: "Booked chair time ÷ bookable time" }));
    ks.appendChild(kpi({ label: "No-show rate", value: k.no_show_rate, prev: p.no_show_rate, kind: "pct", unit: "%", better: "down",
      status: status(num(k.no_show_rate), 5, 10, true, ["Good (<5%)", "Above 5%", "High (>10%)"]) }));
    ks.appendChild(kpi({ label: "New patients", value: k.new_patients, prev: p.new_patients, better: "up", hint: "First-ever booking in this period" }));
    ks.appendChild(kpi({ label: "Revenue recovered", value: d.prices_configured ? k.revenue_recovered : null, prev: d.prices_configured ? p.revenue_recovered : null, kind: "money", better: "up",
      hint: d.prices_configured ? fmtInt(k.refilled) + " cancelled slots refilled from the waiting list (estimate)" : "Add treatment prices to see this" }));
    v.appendChild(ks);
    var g = grid();
    var keys = [{ k: "completed", label: "Attended", cls: "f1" }, { k: "upcoming", label: "Upcoming", cls: "f3" }, { k: "cancelled", label: "Cancelled", cls: "f2" }, { k: "no_show", label: "No-show", cls: "f4" }];
    var trend = d.trend || [];
    var draw = function (b) { columns(b, trend, keys, { bucket: d.bucket, label: "Appointments over time", h: 260 }); };
    g.appendChild(withChart(card("Appointments over time", "By appointment date · per " + d.bucket, { draw: draw,
      table: { cols: ["Period", "Attended", "Upcoming", "Cancelled", "No-show"], rows: trend.map(function (r) { return [fmtDay(r.t, d.bucket), r.completed, r.upcoming, r.cancelled, r.no_show]; }) } }), draw));
    g.appendChild(withChart(card("Needs attention", "Generated from your figures, most important first"), function (b) {
      var order = { critical: 0, warning: 1, info: 2 }; attention(b, (d.attention || []).slice().sort(function (a, c) { return order[a.level] - order[c.level]; }));
    }));
    v.appendChild(g);
  };

  R.bookings = function (d, v) {
    var k = d.kpi || {}, p = d.kpi_prev || {}, nv = d.new_vs_returning || {};
    var self = (+k.online || 0) + (+k.voice || 0), selfPrev = (+p.online || 0) + (+p.voice || 0);
    var ks = el('<div class="kpis"></div>');
    ks.appendChild(kpi({ label: "Bookings made", value: k.booked, prev: p.booked, better: "up", hint: "Created in this period, for any date" }));
    ks.appendChild(kpi({ label: "Booked online or by phone AI", value: pct(self, k.booked), prev: pct(selfPrev, p.booked), kind: "pct", unit: "%", better: "up",
      hint: fmtInt(k.online) + " online · " + fmtInt(k.voice) + " phone AI · " + fmtInt(k.staff) + " front desk" }));
    ks.appendChild(kpi({ label: "Booked while you were closed", value: k.after_hours, better: "up", hint: "Online or phone AI bookings outside opening hours — work your team didn't have to do" }));
    ks.appendChild(kpi({ label: "First-time patients", value: pct(nv.new, (+nv.new || 0) + (+nv.returning || 0)), kind: "pct", unit: "%", hint: fmtInt(nv.new) + " new · " + fmtInt(nv.returning) + " returning" }));
    v.appendChild(ks);
    var g = grid();
    var keys = [{ k: "web", label: "Online", cls: "f1" }, { k: "voice", label: "Phone AI", cls: "f2" }, { k: "staff", label: "Front desk", cls: "f3" }];
    var ch = d.channels || [];
    var draw = function (b) { columns(b, ch, keys, { bucket: d.bucket, label: "Where bookings come from", h: 250 }); };
    g.appendChild(withChart(card("Where bookings come from", "Bookings made per " + d.bucket + ", by channel", { draw: draw,
      table: { cols: ["Period", "Online", "Phone AI", "Front desk"], rows: ch.map(function (r) { return [fmtDay(r.t, d.bucket), r.web, r.voice, r.staff]; }) } }), draw));
    var lt = (d.lead_time || []).map(function (x) { return { label: x.label, value: x.n }; });
    var drawL = function (b) { hbars(b, lt, { cls: "f1", label: "How far ahead people book" }); };
    g.appendChild(withChart(card("How far ahead people book", "Median " + fmt1(k.median_lead_days) + " days ahead", { draw: drawL,
      table: { cols: ["Booked ahead", "Bookings"], rows: lt.map(function (x) { return [x.label, x.value]; }) } }), drawL));
    v.appendChild(g);
    var ts = (d.top_services || []);
    var items = ts.map(function (x) { return { label: x.name, value: x.n, tip: tipRows(x.name, [{ k: "Bookings", v: fmtInt(x.n) }].concat(x.value != null ? [{ k: "Est. value", v: money(x.value, d.currency) }] : [])) }; });
    v.appendChild(withChart(card("Most booked treatments", "Not cancelled"), function (b) { hbars(b, items, { cls: "f3", label: "Most booked treatments", vfmt: function (val, it) { return fmtInt(val); } }); }));
  };

  R.schedule = function (d, v) {
    var L = d.losses || {}, docs = d.doctors || [], cap = 0, bk = 0;
    docs.forEach(function (x) { cap += +x.cap || 0; bk += +x.booked || 0; });
    var fill = cap ? 100 * bk / cap : null;
    var visits = docs.reduce(function (s, x) { return s + (+x.appointments || 0); }, 0);
    var ks = el('<div class="kpis"></div>');
    ks.appendChild(kpi({ label: "Schedule filled", value: fill, kind: "pct", unit: "%", status: status(fill, 85, 70, false, ["Healthy", "Room to grow", "Low"]),
      hint: fmtInt(bk / 60) + " of " + fmtInt(cap / 60) + " bookable hours" }));
    ks.appendChild(kpi({ label: "No-shows", value: L.no_shows, hint: d.prices_configured ? "≈ " + money(L.no_show_value, d.currency) + " of chair time lost" : "Add prices to see the value lost" }));
    ks.appendChild(kpi({ label: "Late cancellations", value: L.late_cancellations, hint: "Cancelled less than 24 h before · " + fmtInt(L.cancellations) + " cancellations in total" }));
    ks.appendChild(kpi({ label: "Visits not marked", value: L.unmarked_past, status: (+L.unmarked_past || 0) > 0 ? ["warn", "Mark on the front desk"] : ["good", "All marked"],
      hint: "Past visits still waiting for Completed / No-show" }));
    v.appendChild(ks);
    var hm = d.heatmap || [];
    var drawH = function (b) { heatmap(b, hm); };
    v.appendChild(withChart(card("When your chairs are empty", "How full each hour of the week was · stronger colour = fuller", { draw: drawH,
      table: { cols: ["Day", "Hour", "Filled %", "Booked h", "Available h"], rows: hm.map(function (c) { return [DAYS[c.wd - 1], c.hr + ":00", c.pct, fmt1(c.booked / 60), fmt1(c.cap / 60)]; }) } }), drawH));
    var g = grid("grid2 even");
    var di = docs.map(function (x) { return { label: x.name, value: x.pct || 0, tip: tipRows(x.name, [{ k: "Filled", v: (x.pct == null ? "–" : x.pct + "%") }, { k: "Appointments", v: fmtInt(x.appointments) }, { k: "No-shows", v: fmtInt(x.no_shows) }, { k: "Available", v: fmtInt(x.cap / 60) + " h" }]) }; });
    var drawD = function (b) { hbars(b, di, { max: 100, cls: "f1", vfmt: function (val) { return Math.round(val) + "%"; }, empty: "No doctor hours set up." }); };
    g.appendChild(withChart(card("Each doctor's diary", "Share of bookable time filled", { draw: drawD,
      table: { cols: ["Doctor", "Filled %", "Appointments", "No-shows"], rows: docs.map(function (x) { return [x.name, x.pct, x.appointments, x.no_shows]; }) } }), drawD));
    var wk = (d.by_weekday || []).filter(function (x) { return x.wd <= 6 || +x.total > 0; });
    var keys = [{ k: "no_show", label: "No-shows", cls: "f4" }, { k: "cancelled", label: "Cancellations", cls: "f2" }];
    var drawW = function (b) { columns(b, wk, keys, { h: 220, xfmt: function (r) { return DAYS[r.wd - 1]; }, xtip: function (r) { return DAYS[r.wd - 1] + " · " + fmtInt(r.total) + " appointments"; } }); };
    g.appendChild(withChart(card("Lost visits by weekday", "No-shows and cancellations", { draw: drawW,
      table: { cols: ["Day", "No-shows", "Cancellations", "All appointments"], rows: wk.map(function (x) { return [DAYS[x.wd - 1], x.no_show, x.cancelled, x.total]; }) } }), drawW));
    v.appendChild(g);
  };

  R.frontdesk = function (d, v) {
    var c = d.calls || {}, cp = d.calls_prev || {}, cb = d.callbacks || {}, rel = d.reliability || {};
    var conv = pct(c.booked, c.total), after = pct(c.after_hours, c.total);
    var ks = el('<div class="kpis"></div>');
    ks.appendChild(kpi({ label: "Calls handled by the AI", value: c.total, prev: cp.total, better: "up", hint: c.avg_minutes != null ? "Average " + fmt1(c.avg_minutes) + " min per call" : "No calls in this period" }));
    ks.appendChild(kpi({ label: "Calls that became bookings", value: conv, kind: "pct", unit: "%", status: status(conv, 60, 40, false, ["Best in class", "Typical", "Below typical"]),
      hint: "Industry: ~40% typical, 60%+ best" }));
    ks.appendChild(kpi({ label: "Calls outside opening hours", value: after, kind: "pct", unit: "%", hint: fmtInt(c.after_hours) + " calls answered while the clinic was closed" }));
    ks.appendChild(kpi({ label: "Call-back response", value: cb.median_hours, kind: "num", unit: " h", status: status(num(cb.median_hours), 2, 8, true, ["Fast", "Could be faster", "Slow"]),
      hint: "Median time to close · " + fmtInt(cb.created) + " requests, " + fmtInt(cb.urgent) + " urgent" }));
    v.appendChild(ks);
    var g = grid();
    var rows = (d.calls_by_hour || []).map(function (x) { return { t: x.hr, n: x.n }; });
    var drawC = function (b) { columns(b, rows, [{ k: "n", label: "Calls", cls: "f1" }], { h: 240, band: [[0, 8], [18, 24]], xfmt: function (r) { return (r.t < 10 ? "0" : "") + r.t; },
      xtip: function (r) { return (r.t < 10 ? "0" : "") + r.t + ":00–" + (r.t + 1 < 10 ? "0" : "") + (r.t + 1) + ":00"; } }); };
    g.appendChild(withChart(card("When patients call", "Calls by hour of day · shaded = evenings and nights", { draw: drawC,
      table: { cols: ["Hour", "Calls"], rows: rows.map(function (r) { return [r.t + ":00", r.n]; }) } }), drawC));
    g.appendChild(withChart(card("Waiting call-backs", "Oldest first · details are on the front desk"), function (b) {
      var o = d.oldest_open || [];
      if (!o.length) b.appendChild(el('<div class="all-good">✓ No open call-backs.</div>'));
      else { var m = el('<div class="mini"></div>'); o.forEach(function (x, i) {
        var row = el("<div><span></span><span></span></div>"); row.firstChild.textContent = "Waiting " + (x.age_hours >= 48 ? Math.round(x.age_hours / 24) + " days" : x.age_hours + " h") + " · via " + (x.source === "voice" ? "phone" : x.source);
        row.lastChild.appendChild(el('<span class="pill ' + (x.priority === "urgent" ? "urgent" : "") + '">' + esc(x.priority) + "</span>")); delay(row, i, 60); m.appendChild(row); }); b.appendChild(m); }
      var st = el('<div class="stat-row"></div>');
      [[fmtInt(rel.operations), "booking actions"], [fmtInt(rel.failed), "failed"], [fmtInt(rel.messages), "messages sent"], [fmtInt(rel.messages_failed), "messages failed"]].forEach(function (x) {
        var e = el("<div><b></b><span></span></div>"); e.firstChild.textContent = x[0]; e.lastChild.textContent = x[1]; st.appendChild(e); });
      b.appendChild(el('<p class="hint">System reliability in this period</p>')); b.appendChild(st);
    }));
    v.appendChild(g);
  };

  R.recovery = function (d, v) {
    var f = d.funnel || {}, rc = d.recovered || {}, rp = d.recovered_prev || {}, lost = d.lost || {};
    var refill = pct(f.accepted, f.cancelled_slots);
    var ks = el('<div class="kpis"></div>');
    ks.appendChild(kpi({ label: "Revenue recovered", value: d.prices_configured ? rc.value : null, prev: d.prices_configured ? rp.value : null, kind: "money", better: "up",
      hint: d.prices_configured ? "Estimated value of refilled slots" : "Add treatment prices to see this" }));
    ks.appendChild(kpi({ label: "Slots refilled", value: rc.n, prev: rp.n, better: "up", hint: "Booked automatically from the waiting list" }));
    ks.appendChild(kpi({ label: "Cancellations refilled", value: refill, kind: "pct", unit: "%", hint: fmtInt(f.accepted) + " of " + fmtInt(f.cancelled_slots) + " cancelled slots" }));
    ks.appendChild(kpi({ label: "Waiting for a slot", value: f.waiting_now, hint: "Patients who agreed to be contacted" }));
    v.appendChild(ks);
    var g = grid("grid2 even");
    g.appendChild(withChart(card("From cancellation to refilled slot", "What happened to cancelled time"), function (b) {
      var steps = [["Cancelled slots", f.cancelled_slots, ""], ["Offered to the waiting list", f.offered, ""], ["Accepted & rebooked", f.accepted, f.expired ? fmtInt(f.expired) + " offers expired unanswered" : ""]];
      var mx = Math.max(1, +f.cancelled_slots || 0, +f.offered || 0), box = el('<div class="funnel"></div>');
      steps.forEach(function (s, i) {
        var row = el('<div class="fstep"><div><span></span><small></small></div><div class="track"><div class="fill"></div></div><div class="num"></div></div>');
        row.querySelector("span").textContent = s[0]; row.querySelector("small").textContent = s[2]; row.querySelector(".num").textContent = fmtInt(s[1]);
        var fill = row.querySelector(".fill"); fill.style.width = Math.max(0, 100 * (+s[1] || 0) / mx) + "%"; delay(fill, i, 140); box.appendChild(row);
      });
      b.appendChild(box);
      if (d.prices_configured) {
        var st = el('<div class="stat-row"></div>');
        [[money(lost.cancelled_value, d.currency), "value of cancelled visits"], [money(lost.no_show_value, d.currency), "value of no-shows"], [money(rc.value, d.currency), "won back"]].forEach(function (x) {
          var e = el("<div><b></b><span></span></div>"); e.firstChild.textContent = x[0]; e.lastChild.textContent = x[1]; st.appendChild(e); });
        b.appendChild(el('<p class="hint">Estimates from your treatment prices</p>')); b.appendChild(st);
      }
    }));
    var ser = d.series || [], per = d.bucket === "day" ? "week" : "month";
    var drawR = function (b) { columns(b, ser, [{ k: d.prices_configured ? "value" : "n", label: d.prices_configured ? "Recovered" : "Slots refilled", cls: "f3" }],
      { h: 240, bucket: per === "month" ? "month" : "day", vfmt: d.prices_configured ? function (x) { return money(x, d.currency); } : fmtInt,
        yfmt: d.prices_configured ? function (x) { return money(x, d.currency); } : fmtInt, xtip: function (r) { return (per === "week" ? "Week of " : "") + fmtDay(r.t, per === "month" ? "month" : "day") + partial(r.t, per); } }); };
    g.appendChild(withChart(card(d.prices_configured ? "Revenue recovered" : "Slots refilled", "Per " + per, { draw: drawR,
      table: { cols: ["Period", "Slots refilled", "Est. value"], rows: ser.map(function (r) { return [fmtDay(r.t, per === "month" ? "month" : "day"), r.n, money(r.value, d.currency)]; }) } }), drawR));
    v.appendChild(g);
    var ws = (d.waiting_by_service || []).map(function (x) { return { label: x.name, value: x.n }; });
    v.appendChild(withChart(card("What people are waiting for", "Active waiting list by treatment"), function (b) { hbars(b, ws, { cls: "f1", empty: "Nobody is on the waiting list right now." }); }));
  };

  function render(d, quiet) {
    S.data = d;
    var v = $("view"); v.innerHTML = ""; v.className = "view" + (quiet ? "" : " enter");
    pending = [];
    (R[d.tab] || R.overview)(d, v);
    pending.forEach(function (f) { f(); }); pending = [];
    var t = new Date(d.generated_at || Date.now());
    $("updated").textContent = "Updated " + t.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) + (d.cached ? " (cached)" : "");
  }

  /* ---------- session / gate ---------- */
  function gate(title, text, btn) {
    $("app").hidden = true; $("gate").hidden = false;
    $("gateTitle").textContent = title; $("gateText").textContent = text; $("gateBtn").textContent = btn || "Go to the front desk";
  }
  async function boot() {
    var s = await call("/api/staff/session", null, "GET");
    if (!s.success) { gate("Sign in to see Insights", "Insights uses your front-desk login.", "Go to sign-in"); return; }
    S.me = s.user; S.tz = s.user.timezone || "UTC";
    if (["manager", "admin"].indexOf(s.user.role) < 0) { gate("Insights is for managers", "Your role (" + s.user.role + ") can use the front desk. Ask the clinic owner if you need Insights.", "Go to the front desk"); return; }
    $("clinicName").textContent = s.user.clinic_name || "Insights";
    document.title = "Insights — " + (s.user.clinic_name || "Clinic");
    $("who").textContent = s.user.email + " · " + s.user.role;
    var ms = (s.memberships || []).filter(function (m) { return m.role === "manager" || m.role === "admin"; }), sw = $("clinicSwitch");
    if (ms.length > 1) {
      sw.innerHTML = ""; ms.forEach(function (m) { var o = document.createElement("option"); o.value = m.clinic_slug; o.textContent = m.clinic_name; sw.appendChild(o); });
      sw.value = s.user.clinic_slug; sw.hidden = false;
      sw.onchange = async function () {
        var r = await call("/api/staff/session", { action: "switch", clinic_slug: sw.value });
        if (r.success) { S.cache = {}; boot(); } else { alert("Couldn't switch clinic."); sw.value = S.me.clinic_slug; }
      };
    }
    $("gate").hidden = true; $("app").hidden = false;
    var r = store.get("range"); setRange(["7", "30", "90", "365"].indexOf(r) >= 0 ? r : "30");
    selectTab((location.hash || "#overview").slice(1), true); requestAnimationFrame(moveInk);
    load();
    clearInterval(S.timer);
    S.timer = setInterval(function () { if (!document.hidden) { S.cache = {}; load(); } }, 5 * 60000);
  }
  boot();
})();
