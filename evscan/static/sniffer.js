/* evscan endpoint sniffer -- paste into your book's DevTools console.
 *
 * Hooks fetch() and XMLHttpRequest, watches what the page requests, and
 * reports which call carries the odds. Everything stays in your browser.
 *
 * It deliberately never reads document.cookie, never records the value of
 * any auth header, and never transmits anything. It prints a report you
 * choose to share.
 *
 *   evscan.report()   ranked summary, safe to paste
 *   evscan.shape(n)   field paths of candidate n, for the adapter mapping
 *   evscan.stop()     unhook and restore the originals
 */
(function () {
  "use strict";

  if (window.evscan && window.evscan.__active) {
    console.log("%cevscan is already running. evscan.report() to see results.",
                "color:#d29922");
    return;
  }

  var URL_SIGNALS = {
    getlines: 6, getodds: 6, getschedule: 5, odds: 5, line: 5, lines: 5,
    board: 5, offering: 5, market: 4, wager: 4, sport: 3, event: 3,
    game: 3, schedule: 3, matchup: 3, contest: 3, bet: 3, league: 2
  };
  var URL_NOISE = ["analytics", "telemetry", "gtag", "collect", "beacon",
                   "pixel", "sentry", "hotjar", "doubleclick", "facebook",
                   "recaptcha", "fonts", "heartbeat", "/ping", "/log"];
  var KEY_SIGNALS = {
    rotation: 8, rotnum: 8, rot: 6, moneyline: 7, wagertype: 5, juice: 6,
    spread: 6, handicap: 5, total: 5, odds: 5, price: 4, line: 4,
    hometeam: 5, awayteam: 5, teamname: 4, gamedate: 4, gametime: 4,
    starttime: 3, period: 3, sportid: 4, leagueid: 3, eventid: 3
  };
  var AMERICAN = /(?<![\d.])[-+](?:[1-9]\d{2}|100)(?![\d.])/g;
  var AUTH_HEADERS = ["cookie", "authorization", "x-auth-token", "x-api-key",
                      "x-access-token", "x-session-id", "x-csrf-token",
                      "x-xsrf-token", "authtoken", "token"];

  var captured = [];

  function walk(node, prefix, out, depth) {
    if (depth > 8 || out.length > 300) return out;
    if (node && typeof node === "object") {
      if (Array.isArray(node)) {
        node.slice(0, 2).forEach(function (item) {
          walk(item, prefix + "[*]", out, depth + 1);
        });
      } else {
        Object.keys(node).forEach(function (key) {
          walk(node[key], prefix ? prefix + "." + key : key, out, depth + 1);
        });
      }
    } else {
      out.push([prefix, node === null ? "null" : typeof node, node]);
    }
    return out;
  }

  function score(url, text, body) {
    var lowered = url.toLowerCase(), total = 0, why = [];
    for (var i = 0; i < URL_NOISE.length; i++) {
      if (lowered.indexOf(URL_NOISE[i]) !== -1) return null;
    }
    Object.keys(URL_SIGNALS).forEach(function (word) {
      if (lowered.indexOf(word) !== -1) { total += URL_SIGNALS[word]; why.push("url:" + word); }
    });
    if (body) {
      total += 4; why.push("json");
      var hits = {};
      walk(body, "", [], 0).forEach(function (row) {
        var leaf = row[0].split(".").pop().replace(/\[\*\]/g, "").toLowerCase().replace(/[_-]/g, "");
        Object.keys(KEY_SIGNALS).forEach(function (sig) {
          if (leaf === sig.replace(/_/g, "")) { hits[sig] = 1; total += KEY_SIGNALS[sig]; }
        });
      });
      var names = Object.keys(hits);
      if (names.length) why.push("fields:" + names.slice(0, 5).join(","));
    }
    var prices = (text.match(AMERICAN) || []).length;
    if (prices >= 4) { total += Math.min(12, prices * 0.5); why.push(prices + " odds-like values"); }
    return total > 0 ? { score: total, why: why } : null;
  }

  function record(url, method, status, text, headerNames) {
    if (!text || text.length < 20) return;
    var body = null;
    try { body = JSON.parse(text); } catch (e) { /* html or not json */ }
    var verdict = score(url, text, body);
    if (!verdict) return;

    var auth = (headerNames || []).filter(function (name) {
      return AUTH_HEADERS.indexOf(name.toLowerCase()) !== -1;
    });

    var parsed;
    try { parsed = new URL(url, location.href); } catch (e) { return; }

    captured.push({
      url: parsed.origin + parsed.pathname,
      params: Array.from(parsed.searchParams.keys()),
      method: method, status: status, score: verdict.score,
      why: verdict.why, bytes: text.length, body: body,
      isJson: body !== null, authHeaders: auth
    });
    captured.sort(function (a, b) { return b.score - a.score; });
  }

  /* ---- hook fetch ---- */
  var origFetch = window.fetch;
  window.fetch = function () {
    var args = arguments;
    var req = args[0];
    var url = (typeof req === "string") ? req : (req && req.url) || "";
    var method = (args[1] && args[1].method) ||
                 (req && req.method) || "GET";
    var headerNames = [];
    try {
      var h = (args[1] && args[1].headers) || (req && req.headers);
      if (h) {
        if (typeof h.forEach === "function") h.forEach(function (_v, k) { headerNames.push(k); });
        else Object.keys(h).forEach(function (k) { headerNames.push(k); });
      }
    } catch (e) { /* ignore */ }

    return origFetch.apply(this, args).then(function (res) {
      try {
        res.clone().text().then(function (text) {
          record(url, method, res.status, text, headerNames);
        }).catch(function () {});
      } catch (e) { /* ignore */ }
      return res;
    });
  };

  /* ---- hook XMLHttpRequest ---- */
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  var origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ev = { method: method, url: url, headers: [] };
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name) {
    if (this.__ev) this.__ev.headers.push(name);
    return origSetHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var self = this;
    this.addEventListener("load", function () {
      if (!self.__ev) return;
      var text = "";
      try {
        text = (self.responseType === "" || self.responseType === "text")
          ? self.responseText
          : (self.responseType === "json" ? JSON.stringify(self.response) : "");
      } catch (e) { return; }
      record(self.__ev.url, self.__ev.method, self.status, text, self.__ev.headers);
    });
    return origSend.apply(this, arguments);
  };

  /* ---- public API ---- */
  window.evscan = {
    __active: true,
    raw: captured,

    report: function (top) {
      top = top || 5;
      if (!captured.length) {
        console.log("%cNothing captured yet.", "color:#d29922;font-weight:bold");
        console.log("Reload the odds board (Ctrl-Shift-R) WITHOUT closing DevTools,\n" +
                    "or click into a league so the page fetches lines. Then run evscan.report().\n" +
                    "If it stays empty, your board is server-rendered HTML -- tell Claude that.");
        return;
      }
      var out = "evscan: " + captured.length + " candidate request(s)\n\n";
      captured.slice(0, top).forEach(function (c, i) {
        out += (i + 1) + ". [score " + c.score.toFixed(0) + "] " + c.method + " " + c.url + "\n";
        out += "     status " + c.status + ", " + c.bytes + " bytes, " +
               (c.isJson ? "JSON" : "not JSON") + "\n";
        out += "     signals: " + c.why.join(" | ") + "\n";
        if (c.params.length) out += "     query params: " + c.params.join(", ") + "\n";
        out += "     auth header: " + (c.authHeaders.length
                 ? c.authHeaders.join(", ") + " (value NOT captured)"
                 : "none seen -- probably a plain session cookie") + "\n\n";
      });
      out += "Run evscan.shape(1) for the field layout of candidate 1.\n";
      console.log("%c" + out, "font-family:monospace;font-size:12px");
      return out;
    },

    shape: function (n) {
      var c = captured[(n || 1) - 1];
      if (!c) { console.log("no candidate " + n); return; }
      if (!c.isJson) { console.log("candidate " + n + " is not JSON (server-rendered HTML)"); return; }
      var seen = {}, out = "field layout of " + c.url + "\n\n";
      walk(c.body, "", [], 0).forEach(function (row) {
        if (seen[row[0]]) return;
        seen[row[0]] = 1;
        var sample = String(row[2]);
        if (sample.length > 34) sample = sample.slice(0, 34) + "...";
        out += "  " + row[0].padEnd(46) + row[1].padEnd(8) + sample + "\n";
      });
      out += "\nCheck this for anything personal (name, balance) before sharing it.\n";
      console.log("%c" + out, "font-family:monospace;font-size:12px");
      return out;
    },

    stop: function () {
      window.fetch = origFetch;
      XMLHttpRequest.prototype.open = origOpen;
      XMLHttpRequest.prototype.send = origSend;
      XMLHttpRequest.prototype.setRequestHeader = origSetHeader;
      window.evscan.__active = false;
      console.log("evscan unhooked. Captured data is still in evscan.raw");
    }
  };

  console.log("%cevscan is watching.", "color:#3fb950;font-weight:bold;font-size:14px");
  console.log("%cNow reload the odds board (Ctrl-Shift-R), then run: evscan.report()",
              "color:#58a6ff;font-size:13px");
  console.log("Your cookies and auth values are never read or recorded.");
})();
