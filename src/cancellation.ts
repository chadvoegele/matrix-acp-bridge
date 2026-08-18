export type Unsubscribe = () => void;

export interface CancellationSignal {
  readonly cancelled: boolean;
  readonly reason: string | undefined;
  onCancel(listener: (reason?: string) => void): Unsubscribe;
}

export interface CancellationController {
  readonly signal: CancellationSignal;
  cancel(reason?: string): void;
}

const noop: Unsubscribe = () => {};

class DefaultCancellation implements CancellationController, CancellationSignal {
  readonly signal: CancellationSignal = this;
  #cancelled = false;
  #reason: string | undefined;
  #listeners = new Set<(reason?: string) => void>();

  get cancelled(): boolean {
    return this.#cancelled;
  }

  get reason(): string | undefined {
    return this.#reason;
  }

  cancel(reason?: string): void {
    if (this.#cancelled) {
      return;
    }

    this.#cancelled = true;
    this.#reason = reason;
    const listeners = [...this.#listeners];
    this.#listeners.clear();
    for (const listener of listeners) {
      listener(reason);
    }
  }

  onCancel(listener: (reason?: string) => void): Unsubscribe {
    if (this.#cancelled) {
      listener(this.#reason);
      return noop;
    }

    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

export function createCancellationController(): CancellationController {
  return new DefaultCancellation();
}
