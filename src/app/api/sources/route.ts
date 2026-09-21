import { NextResponse } from "next/server";
import { activeSources } from "@/lib/ingest/store";
import { pullSourceConfigs } from "@/lib/ingest/pull";

export const dynamic = "force-dynamic";

/** Status of every custom source, for the Sources screen. */
export async function GET() {
  const pullConfigs = pullSourceConfigs();
  const pullKeys = new Set(pullConfigs.map((c) => c.key));

  return NextResponse.json({
    ok: true,
    ingestConfigured: Boolean(process.env.INGEST_TOKEN?.trim()),
    pullConfigured: pullConfigs.length,
    sources: activeSources().map((source) => ({
      key: source.book.key,
      title: source.book.title,
      sharp: source.book.sharp,
      sharpWeight: source.book.sharpWeight,
      lines: source.lines.length,
      receivedAt: new Date(source.receivedAt).toISOString(),
      expiresAt: new Date(source.expiresAt).toISOString(),
      ttlSeconds: source.ttlSeconds,
      createMissingEvents: source.createMissingEvents,
      origin: pullKeys.has(source.book.key) ? "pull" : "push",
      matched: source.lastMatched ?? null,
      unmatched: source.lastUnmatched ?? null,
    })),
  });
}
