import { afterEach, expect, test } from "bun:test";
import { lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  clearStaleProfileLock,
  parseProfileHolder,
  profileHolders,
  profileLockTarget,
  reclaimBrowserProfile,
} from "./browser-profile";

test("PID держателя профиля читается из цели SingletonLock", () => {
  // Формат Chrome: «<hostname>-<pid>». Именно этот файл и указал на осиротевший
  // Chrome прошлой сессии, из-за которого launchPersistentContext сразу закрывался.
  expect(parseProfileHolder("MacBook-Pro-Andy.local-26675")).toBe(26675);
});

test("дефисы в имени хоста не мешают", () => {
  expect(parseProfileHolder("my-long-host-name.local-4242")).toBe(4242);
});

test("мусор и отсутствие блокировки дают null", () => {
  expect(parseProfileHolder("")).toBeNull();
  expect(parseProfileHolder("host-without-pid")).toBeNull();
  expect(parseProfileHolder("host-0")).toBeNull();
  expect(parseProfileHolder("host--5")).toBeNull();
  expect(parseProfileHolder(null)).toBeNull();
});

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeProfileDir(): string {
  const dir = join(import.meta.dir, "..", ".test-tmp", `browser-profile-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

test("осиротевший SingletonLock снимается, если PID уже не жив", () => {
  const profileDir = makeProfileDir();
  symlinkSync("test-host.local-999999", join(profileDir, "SingletonLock"));
  symlinkSync("cookie", join(profileDir, "SingletonCookie"));
  symlinkSync("/tmp/socket", join(profileDir, "SingletonSocket"));

  expect(profileHolders(profileDir)).toEqual([999999]);
  expect(clearStaleProfileLock(profileDir)).toBe(true);
  expect(profileLockTarget(profileDir)).toBeNull();
  expect(() => lstatSync(join(profileDir, "SingletonCookie"))).toThrow();
});

test("reclaimBrowserProfile возвращает true после снятия осиротевшей блокировки", () => {
  const profileDir = makeProfileDir();
  symlinkSync("test-host.local-999998", join(profileDir, "SingletonLock"));

  expect(reclaimBrowserProfile(profileDir)).toBe(true);
  expect(profileLockTarget(profileDir)).toBeNull();
});
