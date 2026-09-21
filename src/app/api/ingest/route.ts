import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { authorizeIngest } from "@/lib/ingest/auth";
import { IngestError, validatePayload } from "@/lib/ingest/types";
import { activeSources, putSource, removeSource } from "@/lib/ingest/store";

export const dynamic = "force-dynamic";

/**
 * Accept lines from a scraper or a private bookie adapter.
 *
 * Responds with what was stored *and* what was rejected and why. A scraper that
 * silently posts 200 malformed lines and gets a 200 back is the failure mode
 * worth designing against here.
 */
export async function POST(request: NextRequest) {
  const auth = authorizeIngest(request.headers);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.message, hint: auth.hint },
      { status: auth.status },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Body is not valid JSON." }, { status: 400 });
  }

  try {
    const result = validatePayload(body);

    if (result.lines.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          error: "No usable lines in payload.",
          rejected: result.errors.length,
          errors: result.errors.slice(0, 20),
        },
        { status: 422 },
      );
    }

    const stored = putSource(result);

    return NextResponse.json({
      ok: true,
      book: stored.book,
      accepted: result.lines.length,
      rejected: result.errors.length,
      errors: result.errors.slice(0, 20),
      expiresAt: new Date(stored.expiresAt).toISOString(),
    });
  } catch (error) {
    if (error instanceof IngestError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json(
      { ok: false, error: (error as Error).message },
      { status: 500 },
    );
  }
}

/** Drop a source immediately rather than waiting for its lines to expire. */
export async function DELETE(request: NextRequest) {
  const auth = authorizeIngest(request.headers);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.message, hint: auth.hint },
      { status: auth.status },
    );
  }

  const key = request.nextUrl.searchParams.get("book");
  if (!key) {
    return NextResponse.json({ ok: false, error: "Pass ?book=<key>." }, { status: 400 });
  }

  return NextResponse.json({ ok: true, removed: removeSource(key) });
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    sources: activeSources().map((source) => ({
      key: source.book.key,
      title: source.book.title,
      lines: source.lines.length,
    })),
  });
}
