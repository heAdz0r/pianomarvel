export interface LatestRequestRun {
  signal: AbortSignal;
  isCurrent: () => boolean;
}

/**
 * Даёт async-операциям семантику latest-wins: новый запуск отменяет предыдущий,
 * а поздний ответ не получает права менять состояние интерфейса.
 */
export class LatestRequest {
  private version = 0;
  private controller?: AbortController;

  begin(): LatestRequestRun {
    this.controller?.abort();
    const version = ++this.version;
    const controller = new AbortController();
    this.controller = controller;
    return {
      signal: controller.signal,
      isCurrent: () => this.version === version && this.controller === controller,
    };
  }

  cancel(): void {
    this.version += 1;
    this.controller?.abort();
    this.controller = undefined;
  }
}
