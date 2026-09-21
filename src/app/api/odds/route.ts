import type { NextRequest } from "next/server";
import { fail, loadEvents, ok } from "@/lib/api";

export const dynamic = "force-dynamic";

/** Raw normalised board, used by the line-shopping screen. */
export async function GET(request: NextRequest) {
  try {
    const { events, demo } = await loadEvents(request.nextUrl.searchParams);
    return ok(events, { demo, eventCount: events.length });
  } catch (error) {
    return fail(error);
  }
}
