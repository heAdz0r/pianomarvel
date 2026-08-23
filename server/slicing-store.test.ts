import { expect, test } from "bun:test";
import { installSlicingStore, SLICING_KEY, type SlicingStoreApi } from "./slicing-store";

/** Минимальный Storage: shim работает только через getItem/removeItem/key/length. */
function fakeStorage(initial: Record<string, string>): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (name: string) => map.get(name) ?? null,
    setItem: (name: string, value: string) => void map.set(name, value),
    removeItem: (name: string) => void map.delete(name),
    clear: () => map.clear(),
  } as Storage;
}

const TABS = [
  { sortName: "W", data: { exercises: [{ title: "Whole" }], tempos: [60, 80, 100] } },
  { sortName: "C", data: { exercises: [] } },
  { sortName: "MIN", data: { exercises: [] } },
];

function install(
  local: Record<string, string>,
  session: Record<string, string> = {},
): SlicingStoreApi {
  const scope = globalThis as unknown as {
    localStorage: Storage;
    sessionStorage: Storage;
    __pmSlicing?: SlicingStoreApi;
  };
  scope.localStorage = fakeStorage(local);
  scope.sessionStorage = fakeStorage(session);
  scope.__pmSlicing = undefined;
  installSlicingStore();
  if (!scope.__pmSlicing) throw new Error("shim не установился");
  return scope.__pmSlicing;
}

test("читает вкладки пьесы из кеша схемы", () => {
  const api = install({ [SLICING_KEY]: JSON.stringify({ "42": TABS }) });

  expect(api.read("42")).toEqual(TABS);
});

test("чужая пьеса, пустой и битый кеш дают null", () => {
  expect(install({ [SLICING_KEY]: JSON.stringify({ "7": TABS }) }).read("42")).toBeNull();
  expect(install({ [SLICING_KEY]: "{}" }).read("42")).toBeNull();
  expect(install({ [SLICING_KEY]: "{not json" }).read("42")).toBeNull();
  expect(install({}).read("42")).toBeNull();
});

test("reset удаляет кеш схемы и не трогает остальные ключи", () => {
  const api = install({ [SLICING_KEY]: JSON.stringify({ "42": TABS }), session: "kept" });

  api.reset();

  expect(api.read("42")).toBeNull();
  expect(api.keys().local).toEqual(["session"]);
});

test("keys отдаёт реальные имена ключей обоих хранилищ", () => {
  const api = install({ authToken: "x", [SLICING_KEY]: "{}" }, { flags: "y" });

  expect(api.keys()).toEqual({ local: ["authToken", SLICING_KEY], session: ["flags"] });
});
