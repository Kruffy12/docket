// Rule-based command parser. Grammar:
//
//   <noun> <record>[,<record>…] [field] <value>   update / action / view
//   <noun> <record> +N|-N [job <n>] [reason…]     change a delta field (e.g. stock)
//   new <noun> <arg>…                              create
//   find [noun] <term>…                            search
//   undo                                           revert last change
//   @<workspace>                                   switch workspace
//
// The parser is pure and deterministic: no network, no AI, no guessing.
// Every result carries position-mapped tokens so the bar can draw chips live.
// Three outcomes besides "empty":
//   ok          a complete command
//   incomplete  nothing wrong yet, more is needed (still typing)
//   error       a token is wrong; it is flagged so the bar can underline it

import { parseDate, DATE_WORDS } from "./dates";
import { editDistance, matchWord, type Candidate } from "./fuzzy";
import {
  isEditable,
  meaningKey,
  recordLabel,
  type ActionDef,
  type CompiledRecipe,
  type FieldDef,
  type LexEntry,
  type RecordId,
} from "./recipes";
import { tokenize, type RawToken } from "./tokenize";
import { vocabularyFor, type Expect } from "./vocab";

export type { Expect } from "./vocab";

export type TokenRole =
  | "keyword"
  | "noun"
  | "record"
  | "field"
  | "value"
  | "action"
  | "text"
  | "date"
  | "workspace"
  | "pending"
  | "unknown";

export interface Token {
  role: TokenRole;
  /** Exactly what was typed for this chip. */
  text: string;
  start: number;
  end: number;
  /** What the chip should read, e.g. "#1284", "Resolved", "Fri 13 Nov". */
  display?: string;
  /** The word was fuzzy-corrected; `display` shows the corrected value. */
  corrected?: boolean;
  /** Set on the token to underline red. */
  error?: string;
  /** For value tokens: the field it belongs to. */
  field?: string;
  /** For value tokens: the recipe's chip colour. */
  color?: string;
}

/** How the user must confirm: plain Enter, Shift+Enter (bulk), or a typed confirm (big bulk). */
export type Confirm = "enter" | "shift-enter" | "typed";

export type Command =
  | { kind: "view"; recipe: string; ids: RecordId[] }
  | {
      kind: "update";
      recipe: string;
      ids: RecordId[];
      field: string;
      /** For op "add", a signed whole number, e.g. "-1". */
      value: string;
      op: "set" | "append" | "add";
      confirm: Confirm;
      /** Delta-field changes: the linked record (e.g. the job a part was used on). */
      link?: RecordId;
      /** Delta-field changes: why, in the user's words. */
      reason?: string;
    }
  | { kind: "action"; recipe: string; ids: RecordId[]; action: string; confirm: Confirm }
  | { kind: "create"; recipe: string; values: Record<string, string>; confirm: Confirm }
  /** Permanent. One record only; the bar asks for its number to be typed before sending. */
  | { kind: "delete"; recipe: string; id: RecordId }
  | { kind: "find"; recipe: string; text: string[]; filters: { field: string; value: string }[] }
  | { kind: "undo" }
  | { kind: "workspace"; name: string };

export interface ParseResult {
  status: "empty" | "ok" | "incomplete" | "error";
  command?: Command;
  tokens: Token[];
  /** Plain-language hint (incomplete) or reason (error). */
  message?: string;
  /** Words the user might have meant, for "Did you mean…". */
  suggestions?: string[];
  /** What could be typed next; drives Tab completion. */
  next: Expect;
}

export interface ParseOptions {
  /** Reference time for relative dates. Defaults to now. */
  now?: Date;
  /** Records above this count need a typed confirm (Settings → Safety). Default 5. */
  bulkLimit?: number;
}

