import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LearningStatus } from "./learning-mode";
import type { UploadedPiece } from "./pieces";

export const CACHE_DB_PATH = join(import.meta.dir, "..", ".data", "pianomarvel.sqlite");
/**
 * Версия алгоритма сборки обучения. Кеш статусов читается ТОЛЬКО по совпадающей
 * версии, поэтому строку обязательно менять при любом изменении музыкальной логики
 * Adaptive, целевой схемы или полезной нагрузки статуса.
 */
export const LEARNING_ALGORITHM_VERSION = "adaptive-musicxml-v3-summary";

export interface CachedLearningStatus {
  status: LearningStatus;
  checkedAt: string;
}

export interface CachedCatalog {
  pieces: UploadedPiece[];
  updatedAt?: string;
}

interface PieceRow {
  payload: string;
}

interface StatusRow {
  piece_id: number;
  payload: string;
  checked_at: string;
}

interface MetaRow {
  value: string;
}

interface ScoreSourceRow {
  piece_id: number;
  xml_path: string;
  updated_at: string;
}

export class PianoCache {
  private readonly db: Database;
  /** Подготовленные выражения переиспользуются: SQL компилируется один раз. */
  private readonly statements = new Map<string, ReturnType<Database["prepare"]>>();

  constructor(path = CACHE_DB_PATH) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS cached_pieces (
        piece_id INTEGER PRIMARY KEY,
        payload TEXT NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS learning_status_cache (
        piece_id INTEGER PRIMARY KEY,
        payload TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        algorithm_version TEXT NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS cache_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS score_sources (
        piece_id INTEGER PRIMARY KEY,
        xml_path TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  getCatalog(): CachedCatalog {
    const pieces = this.db
      .query<PieceRow, []>("SELECT payload FROM cached_pieces ORDER BY piece_id DESC")
      .all()
      .flatMap((row) => parseJson<UploadedPiece>(row.payload));
    const updatedAt = this.db
      .query<MetaRow, [string]>("SELECT value FROM cache_meta WHERE key = ?")
      .get("catalog_updated_at")?.value;
    const sources = new Set(
      this.db
        .query<ScoreSourceRow, []>("SELECT piece_id, xml_path, updated_at FROM score_sources")
        .all()
        .filter((source) => existsSync(source.xml_path))
        .map((source) => source.piece_id),
    );
    return {
      pieces: pieces.map((piece) =>
        sources.has(piece.id) ? { ...piece, hasMusicXml: true } : piece,
      ),
      updatedAt,
    };
  }

  replaceCatalog(pieces: UploadedPiece[], updatedAt = new Date().toISOString()): void {
    const insert = this.statement(
      "INSERT INTO cached_pieces (piece_id, payload) VALUES (?, ?)",
    );
    const saveUpdatedAt = this.statement(
      `INSERT INTO cache_meta (key, value) VALUES ('catalog_updated_at', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    // Одна транзакция вместо N неявных фиксаций заметно ускоряет большие каталоги.
    const replace = this.db.transaction((items: UploadedPiece[]) => {
      this.db.run("DELETE FROM cached_pieces");
      for (const piece of items) insert.run(piece.id, JSON.stringify(piece));
      saveUpdatedAt.run(updatedAt);
    });
    replace(pieces);
  }

  upsertPiece(piece: UploadedPiece, updatedAt = new Date().toISOString()): void {
    this.statement(
        `INSERT INTO cached_pieces (piece_id, payload) VALUES (?, ?)
         ON CONFLICT(piece_id) DO UPDATE SET payload = excluded.payload`,
      )
      .run(piece.id, JSON.stringify(piece));
    this.statement(
        `INSERT INTO cache_meta (key, value) VALUES ('catalog_updated_at', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(updatedAt);
  }

  getLearningStatuses(pieceIds?: number[]): CachedLearningStatus[] {
    if (pieceIds?.length === 0) return [];
    // Значения остаются параметризованными; в SQL строится только число плейсхолдеров.
    const placeholders = pieceIds
      ? ` AND piece_id IN (${pieceIds.map(() => "?").join(",")})`
      : "";
    return this.db
      .query<StatusRow, [string, ...number[]]>(
        `SELECT piece_id, payload, checked_at
         FROM learning_status_cache
         WHERE algorithm_version = ?${placeholders}
         ORDER BY piece_id DESC`,
      )
      .all(LEARNING_ALGORITHM_VERSION, ...(pieceIds ?? []))
      .flatMap((row) => {
        const status = parseJson<LearningStatus>(row.payload)[0];
        return status ? [{ status, checkedAt: row.checked_at }] : [];
      });
  }

  getLearningStatus(pieceId: number): CachedLearningStatus | undefined {
    // Поиск по первичному ключу вместо чтения всей таблицы с фильтром в JavaScript.
    const row = this.db
      .query<StatusRow, [number, string]>(
        `SELECT piece_id, payload, checked_at
           FROM learning_status_cache
          WHERE piece_id = ? AND algorithm_version = ?`,
      )
      .get(pieceId, LEARNING_ALGORITHM_VERSION);
    if (!row) return undefined;
    const status = parseJson<LearningStatus>(row.payload)[0];
    return status ? { status, checkedAt: row.checked_at } : undefined;
  }

  putLearningStatus(status: LearningStatus, checkedAt = new Date().toISOString()): void {
    // Инспекция и сборка пишут независимо: запоздавший старый ответ не должен
    // затирать более свежий статус.
    const existing = this.db
      .query<{ checked_at: string }, [number, string]>(
        "SELECT checked_at FROM learning_status_cache WHERE piece_id = ? AND algorithm_version = ?",
      )
      .get(status.pieceId, LEARNING_ALGORITHM_VERSION);
    if (existing && existing.checked_at > checkedAt) return;

    this.statement(
        `INSERT INTO learning_status_cache
           (piece_id, payload, checked_at, algorithm_version)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(piece_id) DO UPDATE SET
           payload = excluded.payload,
           checked_at = excluded.checked_at,
           algorithm_version = excluded.algorithm_version`,
      )
      .run(
        status.pieceId,
        JSON.stringify(status),
        checkedAt,
        LEARNING_ALGORITHM_VERSION,
      );
  }

  putScoreSource(pieceId: number, xmlPath: string, updatedAt = new Date().toISOString()): void {
    this.statement(
        `INSERT INTO score_sources (piece_id, xml_path, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(piece_id) DO UPDATE SET
           xml_path = excluded.xml_path,
           updated_at = excluded.updated_at`,
      )
      .run(pieceId, xmlPath, updatedAt);
  }

  /**
   * Перепривязывает канонические MusicXML после безопасного перемещения библиотеки.
   * Сопоставление только точное old→new: basename недостаточен, потому что у одного
   * автора могут быть несколько редакций одной композиции.
   */
  rebindScoreSourcePaths(
    relocations: Array<{ from: string; to: string }>,
  ): number {
    const update = this.statement(
      "UPDATE score_sources SET xml_path = ? WHERE xml_path = ?",
    );
    const rebind = this.db.transaction(
      (items: Array<{ from: string; to: string }>): number => {
        let changed = 0;
        for (const item of items) {
          if (!existsSync(item.to)) {
            throw new Error(`Новый MusicXML не найден: ${item.to}`);
          }
          changed += update.run(item.to, item.from).changes;
        }
        return changed;
      },
    );
    return rebind(relocations);
  }

  getScoreSource(pieceId: number): { xmlPath: string; updatedAt: string } | undefined {
    const row = this.db
      .query<ScoreSourceRow, [number]>(
        "SELECT piece_id, xml_path, updated_at FROM score_sources WHERE piece_id = ?",
      )
      .get(pieceId);
    if (!row || !existsSync(row.xml_path)) return undefined;
    return { xmlPath: row.xml_path, updatedAt: row.updated_at };
  }

  /** Сохраняет куки сессии pianomarvel (Playwright-JSON) для быстрой проверки без браузера. */
  putSessionCookies(cookiesJson: string, savedAt = new Date().toISOString()): void {
    const upsert = this.statement(
      `INSERT INTO cache_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    upsert.run("session_cookies", cookiesJson);
    upsert.run("session_cookies_saved_at", savedAt);
  }

  getSessionCookies(): { cookiesJson: string; savedAt?: string } | undefined {
    const read = this.db.query<MetaRow, [string]>("SELECT value FROM cache_meta WHERE key = ?");
    const cookiesJson = read.get("session_cookies")?.value;
    if (!cookiesJson) return undefined;
    return { cookiesJson, savedAt: read.get("session_cookies_saved_at")?.value };
  }

  /**
   * CHANGED: дешёвый флаг результата последней РЕАЛЬНОЙ проверки входа в MuseScore.
   * Позволяет на старте показать статус без запуска браузера (для MuseScore нет
   * HTTP-проверки по кукам, как у pianomarvel, поэтому храним итог явной проверки).
   * undefined = вход ни разу не проверялся.
   */
  setMuseScoreLoginFlag(loggedIn: boolean, at = new Date().toISOString()): void {
    this.statement(
        `INSERT INTO cache_meta (key, value) VALUES ('musescore_login', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(JSON.stringify({ loggedIn, at }));
  }

  getMuseScoreLoginFlag(): { loggedIn: boolean; at: string } | undefined {
    const value = this.db
      .query<MetaRow, [string]>("SELECT value FROM cache_meta WHERE key = ?")
      .get("musescore_login")?.value;
    if (!value) return undefined;
    try {
      return JSON.parse(value) as { loggedIn: boolean; at: string };
    } catch {
      return undefined;
    }
  }

  close(): void {
    this.db.close();
  }

  private statement(sql: string): ReturnType<Database["prepare"]> {
    const cached = this.statements.get(sql);
    if (cached) return cached;
    const prepared = this.db.prepare(sql);
    this.statements.set(sql, prepared);
    return prepared;
  }
}

let defaultCache: PianoCache | undefined;

export function getCache(): PianoCache {
  defaultCache ??= new PianoCache();
  return defaultCache;
}

function parseJson<T>(value: string): T[] {
  try {
    return [JSON.parse(value) as T];
  } catch {
    return [];
  }
}
