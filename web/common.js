// Shared by every page: API address, money formatting, the bot check, and
// safe browser storage.
(function () {
  var QS = (window.QS = {});
  QS.API = "https://api.quickserve.group";
  QS.TURNSTILE_SITE_KEY = "0x4AAAAAAF54MSk3VG1JubiX";
  QS.RATE = 0.30;
  QS.MIN = 500;
  QS.MAX = 5000;

  // Namibian style: N$ 2 600.00
  QS.money = function (n, decimals) {
    var d = decimals == null ? 2 : decimals;
    var s = Number(n).toFixed(d);
    var parts = s.split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    return "N$ " + parts.join(".");
  };
  QS.cost = function (amount) {
    var interest = Math.round(amount * QS.RATE * 100) / 100;
    return { amount: amount, interest: interest, total: amount + interest };
  };

  QS.store = {
    get: function (k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };

  QS.api = function (method, path, body, headers) {
    var h = Object.assign({}, headers || {});
    var opts = { method: method, headers: h };
    if (body !== undefined && !(body instanceof Blob)) { h["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    else if (body) opts.body = body;
    return fetch(QS.API + path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { j._status = r.status; j._ok = r.ok; return j; });
    }, function () { return { _status: 0, _ok: false, error: "You seem to be offline. Check your connection and try again." }; });
  };

  // Bot check (Cloudflare Turnstile), rendered on demand into a container.
  var tsReady = null;
  function loadTurnstile() {
    if (tsReady) return tsReady;
    tsReady = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.async = true;
      s.onload = function () { resolve(window.turnstile); };
      s.onerror = function () { tsReady = null; reject(new Error("bot check failed to load")); };
      document.head.appendChild(s);
    });
    return tsReady;
  }
  // Returns { token(): Promise<string>, reset() }.
  QS.botCheck = function (container) {
    var current = null, waiters = [], widgetId = null;
    loadTurnstile().then(function (ts) {
      widgetId = ts.render(container, {
        sitekey: QS.TURNSTILE_SITE_KEY,
        theme: "light",
        callback: function (t) { current = t; waiters.splice(0).forEach(function (w) { w(t); }); },
        "expired-callback": function () { current = null; },
        "error-callback": function () { current = null; }
      });
    }).catch(function () {
      container.textContent = "The security check couldn't load. Refresh the page to try again.";
    });
    return {
      token: function () { return current ? Promise.resolve(current) : new Promise(function (r) { waiters.push(r); }); },
      ready: function () { return Boolean(current); },
      reset: function () { current = null; if (window.turnstile && widgetId != null) window.turnstile.reset(widgetId); }
    };
  };

  QS.esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  };
})();
