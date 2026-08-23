interface PendingTask {
  run: (lane: number) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

/** FIFO-очередь, исполняющая не больше одной задачи на каждой lane. */
export class ConcurrentLaneQueue {
  private readonly busy: boolean[];
  private readonly pending: PendingTask[] = [];

  constructor(readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error("Concurrency должен быть положительным целым числом.");
    }
    this.busy = Array.from({ length: concurrency }, () => false);
  }

  run<T>(task: (lane: number) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        run: task as (lane: number) => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.pump();
    });
  }

  get queued(): number {
    return this.pending.length;
  }

  get running(): number {
    return this.busy.filter(Boolean).length;
  }

  private pump(): void {
    for (let lane = 0; lane < this.busy.length && this.pending.length > 0; lane += 1) {
      if (this.busy[lane]) continue;
      const next = this.pending.shift();
      if (!next) return;
      this.busy[lane] = true;
      void next
        .run(lane)
        .then(next.resolve, next.reject)
        .finally(() => {
          this.busy[lane] = false;
          this.pump();
        });
    }
  }
}
