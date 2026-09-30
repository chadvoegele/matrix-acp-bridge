export type TimerHandle = unknown;

/** Time is represented as Unix epoch milliseconds. */
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** The production clock boundary used by timers in later modules. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs): TimerHandle => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle): void => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};
