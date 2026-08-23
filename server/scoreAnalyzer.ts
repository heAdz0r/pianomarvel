import { readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { extname } from "node:path";
export interface ScoreAnalysis {
  title: string;
  composer: string;
  artist: string;
  copyright: string;
  defaultTempo?: number;
  genres: string[];
  difficulty: number;
}

const DEFAULT_UPLOAD_TEMPO = 60;
const SCORE_CACHE_LIMIT = 24;
// Один файл участвует в привязке, заполнении метаданных и Adaptive-плане. Ключ по
// mtime и размеру инвалидирует кеш после перезаписи, не требуя ручного сброса.
const xmlCache = new Map<string, { xml: string; analysis?: ScoreAnalysis }>();
let scoreCacheMisses = 0;

function cacheKey(path: string): string {
  const stat = statSync(path);
  return `${path}:${stat.mtimeMs}:${stat.size}`;
}

function rememberScore(
  key: string,
  value: { xml: string; analysis?: ScoreAnalysis },
): void {
  xmlCache.set(key, value);
  while (xmlCache.size > SCORE_CACHE_LIMIT) {
    const oldest = xmlCache.keys().next().value;
    if (oldest === undefined) break;
    xmlCache.delete(oldest);
  }
}

/** Сбрасывает файловый кеш между тестами и диагностическими замерами. */
export function clearScoreCache(): void {
  xmlCache.clear();
  scoreCacheMisses = 0;
}

/** Диагностика кеша для регрессионных тестов и локального benchmark. */
export function scoreCacheStats(): { entries: number; misses: number } {
  return { entries: xmlCache.size, misses: scoreCacheMisses };
}

interface GenreRule {
  genre: string;
  keywords: string[];
}
const GENRE_RULES: GenreRule[] = [
  {
    genre: "Holiday",
    keywords: ["christmas", "holiday", "noel", "snowman", "jingle bells", "weihnacht"],
  },
  {
    genre: "Christian & Gospel",
    keywords: ["gospel", "hymn", "worship", "christian"],
  },
  {
    genre: "Video Game Music",
    keywords: ["video game", "minecraft", "zelda", "final fantasy", "undertale"],
  },
  {
    genre: "TV & Film",
    keywords: ["soundtrack", "film", "movie", "cinema", "disney", "star wars"],
  },
  {
    genre: "Jazz/Blues",
    keywords: ["jazz", "blues", "ragtime", "boogie", "gershwin", "joplin"],
  },
  {
    genre: "Rock & Country",
    keywords: [
      "rock",
      "country",
      "metallica",
      "queen",
      "nirvana",
      "ac dc",
      "led zeppelin",
      "pink floyd",
      "король и шут",
    ],
  },
  {
    genre: "New Age Piano",
    keywords: ["new age", "einaudi", "yiruma", "clayderman"],
  },
  {
    genre: "Classical",
    keywords: [
      "classical",
      "bach",
      "beethoven",
      "brahms",
      "chopin",
      "debussy",
      "grieg",
      "handel",
      "haydn",
      "liszt",
      "mozart",
      "prokofiev",
      "rachmaninoff",
      "ravel",
      "satie",
      "schubert",
      "schumann",
      "tchaikovsky",
      "vivaldi",
    ],
  },
  {
    genre: "Scales & Exercises",
    keywords: ["scale", "exercise", "etude", "hanon", "czerny"],
  },
  {
    genre: "Musical",
    keywords: ["musical", "broadway"],
  },
  {
    genre: "Folk",
    keywords: ["folk", "traditional"],
  },
  {
    genre: "Pop",
    keywords: ["pop", "adele", "billie eilish", "bruno mars", "ed sheeran", "taylor swift"],
  },
];
/** Читает обычный MusicXML или XML-партитуру внутри MXL. */
export async function analyzeScoreFile(
  path: string,
  fallbackMidiPath?: string,
): Promise<ScoreAnalysis> {
  const key = cacheKey(path);
  const cached = xmlCache.get(key);
  const xml = cached?.xml ?? await readScoreXml(path);
  const analysis = cached?.analysis ?? analyzeMusicXml(xml);
  if (!cached?.analysis) rememberScore(key, { xml, analysis });
  if (analysis.defaultTempo !== undefined) return analysis;

  const midiTempo = fallbackMidiPath
    ? await readFile(fallbackMidiPath)
      .then((midi) => extractMidiTempo(new Uint8Array(midi)))
      .catch(() => undefined)
    : undefined;
  return {
    ...analysis,
    defaultTempo: midiTempo ?? DEFAULT_UPLOAD_TEMPO,
  };
}

/** Извлекает метаданные и оценивает музыкальную сложность партитуры. */
export function analyzeMusicXml(xml: string): ScoreAnalysis {
  if (!/<score-(?:partwise|timewise)\b/i.test(xml)) {
    throw new Error("Файл не содержит партитуру MusicXML.");
  }

  const creators = extractElements(xml, "creator").map(({ attributes, value }) => ({
    type: attribute(attributes, "type").toLowerCase(),
    value,
  }));
  const title = firstTag(xml, "work-title") || firstTag(xml, "movement-title");
  const copyright = firstTag(xml, "rights");
  const explicitArtist = creators.find((item) =>
    ["artist", "performer"].includes(item.type),
  )?.value;
  const lyricist = creators.find((item) => item.type === "lyricist")?.value;
  const artist = explicitArtist || lyricist || creditFromRights(copyright);
  const rawComposer = creators.find((item) => item.type === "composer")?.value ?? "";
  const composer = isUsableCredit(rawComposer) ? rawComposer : artist;
  const defaultTempo = extractTempo(xml);
  const context = [
    title,
    composer,
    artist,
    copyright,
    ...extractAllTags(xml, "credit-words"),
    ...extractAllTags(xml, "miscellaneous-field"),
  ].join(" ");

  return {
    title,
    composer,
    artist,
    copyright,
    defaultTempo,
    genres: inferGenres(context),
    difficulty: estimateDifficulty(xml),
  };
}

export async function readScoreXml(path: string): Promise<string> {
  const key = cacheKey(path);
  const cached = xmlCache.get(key);
  if (cached) return cached.xml;
  const xml = await readScoreXmlUncached(path);
  rememberScore(key, { xml });
  return xml;
}

async function readScoreXmlUncached(path: string): Promise<string> {
  scoreCacheMisses += 1;
  if (extname(path).toLowerCase() !== ".mxl") return readFile(path, "utf8");

  const listProcess = Bun.spawn(["unzip", "-Z1", path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const entries = (await new Response(listProcess.stdout).text())
    .split(/\r?\n/)
    .filter(Boolean);
  if ((await listProcess.exited) !== 0) {
    const error = await new Response(listProcess.stderr).text();
    throw new Error(`Не удалось прочитать MXL: ${error.trim()}`);
  }

  const entry = entries.find(
    (name) =>
      /\.(?:musicxml|xml)$/i.test(name) &&
      !/^META-INF\//i.test(name) &&
      !/container\.xml$/i.test(name),
  );
  if (!entry) throw new Error("В MXL не найдена партитура MusicXML.");

  const extractProcess = Bun.spawn(["unzip", "-p", path, entry], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const xml = await new Response(extractProcess.stdout).text();
  if ((await extractProcess.exited) !== 0) {
    const error = await new Response(extractProcess.stderr).text();
    throw new Error(`Не удалось извлечь MusicXML: ${error.trim()}`);
  }
  return xml;
}

function inferGenres(context: string): string[] {
  const normalized = normalizeText(context);
  const match = GENRE_RULES.find((rule) =>
    rule.keywords.some((keyword) => normalized.includes(normalizeText(keyword))),
  );
  return match ? [match.genre] : [];
}

function estimateDifficulty(xml: string): number {
  const notes = extractRawElements(xml, "note").filter((note) => !/<rest\b/i.test(note));
  const measures = Math.max(1, countTags(xml, "measure"));
  const density = notes.length / measures;
  const chordRatio = notes.filter((note) => /<chord\b/i.test(note)).length / Math.max(1, notes.length);
  const accidentalRatio =
    notes.filter((note) => /<alter>\s*-?[1-9]/i.test(note) || /<accidental\b/i.test(note))
      .length / Math.max(1, notes.length);
  const veryFastRatio =
    notes.filter((note) => /<type>\s*(?:32nd|64th|128th)\s*<\/type>/i.test(note)).length /
    Math.max(1, notes.length);
  const fastRatio =
    notes.filter((note) => /<type>\s*16th\s*<\/type>/i.test(note)).length /
    Math.max(1, notes.length);
  const tupletRatio =
    notes.filter((note) => /<time-modification\b/i.test(note)).length /
    Math.max(1, notes.length);
  const voices = new Set(extractAllTags(xml, "voice")).size;
  const pitchRange = calculatePitchRange(notes);
  const staves = Math.max(1, ...extractAllTags(xml, "staves").map(Number).filter(Number.isFinite));

  let score = 1;
  score += density >= 18 ? 4 : density >= 12 ? 3 : density >= 8 ? 2 : density >= 4 ? 1 : 0;
  score += chordRatio >= 0.25 ? 2 : chordRatio >= 0.1 ? 1 : 0;
  score += voices >= 3 ? 2 : voices >= 2 ? 1 : 0;
  score += veryFastRatio >= 0.05 ? 2 : fastRatio >= 0.1 ? 1 : 0;
  score += tupletRatio >= 0.02 ? 1 : 0;
  score += accidentalRatio >= 0.15 ? 2 : accidentalRatio >= 0.05 ? 1 : 0;
  score += pitchRange >= 60 ? 2 : pitchRange >= 36 ? 1 : 0;
  score += measures >= 80 ? 1 : 0;
  score += staves >= 2 ? 1 : 0;
  return Math.max(1, Math.min(18, score));
}

function calculatePitchRange(notes: string[]): number {
  const steps: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const pitches = notes.flatMap((note) => {
    const step = firstTag(note, "step").toUpperCase();
    const octave = Number(firstTag(note, "octave"));
    const alter = Number(firstTag(note, "alter") || 0);
    return step in steps && Number.isFinite(octave) ? [(octave + 1) * 12 + steps[step] + alter] : [];
  });
  return pitches.length ? Math.max(...pitches) - Math.min(...pitches) : 0;
}

function extractTempo(xml: string): number | undefined {
  const sound = xml.match(/<sound\b[^>]*\btempo\s*=\s*["']([^"']+)["']/i)?.[1];
  const value = Number(sound ?? firstTag(xml, "per-minute"));
  return Number.isFinite(value) && value >= 30 && value <= 240 ? Math.round(value) : undefined;
}

/**
 * Первый допустимый Set Tempo из Standard MIDI File.
 *
 * Некоторые MuseScore-партитуры не содержат `<sound tempo>`/`<per-minute>`,
 * хотя соседний MIDI хранит точный темп. Это значение используется только как
 * fallback метаданных legacy-upload; MusicXML и Learn Mode оно не переписывает.
 */
export function extractMidiTempo(midi: Uint8Array): number | undefined {
  if (ascii(midi, 0, 4) !== "MThd" || midi.length < 14) return undefined;

  const headerLength = uint32(midi, 4);
  let chunkOffset = 8 + headerLength;
  while (chunkOffset + 8 <= midi.length) {
    const type = ascii(midi, chunkOffset, 4);
    const length = uint32(midi, chunkOffset + 4);
    const start = chunkOffset + 8;
    const end = Math.min(midi.length, start + length);
    if (type === "MTrk") {
      const tempo = extractTrackTempo(midi, start, end);
      if (tempo !== undefined) return tempo;
    }
    chunkOffset = start + length;
  }
  return undefined;
}

function extractTrackTempo(
  midi: Uint8Array,
  start: number,
  end: number,
): number | undefined {
  let offset = start;
  let runningStatus = 0;
  while (offset < end) {
    const delta = readVariableLength(midi, offset, end);
    if (!delta) return undefined;
    offset = delta.next;
    if (offset >= end) return undefined;

    let status = midi[offset];
    if (status >= 0x80) {
      offset += 1;
      if (status < 0xf0) runningStatus = status;
    } else {
      if (!runningStatus) return undefined;
      status = runningStatus;
    }

    if (status === 0xff) {
      if (offset >= end) return undefined;
      const metaType = midi[offset++];
      const size = readVariableLength(midi, offset, end);
      if (!size) return undefined;
      offset = size.next;
      if (offset + size.value > end) return undefined;
      if (metaType === 0x51 && size.value === 3) {
        const micros = (midi[offset] << 16) | (midi[offset + 1] << 8) | midi[offset + 2];
        const bpm = 60_000_000 / micros;
        if (Number.isFinite(bpm) && bpm >= 30 && bpm <= 240) return Math.round(bpm);
      }
      offset += size.value;
      continue;
    }

    if (status === 0xf0 || status === 0xf7) {
      const size = readVariableLength(midi, offset, end);
      if (!size) return undefined;
      offset = size.next + size.value;
      continue;
    }

    const dataBytes = status >= 0xc0 && status <= 0xdf ? 1 : 2;
    offset += dataBytes;
  }
  return undefined;
}

function readVariableLength(
  bytes: Uint8Array,
  offset: number,
  end: number,
): { value: number; next: number } | undefined {
  let value = 0;
  for (let count = 0; count < 4 && offset < end; count += 1) {
    const byte = bytes[offset++];
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, next: offset };
  }
  return undefined;
}

function uint32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000 +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  );
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function firstTag(xml: string, tag: string): string {
  return extractAllTags(xml, tag)[0] ?? "";
}

function extractAllTags(xml: string, tag: string): string[] {
  return extractElements(xml, tag).map((item) => item.value);
}

function extractElements(xml: string, tag: string): Array<{ attributes: string; value: string }> {
  const regex = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, "gi");
  return [...xml.matchAll(regex)].map((match) => ({
    attributes: match[1] ?? "",
    value: decodeXml((match[2] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()),
  }));
}

function extractRawElements(xml: string, tag: string): string[] {
  const regex = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
  return [...xml.matchAll(regex)].map((match) => match[0]);
}

function countTags(xml: string, tag: string): number {
  return [...xml.matchAll(new RegExp(`<${tag}\\b`, "gi"))].length;
}

function attribute(attributes: string, name: string): string {
  return attributes.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1] ?? "";
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function isUsableCredit(value: string): boolean {
  const trimmed = value.trim();
  const letters = trimmed.match(/\p{L}/gu)?.length ?? 0;
  return letters >= 2 && !/^[_-].*[_-]$/.test(trimmed);
}

function creditFromRights(value: string): string {
  const trimmed = value.trim();
  return trimmed &&
    trimmed.length <= 80 &&
    !/copyright|©|\b(?:19|20)\d{2}\b/i.test(trimmed) &&
    isUsableCredit(trimmed)
    ? trimmed
    : "";
}
