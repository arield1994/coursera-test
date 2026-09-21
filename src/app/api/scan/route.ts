import type { NextRequest } from "next/server";
import { bool, devigMethod, fail, list, loadEvents, num, ok } from "@/lib/api";
import { DEFAULT_SCAN_OPTIONS, scanForEv } from "@/lib/ev/scanner";
import { DEFAULT_SHARP_BOOKS } from "@/lib/odds/books";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  try {
    const { events, demo, sportKeys } = await loadEvents(params);

    const opportunities = scanForEv(events, {
      devigMethod: devigMethod(params, DEFAULT_SCAN_OPTIONS.devigMethod),
      sharpBooks: list(params, "sharp", DEFAULT_SHARP_BOOKS),
      targetBooks: list(params, "books"),
      marketKeys: list(params, "markets"),
      minEvPercent: num(params, "minEv", DEFAULT_SCAN_OPTIONS.minEvPercent),
      maxEvPercent: num(params, "maxEv", DEFAULT_SCAN_OPTIONS.maxEvPercent),
      minSharpBooks: num(params, "minSharp", DEFAULT_SCAN_OPTIONS.minSharpBooks),
      maxHoursAhead: num(params, "maxHours", DEFAULT_SCAN_OPTIONS.maxHoursAhead),
      includeSharpAsTarget: bool(params, "includeSharp"),
      stake: {
        bankroll: num(params, "bankroll", DEFAULT_SCAN_OPTIONS.stake.bankroll),
        kellyMultiplier: num(params, "kelly", DEFAULT_SCAN_OPTIONS.stake.kellyMultiplier),
        maxStakeFraction: num(params, "maxStake", DEFAULT_SCAN_OPTIONS.stake.maxStakeFraction ?? 0.05),
      },
    });

    const limit = num(params, "limit", 300);
    return ok(opportunities.slice(0, limit), {
      demo,
      sportKeys,
      eventCount: events.length,
      total: opportunities.length,
    });
  } catch (error) {
    return fail(error);
  }
}
