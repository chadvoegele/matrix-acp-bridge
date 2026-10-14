/** A small cancellable semaphore for unresolved ACP prompt requests. */
export class PromptPermits {
  #available: number;

  readonly #waiters: ((release: (() => void) | undefined) => void)[] = [];

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new RangeError("maxConcurrentPrompts must be a positive safe integer");
    }
    this.#available = limit;
  }

  acquire(): Promise<(() => void) | undefined> {
    if (this.#available > 0) {
      this.#available -= 1;
      return Promise.resolve(this.#createRelease());
    }
    return new Promise((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  cancelWaiters(): void {
    while (this.#waiters.length > 0) {
      const waiter = this.#waiters.shift();
      if (waiter === undefined) {
        continue;
      }
      // eslint-disable-next-line unicorn/no-useless-undefined -- undefined releases a cancelled waiter without a permit
      waiter(undefined);
    }
  }

  #createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#releaseOne();
    };
  }

  #releaseOne(): void {
    while (this.#waiters.length > 0) {
      const waiter = this.#waiters.shift();
      if (waiter === undefined) {
        continue;
      }
      waiter(this.#createRelease());
      return;
    }
    this.#available += 1;
  }
}
