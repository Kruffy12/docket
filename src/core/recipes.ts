// Recipe schema, validation and the compiled lexicon the parser matches against.
// A recipe describes one noun (e.g. "job") over one table: which words mean
// which field, value or action, and the rules that apply when they change.

export type FieldType = "enum" | "text" | "date" | "user" | "number";

/** Record IDs: job numbers, or text keys such as an inventory SKU. */
export type RecordId = number | string;

export interface EnumValue {
  value: string;
  label: string;
  aliases?: string[];
  /** Muted chip colour name for the UI. */
  color?: string;
}

/**
 * A follow-on change. On a field, it fires when the field is set to one of
 * `onValues`. On an action, it fires when `when` matches the record (or always).
 * `to` is a literal, or one of: $today, $me (signed-in user), $clear.
 */
export interface Effect {
  onValues?: string[];
  when?: { field: string; in: string[] };
  set: string;
  to: string;
  onlyIfEmpty?: boolean;
}

export interface Notice {
  onValues: string[];
  text: string;
}

export interface FieldDef {
  name: string;
  label: string;
  type: FieldType;
  aliases?: string[];
  /** Defaults to true. Read-only fields can show on previews but never be set. */
  editable?: boolean;
  /** "append" adds a line to existing text instead of replacing it. */
  mode?: "set" | "append";
  values?: EnumValue[];
  effects?: Effect[];
  notices?: Notice[];
  /** Shown when someone tries to set a read-only field, e.g. how it does change. */
  hint?: string;
  /**
   * The value lives inside another text field as one "Key: Value" item of a
   * "; "-separated list (e.g. an inspection checklist). Enum values are stored
   * by their label. Part fields only take a value after their name: their
   * values are never bare words, so several parts can share "present"/"missing".
   */
  part?: { of: string; key: string };
  /** On the field that holds parts: the text that means "nothing recorded". */
  placeholder?: string;
  /** Number fields: whole numbers only. */
  integer?: boolean;
  /** Number fields: "+3" / "-1" right after the record changes this field by that much. */
  delta?: boolean;
  /** Delta fields: noun of a record a change can name, e.g. "job" in "-1 job 1284". */
  link?: string;
  /** Only these portal roles may change the field (the server ignores others). */
  roles?: string[];
}

export interface ActionDef {
  name: string;
  label: string;
  aliases?: string[];
  requires?: { field: string; in: string[] };
  effects?: Effect[];
}

export interface Recipe {
  noun: string;
  label: string;
  plural: string;
  aliases: string[];
  table: string;
  idColumn: string;
  /** "number" (default): IDs like 1284. "text": IDs like an SKU, typed as one word or "quoted". */
  idType?: "number" | "text";
  defaultField: string;
  fields: FieldDef[];
  actions: ActionDef[];
  preview: string[];
  create?: { args: string[] };
  rules: {
    confirm: "always" | "risky";
    allowCreate: boolean;
    allowDelete: boolean;
  };
}

export type Meaning =
  | { kind: "field"; field: FieldDef }
  | { kind: "action"; action: ActionDef }
  | { kind: "value"; field: FieldDef; value: EnumValue };

export interface LexEntry {
  word: string;
  meaning: Meaning;
  /** True for the canonical name, false for an alias. */
  canonical: boolean;
}

export interface CompiledRecipe extends Recipe {
  fieldMap: Map<string, FieldDef>;
  /** Every word that can follow a record ID: fields, actions, enum values. */
  lexicon: LexEntry[];
  /** The noun and its aliases. */
  nounWords: string[];
}

/** Words the parser reserves at the start of a line. */
export const RESERVED_WORDS = ["new", "find", "undo"];

export class RecipeError extends Error {
  readonly issues: string[];
  constructor(name: string, issues: string[]) {
    super(`Recipe "${name}" is invalid:\n- ${issues.join("\n- ")}`);
    this.name = "RecipeError";
    this.issues = issues;
  }
}

export function meaningKey(m: Meaning): string {
  switch (m.kind) {
    case "field":
      return `field:${m.field.name}`;
    case "action":
      return `action:${m.action.name}`;
    case "value":
      return `value:${m.field.name}:${m.value.value}`;
  }
}

export function isEditable(field: FieldDef): boolean {
  return field.editable !== false;
}

const WORD = /^[a-z][a-z0-9-]*$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isStr(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}
function isStrArr(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isStr);
}

