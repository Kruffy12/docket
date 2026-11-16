// Turns a parsed update/action plus the record's current values into the exact
// list of before → after changes, applying the recipe's rules and effects.
// Pure: the caller supplies the record (fetched fresh right before writing).

import { toIsoDate } from "./dates";
import type { Command } from "./parser";
import { valueLabel, type CompiledRecipe, type Effect } from "./recipes";

export type RecordData = Record<string, string | null | undefined>;

export interface FieldChange {
  field: string;
  label: string;
  before: string | null;
  after: string | null;
  beforeLabel: string;
  afterLabel: string;
  /** "command" for what the user typed, "effect" for a recipe follow-on. */
  source: "command" | "effect";
}

export interface ChangePlan {
  changes: FieldChange[];
  /** Side effects the user should know about (e.g. a push notification). */
  notices: string[];
  /** Set when a rule forbids the change; nothing should be written. */
  blocked?: string;
  /** True when the record already has these values. */
  noop: boolean;
}

export interface PlanContext {
  now: Date;
  /** Signed-in user, for $me. */
  me: string;
}

type Plannable = Extract<Command, { kind: "update" } | { kind: "action" }>;

const isEmpty = (v: string | null | undefined) => v === null || v === undefined || v.trim() === "";

export function planChanges(
  recipe: CompiledRecipe,
  command: Plannable,
  record: RecordData,
  ctx: PlanContext,
): ChangePlan {
  const pending = new Map<string, { after: string | null; source: FieldChange["source"] }>();
  const notices: string[] = [];
  const current = (field: string) => (pending.has(field) ? pending.get(field)!.after : (record[field] ?? null));

  const resolveTo = (to: string): string | null => {
    if (to === "$today") return toIsoDate(ctx.now);
    if (to === "$me") return ctx.me;
    if (to === "$clear") return null;
    return to;
  };

  const applyEffect = (e: Effect) => {
    if (e.when && !e.when.in.includes(record[e.when.field] ?? "")) return;
    if (e.onlyIfEmpty && !isEmpty(current(e.set))) return;
    pending.set(e.set, { after: resolveTo(e.to), source: "effect" });
  };

  if (command.kind === "update") {
    const field = recipe.fieldMap.get(command.field);
    if (!field) return { changes: [], notices, blocked: `Unknown field "${command.field}"`, noop: false };
    const before = record[field.name] ?? null;
    let after: string | null = command.value;
    if (command.op === "append") {
      after = isEmpty(before) ? command.value : `${before!.replace(/\s+$/, "")}\n${command.value}`;
    }
    pending.set(field.name, { after, source: "command" });
    if (before !== after) {
      for (const e of field.effects ?? []) if (e.onValues?.includes(command.value)) applyEffect(e);
      for (const n of field.notices ?? []) if (n.onValues.includes(command.value)) notices.push(n.text);
    }
  } else {
    const action = recipe.actions.find((a) => a.name === command.action);
    if (!action) return { changes: [], notices, blocked: `Unknown action "${command.action}"`, noop: false };
    if (action.requires) {
      const f = recipe.fieldMap.get(action.requires.field)!;
      const have = record[f.name] ?? "";
      if (!action.requires.in.includes(have)) {
        const want = action.requires.in.map((v) => valueLabel(f, v)).join(" or ");
        const now = have ? valueLabel(f, have) : "empty";
        return {
          changes: [],
          notices,
          blocked: `${action.label} only works when ${f.label.toLowerCase()} is ${want} (it's ${now})`,
          noop: false,
        };
      }
    }
    for (const e of action.effects ?? []) applyEffect(e);
  }

  const changes: FieldChange[] = [];
  for (const [name, { after, source }] of pending) {
    const before = record[name] ?? null;
    // "" and null are both "empty": never show a — → — change.
    if (before === after || (isEmpty(before) && isEmpty(after))) continue;
    const f = recipe.fieldMap.get(name)!;
    const label = (v: string | null) => (v === null || v === "" ? "—" : f.type === "enum" ? valueLabel(f, v) : v);
    changes.push({
      field: name,
      label: f.label,
      before,
      after,
      beforeLabel: label(before),
      afterLabel: label(after),
      source,
    });
  }
  // The typed change first, follow-on effects after.
  changes.sort((a, b) => Number(a.source === "effect") - Number(b.source === "effect"));
  return { changes, notices: changes.length ? notices : [], noop: changes.length === 0 };
}
