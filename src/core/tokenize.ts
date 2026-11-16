// Splits a command line into whitespace-separated tokens, keeping "quoted text"
// together and recording source offsets so the UI can draw chips in place.

export interface RawToken {
  /** Token content; for quoted tokens, the text inside the quotes. */
  text: string;
  /** Exactly what was typed, quotes included. */
  raw: string;
  start: number;
  end: number;
  quoted: boolean;
  /** A quote was opened but not closed yet (the user is still typing). */
  unterminated: boolean;
}

const OPEN_QUOTES = new Set(['"', "“"]);
const CLOSE_QUOTES = new Set(['"', "”"]);
const isSpace = (c: string) => /\s/.test(c);

export function tokenize(input: string): RawToken[] {
  const tokens: RawToken[] = [];
  let i = 0;
  while (i < input.length) {
    if (isSpace(input[i])) {
      i++;
      continue;
    }
    const start = i;
    if (OPEN_QUOTES.has(input[i])) {
      i++;
      while (i < input.length && !CLOSE_QUOTES.has(input[i])) i++;
      const unterminated = i >= input.length;
      const text = input.slice(start + 1, i);
      if (!unterminated) i++; // consume closing quote
      tokens.push({ text, raw: input.slice(start, i), start, end: i, quoted: true, unterminated });
    } else {
      while (i < input.length && !isSpace(input[i])) i++;
      const raw = input.slice(start, i);
      tokens.push({ text: raw, raw, start, end: i, quoted: false, unterminated: false });
    }
  }
  return tokens;
}
