// Part fields: values kept inside one text field as "Key: Value; Key: Value",
// the way Servicell stores its inspection checklist:
//   "SIM Tray: Present; SIM Card: Missing; Case: Not Brought; Charger: Not Brought; Other: eSIM"
// Reading splits that into one value per part field; writing puts a changed
// item back in place and leaves every other item (and any free text) as it was.

import type { CompiledRecipe, FieldDef } from "./recipes";
import type { FieldChange, RecordData } from "./rules";

interface Segment {
  /** Lower-cased key, or null for free text that isn't "Key: Value". */
  key: string | null;
  text: string;
}

const isEmpty = (v: string | null | undefined) => v === null || v === undefined || v.trim() === "";

/** Part fields stored in `holder`, in recipe order. */
export function partsOf(recipe: CompiledRecipe, holder: string): FieldDef[] {
  return recipe.fields.filter((f) => f.part?.of === holder);
}

function split(text: string | null | undefined, holder: FieldDef, parts: FieldDef[]): Segment[] {
  if (isEmpty(text) || text!.trim() === holder.placeholder) return [];
  const raw = text!.split(";").map((s) => s.trim()).filter(Boolean);
  const textKeys = new Set(parts.filter((p) => p.type === "text").map((p) => p.part!.key.toLowerCase()));
  const out: Segment[] = [];
  for (const [i, seg] of raw.entries()) {
    const at = seg.indexOf(":");
    const key = at > 0 ? seg.slice(0, at).trim().toLowerCase() : null;
    if (key !== null && textKeys.has(key)) {
      // A free-text item (e.g. "Other: …") keeps any semicolons typed into it.
      out.push({ key, text: raw.slice(i).join("; ") });
      break;
    }
    out.push({ key, text: seg });
  }
  return out;
}

function valueOf(seg: Segment, part: FieldDef): string | null {
  const v = seg.text.slice(seg.text.indexOf(":") + 1).trim();
  if (v === "") return null;
  if (part.type !== "enum") return v;
  const hit = part.values?.find((x) => x.label.toLowerCase() === v.toLowerCase() || x.value === v.toLowerCase());
  // An unknown word is kept as-is so the card shows what's really stored.
  return hit ? hit.value : v;
}

function stored(part: FieldDef, value: string): string {
  const label = part.type === "enum" ? (part.values?.find((x) => x.value === value)?.label ?? value) : value;
  return `${part.part!.key}: ${label}`;
}

/** Fill each part field from its holder's text. */
export function decodeParts(recipe: CompiledRecipe, record: RecordData): RecordData {
  const holders = new Set(recipe.fields.flatMap((f) => (f.part ? [f.part.of] : [])));
  if (holders.size === 0) return record;
  const out = { ...record };
  for (const h of holders) {
    const holder = recipe.fieldMap.get(h)!;
    const parts = partsOf(recipe, h);
    const segs = split(record[h], holder, parts);
    for (const p of parts) {
      const seg = segs.find((s) => s.key === p.part!.key.toLowerCase());
      out[p.name] = seg ? valueOf(seg, p) : null;
    }
  }
  return out;
}

/** The holder's text with the given parts changed (null removes the item). */
export function encodeParts(
  recipe: CompiledRecipe,
  holderName: string,
  current: string | null | undefined,
  set: Record<string, string | null>,
): string {
  const holder = recipe.fieldMap.get(holderName)!;
  const parts = partsOf(recipe, holderName);
  const segs = split(current, holder, parts);
  const order = parts.map((p) => p.part!.key.toLowerCase());

  for (const [name, value] of Object.entries(set)) {
    const part = recipe.fieldMap.get(name)!;
    const key = part.part!.key.toLowerCase();
    const at = segs.findIndex((s) => s.key === key);
    if (isEmpty(value)) {
      if (at >= 0) segs.splice(at, 1);
      continue;
    }
    const seg = { key, text: stored(part, value!) };
    if (at >= 0) {
      segs[at] = seg;
      continue;
    }
    // New item: before the first existing item that comes later in recipe order.
    const rank = order.indexOf(key);
    const before = segs.findIndex((s) => s.key !== null && order.indexOf(s.key) > rank);
    if (before >= 0) segs.splice(before, 0, seg);
    else segs.push(seg);
  }

  const text = segs.map((s) => s.text).join("; ");
  return text === "" ? (holder.placeholder ?? "") : text;
}

/**
 * Turn field changes into what the API takes: part changes fold into their
 * holder field. `record` is the record the changes were planned against.
 */
export function toApiData(
  recipe: CompiledRecipe,
  record: RecordData,
  changes: Pick<FieldChange, "field" | "after">[],
): Record<string, string | null> {
  const data: Record<string, string | null> = {};
  const byHolder = new Map<string, Record<string, string | null>>();
  for (const c of changes) {
    const part = recipe.fieldMap.get(c.field)?.part;
    if (!part) {
      data[c.field] = c.after;
      continue;
    }
    const set = byHolder.get(part.of) ?? {};
    set[c.field] = c.after;
    byHolder.set(part.of, set);
  }
  for (const [holder, set] of byHolder) {
    data[holder] = encodeParts(recipe, holder, data[holder] ?? record[holder], set);
  }
  return data;
}

/** The record after changes, with holders and their parts kept in step. */
export function withChanges(
  recipe: CompiledRecipe,
  record: RecordData,
  changes: Pick<FieldChange, "field" | "after">[],
): RecordData {
  const next: RecordData = { ...record, ...toApiData(recipe, record, changes) };
  for (const c of changes) next[c.field] = c.after;
  return decodeParts(recipe, next);
}
