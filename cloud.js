/* QuickServe cloud sync — optional, additive layer over the local-first app.
 *
 * The app works exactly as before with this file absent or failing: every
 * network call is guarded, and nothing here runs until the user signs in.
 * When signed in, the whole ledger is mirrored to a Supabase "ledger" row so
 * two phones share one book and the data is backed up off-device.
 *
 * The two constants below are PUBLIC values, safe to ship in a static site:
 *  - the project URL is public,
 *  - the publishable key is the browser-side key; your data is protected by
 *    row-level security + your logins, not by hiding this key.
 * The secret key is never used here and must never be put in client code.
 */
(function () {
  "use strict";

  var CLOUD = {
    url: "https://ptlwhpvzyfpxtpghwlqs.supabase.co",
    key: "sb_publishable_jy5bMPcZ9uIwXHV2M7Sq0g_5uYtWcZH"
  };

  var STORAGE_KEY = "quickserve_cashloan_v1";      // must match app.js
  var SESSION_KEY = "quickserve_cloud_v1";          // our session + sync cursor
  var CONFLICT_KEY = "quickserve_cloud_conflict_v1"; // safety copy on adopt

  // ---------- tiny helpers ----------
  function note(msg) { try { if (typeof toast === "function") toast(msg); } catch (e) {} }
  function readLocal() { try { return localStorage.getItem(STORAGE_KEY) || ""; } catch (e) { return ""; } }
  function hash(str) { // djb2, enough to tell "changed" from "same"
    var h = 5381; for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return String(h >>> 0);
  }
  function session() { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch (e) { return null; } }
  function setSession(s) { try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) {} }
  function clearSession() { try { localStorage.removeItem(SESSION_KEY); } catch (e) {} }

  function api(path, opts) {
    opts = opts || {};
    var headers = Object.assign({ "apikey": CLOUD.key, "Content-Type": "application/json" }, opts.headers || {});
    return fetch(CLOUD.url + path, { method: opts.method || "GET", headers: headers, body: opts.body });
  }

  // ---------- auth ----------
  function storeToken(json, email) {
    var s = session() || {};
    s.access_token = json.access_token;
    s.refresh_token = json.refresh_token;
    s.expires_at = Date.now() + (Number(json.expires_in || 3600) * 1000);
    s.email = email || (json.user && json.user.email) || s.email;
    setSession(s);
  }

  async function signIn(email, password) {
    try {
      var r = await api("/auth/v1/token?grant_type=password", { method: "POST", body: JSON.stringify({ email: email, password: password }) });
      var j = await r.json();
      if (!r.ok) return { ok: false, error: j.error_description || j.msg || j.message || "Sign in failed." };
      storeToken(j, email);
      return { ok: true };
    } catch (e) { return { ok: false, error: "No connection. Check your internet and try again." }; }
  }

  async function signUp(email, password) {
    try {
      var r = await api("/auth/v1/signup", { method: "POST", body: JSON.stringify({ email: email, password: password }) });
      var j = await r.json();
      if (!r.ok) return { ok: false, error: j.error_description || j.msg || j.message || "Could not create the account." };
      if (j.access_token) { storeToken(j, email); return { ok: true, signedIn: true }; }
      return { ok: true, signedIn: false }; // email confirmation required
    } catch (e) { return { ok: false, error: "No connection. Check your internet and try again." }; }
  }

  async function accessToken() {
    var s = session();
    if (!s || !s.access_token) return null;
    if (Date.now() < (s.expires_at || 0) - 60000) return s.access_token;
    try {
      var r = await api("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: JSON.stringify({ refresh_token: s.refresh_token }) });
      var j = await r.json();
      if (!r.ok) return null;
      storeToken(j, s.email);
      return j.access_token;
    } catch (e) { return null; }
  }

  async function signOut() {
    var token = (session() || {}).access_token;
    try { if (token) await api("/auth/v1/logout", { method: "POST", headers: { Authorization: "Bearer " + token } }); } catch (e) {}
    clearSession();
    renderUI();
    note("Signed out of cloud sync.");
  }

  // ---------- ledger row (single shared document, id = 'main') ----------
  async function authHeaders() {
    var token = await accessToken();
    if (!token) return null;
    return { Authorization: "Bearer " + token };
  }

  async function pull() {
    var h = await authHeaders(); if (!h) return { auth: false };
    var r = await api("/rest/v1/ledger?id=eq.main&select=data,rev,updated_at,updated_by", { headers: h });
    if (!r.ok) return { error: "read " + r.status };
    var rows = await r.json();
    return { row: rows && rows[0] ? rows[0] : null };
  }

  async function pushNew(stateStr) {
    var h = await authHeaders(); if (!h) return { auth: false };
    var body = JSON.stringify({ id: "main", data: JSON.parse(stateStr), rev: 1, updated_at: new Date().toISOString(), updated_by: (session() || {}).email || "" });
    var r = await api("/rest/v1/ledger", { method: "POST", headers: Object.assign({ Prefer: "return=representation" }, h), body: body });
    if (!r.ok) return { error: "insert " + r.status };
    var rows = await r.json();
    return { row: rows && rows[0] ? rows[0] : { rev: 1 } };
  }

  async function pushUpdate(stateStr, expectedRev) {
    var h = await authHeaders(); if (!h) return { auth: false };
    var body = JSON.stringify({ data: JSON.parse(stateStr), rev: expectedRev + 1, updated_at: new Date().toISOString(), updated_by: (session() || {}).email || "" });
    var r = await api("/rest/v1/ledger?id=eq.main&rev=eq." + expectedRev, { method: "PATCH", headers: Object.assign({ Prefer: "return=representation" }, h), body: body });
    if (!r.ok) return { error: "update " + r.status };
    var rows = await r.json();
    if (!rows || !rows.length) return { conflict: true }; // rev moved under us
    return { row: rows[0] };
  }

  function markSynced(rev) {
    var s = session() || {}; s.rev = rev; s.syncedHash = hash(readLocal()); s.lastSyncAt = new Date().toISOString(); setSession(s);
  }

  function adoptRemote(row) {
    try {
      // keep a safety copy of what was on this device before we overwrite it
      localStorage.setItem(CONFLICT_KEY, readLocal());
      localStorage.setItem(STORAGE_KEY, JSON.stringify(row.data));
      var s = session() || {}; s.rev = row.rev; s.syncedHash = hash(JSON.stringify(row.data)); s.lastSyncAt = new Date().toISOString(); setSession(s);
    } catch (e) {}
  }

  // Full reconcile — used on load and on the manual "Sync now" button.
  // May reload the page after adopting newer remote data.
  async function syncNow(interactive) {
    var s = session();
    if (!s || !s.access_token) { renderUI(); return; }
    setStatus("Syncing…");
    var pulled = await pull();
    if (pulled.auth === false) { setStatus("Please sign in again."); return; }
    if (pulled.error) { setStatus("Offline — will sync when you're back online."); return; }

    var localStr = readLocal();
    var localDirty = s.syncedHash !== hash(localStr);

    if (!pulled.row) {                       // cloud empty → seed it from this phone
      if (localStr && localStr !== "{}") {
        var seeded = await pushNew(localStr);
        if (seeded.row) { markSynced(seeded.row.rev); setStatus("Backed up to the cloud."); if (interactive) note("Loan book backed up to the cloud."); }
        else setStatus("Couldn't back up yet — try again.");
      } else { setStatus("Signed in. Nothing to sync yet."); }
      renderUI(); return;
    }

    var remoteNewer = (pulled.row.rev || 0) > (s.rev || 0);
    if (remoteNewer) {
      if (localDirty && interactive) {
        note("The other phone had newer data — pulling it in. Your last local change was saved to a recovery copy.");
      }
      adoptRemote(pulled.row);
      if (interactive || localDirty) { location.reload(); return; }
      renderUI(); return;
    }

    // remote is our baseline; push if we changed anything
    if (localDirty) {
      var up = await pushUpdate(localStr, s.rev || (pulled.row.rev || 0));
      if (up.conflict) { var again = await pull(); if (again.row) { adoptRemote(again.row); location.reload(); return; } }
      else if (up.row) { markSynced(up.row.rev); setStatus("Synced."); }
      else setStatus("Offline — will sync when you're back online.");
    } else {
      setStatus("Up to date.");
    }
    renderUI();
  }

  // After a local save: push only. Never adopt/reload mid-edit; if the cloud is
  // newer, we leave local alone and tell the user to Sync, so nothing is lost.
  var pushTimer = null;
  function schedulePush() {
    var s = session(); if (!s || !s.access_token) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(pushIfSafe, 2500);
  }
  async function pushIfSafe() {
    var s = session(); if (!s || !s.access_token) return;
    var localStr = readLocal();
    if (s.syncedHash === hash(localStr)) return; // nothing changed
    var pulled = await pull();
    if (pulled.auth === false || pulled.error) { setStatus("Offline — changes saved on this phone."); return; }
    if (pulled.row && (pulled.row.rev || 0) > (s.rev || 0)) {
      setStatus("The other phone has newer data — tap Sync now to merge.");
      note("Newer data on the other phone — tap Sync now before it can sync.");
      renderUI(); return;
    }
    if (!pulled.row) { var seeded = await pushNew(localStr); if (seeded.row) { markSynced(seeded.row.rev); setStatus("Backed up."); } return; }
    var up = await pushUpdate(localStr, s.rev || pulled.row.rev);
    if (up.conflict) { setStatus("Tap Sync now to merge the other phone's changes."); }
    else if (up.row) { markSynced(up.row.rev); setStatus("Backed up to the cloud."); }
    renderUI();
  }

  // ---------- UI ----------
  function setStatus(text) { var el = document.getElementById("cloudStatus"); if (el) el.textContent = text; }
  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }

  function renderUI() {
    var host = document.getElementById("cloudSyncBody");
    if (!host) return;
    var s = session();
    if (s && s.access_token) {
      var when = s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString() : "not yet";
      host.innerHTML =
        '<p class="item-meta">Signed in as <strong>' + esc(s.email) + '</strong>. Your loan book syncs to the cloud and to your other phone.</p>' +
        '<p class="item-meta" id="cloudStatus">Last synced: ' + esc(when) + '</p>' +
        '<div class="action-row">' +
        '<button class="icon-text-btn primary" type="button" id="cloudSyncNow"><span>Sync now</span></button>' +
        '<button class="icon-text-btn" type="button" id="cloudSignOut"><span>Sign out</span></button>' +
        '</div>';
      var syncBtn = document.getElementById("cloudSyncNow");
      if (syncBtn) syncBtn.addEventListener("click", function () { syncNow(true); });
      var outBtn = document.getElementById("cloudSignOut");
      if (outBtn) outBtn.addEventListener("click", signOut);
    } else {
      host.innerHTML =
        '<p class="item-meta">Sign in to share this loan book with your other phone and back it up off this device.</p>' +
        '<div class="form-grid">' +
        '<label class="wide"><span>Email</span><input id="cloudEmail" type="email" inputmode="email" autocomplete="username" placeholder="you@example.com" /></label>' +
        '<label class="wide"><span>Password</span><input id="cloudPassword" type="password" autocomplete="current-password" placeholder="At least 6 characters" /></label>' +
        '</div>' +
        '<p class="item-meta" id="cloudStatus"></p>' +
        '<div class="action-row">' +
        '<button class="icon-text-btn primary" type="button" id="cloudSignIn"><span>Sign in</span></button>' +
        '<button class="icon-text-btn" type="button" id="cloudCreate"><span>Create account</span></button>' +
        '</div>';
      var inBtn = document.getElementById("cloudSignIn");
      if (inBtn) inBtn.addEventListener("click", function () { doAuth(false); });
      var createBtn = document.getElementById("cloudCreate");
      if (createBtn) createBtn.addEventListener("click", function () { doAuth(true); });
    }
  }

  async function doAuth(isCreate) {
    var email = (document.getElementById("cloudEmail") || {}).value || "";
    var password = (document.getElementById("cloudPassword") || {}).value || "";
    email = email.trim();
    if (!email || password.length < 6) { setStatus("Enter an email and a password of at least 6 characters."); return; }
    setStatus(isCreate ? "Creating account…" : "Signing in…");
    var res = isCreate ? await signUp(email, password) : await signIn(email, password);
    if (!res.ok) { setStatus(res.error || "That didn't work."); return; }
    if (isCreate && !res.signedIn) { setStatus("Account created — check your email to confirm, then sign in."); return; }
    note("Signed in to cloud sync.");
    renderUI();
    await syncNow(true);
  }

  // ---------- wire-up ----------
  function boot() {
    try {
      renderUI();
      document.addEventListener("qs:saved", schedulePush);
      var s = session();
      if (s && s.access_token) { syncNow(false); }
    } catch (e) { /* never break the app */ }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  // expose a tiny surface for debugging / manual use
  window.qsCloud = { sync: function () { return syncNow(true); }, signOut: signOut, session: session };
})();
