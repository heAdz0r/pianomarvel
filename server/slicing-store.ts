/**
 * Доступ к кешу схемы slicing на стороне страницы Piano Marvel.
 *
 * Источник данных — тот же, что и всегда: `localStorage.slicingData[pieceId]`. Модуль
 * не меняет поведение, он лишь убирает двенадцать копий одного и того же разбора JSON
 * из page.evaluate по всему пайплайну и даёт диагностике честный ответ на вопрос
 * «что вообще лежит в хранилище», когда кеша нет.
 *
 * История: в августе 2026 Piano Marvel на сутки перестал зеркалить схему в
 * localStorage, и здесь жило сетевое зеркало ответов `server-method-146` вместе с
 * патчами XHR/fetch. Piano Marvel починил зеркалирование, а патчи страницы — слишком
 * грубое вмешательство, чтобы держать их «на всякий случай»: если понадобится снова,
 * рабочая версия есть в коммите d1ed3d8.
 */

/** Ключ кеша схемы в localStorage. */
export const SLICING_KEY = "slicingData";

export interface SlicingStoreApi {
  /** Список вкладок пьесы, либо null. */
  read(pieceId: string): unknown[] | null;
  /** Удаляет кеш схемы: страница обязана перечитать состояние с сервера. */
  reset(): void;
  /** Реальные имена ключей обоих хранилищ — по ним видно, куда делся кеш. */
  keys(): { local: string[]; session: string[] };
}

declare global {
  /** Устанавливается installSlicingStore до скриптов страницы. */
  var __pmSlicing: SlicingStoreApi | undefined;
}

/**
 * Ставит `window.__pmSlicing`. Функция целиком сериализуется в страницу через
 * `page.addInitScript`, поэтому не имеет ни одной внешней ссылки — всё внутри.
 */
export function installSlicingStore(): void {
  const KEY = "slicingData";

  function names(storage: Storage): string[] {
    const result: string[] = [];
    try {
      for (let index = 0; index < storage.length; index += 1) {
        const name = storage.key(index);
        if (name !== null) result.push(name);
      }
    } catch {
      // Доступ к хранилищу может быть закрыт политикой — это тоже валидный ответ.
    }
    return result;
  }

  const api: SlicingStoreApi = {
    read(pieceId) {
      try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return null;
        const tabs = (JSON.parse(raw) as Record<string, unknown>)[pieceId];
        return Array.isArray(tabs) ? tabs : null;
      } catch {
        return null;
      }
    },

    reset() {
      try {
        localStorage.removeItem(KEY);
      } catch {
        // не удалось удалить — страница всё равно перечитает схему с сервера
      }
    },

    keys() {
      const read = (storage: Storage | undefined) => (storage ? names(storage) : []);
      let local: string[] = [];
      let session: string[] = [];
      try {
        local = read(localStorage);
      } catch {
        local = [];
      }
      try {
        session = read(sessionStorage);
      } catch {
        session = [];
      }
      return { local, session };
    },
  };

  (globalThis as { __pmSlicing?: SlicingStoreApi }).__pmSlicing = api;
}
