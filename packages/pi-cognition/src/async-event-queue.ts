export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    readonly resolve: (result: IteratorResult<T>) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  private ended = false;
  private failure: unknown;

  public push(value: T): void {
    if (this.ended || this.failure !== undefined) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value });
      return;
    }
    this.values.push(value);
  }

  public end(): void {
    if (this.ended || this.failure !== undefined) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  public fail(error: unknown): void {
    if (this.ended || this.failure !== undefined) return;
    this.failure = error;
    this.values.splice(0);
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  public [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.values.length > 0) {
          const value = this.values.shift() as T;
          return Promise.resolve({ done: false, value });
        }
        if (this.failure !== undefined) {
          return Promise.reject(this.failure);
        }
        if (this.ended) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}
