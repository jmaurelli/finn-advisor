/**
 * Time and identifiers are injected so expiry and replay behavior can be
 * tested exactly, rather than by sleeping and hoping.
 */
export interface Clock {
  now: () => number;
}

export const systemClock: Clock = { now: () => Date.now() };

export class TestClock implements Clock {
  private current: number;
  constructor(startMs: number) {
    this.current = startMs;
  }
  now = (): number => this.current;
  advance(ms: number): void {
    this.current += ms;
  }
  set(ms: number): void {
    this.current = ms;
  }
}

export function isoTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}
