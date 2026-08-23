import { lstatSync, readlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const LOCK_FILES = ["SingletonLock", "SingletonCookie", "SingletonSocket"] as const;

function lockFilePath(profileDir: string, file: (typeof LOCK_FILES)[number]): string {
  return join(profileDir, file);
}

function hasLockFile(profileDir: string, file: (typeof LOCK_FILES)[number]): boolean {
  try {
    return lstatSync(lockFilePath(profileDir, file)).isSymbolicLink();
  } catch {
    return false;
  }
}

/** PID из цели симлинка SingletonLock (`<hostname>-<pid>`). */
export function parseProfileHolder(lockTarget: string | null): number | null {
  if (!lockTarget) return null;
  const match = lockTarget.match(/-(\d+)$/);
  if (!match) return null;
  const prefix = lockTarget.slice(0, -match[0].length);
  // «host--5» — битый формат: перед PID не должно быть висящего дефиса.
  if (!prefix || prefix.endsWith("-")) return null;
  const pid = Number(match[1]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return pid;
}

/** Цель симлинка SingletonLock или null, если блокировки нет. */
export function profileLockTarget(profileDir: string): string | null {
  const lockPath = lockFilePath(profileDir, "SingletonLock");
  try {
    if (!lstatSync(lockPath).isSymbolicLink()) return null;
    return readlinkSync(lockPath);
  } catch {
    return null;
  }
}

/** PID процесса, держащего профиль Chrome (по SingletonLock). */
export function profileHolders(profileDir: string): number[] {
  const pid = parseProfileHolder(profileLockTarget(profileDir));
  return pid ? [pid] : [];
}

/** Все PID Chrome с этим user-data-dir (включая helper/renderer после сбоя). */
export function profileChromePids(profileDir: string): number[] {
  const result = Bun.spawnSync(["pgrep", "-f", `user-data-dir=${profileDir}`]);
  if (result.exitCode !== 0) return [];
  const pids = new Set<number>();
  for (const line of new TextDecoder().decode(result.stdout).split("\n")) {
    const pid = Number(line.trim());
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.add(pid);
  }
  return [...pids];
}

function profileBlockers(profileDir: string, protectedPids: ReadonlySet<number>): number[] {
  const pids = new Set<number>([
    ...profileHolders(profileDir),
    ...profileChromePids(profileDir),
  ]);
  return [...pids].filter((pid) => isProcessAlive(pid) && !protectedPids.has(pid));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isChromeProcess(pid: number): boolean {
  const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "comm="]);
  if (result.exitCode !== 0) return false;
  return /chrome/i.test(new TextDecoder().decode(result.stdout));
}

/** Удаляет осиротевшие файлы блокировки, если держатель уже не жив. */
export function clearStaleProfileLock(profileDir: string): boolean {
  const holders = profileHolders(profileDir).filter(isProcessAlive);
  if (holders.length > 0) return false;

  let cleared = false;
  for (const file of LOCK_FILES) {
    if (!hasLockFile(profileDir, file)) continue;
    try {
      unlinkSync(lockFilePath(profileDir, file));
      cleared = true;
    } catch {
    }
  }
  return cleared;
}

function freeProfileHolder(pid: number, force: boolean): void {
  try {
    process.kill(pid, force ? "SIGKILL" : "SIGTERM");
    console.log(`  профиль Chrome: ${force ? "SIGKILL" : "SIGTERM"} → PID ${pid}`);
  } catch {
  }
}

function profileLocked(profileDir: string): boolean {
  return hasLockFile(profileDir, "SingletonLock");
}

export interface ReclaimProfileOptions {
  /** PID, которые нельзя завершать (например, окно ручного входа). */
  protectedPids?: number[];
}

/**
 * Освобождает persistent-профиль Chrome от прошлой сессии.
 * Завершает все процессы с user-data-dir профиля и снимает осиротевший SingletonLock.
 */
export function reclaimBrowserProfile(
  profileDir: string,
  options: ReclaimProfileOptions = {},
): boolean {
  const protectedPids = new Set(options.protectedPids ?? []);

  const blocked = () =>
    profileLocked(profileDir) || profileBlockers(profileDir, protectedPids).length > 0;

  if (!blocked()) return true;

  const alive = profileBlockers(profileDir, protectedPids);
  if (alive.length > 0) {
    console.log(
      `Профиль Chrome занят (PID ${alive.join(", ")}) — освобождаю прошлую сессию…`,
    );
  }

  for (let attempt = 1; attempt <= 40; attempt += 1) {
    for (const pid of profileBlockers(profileDir, protectedPids)) {
      if (isChromeProcess(pid)) freeProfileHolder(pid, attempt > 10);
    }
    clearStaleProfileLock(profileDir);
    if (!blocked()) return true;
    Bun.sleepSync(100);
  }

  console.error("⚠️  Не удалось освободить профиль Chrome.");
  return false;
}