const ID_PART = /^#?\d+$/;
const ID_TOKEN = /^[#\d,]+$/;
const GLUED = /^([a-z]+)(#?\d[\d,]*)$/i;
const DELTA = /^[+-]\d+$/;
const NUMBER = /^-?(\d+(\.\d*)?|\.\d+)$/;

function confirmFor(count: number, bulkLimit: number): Confirm {
  if (count <= 1) return "enter";
  return count <= bulkLimit ? "shift-enter" : "typed";
}

type Resolved<T> =
  | { kind: "match"; item: T; word: string; corrected: boolean }
  | { kind: "pending"; words: string[] }
  | { kind: "ambiguous"; words: string[] }
  | { kind: "none"; suggestions: string[] };

class Parser {
  private readonly raw: RawToken[];
  private readonly trailingSpace: boolean;
  private readonly tokens: Token[] = [];
  private readonly input: string;
  private readonly recipes: CompiledRecipe[];
  private readonly now: Date;
  private readonly bulkLimit: number;

  constructor(input: string, recipes: CompiledRecipe[], opts: ParseOptions) {
    this.input = input;
    this.recipes = recipes;
    this.now = opts.now ?? new Date();
    this.bulkLimit = opts.bulkLimit ?? 5;
    this.raw = tokenize(input);
    this.trailingSpace = /\s$/.test(input);
  }

  // ---- result builders -------------------------------------------------

  private ok(command: Command, next: Expect = { kind: "none" }): ParseResult {
    return { status: "ok", command, tokens: this.tokens, next };
  }

  private incomplete(message: string, next: Expect): ParseResult {
    return { status: "incomplete", tokens: this.tokens, message, next };
  }

  /** Flag raw token `i` as wrong; later tokens are kept as neutral chips. */
  private error(i: number, message: string, suggestions: string[] = []): ParseResult {
    const t = this.raw[i];
    this.tokens.push({ role: "unknown", text: t.raw, start: t.start, end: t.end, error: message });
    this.rest(i + 1);
    return { status: "error", tokens: this.tokens, message, suggestions, next: { kind: "none" } };
  }

  private rest(from: number) {
    for (const t of this.raw.slice(from)) {
      this.tokens.push({ role: "unknown", text: t.raw, start: t.start, end: t.end });
    }
  }

  private push(t: RawToken, role: TokenRole, extra: Partial<Token> = {}) {
    this.tokens.push({ role, text: t.raw, start: t.start, end: t.end, ...extra });
  }

  /** True while the user is still typing raw token `i` (last, no trailing space, not a closed quote). */
  private typing(i: number): boolean {
    const t = this.raw[i];
    return i === this.raw.length - 1 && !this.trailingSpace && !(t.quoted && !t.unterminated);
  }

  // ---- word resolution -------------------------------------------------

  /**
   * Exact match first; while still typing, a prefix of a known word is
   * "pending" rather than wrong; only then try a unique fuzzy match.
   */
  private resolve<T>(i: number, cands: Candidate<T>[], keyOf: (t: T) => string, next: Expect): Resolved<T> {
    const text = this.raw[i].text.toLowerCase();
    const exact = matchWord(text, cands, keyOf, { fuzzy: false });
    if (exact.status === "match") return { kind: "match", item: exact.item, word: exact.word, corrected: false };
    if (exact.status === "ambiguous") return { kind: "ambiguous", words: exact.words };

    const prefixed = this.prefixWords(text, next);
    if (this.typing(i) && text.length > 0 && prefixed.length > 0) return { kind: "pending", words: prefixed };

    const fuzzy = matchWord(text, cands, keyOf);
    if (fuzzy.status === "match") return { kind: "match", item: fuzzy.item, word: fuzzy.word, corrected: true };
    if (fuzzy.status === "ambiguous") return { kind: "ambiguous", words: fuzzy.words };

    if (prefixed.length) return { kind: "none", suggestions: prefixed.slice(0, 3) };
    const near = cands
      .map((c) => ({ w: c.word, d: editDistance(text, c.word) }))
      .filter((x) => x.d <= 2 && x.w.length > 1)
      .sort((a, b) => a.d - b.d)
      .map((x) => x.w);
    return { kind: "none", suggestions: [...new Set(near)].slice(0, 3) };
  }

  private prefixWords(text: string, next: Expect): string[] {
    const words = vocabularyFor(next, this.recipes)
      .filter((w) => w.word.startsWith(text) && w.word !== text)
      .sort((a, b) => Number(b.canonical) - Number(a.canonical));
    return [...new Set(words.map((w) => w.word))];
  }

  private nounCandidates(): Candidate<CompiledRecipe>[] {
    return this.recipes.flatMap((r) => r.nounWords.map((w, idx) => ({ word: w, item: r, canonical: idx === 0 })));
  }

  // ---- entry -------------------------------------------------------------

  run(): ParseResult {
    if (this.raw.length === 0) return { status: "empty", tokens: [], next: { kind: "command" } };
    if (this.recipes.length === 0) return this.error(0, "No recipes are loaded");

    const first = this.raw[0];
    const word = first.text.toLowerCase();

    if (!first.quoted && word.startsWith("@")) return this.workspace();
    if (!first.quoted && word === "undo") {
      this.push(first, "keyword", { display: "undo" });
      if (this.raw.length > 1) return this.error(1, "undo takes nothing after it");
      return this.ok({ kind: "undo" });
    }
    if (!first.quoted && word === "find") {
      this.push(first, "keyword", { display: "find" });
      return this.find(1);
    }
    if (!first.quoted && word === "new") {
      this.push(first, "keyword", { display: "new" });
      return this.create(1);
    }
    return this.edit();
  }

  // ---- @workspace ------------------------------------------------------

  private workspace(): ParseResult {
    const t = this.raw[0];
    const name = t.text.slice(1).toLowerCase();
    if (name === "") {
      this.push(t, "pending");
      return this.incomplete("Type a workspace name, e.g. @servicell", { kind: "workspace" });
    }
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) return this.error(0, `"${t.text}" isn't a workspace name`);
    this.push(t, "workspace", { display: `@${name}` });
    if (this.raw.length > 1) return this.error(1, "Nothing goes after a workspace switch");
    return this.ok({ kind: "workspace", name });
  }

  // ---- <noun> <records> [field] <value> ----------------------------------

  private edit(): ParseResult {
    const first = this.raw[0];

    // Glued noun + id, e.g. j1284 or job#1284,1290
    const glued = first.quoted ? null : GLUED.exec(first.text);
    if (glued) {
      const r = this.nounCandidates().find((c) => c.word === glued[1].toLowerCase())?.item;
      if (r) {
        const nounEnd = first.start + glued[1].length;
        this.tokens.push({ role: "noun", text: glued[1], start: first.start, end: nounEnd, display: r.label });
        return this.records(r, 1, { text: glued[2], start: nounEnd });
      }
    }

    if (!first.quoted && ID_TOKEN.test(first.text)) {
      const nouns = this.recipes.map((r) => r.noun);
      return this.error(0, `Start with what to change, e.g. "${nouns[0]} ${first.text.replace(/^#/, "")}"`, nouns);
    }

    const res = this.resolve(0, this.nounCandidates(), (r) => r.noun, { kind: "command" });
    switch (res.kind) {
      case "match":
        this.push(first, "noun", { display: res.item.label, corrected: res.corrected || undefined });
        return this.records(res.item, 1);
      case "pending":
        this.push(first, "pending");
        return this.incomplete(`Keep typing: ${res.words.slice(0, 3).join(", ")}`, { kind: "command" });
      case "ambiguous":
        return this.error(0, `"${first.text}" could be ${res.words.join(" or ")}`, res.words);
      case "none":
        return this.error(0, `Unknown command "${first.text}"`, res.suggestions);
    }
  }

  /** Parse one or more record IDs starting at raw index `i` (plus an optional glued remainder). */
  private records(recipe: CompiledRecipe, i: number, seed?: { text: string; start: number }): ParseResult {
    if (recipe.idType === "text") return this.textRecord(recipe, i);
    const segments: { text: string; start: number; rawIndex: number }[] = [];
    if (seed) segments.push({ ...seed, rawIndex: 0 });

    let j = i;
    while (j < this.raw.length) {
      const t = this.raw[j];
      if (t.quoted || !ID_TOKEN.test(t.text)) break;
      const prev = segments[segments.length - 1];
      const continues = !prev || prev.text.endsWith(",") || t.text.startsWith(",");
      if (!continues) break;
      segments.push({ text: t.text, start: t.start, rawIndex: j });
      j++;
    }

    const recordNext: Expect = { kind: "record", recipe: recipe.noun };
    if (segments.length === 0) {
      if (j >= this.raw.length) return this.incomplete(`Which ${recipe.noun}? Type its number`, recordNext);
      return this.error(j, `Expected a ${recipe.noun} number, e.g. ${recipe.noun} 1284`);
    }

    const ids: number[] = [];
    for (const [s, seg] of segments.entries()) {
      let offset = 0;
      const parts = seg.text.split(",");
      for (const [k, part] of parts.entries()) {
        const start = seg.start + offset;
        offset += part.length + 1;
        if (part === "") continue;
        const stillTypingThis =
          s === segments.length - 1 && k === parts.length - 1 && j >= this.raw.length && !this.trailingSpace;
        if (part === "#" && stillTypingThis) {
          this.tokens.push({ role: "pending", text: part, start, end: start + 1 });
          return this.incomplete(`Which ${recipe.noun}? Type its number`, recordNext);
        }
        if (!ID_PART.test(part)) {
          this.tokens.push({ role: "unknown", text: part, start, end: start + part.length, error: `"${part}" isn't a number` });
          this.rest(seg.rawIndex + 1);
          return { status: "error", tokens: this.tokens, message: `"${part}" isn't a ${recipe.noun} number`, next: { kind: "none" } };
        }
        const id = Number(part.replace("#", ""));
        this.tokens.push({ role: "record", text: part, start, end: start + part.length, display: `#${id}` });
        if (!ids.includes(id)) ids.push(id);
      }
    }

    const last = segments[segments.length - 1];
    if (last.text.endsWith(",") && j >= this.raw.length) {
      return this.incomplete(`Add another ${recipe.noun} number`, recordNext);
    }

    if (j >= this.raw.length) {
      // Still typing the number → completion offers recent IDs; otherwise a field/value comes next.
      const stillTyping = !this.trailingSpace;
      return this.ok(
        { kind: "view", recipe: recipe.noun, ids },
        stillTyping ? recordNext : { kind: "change", recipe: recipe.noun },
      );
    }
    return this.change(recipe, ids, j);
  }

  /** One text key (e.g. an SKU): a single word, or "quoted" when it has spaces. */
  private textRecord(recipe: CompiledRecipe, i: number): ParseResult {
    const recordNext: Expect = { kind: "record", recipe: recipe.noun };
    const key = recipe.fieldMap.get(recipe.idColumn)?.label ?? "key";
    if (i >= this.raw.length) return this.incomplete(`Which ${recipe.noun}? Type its ${key}`, recordNext);
    const t = this.raw[i];
    if (t.unterminated) {
      this.push(t, "pending");
      return this.incomplete("Close the quote to finish", recordNext);
    }
    const id = t.text.trim();
    if (id === "") return this.error(i, `Type the ${recipe.noun}'s ${key}`);
    this.push(t, "record", { display: id });
    if (i + 1 >= this.raw.length) {
      return this.ok(
        { kind: "view", recipe: recipe.noun, ids: [id] },
        this.typing(i) ? recordNext : { kind: "change", recipe: recipe.noun },
      );
    }
    return this.change(recipe, [id], i + 1);
  }

  /** After the records: a field name, an action, or a bare value of some field. */
  private change(recipe: CompiledRecipe, ids: RecordId[], i: number): ParseResult {
    const t = this.raw[i];
    const next: Expect = { kind: "change", recipe: recipe.noun };
    if (t.quoted) return this.error(i, "Expected a field, value or action here, not quoted text");
    const deltaField = recipe.fields.find((f) => f.delta && isEditable(f));
    if (deltaField && DELTA.test(t.text)) {
      const n = Number(t.text);
      this.push(t, "value", { display: `${deltaField.label} ${t.text}`, field: deltaField.name });
      if (n === 0) return this.error(i, "Change it by at least 1");
      if (ids.length > 1) return this.error(i, `Change ${deltaField.label.toLowerCase()} one ${recipe.noun} at a time`);
      return this.deltaExtras(recipe, ids, deltaField, String(n), "add", i + 1);
    }
    if (recipe.rules.allowDelete && t.text.toLowerCase() === "delete") {
      this.push(t, "keyword", { display: "delete" });
      if (ids.length > 1) return this.error(i, `Delete one ${recipe.noun} at a time`);
      if (i + 1 < this.raw.length) return this.error(i + 1, "delete takes nothing after it");
      return this.ok({ kind: "delete", recipe: recipe.noun, id: ids[0] });
    }

    const cands: Candidate<LexEntry>[] = recipe.lexicon.map((e) => ({ word: e.word, item: e, canonical: e.canonical }));
    const res = this.resolve(i, cands, (e) => meaningKey(e.meaning), next);

    if (res.kind === "pending") {
      this.push(t, "pending");
      return this.incomplete(`Keep typing: ${res.words.slice(0, 3).join(", ")}`, next);
    }
    if (res.kind === "ambiguous") {
      return this.error(i, `"${t.text}" could be ${res.words.join(" or ")}`, res.words);
    }
    if (res.kind === "none") {
      const readOnly = recipe.fields.find((f) => !isEditable(f) && f.name.toLowerCase() === t.text.toLowerCase());
      if (readOnly) {
        const why = readOnly.hint
          ? `${readOnly.label} is read-only in Docket. ${readOnly.hint}`
          : `${readOnly.label} is read-only in Docket`;
        return this.error(i, why);
      }
      return this.error(i, `Unknown field, value or action "${t.text}"`, res.suggestions);
    }

    const m = res.item.meaning;
    const corrected = res.corrected || undefined;
    switch (m.kind) {
      case "action":
        this.push(t, "action", { display: m.action.label, corrected });
        return this.action(recipe, ids, m.action, i + 1);
      case "value":
        this.push(t, "value", {
          display: m.value.label,
          corrected,
          field: m.field.name,
          color: m.value.color,
        });
        if (i + 1 < this.raw.length) return this.error(i + 1, "Nothing goes after the new value");
        return this.update(recipe, ids, m.field, m.value.value, "set");
      case "field":
        this.push(t, "field", { display: m.field.label, corrected });
        return this.fieldValue(recipe, ids, m.field, i + 1);
    }
  }

  private action(recipe: CompiledRecipe, ids: RecordId[], action: ActionDef, i: number): ParseResult {
    if (i < this.raw.length) return this.error(i, `${action.label} takes nothing after it`);
    return this.ok({
      kind: "action",
      recipe: recipe.noun,
      ids,
      action: action.name,
      confirm: confirmFor(ids.length, this.bulkLimit),
    });
  }

  private update(recipe: CompiledRecipe, ids: RecordId[], field: FieldDef, value: string, op: "set" | "append") {
    return this.ok({
      kind: "update",
      recipe: recipe.noun,
      ids,
      field: field.name,
      value,
      op,
      confirm: confirmFor(ids.length, this.bulkLimit),
    });
  }

  /** The value after an explicit field name. */
  private fieldValue(recipe: CompiledRecipe, ids: RecordId[], field: FieldDef, i: number): ParseResult {
    const r = recipe.noun;
    if (field.type === "number") {
      const next: Expect = { kind: "text", recipe: r, field: field.name };
      if (i >= this.raw.length) return this.incomplete(`New ${field.label.toLowerCase()}? Type a number`, next);
      const t = this.raw[i];
      const text = t.text.trim().replace(/^\$/, "");
      if (t.quoted || !NUMBER.test(text) || (field.integer && !/^-?\d+$/.test(text))) {
        if (this.typing(i) && /^[-$.]?$/.test(text)) {
          this.push(t, "pending");
          return this.incomplete(`New ${field.label.toLowerCase()}? Type a number`, next);
        }
        return this.error(i, `${field.label} needs ${field.integer ? "a whole number" : "a number"}`);
      }
      const n = Number(text);
      if (n < 0) return this.error(i, `${field.label} can't be negative`);
      this.push(t, "value", { display: String(n), field: field.name });
      if (field.delta) {
        if (ids.length > 1) return this.error(i, `Set ${field.label.toLowerCase()} one ${recipe.noun} at a time`);
        return this.deltaExtras(recipe, ids, field, String(n), "set", i + 1);
      }
      if (i + 1 < this.raw.length) return this.error(i + 1, "Nothing goes after the new value");
      return this.update(recipe, ids, field, String(n), "set");
    }
    if (field.type === "enum") {
      const next: Expect = { kind: "value", recipe: r, field: field.name };
      if (i >= this.raw.length) {
        return this.incomplete(`New ${field.label.toLowerCase()}?`, next);
      }
      const t = this.raw[i];
      const cands = (field.values ?? []).flatMap((v) => [
        { word: v.value.toLowerCase(), item: v, canonical: true },
        ...(v.aliases ?? []).map((a) => ({ word: a.toLowerCase(), item: v, canonical: false })),
      ]);
      const res = this.resolve(i, cands, (v) => v.value, next);
      if (res.kind === "pending") {
        this.push(t, "pending");
        return this.incomplete(`Keep typing: ${res.words.slice(0, 3).join(", ")}`, next);
      }
      if (res.kind === "ambiguous") return this.error(i, `"${t.text}" could be ${res.words.join(" or ")}`, res.words);
      if (res.kind === "none") {
        return this.error(i, `"${t.text}" isn't a ${field.label.toLowerCase()} value`, res.suggestions);
      }
      this.push(t, "value", {
        display: res.item.label,
        corrected: res.corrected || undefined,
        field: field.name,
        color: res.item.color,
      });
      if (i + 1 < this.raw.length) return this.error(i + 1, "Nothing goes after the new value");
      return this.update(recipe, ids, field, res.item.value, "set");
    }

    if (field.type === "text") {
      const next: Expect = { kind: "text", recipe: r, field: field.name };
      const text = this.restText(i);
      if (text === null) return this.incomplete(`Type the ${field.label.toLowerCase()} text`, next);
      if (text.unterminated) {
        this.pushSpan(i, "text", text.value);
        return this.incomplete("Close the quote to finish", next);
      }
      if (text.value === "") return this.error(i, `${field.label} can't be empty`);
      this.pushSpan(i, "text", text.value);
      return this.update(recipe, ids, field, text.value, field.mode === "append" ? "append" : "set");
    }

    if (field.type === "date") {
      const next: Expect = { kind: "date", recipe: r, field: field.name };
      if (i >= this.raw.length) return this.incomplete("When? e.g. fri, tomorrow, +3, nov 14", next);
      const text = this.restText(i)!;
      const parsed = parseDate(text.value, this.now);
      if (parsed) {
        this.pushSpan(i, "date", parsed.label);
        return this.update(recipe, ids, field, parsed.iso, "set");
      }
      const lastWord = this.raw[this.raw.length - 1].text.toLowerCase();
      const partial =
        this.typing(this.raw.length - 1) &&
        (DATE_WORDS.some((w) => w.startsWith(lastWord)) || /^\+?\d{0,3}$/.test(lastWord));
      if (partial) {
        this.pushSpan(i, "pending");
        return this.incomplete("When? e.g. fri, tomorrow, +3, nov 14", next);
      }
      // Underline the whole date span.
      const first = this.raw[i];
      const last = this.raw[this.raw.length - 1];
      const message = `"${text.value}" isn't a date I understand (try fri, tomorrow, +3, nov 14)`;
      this.tokens.push({
        role: "unknown",
        text: this.input.slice(first.start, last.end),
        start: first.start,
        end: last.end,
        error: message,
      });
      return { status: "error", tokens: this.tokens, message, next: { kind: "none" } };
    }

    // "user" fields are never in the lexicon, so this is unreachable with a valid recipe.
    return this.error(i - 1, `${field.label} can't be set directly`);
  }

  /**
   * After a delta-field change: an optional linked record ("job 1284") and an
   * optional reason, in either order. Everything that isn't the link is the reason.
   */
  private deltaExtras(
    recipe: CompiledRecipe,
    ids: RecordId[],
    field: FieldDef,
    value: string,
    op: "set" | "add",
    i: number,
  ): ParseResult {
    const linked = field.link ? this.recipes.find((r) => r.noun === field.link) : undefined;
    let link: RecordId | undefined;
    const reasonParts: string[] = [];
    for (let j = i; j < this.raw.length; j++) {
      const t = this.raw[j];
      if (t.unterminated) {
        this.push(t, "text", { display: t.text });
        return this.incomplete("Close the quote to finish", { kind: "none" });
      }
      const word = t.text.toLowerCase();
      const glued = !t.quoted && linked ? GLUED.exec(t.text) : null;
      if (linked && link === undefined && glued && linked.nounWords.includes(glued[1].toLowerCase()) && !glued[2].includes(",")) {
        link = Number(glued[2].replace("#", ""));
        this.push(t, "record", { display: `${linked.label} ${recordLabel(linked, link)}` });
        continue;
      }
      if (linked && link === undefined && !t.quoted && linked.nounWords.includes(word)) {
        const n = this.raw[j + 1];
        if (!n) {
          this.push(t, "noun", { display: linked.label });
          return this.incomplete(`Which ${linked.noun}? Type its number`, { kind: "record", recipe: linked.noun });
        }
        if (!n.quoted && ID_PART.test(n.text)) {
          link = Number(n.text.replace("#", ""));
          this.push(t, "noun", { display: linked.label });
          this.push(n, "record", { display: recordLabel(linked, link) });
          j++;
          continue;
        }
      }
      if (t.text.trim() !== "") {
        reasonParts.push(t.text.trim());
        this.push(t, "text", { display: t.text });
      }
    }
    const reason = reasonParts.join(" ");
    return this.ok({
      kind: "update",
      recipe: recipe.noun,
      ids,
      field: field.name,
      value,
      op,
      confirm: "enter",
      ...(link !== undefined ? { link } : {}),
      ...(reason ? { reason } : {}),
    });
  }

  /** Everything from raw[i] to the end as one string; a lone quoted token gives its inner text. */
  private restText(i: number): { value: string; unterminated: boolean } | null {
    if (i >= this.raw.length) return null;
    const slice = this.raw.slice(i);
    const unterminated = slice.some((t) => t.unterminated);
    if (slice.length === 1 && slice[0].quoted) return { value: slice[0].text.trim(), unterminated };
    const first = slice[0];
    const last = slice[slice.length - 1];
    return { value: this.input.slice(first.start, last.end).trim(), unterminated };
  }

  private pushSpan(i: number, role: TokenRole, display?: string) {
    const first = this.raw[i];
    const last = this.raw[this.raw.length - 1];
    this.tokens.push({ role, text: this.input.slice(first.start, last.end), start: first.start, end: last.end, display });
  }

  // ---- new <noun> <args…> --------------------------------------------------

  private create(i: number): ParseResult {
    if (i >= this.raw.length) return this.incomplete("New what? e.g. new job", { kind: "noun", for: "create" });
    const t = this.raw[i];
    const res = this.resolve(i, this.nounCandidates(), (r) => r.noun, { kind: "noun", for: "create" });
    if (res.kind === "pending") {
      this.push(t, "pending");
      return this.incomplete(`Keep typing: ${res.words.slice(0, 3).join(", ")}`, { kind: "noun", for: "create" });
    }
    if (res.kind !== "match") {
      return this.error(i, `Unknown thing to create "${t.text}"`, res.kind === "none" ? res.suggestions : res.words);
    }
    const recipe = res.item;
    this.push(t, "noun", { display: recipe.label, corrected: res.corrected || undefined });

    const args = recipe.create?.args ?? [];
    if (!recipe.rules.allowCreate || args.length === 0) {
      this.tokens.pop();
      return this.error(i, `Creating ${recipe.plural} isn't allowed`);
    }

    const values: Record<string, string> = {};
    let j = i + 1;
    for (const [k, argName] of args.entries()) {
      const field = recipe.fieldMap.get(argName)!;
      const next: Expect = { kind: "arg", recipe: recipe.noun, field: argName };
      if (j >= this.raw.length) {
        return this.incomplete(`${field.label}? (${args.map((a) => recipe.fieldMap.get(a)!.label).join(", ")})`, next);
      }
      const isLastArg = k === args.length - 1;
      const t = this.raw[j];
      let value: string;
      if (isLastArg) {
        const rest = this.restText(j)!;
        this.pushSpan(j, "text", `${field.label}: ${rest.value}`);
        if (rest.unterminated) return this.incomplete("Close the quote to finish", next);
        value = rest.value;
        j = this.raw.length;
      } else {
        this.push(t, "text", { display: `${field.label}: ${t.text}` });
        if (t.unterminated) return this.incomplete("Close the quote to finish", next);
        value = t.text.trim();
        j++;
      }
      if (value === "") {
        this.tokens.pop();
        const idx = this.raw.indexOf(t);
        return this.error(idx, `${field.label} can't be empty`);
      }
      values[argName] = value;
    }
    return this.ok({ kind: "create", recipe: recipe.noun, values, confirm: "enter" });
  }

  // ---- find [noun] <terms…> ------------------------------------------------

  private find(i: number): ParseResult {
    let recipe = this.recipes[0];
    if (i < this.raw.length && !this.raw[i].quoted) {
      const w = this.raw[i].text.toLowerCase();
      const r = this.recipes.find((x) => x.nounWords.includes(w));
      if (r) {
        recipe = r;
        this.push(this.raw[i], "noun", { display: r.label });
        i++;
      }
    }
    const next: Expect = { kind: "search", recipe: recipe.noun };
    if (i >= this.raw.length) return this.incomplete(`Search ${recipe.plural} for…`, next);

    const text: string[] = [];
    const filters: { field: string; value: string }[] = [];
    for (let j = i; j < this.raw.length; j++) {
      const t = this.raw[j];
      if (t.unterminated) {
        this.push(t, "text", { display: t.text });
        return this.incomplete("Close the quote to finish", next);
      }
      // Only exact value words become filters; everything else is free text (never fuzzy).
      const hit = t.quoted
        ? undefined
        : recipe.lexicon.find((e) => e.word === t.text.toLowerCase() && e.meaning.kind === "value");
      if (hit && hit.meaning.kind === "value") {
        const { field, value } = hit.meaning;
        filters.push({ field: field.name, value: value.value });
        this.push(t, "value", { display: value.label, field: field.name, color: value.color });
      } else if (t.text.trim() !== "") {
        text.push(t.text.trim());
        this.push(t, "text", { display: t.text });
      }
    }
    if (text.length === 0 && filters.length === 0) return this.incomplete(`Search ${recipe.plural} for…`, next);
    return this.ok({ kind: "find", recipe: recipe.noun, text, filters }, next);
  }
}

export function parse(input: string, recipes: CompiledRecipe[], opts: ParseOptions = {}): ParseResult {
  return new Parser(input, recipes, opts).run();
}
