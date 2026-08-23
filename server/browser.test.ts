import { describe, expect, test } from "bun:test";
import {
  buildExternalChromeArgs,
  PLAYWRIGHT_IGNORED_ARGS,
  RetryableLaunch,
} from "./browser";

describe("обычный Chrome для Google OAuth", () => {
  test("использует отдельный профиль без флагов автоматизации", () => {
    const args = buildExternalChromeArgs("/tmp/piano profile", "https://example.com/login");

    expect(args).toContain("--user-data-dir=/tmp/piano profile");
    expect(args.at(-1)).toBe("https://example.com/login");
    expect(args.some((arg) => arg.includes("enable-automation"))).toBe(false);
    expect(args.some((arg) => arg.includes("remote-debugging"))).toBe(false);
  });

  test("использует системный Keychain для cookies обычного Chrome", () => {
    expect(PLAYWRIGHT_IGNORED_ARGS).toContain("--use-mock-keychain");
    expect(PLAYWRIGHT_IGNORED_ARGS).toContain("--password-store=basic");
  });

  test("после неудачного запуска следующий вызов создаёт новый контекст", async () => {
    const launch = new RetryableLaunch<string>();
    let attempts = 0;
    const start = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("SingletonLock");
      return "context";
    };

    await expect(launch.get(start)).rejects.toThrow("SingletonLock");
    await expect(launch.get(start)).resolves.toBe("context");
    expect(attempts).toBe(2);
  });
});
