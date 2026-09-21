import { timingSafeEqual } from "node:crypto";

export interface AuthResult {
  ok: boolean;
  status: number;
  message?: string;
  hint?: string;
}

/**
 * Guard the ingest endpoint with a shared secret.
 *
 * With no token configured the endpoint is open in development and *closed* in
 * production. An unauthenticated write path that injects prices straight into
 * the scanner is not something to leave open by accident, and failing closed
 * makes the misconfiguration obvious the first time a scraper posts.
 */
export function authorizeIngest(headers: Headers): AuthResult {
  const expected = process.env.INGEST_TOKEN?.trim();

  if (!expected) {
    if (process.env.NODE_ENV === "production") {
      return {
        ok: false,
        status: 503,
        message: "Ingest is disabled because INGEST_TOKEN is not set.",
        hint: "Set INGEST_TOKEN in the server environment and send it as 'Authorization: Bearer <token>'.",
      };
    }
    return { ok: true, status: 200 };
  }

  const header = headers.get("authorization") ?? "";
  const supplied =
    (header.toLowerCase().startsWith("bearer ") ? header.slice(7) : "") ||
    headers.get("x-ingest-token") ||
    "";

  if (!supplied || !constantTimeEquals(supplied.trim(), expected)) {
    return {
      ok: false,
      status: 401,
      message: "Missing or invalid ingest token.",
      hint: "Send 'Authorization: Bearer <INGEST_TOKEN>'.",
    };
  }

  return { ok: true, status: 200 };
}

/** Compare without leaking the answer through response timing. */
function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  // timingSafeEqual throws on length mismatch, which would itself be a leak,
  // so equalise the comparison length first.
  if (bufferA.length !== bufferB.length) {
    timingSafeEqual(bufferA, bufferA);
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}
