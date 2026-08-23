import { PROFILE_DIR } from "./browser";
import { reclaimBrowserProfile } from "./browser-profile";
import { reclaimPort } from "./ports";

/**
 * Освобождает порты dev-сессии ПЕРЕД стартом concurrently, чтобы `bun run dev`
 * всегда поднимал свежие сервер (3001) и Vite (5173) на тех же портах, а не уходил
 * на 5174. Vite сам держателя порта не убивает — поэтому чистим здесь.
 * Профиль Chrome чистим так же: осиротевший SingletonLock ломает launchPersistentContext.
 */
const DEV_PORTS = [3001, 5173];
for (const port of DEV_PORTS) reclaimPort(port);
reclaimBrowserProfile(PROFILE_DIR);
