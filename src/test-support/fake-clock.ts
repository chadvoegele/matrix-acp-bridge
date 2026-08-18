import type { Clock, TimerHandle } from "../clock.js";

interface FakeTimer {
  readonly id: number;
  readonly dueAt: number;
  readonly callback: () => void;
  cancelled: boolean;
}

/** A deterministic timer implementation for unit tests. */
export class FakeClock implements Clock {
  #now: number;
  #nextId = 0;
  #timers = new Set<FakeTimer>();

  constructor(startAt = 0) {
    this.#now = startAt;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new RangeError("fake timer delay must be a finite non-negative number");
    }

    const timer: FakeTimer = {
      id: this.#nextId,
      dueAt: this.#now + delayMs,
      callback,
      cancelled: false,
    };
    this.#nextId += 1;
    this.#timers.add(timer);
    return timer;
  }

  clearTimeout(handle: TimerHandle): void {
    if (this.#timers.has(handle as FakeTimer)) {
      (handle as FakeTimer).cancelled = true;
      this.#timers.delete(handle as FakeTimer);
    }
  }

  advanceBy(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new RangeError("fake clock advance must be a finite non-negative number");
    }

    const target = this.#now + milliseconds;
    this.#runUntil(target);
    this.#now = target;
  }

  runAll(): void {
    while (this.#timers.size > 0) {
      const next = this.#nextTimer();
      if (next === undefined) {
        return;
      }
      this.#runUntil(next.dueAt);
    }
  }

  get pendingTimerCount(): number {
    return this.#timers.size;
  }

  #runUntil(target: number): void {
    while (true) {
      const next = this.#nextTimer();
      if (next === undefined || next.dueAt > target) {
        return;
      }

      this.#timers.delete(next);
      this.#now = next.dueAt;
      if (!next.cancelled) {
        next.callback();
      }
    }
  }

  #nextTimer(): FakeTimer | undefined {
    let next: FakeTimer | undefined;
    for (const timer of this.#timers) {
      if (
        next === undefined ||
        timer.dueAt < next.dueAt ||
        (timer.dueAt === next.dueAt && timer.id < next.id)
      ) {
        next = timer;
      }
    }
    return next;
  }
}
