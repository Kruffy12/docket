// The words that can come next at a given point in a command. Shared by the
// parser (to tell "still typing" from "wrong") and by Tab completion.

import { DATE_WORDS } from "./dates";
import { RESERVED_WORDS, type CompiledRecipe } from "./recipes";

export type Expect =
  | { kind: "command" }
  | { kind: "noun"; for: "edit" | "create" | "find" }
  | { kind: "record"; recipe: string }
  | { kind: "change"; recipe: string }
  | { kind: "value"; recipe: string; field: string }
  | { kind: "text"; recipe: string; field: string }
  | { kind: "date"; recipe: string; field: string }
  | { kind: "arg"; recipe: string; field: string }
  | { kind: "search"; recipe: string }
  | { kind: "workspace" }
  | { kind: "none" };

export type WordKind = "keyword" | "noun" | "field" | "value" | "action" | "date";

export interface VocabWord {
  word: string;
  label: string;
  kind: WordKind;
  canonical: boolean;
}

export function findRecipe(recipes: CompiledRecipe[], noun: string): CompiledRecipe | undefined {
  return recipes.find((r) => r.noun === noun);
}

function nounWords(recipes: CompiledRecipe[]): VocabWord[] {
  return recipes.flatMap((r) =>
    r.nounWords.map((w, i) => ({ word: w, label: r.label, kind: "noun" as const, canonical: i === 0 })),
  );
}

export function vocabularyFor(next: Expect, recipes: CompiledRecipe[]): VocabWord[] {
  switch (next.kind) {
    case "command":
      return [
        ...RESERVED_WORDS.map((w) => ({ word: w, label: w, kind: "keyword" as const, canonical: true })),
        ...nounWords(recipes),
      ];
    case "noun":
      return nounWords(recipes);
    case "change": {
      const r = findRecipe(recipes, next.recipe);
      if (!r) return [];
      return r.lexicon.map((e) => ({
        word: e.word,
        label:
          e.meaning.kind === "field"
            ? e.meaning.field.label
            : e.meaning.kind === "action"
              ? e.meaning.action.label
              : `${e.meaning.field.label} → ${e.meaning.value.label}`,
        kind: e.meaning.kind,
        canonical: e.canonical,
      }));
    }
    case "value": {
      const f = findRecipe(recipes, next.recipe)?.fieldMap.get(next.field);
      return (f?.values ?? []).flatMap((v) => [
        { word: v.value, label: v.label, kind: "value" as const, canonical: true },
        ...(v.aliases ?? []).map((a) => ({ word: a, label: v.label, kind: "value" as const, canonical: false })),
      ]);
    }
    case "date":
      return DATE_WORDS.map((w) => ({ word: w, label: w, kind: "date" as const, canonical: true }));
    default:
      return [];
  }
}
