import { describe, expect, it } from "vitest";
import {
  canonicalizeOutcomeName,
  matchEvent,
  normalizeTeam,
  teamSimilarity,
} from "../src/lib/odds/match";
import type { GameEvent } from "../src/lib/odds/types";

const HOUR = 3_600_000;

function game(
  id: string,
  awayTeam: string,
  homeTeam: string,
  sportKey = "basketball_nba",
  hoursAhead = 6,
): GameEvent {
  return {
    id,
    sportKey,
    sportTitle: sportKey,
    commenceTime: new Date(Date.now() + hoursAhead * HOUR).toISOString(),
    homeTeam,
    awayTeam,
    markets: [],
  };
}

describe("team normalization", () => {
  it("collapses the ways one team gets written", () => {
    const variants = ["Los Angeles Lakers", "LA Lakers", "L.A. Lakers", "los angeles lakers"];
    for (const variant of variants) {
      expect(normalizeTeam(variant), variant).toBe("los angeles lakers");
    }
  });

  it("strips club suffixes and accents", () => {
    expect(normalizeTeam("Manchester City FC")).toBe("manchester city");
    expect(normalizeTeam("Atlético Madrid")).toBe("atletico madrid");
    expect(normalizeTeam("Man Utd")).toBe("manchester united");
  });

  it("scores identical teams above different ones in the same city", () => {
    expect(teamSimilarity("LA Lakers", "Los Angeles Lakers")).toBe(1);
    expect(teamSimilarity("Lakers", "Los Angeles Lakers")).toBeGreaterThan(0.9);
    // Same city, different team — the dangerous near-miss.
    expect(teamSimilarity("Los Angeles Lakers", "Los Angeles Clippers")).toBeLessThan(0.8);
    expect(teamSimilarity("New York Yankees", "New York Mets")).toBeLessThan(0.8);
    expect(teamSimilarity("New York Jets", "New York Giants")).toBeLessThan(0.8);
  });
});

describe("event matching", () => {
  const events = [
    game("a", "Los Angeles Lakers", "Boston Celtics"),
    game("b", "New York Knicks", "Philadelphia 76ers"),
    game("c", "Los Angeles Clippers", "Denver Nuggets"),
  ];

  it("attaches an abbreviated scrape to the right game", () => {
    const match = matchEvent(
      { awayTeam: "LA Lakers", homeTeam: "Celtics", sportKey: "basketball_nba" },
      events,
    );
    expect(match?.event.id).toBe("a");
    expect(match?.flipped).toBe(false);
  });

  it("detects a source that lists the teams the other way round", () => {
    const match = matchEvent({ awayTeam: "Boston Celtics", homeTeam: "LA Lakers" }, events);
    expect(match?.event.id).toBe("a");
    expect(match?.flipped).toBe(true);
  });

  it("does not confuse the Lakers with the Clippers", () => {
    const match = matchEvent({ awayTeam: "LA Clippers", homeTeam: "Nuggets" }, events);
    expect(match?.event.id).toBe("c");
  });

  it("drops a line it cannot place rather than guessing", () => {
    expect(matchEvent({ awayTeam: "Miami Heat", homeTeam: "Chicago Bulls" }, events)).toBeNull();
  });

  it("refuses an ambiguous nickname instead of picking one", () => {
    // "United" alone fits both; attaching it to either would invent an edge.
    const ambiguous = [
      game("x", "Manchester United", "Arsenal", "soccer_epl"),
      game("y", "Newcastle United", "Arsenal", "soccer_epl"),
    ];
    expect(matchEvent({ awayTeam: "United", homeTeam: "Arsenal" }, ambiguous)).toBeNull();
    // Spelled out, it resolves cleanly.
    expect(
      matchEvent({ awayTeam: "Man Utd", homeTeam: "Arsenal" }, ambiguous)?.event.id,
    ).toBe("x");
  });

  it("will not match across sports", () => {
    const match = matchEvent(
      { awayTeam: "LA Lakers", homeTeam: "Celtics", sportKey: "icehockey_nhl" },
      events,
    );
    expect(match).toBeNull();
  });

  it("will not match a fixture played on another day", () => {
    const candidate = {
      awayTeam: "LA Lakers",
      homeTeam: "Celtics",
      commenceTime: new Date(Date.now() + 72 * HOUR).toISOString(),
    };
    expect(matchEvent(candidate, events)).toBeNull();
    expect(matchEvent(candidate, events, { toleranceMs: 96 * HOUR })?.event.id).toBe("a");
  });

  it("tolerates sources disagreeing about the start time by minutes", () => {
    const event = events[0];
    const candidate = {
      awayTeam: "LA Lakers",
      homeTeam: "Celtics",
      commenceTime: new Date(Date.parse(event.commenceTime) + 10 * 60_000).toISOString(),
    };
    expect(matchEvent(candidate, events)?.event.id).toBe("a");
  });
});

describe("outcome canonicalization", () => {
  const event = game("a", "Los Angeles Lakers", "Boston Celtics");

  it("rewrites a scraped team name to the feed's spelling", () => {
    expect(canonicalizeOutcomeName("LA Lakers", event)).toBe("Los Angeles Lakers");
    expect(canonicalizeOutcomeName("Celtics", event)).toBe("Boston Celtics");
  });

  it("leaves non-team outcomes alone", () => {
    for (const name of ["Over", "Under", "Draw", "LeBron James"]) {
      expect(canonicalizeOutcomeName(name, event)).toBe(name);
    }
  });
});
