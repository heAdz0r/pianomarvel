/**
 * Освобождение TCP-порта от прошлой сессии.
 * Важно: `lsof -t` (terse) на macOS НЕ находит tcp6-сокет Bun/Vite, поэтому парсим
 * полный вывод `lsof -nP -iTCP:<port>` и берём PID только из строк состояния (LISTEN).
 */

/** PID процессов, СЛУШАЮЩИХ порт (в т.ч. tcp6), кроме текущего. */
export function portHolders(port: number): number[] {
  const result = Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`]);
  const pids = new Set<number>();
  for (const line of new TextDecoder().decode(result.stdout).split("\n")) {
    if (!/\(LISTEN\)/.test(line)) continue;
    const pid = Number(line.trim().split(/\s+/)[1]);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.add(pid);
  }
  return [...pids];
}

/** Завершает держателей порта: SIGTERM (даёт корректно закрыть браузер), либо SIGKILL. */
export function freePort(port: number, force: boolean): void {
  for (const pid of portHolders(port)) {
    try {
      process.kill(pid, force ? "SIGKILL" : "SIGTERM");
      console.log(`  порт ${port}: ${force ? "SIGKILL" : "SIGTERM"} → PID ${pid}`);
    } catch {
    }
  }
}

/**
 * Освобождает порт и ждёт, пока он реально станет свободным.
 * Триггер завершения — пустой список держателей (фактическое состояние ОС),
 * а не таймер; короткая пауза между попытками нужна лишь чтобы прошлый процесс
 * успел закрыть браузер и выйти. Сначала мягко (SIGTERM), после — принудительно.
 */
export function reclaimPort(port: number): boolean {
  if (portHolders(port).length === 0) return true;
  console.log(`Порт ${port} занят — освобождаю прошлую сессию…`);
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    freePort(port, attempt > 10);
    if (portHolders(port).length === 0) return true;
    Bun.sleepSync(100);
  }
  console.error(`⚠️  Не удалось освободить порт ${port}.`);
  return false;
}
