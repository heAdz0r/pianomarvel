import { getContext } from "./browser";
import { runBrowserTask } from "./browser-task";
import { GENRES } from "./genres";

export interface UploadedPiece {
  id: number;
  title: string;
  difficulty: number;
  composer: string;
  artist: string;
  genres: string[];
  hasMusicXml?: boolean;
}

interface RawPiece {
  title?: unknown;
  difficulty?: unknown;
  composer?: unknown;
  artist?: unknown;
  genres?: unknown;
}

const GENRES_BY_ID = new Map(Object.entries(GENRES).map(([name, id]) => [id, name]));

export function parseUploadedPieces(payload: unknown): UploadedPiece[] {
  if (!payload || typeof payload !== "object") return [];
  const rawPieces = (payload as { pieces?: unknown }).pieces;
  if (!rawPieces || typeof rawPieces !== "object") return [];

  return Object.entries(rawPieces as Record<string, RawPiece>)
    .flatMap(([rawId, piece]) => {
      const id = Number(rawId);
      if (!Number.isInteger(id) || !piece || typeof piece !== "object") return [];
      const genreIds = Array.isArray(piece.genres) ? piece.genres.map(Number) : [];
      return [{
        id,
        title: text(piece.title) || `Композиция ${id}`,
        difficulty: Number.isFinite(Number(piece.difficulty)) ? Number(piece.difficulty) : 0,
        composer: text(piece.composer),
        artist: text(piece.artist),
        genres: genreIds.flatMap((genreId) => {
          const name = GENRES_BY_ID.get(genreId);
          return name ? [name] : [];
        }),
      }];
    })
    .sort((a, b) => b.id - a.id);
}

/** Читает полный список My Uploads из авторизованной браузерной сессии. */
export async function getUploadedPieces(): Promise<UploadedPiece[]> {
  return runBrowserTask(readUploadedPieces);
}

async function readUploadedPieces(): Promise<UploadedPiece[]> {
  const context = await getContext();
  const page = await context.newPage();
  try {
    await page.goto("https://pianomarvel.com/uploads", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    const payload = await page.evaluate(async () => {
      const response = await fetch("/uploads/getItems", { method: "POST" });
      if (!response.ok) throw new Error(`getItems: HTTP ${response.status}`);
      return response.json();
    });
    return parseUploadedPieces(payload);
  } finally {
    await page.close().catch(() => undefined);
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