/** Validate untrusted JSON and compile it. Throws RecipeError listing every problem. */
export function loadRecipe(input: unknown): CompiledRecipe {
  const issues: string[] = [];
  const name = isObj(input) && isStr(input.noun) ? input.noun : "(unnamed)";
  if (!isObj(input)) throw new RecipeError(name, ["recipe must be an object"]);
  const r = input as Partial<Recipe> & Record<string, unknown>;

  for (const key of ["noun", "label", "plural", "table", "idColumn", "defaultField"] as const) {
    if (!isStr(r[key])) issues.push(`"${key}" must be a non-empty string`);
  }
  if (r.idType !== undefined && r.idType !== "number" && r.idType !== "text") {
    issues.push(`"idType" must be "number" or "text"`);
  }
  if (!isStrArr(r.aliases)) issues.push(`"aliases" must be an array of strings`);
  if (!Array.isArray(r.fields) || r.fields.length === 0) issues.push(`"fields" must be a non-empty array`);
  if (r.actions !== undefined && !Array.isArray(r.actions)) issues.push(`"actions" must be an array`);
  if (!isStrArr(r.preview)) issues.push(`"preview" must be an array of field names`);
  if (
    !isObj(r.rules) ||
    (r.rules.confirm !== "always" && r.rules.confirm !== "risky") ||
    typeof r.rules.allowCreate !== "boolean" ||
    typeof r.rules.allowDelete !== "boolean"
  ) {
    issues.push(`"rules" needs confirm ("always" | "risky"), allowCreate and allowDelete`);
  }
  if (issues.length) throw new RecipeError(name, issues);

  const recipe: Recipe = {
    noun: r.noun!.toLowerCase(),
    label: r.label!,
    plural: r.plural!,
    aliases: r.aliases!.map((a) => a.toLowerCase()),
    table: r.table!,
    idColumn: r.idColumn!,
    idType: r.idType === "text" ? "text" : "number",
    defaultField: r.defaultField!,
    fields: r.fields as FieldDef[],
    actions: (r.actions ?? []) as ActionDef[],
    preview: r.preview!,
    create: r.create as Recipe["create"],
    rules: r.rules as Recipe["rules"],
  };

  // Fields
  const fieldMap = new Map<string, FieldDef>();
  for (const [i, f] of recipe.fields.entries()) {
    if (!isObj(f) || !isStr(f.name) || !isStr(f.label)) {
      issues.push(`fields[${i}] needs a name and label`);
      continue;
    }
    if (!["enum", "text", "date", "user", "number"].includes(f.type)) {
      issues.push(`field "${f.name}" has unknown type "${String(f.type)}"`);
    }
    if (fieldMap.has(f.name)) issues.push(`field "${f.name}" is defined twice`);
    fieldMap.set(f.name, f);
    if (f.aliases !== undefined && !isStrArr(f.aliases)) issues.push(`field "${f.name}" aliases must be strings`);
    if (f.mode === "append" && f.type !== "text") issues.push(`field "${f.name}": only text fields can append`);
    if (f.type === "enum") {
      if (!Array.isArray(f.values) || f.values.length === 0) {
        issues.push(`enum field "${f.name}" needs values`);
      } else {
        for (const v of f.values) {
          if (!isObj(v) || !isStr(v.value) || !isStr(v.label)) issues.push(`field "${f.name}" has a value without value/label`);
          else if (v.aliases !== undefined && !isStrArr(v.aliases)) issues.push(`value "${v.value}" aliases must be strings`);
        }
      }
    } else if (f.values !== undefined) {
      issues.push(`field "${f.name}" is not an enum but has values`);
    }
  }
  if (issues.length) throw new RecipeError(name, issues);

  for (const f of recipe.fields) {
    if (f.part) {
      const holder = fieldMap.get(f.part.of);
      if (!holder || holder.type !== "text") issues.push(`field "${f.name}" is part of "${f.part.of}", which must be a text field`);
      else if (holder.mode === "append") issues.push(`field "${f.part.of}" holds parts, so it can't append`);
      if (!isStr(f.part.key)) issues.push(`field "${f.name}" part needs a key`);
      if (f.type !== "enum" && f.type !== "text") issues.push(`part field "${f.name}" must be enum or text`);
      if (f.effects?.length || f.notices?.length) issues.push(`part field "${f.name}" can't have effects or notices`);
    }
    if ((f.integer || f.delta) && f.type !== "number") issues.push(`field "${f.name}": integer/delta need a number field`);
    if (f.roles !== undefined && !isStrArr(f.roles)) issues.push(`field "${f.name}" roles must be strings`);
  }
  if (recipe.fields.filter((f) => f.delta).length > 1) issues.push(`only one field can take +/- changes`);

  const enumHas = (fieldName: string, value: string) =>
    fieldMap.get(fieldName)?.values?.some((v) => v.value === value) ?? false;

  const checkEffect = (owner: string, e: Effect) => {
    const target = fieldMap.get(e.set);
    if (!target) return issues.push(`${owner}: effect sets unknown field "${e.set}"`);
    if (!isStr(e.to)) return issues.push(`${owner}: effect on "${e.set}" needs "to"`);
    if (!e.to.startsWith("$") && target.type === "enum" && !enumHas(e.set, e.to)) {
      issues.push(`${owner}: "${e.to}" is not a value of "${e.set}"`);
    }
    if (e.when) {
      if (!fieldMap.has(e.when.field)) issues.push(`${owner}: condition on unknown field "${e.when.field}"`);
      for (const v of e.when.in ?? []) {
        if (!enumHas(e.when.field, v)) issues.push(`${owner}: "${v}" is not a value of "${e.when.field}"`);
      }
    }
  };

  for (const f of recipe.fields) {
    for (const e of f.effects ?? []) {
      checkEffect(`field "${f.name}"`, e);
      for (const v of e.onValues ?? []) {
        if (!enumHas(f.name, v)) issues.push(`field "${f.name}": effect trigger "${v}" is not one of its values`);
      }
    }
    for (const n of f.notices ?? []) {
      for (const v of n.onValues) {
        if (!enumHas(f.name, v)) issues.push(`field "${f.name}": notice trigger "${v}" is not one of its values`);
      }
    }
  }

  const def = fieldMap.get(recipe.defaultField);
  if (!def) issues.push(`defaultField "${recipe.defaultField}" is not a field`);
  else if (!isEditable(def)) issues.push(`defaultField "${recipe.defaultField}" must be editable`);

  for (const p of recipe.preview) if (!fieldMap.has(p)) issues.push(`preview field "${p}" is not a field`);
  for (const a of recipe.create?.args ?? []) if (!fieldMap.has(a)) issues.push(`create arg "${a}" is not a field`);

  const actionNames = new Set<string>();
  for (const [i, a] of recipe.actions.entries()) {
    if (!isObj(a) || !isStr(a.name) || !isStr(a.label)) {
      issues.push(`actions[${i}] needs a name and label`);
      continue;
    }
    if (actionNames.has(a.name)) issues.push(`action "${a.name}" is defined twice`);
    actionNames.add(a.name);
    if (a.requires) {
      if (!fieldMap.has(a.requires.field)) issues.push(`action "${a.name}" requires unknown field "${a.requires.field}"`);
      for (const v of a.requires.in ?? []) {
        if (!enumHas(a.requires.field, v)) issues.push(`action "${a.name}": "${v}" is not a value of "${a.requires.field}"`);
      }
    }
    for (const e of a.effects ?? []) checkEffect(`action "${a.name}"`, e);
  }

  // Lexicon + collision check: one word must mean exactly one thing.
  const lexicon: LexEntry[] = [];
  const add = (word: string, meaning: Meaning, canonical: boolean) =>
    lexicon.push({ word: word.toLowerCase(), meaning, canonical });

  for (const f of recipe.fields) {
    if (!isEditable(f)) continue;
    add(f.name, { kind: "field", field: f }, true);
    for (const a of f.aliases ?? []) add(a, { kind: "field", field: f }, false);
    // Part fields share value words ("present"), so their values only follow the field name.
    for (const v of f.part ? [] : (f.values ?? [])) {
      add(v.value, { kind: "value", field: f, value: v }, true);
      for (const a of v.aliases ?? []) add(a, { kind: "value", field: f, value: v }, false);
    }
  }
  for (const a of recipe.actions) {
    add(a.name, { kind: "action", action: a }, true);
    for (const al of a.aliases ?? []) add(al, { kind: "action", action: a }, false);
  }

  const nounWords = [recipe.noun, ...recipe.aliases];
  const seen = new Map<string, string>();
  for (const e of lexicon) {
    // Words are matched case-insensitively against single whitespace-free tokens.
    if (!WORD.test(e.word)) issues.push(`"${e.word}" must be one lowercase word (letters, digits, hyphens)`);
    if (RESERVED_WORDS.includes(e.word)) issues.push(`"${e.word}" is a reserved word`);
    if (nounWords.includes(e.word)) issues.push(`"${e.word}" is both a noun and a ${e.meaning.kind}`);
    const key = meaningKey(e.meaning);
    const prev = seen.get(e.word);
    if (prev !== undefined && prev !== key) issues.push(`"${e.word}" means both ${prev} and ${key}`);
    seen.set(e.word, key);
  }
  for (const w of nounWords) {
    if (!/^[a-z]+$/.test(w)) issues.push(`noun word "${w}" must be letters only`);
    if (RESERVED_WORDS.includes(w)) issues.push(`noun word "${w}" is reserved`);
  }

  if (issues.length) throw new RecipeError(name, issues);
  return { ...recipe, fieldMap, lexicon, nounWords };
}

/** Compile several recipes and make sure their noun words don't overlap. */
export function loadRecipes(inputs: unknown[]): CompiledRecipe[] {
  const recipes = inputs.map(loadRecipe);
  const owner = new Map<string, string>();
  const issues: string[] = [];
  for (const r of recipes) {
    for (const w of r.nounWords) {
      const prev = owner.get(w);
      if (prev && prev !== r.noun) issues.push(`"${w}" is a noun word for both "${prev}" and "${r.noun}"`);
      owner.set(w, r.noun);
    }
  }
  for (const r of recipes) {
    for (const f of r.fields) {
      if (f.link && !recipes.some((x) => x.noun === f.link)) issues.push(`field "${r.noun}.${f.name}" links to unknown noun "${f.link}"`);
    }
  }
  if (issues.length) throw new RecipeError("(set)", issues);
  return recipes;
}

/** How a record is written in the bar: "#1284" for numbered records, the key itself otherwise. */
export function recordLabel(recipe: Pick<Recipe, "idType">, id: RecordId): string {
  return recipe.idType === "text" ? String(id) : `#${id}`;
}

export function valueLabel(field: FieldDef, value: string): string {
  return field.values?.find((v) => v.value === value)?.label ?? value;
}
