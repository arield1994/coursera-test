import type { NextRequest } from "next/server";
import { fail, loadEvents, num, ok } from "@/lib/api";
import { DEFAULT_MIDDLE_OPTIONS, findMiddles } from "@/lib/ev/arbitrage";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  try {
    const { events, demo } = await loadEvents(params);

    const middles = findMiddles(events, {
      totalStake: num(params, "stake", DEFAULT_MIDDLE_OPTIONS.totalStake),
      maxCostPercent: num(params, "maxCost", DEFAULT_MIDDLE_OPTIONS.maxCostPercent),
      minWindowWidth: num(params, "minWidth", DEFAULT_MIDDLE_OPTIONS.minWindowWidth),
      maxHoursAhead: num(params, "maxHours", DEFAULT_MIDDLE_OPTIONS.maxHoursAhead),
    });

    const limit = num(params, "limit", 200);
    return ok(middles.slice(0, limit), {
      demo,
      eventCount: events.length,
      total: middles.length,
    });
  } catch (error) {
    return fail(error);
  }
}
