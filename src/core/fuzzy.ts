// Exact-then-fuzzy word matching. Fuzzy matching only ever accepts a single,
// unambiguous best candidate; ties between different meanings are reported,
// never guessed.

/** Optimal string alignment distance (Levenshtein + adjacent transpositions). */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => {
    const row = new Array<number>(n + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

/** How many typos we tolerate for an input of this length. Short words must be exact. */
export function maxEdits(length: number): number {
  if (length <= 3) return 0;
  if (length <= 5) return 1;
  return 2;
}

export interface Candidate<T> {
  word: string;
  item: T;
  canonical?: boolean;
}

export type MatchResult<T> =
  | { status: "match"; item: T; word: string; corrected: boolean }
  | { status: "ambiguous"; items: T[]; words: string[] }
  | { status: "none" };

function pick<T>(hits: Candidate<T>[], keyOf: (t: T) => string): Candidate<T>[] {
  // One representative per distinct meaning, preferring the canonical word.
  const byKey = new Map<string, Candidate<T>>();
  for (const h of hits) {
    const k = keyOf(h.item);
    const prev = byKey.get(k);
    if (!prev || (!prev.canonical && h.canonical)) byKey.set(k, h);
  }
  return [...byKey.values()];
}

export function matchWord<T>(
  input: string,
  candidates: Candidate<T>[],
  keyOf: (t: T) => string,
  opts: { fuzzy?: boolean } = {},
): MatchResult<T> {
  const word = input.toLowerCase();

  const exact = pick(
    candidates.filter((c) => c.word === word),
    keyOf,
  );
  if (exact.length === 1) return { status: "match", item: exact[0].item, word: exact[0].word, corrected: false };
  if (exact.length > 1) return { status: "ambiguous", items: exact.map((e) => e.item), words: exact.map((e) => e.word) };

  const budget = opts.fuzzy === false ? 0 : maxEdits(word.length);
  if (budget === 0) return { status: "none" };

  let best = Infinity;
  let hits: Candidate<T>[] = [];
  for (const c of candidates) {
    const dist = editDistance(word, c.word);
    if (dist > budget) continue;
    if (dist < best) {
      best = dist;
      hits = [c];
    } else if (dist === best) {
      hits.push(c);
    }
  }
  const unique = pick(hits, keyOf);
  if (unique.length === 1) return { status: "match", item: unique[0].item, word: unique[0].word, corrected: true };
  if (unique.length > 1) return { status: "ambiguous", items: unique.map((u) => u.item), words: unique.map((u) => u.word) };
  return { status: "none" };
}
