/**
 * A console snippet that finds a bookmaker's odds API while you browse it.
 *
 * Paste it into DevTools on the book's own site and it wraps fetch and
 * XMLHttpRequest, inspects the JSON going past, and works out which request
 * carries the odds and how to read it. No HAR export, no file to move around,
 * and it sees exactly what your logged-in session sees.
 *
 * It only ever reads. Requests are passed through untouched, every hook is
 * wrapped in try/catch so a failure here cannot break the page, and
 * `__edgescan.stop()` puts the originals back.
 */

import {
  inferMapping,
  describeShape,
  redactUrl,
  type InferredMapping,
} from "../src/lib/ingest/discover";
import { readPath } from "../src/lib/ingest/pull";
import type { FieldMapping } from "../src/lib/ingest/pull";

interface Hit {
  url: string;
  method: string;
  headerNames: string[];
  /** True when the request relied on cookies rather than an explicit header. */
  cookieAuth: boolean;
  inferred: InferredMapping;
  shape: unknown;
  seen: number;
}

const AUTH_HEADER =
  /^(authorization|x-api-key|x-auth|x-access-token|apikey|api-key|x-session|x-device|x-client|ocp-apim-subscription-key)/i;

const hits = new Map<string, Hit>();
let announced = false;

function record(url: string, method: string, headerNames: string[], text: string): void {
  try {
    if (!text || text.length < 40) return;
    const trimmed = text.trimStart();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return;

    const body = JSON.parse(text);
    const inferred = inferMapping(body);
    if (!inferred) return;

    const key = url.split("?")[0];
    const existing = hits.get(key);
    if (existing && existing.inferred.confidence >= inferred.confidence) {
      existing.seen++;
      return;
    }

    const auth = headerNames.filter((name) => AUTH_HEADER.test(name));

    // Describe only the branch holding the games. The rest of a logged-in
    // response is account data -- balances, customer records -- that has no
    // bearing on the mapping and should not travel with it, not even as
    // key names.
    const branch = inferred.mapping.lines
      ? readPath(body, inferred.mapping.lines)
      : body;

    hits.set(key, {
      url,
      method,
      headerNames: auth,
      cookieAuth: auth.length === 0,
      inferred,
      shape: describeShape(branch),
      seen: (existing?.seen ?? 0) + 1,
    });

    if (!announced) {
      announced = true;
      console.log(
        "%c[EdgeScan] Found an odds endpoint. Run __edgescan.report() when you have clicked around a bit.",
        "color:#3fd39a;font-weight:bold",
      );
    }
  } catch {
    // Never let inspection interfere with the page.
  }
}

function headerNamesFrom(init?: RequestInit, request?: Request): string[] {
  const names: string[] = [];
  try {
    const headers = init?.headers ?? request?.headers;
    if (!headers) return names;
    if (typeof Headers !== "undefined" && headers instanceof Headers) {
      headers.forEach((_value, name) => names.push(name));
    } else if (Array.isArray(headers)) {
      for (const [name] of headers) names.push(name);
    } else {
      names.push(...Object.keys(headers as Record<string, string>));
    }
  } catch {
    // Header shape varies; names are a nicety, not required.
  }
  return names;
}

const originalFetch = window.fetch;
const originalOpen = XMLHttpRequest.prototype.open;
const originalSend = XMLHttpRequest.prototype.send;
const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;

function install(): void {
  window.fetch = async function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const response = await originalFetch.call(window, input as RequestInfo, init);
    try {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? (input as Request)?.method ?? "GET").toUpperCase();
      // Read from a clone so the page still gets an unconsumed body.
      response
        .clone()
        .text()
        .then((text) =>
          record(
            new URL(url, location.href).href,
            method,
            headerNamesFrom(init, input as Request),
            text,
          ),
        )
        .catch(() => {});
    } catch {
      // Pass through regardless.
    }
    return response;
  };

  interface TrackedXhr extends XMLHttpRequest {
    __es?: { url: string; method: string; headers: string[] };
  }

  XMLHttpRequest.prototype.open = function patchedOpen(
    this: TrackedXhr,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    try {
      this.__es = { url: new URL(String(url), location.href).href, method, headers: [] };
    } catch {
      // Ignore unparseable URLs.
    }
    // eslint-disable-next-line prefer-rest-params
    return originalOpen.apply(this, arguments as never);
  } as typeof XMLHttpRequest.prototype.open;

  XMLHttpRequest.prototype.setRequestHeader = function patchedSetHeader(
    this: TrackedXhr,
    name: string,
    value: string,
  ) {
    try {
      this.__es?.headers.push(name);
    } catch {
      // Ignore.
    }
    return originalSetHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function patchedSend(this: TrackedXhr, ...args: unknown[]) {
    try {
      this.addEventListener("load", () => {
        try {
          const meta = this.__es;
          if (!meta) return;
          const text =
            typeof this.responseType === "string" &&
            this.responseType !== "" &&
            this.responseType !== "text"
              ? this.responseType === "json"
                ? JSON.stringify(this.response)
                : ""
              : this.responseText;
          record(meta.url, meta.method, meta.headers, text);
        } catch {
          // Ignore.
        }
      });
    } catch {
      // Ignore.
    }
    // eslint-disable-next-line prefer-rest-params
    return originalSend.apply(this, arguments as never);
  } as typeof XMLHttpRequest.prototype.send;
}

