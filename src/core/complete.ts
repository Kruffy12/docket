// Tab completion: what can replace the word under the cursor (end of input).

import { parse, type ParseOptions } from "./parser";
import type { CompiledRecipe } from "./recipes";
import { tokenize } from "./tokenize";
import { vocabularyFor, type WordKind } from "./vocab";

export interface CompletionItem {
  /** Text to insert in place of the partial word. */
  text: string;
  label: string;
  kind: WordKind | "record";
}

export interface Completion {
  /** Replace input[from, to) with an item's text. */
  from: number;
  to: number;
  items: CompletionItem[];
}

export interface CompleteOptions extends ParseOptions {
  /** Most recent first; offered when a record number is expected. */
  recentIds?: number[];
  limit?: number;
}

export function complete(input: string, recipes: CompiledRecipe[], opts: CompleteOptions = {}): Completion {
  const limit = opts.limit ?? 8;
  const raw = tokenize(input);
  const last = raw[raw.length - 1];
  const atBoundary = raw.length === 0 || /\s$/.test(input);
  if (!atBoundary && last.quoted) return { from: input.length, to: input.length, items: [] };

  const from = atBoundary ? input.length : last.start;
  const partial = atBoundary ? "" : last.text.toLowerCase();
  const context = parse(input.slice(0, from), recipes, opts);
  if (context.status === "error") return { from, to: input.length, items: [] };

  const next = context.next;
  const items: CompletionItem[] = [];

  if (next.kind === "record") {
    const digits = partial.replace(/^#/, "");
    for (const id of opts.recentIds ?? []) {
      if (/^\d*$/.test(digits) && String(id).startsWith(digits)) {
        items.push({ text: String(id), label: `#${id}`, kind: "record" });
      }
    }
  } else {
    const words = vocabularyFor(next, recipes)
      .filter((w) => w.word.startsWith(partial))
      // Canonical names first, then shorter words, then alphabetical.
      .sort(
        (a, b) =>
          Number(b.canonical) - Number(a.canonical) ||
          a.word.length - b.word.length ||
          a.word.localeCompare(b.word),
      );
    const seen = new Set<string>();
    for (const w of words) {
      if (seen.has(w.word)) continue;
      seen.add(w.word);
      items.push({ text: w.word, label: w.label, kind: w.kind });
    }
  }

  return { from, to: input.length, items: items.slice(0, limit) };
}
