import type { ReactNode, RefObject } from "react";
import type { Token } from "../core/parser";
import type { CompiledRecipe } from "../core/recipes";
import { recordLabel, valueLabel, type RecordId } from "../core/recipes";
import type { FieldChange, RecordData } from "../core/rules";

/**
 * Chips drawn behind the input's own text (same mono font, same offsets), so typing,
 * selection and the caret stay a plain <input>. Chip padding is a box-shadow so it
 * never shifts the text.
 */
export function ChipLayer({
  input,
  tokens,
  busy,
  layerRef,
}: {
  input: string;
  tokens: Token[];
  busy: boolean;
  layerRef: RefObject<HTMLDivElement | null>;
}) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [i, t] of tokens.entries()) {
    if (t.start < at) continue;
    parts.push(input.slice(at, t.start));
    const cls = ["chip", `chip-${t.role}`, t.error ? "chip-error" : "", t.color ? `tone-${t.color}` : ""].join(" ");
    parts.push(
      <span key={i} className={cls}>
        {input.slice(t.start, t.end)}
      </span>,
    );
    at = t.end;
  }
  parts.push(input.slice(at));
  return (
    <div className={`chip-layer${busy ? " is-busy" : ""}`} ref={layerRef} aria-hidden>
      {parts}
    </div>
  );
}

/** A value as a chip, coloured when it's one of the recipe's enum values. */
export function Value({
  recipe,
  field,
  value,
  label,
  stamp,
}: {
  recipe: CompiledRecipe;
  field: string;
  value: string | null;
  label?: string;
  stamp?: boolean;
}) {
  const f = recipe.fieldMap.get(field);
  const color = f?.type === "enum" ? f.values?.find((v) => v.value === value)?.color : undefined;
  const text = label ?? (value === null || value === "" ? "—" : f?.type === "enum" ? valueLabel(f, value) : value);
  return <span className={`pill${color ? ` tone-${color}` : ""}${stamp ? " stamp" : ""}`}>{text}</span>;
}

/** The record and, when given, the exact before → after of each field. */
export function Card({
  recipe,
  id,
  record,
  changes,
  compact,
  stamp,
  note,
}: {
  recipe: CompiledRecipe;
  id: RecordId;
  record: RecordData;
  changes?: FieldChange[];
  compact?: boolean;
  stamp?: boolean;
  note?: string;
}) {
  const fields = recipe.preview.map((name) => recipe.fieldMap.get(name)!).filter((f) => record[f.name]);
  // Numbers read as "Stock 4" so several of them don't run together.
  const text = fields
    .filter((f) => f.type !== "enum")
    .map((f) => (f.type === "number" ? `${f.label} ${record[f.name]}` : record[f.name]));
  const enums = fields.filter((f) => f.type === "enum");
  return (
    <div className={`card${compact ? " is-compact" : ""}`}>
      <div className="card-head">
        <span className="card-id">
          {recipe.label} {recordLabel(recipe, id)}
        </span>
        <span className="card-sub">{text.join(" · ")}</span>
        {!changes && (
          <span className="card-tags">
            {enums.map((f) => (
              <Value key={f.name} recipe={recipe} field={f.name} value={record[f.name] ?? null} />
            ))}
          </span>
        )}
      </div>
      {changes?.map((c) => (
        <div className="change" key={c.field}>
          <span className="change-label">{c.label}</span>
          <Value recipe={recipe} field={c.field} value={c.before} label={c.beforeLabel} />
          <span className="arrow">→</span>
          <Value recipe={recipe} field={c.field} value={c.after} label={c.afterLabel} stamp={stamp} />
        </div>
      ))}
      {note && <div className="card-note">{note}</div>}
    </div>
  );
}
