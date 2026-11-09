// The 4-sheet application. Details are kept on the phone (localStorage) as
// the applicant goes, so a refresh or a dropped connection loses nothing.
// The draft is created on the service when sheet 2 is finished; documents
// upload one at a time on sheet 3; sheet 4 hands it in.
(function () {
  var KEY = "qs_apply_v1", RECEIPT = "qs_receipt";
  var PURPOSES = ["School fees", "Transport", "Medical", "Household", "Emergency", "Other"];
  var KINDS = [
    { kind: "id", title: "3.1 Namibian ID · front & back", need: 1, multiple: true },
    { kind: "payslip", title: "3.2 Latest payslip", need: 1, multiple: true },
    { kind: "bank", title: "3.3 Bank statements · last 3 months", need: 3, multiple: true }
  ];
  var LABELS = ["", "Next: about you", "Next: documents", "Next: check & sign", "Hand in my application"];
  var $ = function (id) { return document.getElementById(id); };

  var st = QS.store.get(KEY) || {};
  st.sheet = st.sheet || 1;
  st.amount = st.amount || 2000;
  st.d = st.d || {};
  st.files = st.files || { id: [], payslip: [], bank: [] };
  try {
    var qa = Number(new URLSearchParams(location.search).get("amount"));
    if (qa >= QS.MIN && qa <= QS.MAX && !st.ref) st.amount = Math.round(qa / 100) * 100;
  } catch (e) {}
  function save() { QS.store.set(KEY, st); }

  var bot = null, busy = false;

  // ---------- sheet 1
  function drawAmount() {
    var c = QS.cost(st.amount);
    $("amountOut").textContent = QS.money(st.amount, 0);
    $("interestOut").textContent = QS.money(c.interest);
    $("totalOut").textContent = QS.money(c.total);
    $("less").disabled = st.amount <= QS.MIN; $("more").disabled = st.amount >= QS.MAX;
    [].forEach.call(document.querySelectorAll("#chips .chip"), function (b) { b.setAttribute("aria-pressed", String(Number(b.dataset.amt) === st.amount)); });
    save();
  }
  $("less").onclick = function () { st.amount = Math.max(QS.MIN, st.amount - 100); drawAmount(); };
  $("more").onclick = function () { st.amount = Math.min(QS.MAX, st.amount + 100); drawAmount(); };
  [].forEach.call(document.querySelectorAll("#chips .chip"), function (b) { b.onclick = function () { st.amount = Number(b.dataset.amt); drawAmount(); }; });
  $("purposes").innerHTML = PURPOSES.map(function (p, i) {
    return '<label class="tick"><input type="radio" name="purpose" value="' + p + '" id="p' + i + '"' + (st.purpose === p ? " checked" : "") + '><span class="box" aria-hidden="true"></span>' + p + "</label>";
  }).join("");
  $("purposes").addEventListener("change", function (e) { st.purpose = e.target.value; $("err-purpose").textContent = ""; save(); });

  // ---------- sheet 2
  var form = $("detailsForm");
  Object.keys(st.d).forEach(function (k) { if (form.elements[k]) form.elements[k].value = st.d[k]; });
  form.addEventListener("input", function (e) {
    if (!e.target.name) return;
    st.d[e.target.name] = e.target.value; save();
    var f = e.target.closest(".field"); if (f) { f.classList.remove("bad"); f.querySelector(".err").textContent = ""; }
  });
  function fieldErrors(errs) {
    var first = null;
    [].forEach.call(form.querySelectorAll(".field"), function (f) {
      var msg = errs[f.dataset.f] || "";
      f.classList.toggle("bad", Boolean(msg));
      f.querySelector(".err").textContent = msg;
      if (msg && !first) first = f.querySelector("input");
    });
    if (first) first.focus();
  }
  function payload() {
    var p = Object.assign({}, st.d, { amount: String(st.amount), purpose: st.purpose, term: "payday" });
    return p;
  }

  // ---------- sheet 3
  function drawDocs() {
    $("docs").innerHTML = KINDS.map(function (k) {
      var list = st.files[k.kind] || [];
      var done = list.length >= k.need;
      var count = k.need > 1 ? "<b>" + Math.min(list.length, k.need) + " OF " + k.need + "</b>" : "";
      return '<div class="doc' + (done ? "" : " need") + '">'
        + '<p class="tabhead"><span>' + QS.esc(k.title.toUpperCase()) + "</span>" + count + "</p>"
        + '<div class="body"><ul>' + list.map(function (f) {
          return '<li><span class="name">' + QS.esc(f.name) + '</span><button type="button" class="link-btn" data-del="' + k.kind + "|" + f.fileId + '">Remove</button></li>';
        }).join("") + "</ul>"
        + '<div id="prog-' + k.kind + '"></div>'
        + '<label class="add-file"><input type="file" accept="image/*,application/pdf" data-kind="' + k.kind + '"' + (k.multiple ? " multiple" : "") + '>'
        + '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>'
        + (list.length ? "ADD ANOTHER" : "ATTACH") + "</label></div>"
        + (list.length ? '<span class="stamp stamp-green" aria-hidden="true">Attached</span>' : "")
        + "</div>";
    }).join("");
  }
  $("docs").addEventListener("change", function (e) {
    var input = e.target; if (!input.files || !input.files.length) return;
    var kind = input.dataset.kind, files = [].slice.call(input.files);
    input.value = "";
    files.reduce(function (p, f) { return p.then(function () { return upload(kind, f); }); }, Promise.resolve()).then(drawDocs, drawDocs);
  });
  $("docs").addEventListener("click", function (e) {
    var b = e.target.closest("[data-del]"); if (!b) return;
    var parts = b.dataset.del.split("|");
    b.disabled = true;
    QS.api("DELETE", "/v2/applications/" + st.ref + "/files/" + parts[1], undefined, { "X-Upload-Token": st.up }).then(function (r) {
      if (r._ok || r._status === 404) { st.files[parts[0]] = st.files[parts[0]].filter(function (f) { return f.fileId !== parts[1]; }); save(); }
      else if (r._status === 403) return expired();
      else alertOn(3, r.error);
      drawDocs();
    });
  });

  function shrink(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 700 * 1024 || !window.createImageBitmap) return Promise.resolve(file);
    return createImageBitmap(file).then(function (img) {
      var scale = Math.min(1, 2000 / Math.max(img.width, img.height));
      var c = document.createElement("canvas");
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      return new Promise(function (res) { c.toBlob(function (b) { res(b && b.size < file.size ? b : file); }, "image/jpeg", 0.82); });
    }).catch(function () { return file; });
  }
  function upload(kind, file) {
    alertOff(3);
    if (file.size > 25 * 1024 * 1024) { alertOn(3, file.name + " is too large. Try a photo instead of a scan."); return Promise.resolve(); }
    var box = $("prog-" + kind);
    var row = document.createElement("div");
    row.innerHTML = '<span class="mono" style="font-size:13px">Uploading ' + QS.esc(file.name) + '…</span><div class="progress"><i></i></div>';
    box.appendChild(row);
    return shrink(file).then(function (blob) {
      if (blob.size > 10 * 1024 * 1024) throw { msg: file.name + " is over 10 MB. Try a photo instead of a scan." };
      return new Promise(function (resolve, reject) {
        var x = new XMLHttpRequest();
        x.open("PUT", QS.API + "/v2/applications/" + st.ref + "/files/" + kind);
        x.setRequestHeader("X-Upload-Token", st.up);
        x.setRequestHeader("Content-Type", blob.type || "application/octet-stream");
        x.upload.onprogress = function (ev) { if (ev.lengthComputable) row.querySelector("i").style.width = Math.round(ev.loaded / ev.total * 100) + "%"; };
        x.onload = function () {
          var j = {}; try { j = JSON.parse(x.responseText); } catch (e) {}
          if (x.status === 201) resolve(j);
          else if (x.status === 403) reject({ expired: true });
          else reject({ msg: j.error || "That upload didn't work. Try again." });
        };
        x.onerror = function () { reject({ msg: "The upload stopped. Check your connection and try again." }); };
        x.send(blob);
      });
    }).then(function (j) {
      st.files[kind].push({ fileId: j.fileId, name: file.name }); save();
    }).catch(function (err) {
      if (err && err.expired) return expired();
      alertOn(3, (err && err.msg) || "That upload didn't work. Try again.");
    }).then(function () { row.remove(); });
  }

  // ---------- sheet 4
  function drawSummary() {
    var c = QS.cost(st.amount);
    var nFiles = st.files.id.length + st.files.payslip.length + st.files.bank.length;
    $("summary").innerHTML =
      '<div class="line"><span>' + QS.esc(st.d.fullName || "") + '</span><button type="button" class="link-btn mono" data-go="2" style="font-size:12px">EDIT</button></div>'
      + '<div class="line"><span>' + nFiles + ' documents attached</span><button type="button" class="link-btn mono" data-go="3" style="font-size:12px">EDIT</button></div>'
      + '<div class="line"><span>Borrow · repay on payday</span><span>' + QS.money(c.amount) + "</span></div>"
      + '<div class="line total"><span>TO REPAY</span><span>' + QS.money(c.total) + "</span></div>";
  }
  $("summary").addEventListener("click", function (e) { var b = e.target.closest("[data-go]"); if (b) show(Number(b.dataset.go)); });

  // ---------- navigation
  function alertOn(n, msg) { var a = $("alert" + n); if (a) { a.textContent = msg; a.hidden = false; } }
  function alertOff(n) { var a = $("alert" + n); if (a) a.hidden = true; }
  function expired() {
    st.ref = null; st.up = null; st.files = { id: [], payslip: [], bank: [] }; save();
    show(2);
    alertOn(2, "Your session ran out, so we need to start your application again. Your details are still filled in; tap Next to continue.");
  }
  function show(n) {
    st.sheet = n; save();
    for (var i = 1; i <= 5; i += 1) $("s" + i).hidden = i !== n;
    var tabs = $("tabs").children;
    for (var t = 0; t < 4; t += 1) tabs[t].className = t + 1 < n ? "done" : t + 1 === n ? "now" : "";
    $("sheetLabel").textContent = n <= 4 ? "Application · sheet " + n + " of 4" : "Application handed in";
    $("back").hidden = n === 1 || n === 5;
    var next = $("next");
    if (n === 5) {
      next.outerHTML = '<a class="btn btn-leaf" id="next" href="/track" style="flex:1">Track this application</a>';
      $("footNote").innerHTML = '<a href="/" style="color:var(--desk-ink)">Done</a>';
    } else {
      next.textContent = LABELS[n];
      next.className = "btn " + (n === 4 ? "btn-canary" : "btn-leaf");
      $("footNote").textContent = n === 3 ? "Stored privately. Only our credit staff can open them." : "Saved on this phone as you go.";
    }
    if (n === 2 && !st.ref && !bot) bot = QS.botCheck($("ts2"));
    if (n === 2 && st.ref) $("ts2").hidden = true;
    if (n === 3) drawDocs();
    if (n === 4) drawSummary();
    var h = $("h" + n); if (h) h.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }

  $("back").onclick = function () { if (!busy) show(Math.max(1, st.sheet - 1)); };
  $("next").onclick = function () {
    if (busy) return;
    var n = st.sheet;
    if (n === 1) {
      if (!st.purpose) { $("err-purpose").textContent = "Tick what the loan is for."; return; }
      return show(2);
    }
    if (n === 2) return saveDetails();
    if (n === 3) {
      var missing = KINDS.filter(function (k) { return !(st.files[k.kind] || []).length; });
      if (missing.length) { alertOn(3, "Still needed: " + missing.map(function (k) { return k.title.replace(/^3\.\d /, ""); }).join(", ") + "."); return; }
      return show(4);
    }
    if (n === 4) return handIn();
  };

  function working(on, label) {
    busy = on; var b = $("next"); b.disabled = on;
    if (label) b.textContent = on ? label : LABELS[st.sheet];
  }

  function saveDetails() {
    alertOff(2);
    var missing = {};
    ["fullName", "nationalId", "phone", "employer", "payday", "netIncome", "kinName", "kinPhone"].forEach(function (k) {
      if (!String(st.d[k] || "").trim()) missing[k] = "This is needed.";
    });
    if (Object.keys(missing).length) return fieldErrors(missing);
    working(true, "Saving…");
    var req = st.ref
      ? QS.api("PUT", "/v2/applications/" + st.ref, payload(), { "X-Upload-Token": st.up })
      : bot.token().then(function (t) { return QS.api("POST", "/v2/applications", Object.assign(payload(), { turnstileToken: t })); });
    req.then(function (r) {
      working(false, true);
      if (r._ok) {
        if (r.uploadToken) { st.ref = r.reference; st.up = r.uploadToken; save(); }
        fieldErrors({});
        return show(3);
      }
      if (bot && !r.fields) bot.reset(); // a field error doesn't use up the security check
      if (r._status === 403 && st.ref) return expired();
      if (r.fields) { fieldErrors(r.fields); if (r.fields.amount || r.fields.purpose) alertOn(2, r.fields.amount || r.fields.purpose); return; }
      alertOn(2, r.error || "Something went wrong. Try again.");
    });
  }

  function handIn() {
    alertOff(4);
    var f = $("signForm").elements;
    if (!f.creditCheck.checked || !f.privacy.checked || !f.truthful.checked) return alertOn(4, "Tick all three boxes to hand in your application.");
    var name = f.signedName.value.trim().replace(/\s+/g, " ");
    if (name.toLowerCase() !== String(st.d.fullName || "").trim().replace(/\s+/g, " ").toLowerCase()) {
      return alertOn(4, "Type your full name exactly as on sheet 2: " + (st.d.fullName || ""));
    }
    working(true, "Handing in…");
    QS.api("POST", "/v2/applications/" + st.ref + "/submit",
      { consent: { creditCheck: true, privacy: true, truthful: true }, signedName: name },
      { "X-Upload-Token": st.up }).then(function (r) {
      working(false, true);
      if (r._ok) {
        var c = QS.cost(st.amount);
        var receipt = { ref: r.reference, trackToken: r.trackToken, name: st.d.fullName, amount: c.amount, total: c.total, at: r.submittedAt };
        QS.store.set(RECEIPT, receipt);
        QS.store.del(KEY);
        drawReceipt(receipt);
        return show(5);
      }
      if (r._status === 403) return expired();
      if (r.missing) { show(3); alertOn(3, "Some documents are missing. Attach them and try again."); return; }
      alertOn(4, r.error || "Something went wrong. Try again.");
    });
  }

  function drawReceipt(rc) {
    var when = new Date(rc.at);
    $("rRef").textContent = rc.ref;
    $("rLines").innerHTML =
      '<div class="line"><span>Name</span><span>' + QS.esc(rc.name) + "</span></div>"
      + '<div class="line"><span>Asked for</span><span>' + QS.money(rc.amount) + " · payday</span></div>"
      + '<div class="line"><span>Handed in</span><span>' + when.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) + " · " + when.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) + "</span></div>";
    $("rStamp").innerHTML = "Received<small>" + when.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).toUpperCase() + "</small>";
  }

  drawAmount();
  show(st.sheet === 5 ? 1 : st.sheet);
  if (st.sheet >= 3 && !st.ref) show(2);
})();
