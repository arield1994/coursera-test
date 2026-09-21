import type { NextRequest } from "next/server";
import { fail, list, loadEvents, num, ok } from "@/lib/api";
import { DEFAULT_ARB_OPTIONS, findArbitrage } from "@/lib/ev/arbitrage";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  try {
    const { events, demo } = await loadEvents(params);

    const arbs = findArbitrage(events, {
      totalStake: num(params, "stake", DEFAULT_ARB_OPTIONS.totalStake),
      minProfitPercent: num(params, "minProfit", DEFAULT_ARB_OPTIONS.minProfitPercent),
      maxProfitPercent: num(params, "maxProfit", DEFAULT_ARB_OPTIONS.maxProfitPercent),
      marketKeys: list(params, "markets"),
      books: list(params, "books"),
      maxHoursAhead: num(params, "maxHours", DEFAULT_ARB_OPTIONS.maxHoursAhead),
    });

    return ok(arbs, { demo, eventCount: events.length, total: arbs.length });
  } catch (error) {
    return fail(error);
  }
}
