export interface MetadataGuess {
  title: string;
  composer: string;
  artist: string;
}

/**
 * Best-effort guess at song metadata from a filename like
 * "gymnopedie-no-1-satie" or "nothing-else-matters-metallica". This is
 * intentionally dumb — it just cleans up the filename into a title and takes
 * a stab at a composer/artist if the name matches "<title> - <artist>" or
 * "<title> <artist>" patterns. The user reviews/edits everything in the UI
 * before it gets uploaded, so a wrong guess here just means one extra click,
 * not a bad upload.
 */
export function guessMetadata(baseName: string): MetadataGuess {
  const cleaned = baseName
    .replace(/[_]+/g, " ")
    .replace(/-+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // "<title> - <artist>" (dash was already turned into a space above, so
  // detect it from the original string instead).
  const dashSplit = baseName.split(/\s*-\s*/).filter(Boolean);
  let title = titleCase(cleaned);
  let composer = "";
  let artist = "";

  if (dashSplit.length >= 2) {
    // Heuristic: last dash-separated chunk is often the artist/composer
    // (e.g. "gymnopedie-no-1-satie" -> last chunk "satie"), unless it's a
    // number like "no-1".
    const last = dashSplit[dashSplit.length - 1];
    if (last && !/^no\.?\s*\d+$/i.test(last) && !/^\d+$/.test(last)) {
      artist = titleCase(last);
      composer = artist;
      title = titleCase(dashSplit.slice(0, -1).join(" "));
    }
  }

  return { title, composer, artist };
}

function titleCase(s: string): string {
  return s
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