function ranked(): Hit[] {
  return [...hits.values()].sort((a, b) => b.inferred.confidence - a.inferred.confidence);
}

function sourceConfig(hit: Hit, key: string) {
  const headers: Record<string, string> = {};
  for (const name of hit.headerNames) {
    headers[name] = `REPLACE_WITH_YOUR_${name.toUpperCase()}`;
  }
  if (hit.cookieAuth) headers["Cookie"] = "REPLACE_WITH_YOUR_COOKIE";

  return {
    key,
    title: key,
    url: hit.url,
    headers,
    sharp: false,
    ttlSeconds: 60,
    mapping: hit.inferred.mapping as FieldMapping,
  };
}

const api = {
  /** Full report, including the real URL and a ready CUSTOM_SOURCES line. */
  report(bookKey = "mybookie") {
    const found = ranked();
    if (found.length === 0) {
      console.log(
        "%c[EdgeScan] Nothing yet. Click through to a page that shows prices, then run __edgescan.report() again.",
        "color:#f0b429",
      );
      return;
    }

    console.log(`%c[EdgeScan] ${found.length} candidate endpoint(s)`, "font-weight:bold");
    console.table(
      found.map((hit) => ({
        confidence: `${Math.round(hit.inferred.confidence * 100)}%`,
        games: hit.inferred.gameCount,
        auth: hit.cookieAuth ? "cookies" : hit.headerNames.join(", "),
        url: hit.url.slice(0, 90),
      })),
    );

    for (const note of found[0].inferred.notes) console.log(`note: ${note}`);
    if (found[0].cookieAuth) {
      console.log(
        "note: this request carried no auth header, so the session is cookie-based. " +
          "Copy the Cookie request header from the Network tab into the config below.",
      );
    }

    const line = `CUSTOM_SOURCES='${JSON.stringify([sourceConfig(found[0], bookKey)])}'`;
    console.log("%c\nPaste into your .env (keep it private):\n", "font-weight:bold");
    console.log(line);
    console.log(
      "%c\nThis line contains the live URL, which usually carries a session token in\n" +
        "its query string. Treat it like a password. To send it to someone helping\n" +
        "you, use __edgescan.share() instead, which strips every value.",
      "color:#f0b429",
    );
    console.log("\ncopy(__edgescan.env())    copy(__edgescan.share())");
    return line;
  },

  /** The CUSTOM_SOURCES line on its own, for copy(). */
  env(bookKey = "mybookie") {
    const found = ranked();
    if (found.length === 0) return "";
    return `CUSTOM_SOURCES='${JSON.stringify([sourceConfig(found[0], bookKey)])}'`;
  },

  /**
   * A summary with nothing secret in it — safe to paste to someone helping.
   * No header values, no cookies, no query values, no response values.
   */
  share() {
    return JSON.stringify(
      {
        endpoints: ranked()
          .slice(0, 3)
          .map((hit) => ({
            url: redactUrl(hit.url),
            method: hit.method,
            confidence: hit.inferred.confidence,
            games: hit.inferred.gameCount,
            auth: hit.cookieAuth ? ["cookie-based"] : hit.headerNames,
            mapping: hit.inferred.mapping,
            // Scoped to the games array; see record().
            shapeOfGames: hit.shape,
            notes: hit.inferred.notes,
          })),
        candidates: hits.size,
      },
      null,
      2,
    );
  },

  /** Restore the originals. */
  stop() {
    window.fetch = originalFetch;
    XMLHttpRequest.prototype.open = originalOpen;
    XMLHttpRequest.prototype.send = originalSend;
    XMLHttpRequest.prototype.setRequestHeader = originalSetHeader;
    console.log("[EdgeScan] stopped; originals restored.");
  },
};

install();
(window as unknown as Record<string, unknown>).__edgescan = api;

console.log(
  "%c[EdgeScan] listening. Click through to a page showing odds, then run __edgescan.report()",
  "color:#3fd39a;font-weight:bold",
);
