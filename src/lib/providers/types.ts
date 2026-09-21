import type { GameEvent, Sport } from "../odds/types";

export interface OddsProvider {
  readonly name: string;
  /** True when the provider is serving generated data rather than live prices. */
  readonly isDemo: boolean;
  listSports(): Promise<Sport[]>;
  fetchOdds(params: {
    sportKeys: string[];
    marketKeys: string[];
    regions?: string[];
  }): Promise<GameEvent[]>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
