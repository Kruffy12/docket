// Preview → write → undo, over a pluggable transport (the Rust portal client in
// the app, a fake in tests).
//
// Safety rules (spec: "certain" and "reversible"):
//   - Every write is previewed first, from the cached list.
//   - Right before writing, the list is fetched again and the plan recomputed
//     from fresh data. If it differs from what was previewed, nothing is written.
//   - Records with nothing to change are skipped (a no-op status write would
//     still push a notification to staff).
//   - Bulk writes go one record at a time and stop at the first failure.
//   - Undo first checks the record still holds what Docket wrote.

import type { Command } from "./parser";
import { recordLabel, valueLabel, type CompiledRecipe, type RecordId } from "./recipes";
import { decodeParts, toApiData, withChanges } from "./checklist";
import { planChanges, type ChangePlan, type FieldChange, type RecordData } from "./rules";
import { editDistance } from "./fuzzy";

export interface Transport {
  call(action: string, id?: number | null, data?: Record<string, unknown>): Promise<any>;
}

/** Error shape the Rust side rejects with: { code, message }. */
export class PortalError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PortalError";
    this.code = code;
  }
  static from(e: unknown): PortalError {
    if (e instanceof PortalError) return e;
    if (e && typeof e === "object" && "code" in e && "message" in e) {
      return new PortalError(String((e as any).code), String((e as any).message));
    }
    return new PortalError("UNKNOWN", e instanceof Error ? e.message : String(e));
  }
}

/** A stock-style change sent through the adapter's `adjust` action. */
export interface Adjustment {
  type: "add" | "remove" | "set";
  qty: number;
  link?: RecordId;
  reason?: string;
}

export interface Adapter {
  listAction: string;
  listKey: string;
  createAction: string;
  /** Asked for the last ID before creating. Without it, the new record's ID is its idColumn value. */
  lastIdAction?: string;
  deleteAction?: string;
  /** Defaults to "update". */
  updateAction?: string;
  /** Send the record ID inside `data` under this key instead of as `id` (e.g. "sku"). */
  idParam?: string;
  /** Fields the update action accepts. */
  updatable: string[];
  /** Recipe action name → API action. */
  actions: Record<string, string>;
  createData: (id: RecordId, values: Record<string, string>) => Record<string, unknown>;
  searchFields: string[];
  /** Field holding who claimed the record (for undoing claim/unclaim). */
  claimField?: string;
  /** A field changed only through its own action (add/remove/set), e.g. stock quantity. */
  adjust?: {
    field: string;
    action: string;
    data: (a: Adjustment) => Record<string, unknown>;
  };
}

type Plannable = Extract<Command, { kind: "update" } | { kind: "action" }>;

export interface RecordPlan {
  id: RecordId;
  record: RecordData;
  plan: ChangePlan;
  /** true, or why this change can't be undone. */
  undo: true | string;
}

export interface Preview {
  command: Plannable;
  items: RecordPlan[];
  missing: { id: RecordId; suggestions: RecordId[] }[];
  /** Plain-language reasons nothing may be written. */
  problems: string[];
  /** Something to write and nothing in the way. */
  writable: boolean;
  /** The time effects like $today were computed for. */
  now: Date;
}

export interface HistoryEntry {
  seq: number;
  at: Date;
  recipe: string;
  id: RecordId;
  /** e.g. "Status → Resolved" or "Claim". */
  summary: string;
  kind: "update" | "action" | "create" | "undo";
  action?: string;
  changes: FieldChange[];
  undo: true | string;
  undone?: boolean;
}

export type ApplyResult =
  | { status: "done"; entries: HistoryEntry[]; notices: string[] }
  | { status: "stale"; preview: Preview; message: string }
  | { status: "partial"; entries: HistoryEntry[]; failedId: RecordId; error: PortalError; notStarted: RecordId[] };

export type UndoResult =
  | { status: "done"; message: string; entry: HistoryEntry }
  | { status: "refused"; message: string };

const isEmpty = (v: string | null | undefined) => v === null || v === undefined || String(v).trim() === "";
const same = (a: string | null | undefined, b: string | null | undefined) =>
  (isEmpty(a) && isEmpty(b)) || a === b;

export interface ExecutorOptions {
  /** Signed-in username, for $me and claim rules. */
  me: () => string;
  /** Signed-in portal role, for fields limited to some roles. */
  role?: () => string;
  now?: () => Date;
}

export class Executor {
  private readonly records = new Map<RecordId, RecordData>();
  private readonly search = new Map<RecordId, string>();
  /** Text IDs typed in any case → the stored ID. */
  private readonly keys = new Map<string, RecordId>();
  private seq = 0;
  readonly history: HistoryEntry[] = [];
  loadedAt: Date | null = null;

  constructor(
    private readonly transport: Transport,
    private readonly recipe: CompiledRecipe,
    private readonly adapter: Adapter,
    private readonly opts: ExecutorOptions,
  ) {}

  private now() {
    return this.opts.now ? this.opts.now() : new Date();
  }

  private async call(action: string, id?: number | null, data?: Record<string, unknown>) {
    try {
      return await this.transport.call(action, id ?? null, data);
    } catch (e) {
      throw PortalError.from(e);
    }
  }

  /** Call an action on one record, passing its ID the way the adapter wants. */
  private callFor(action: string, id: RecordId, data: Record<string, unknown> = {}) {
    if (this.adapter.idParam) return this.call(action, null, { ...data, [this.adapter.idParam]: id });
    return this.call(action, id as number, data);
  }

  /** Write planned field changes: the adjust field through its action, the rest in one update. */
  private async write(
    id: RecordId,
    record: RecordData,
    changes: Pick<FieldChange, "field" | "before" | "after">[],
    adjustment?: Omit<Adjustment, "type" | "qty"> & { op?: "set" | "add" },
  ) {
    const adjust = this.adapter.adjust;
    const counted = adjust ? changes.find((c) => c.field === adjust.field) : undefined;
    const rest = changes.filter((c) => c !== counted);
    if (rest.length) {
      await this.callFor(this.adapter.updateAction ?? "update", id, toApiData(this.recipe, record, rest));
    }
    if (adjust && counted) {
      const before = Number(counted.before ?? 0) || 0;
      const after = Number(counted.after ?? 0) || 0;
      const diff = after - before;
      const a: Adjustment =
        adjustment?.op === "set"
          ? { type: "set", qty: after }
          : { type: diff >= 0 ? "add" : "remove", qty: Math.abs(diff) };
      if (adjustment?.link !== undefined) a.link = adjustment.link;
      if (adjustment?.reason) a.reason = adjustment.reason;
      await this.callFor(adjust.action, id, adjust.data(a));
    }
  }

  /** The stored ID for what was typed, when exactly one record matches. */
  private resolveId(id: RecordId): RecordId {
    if (this.recipe.idType !== "text") return id;
    const m = this.match(id);
    return m.length === 1 ? m[0] : id;
  }

  /**
   * Every record a typed ID or name could mean, best first. Text IDs: the key
   * itself (any case) wins; then a record whose title is exactly that; then
   * records whose title contains every typed word (e.g. "a12 scr" → "A12 screen").
   */
  match(typed: RecordId, records: Map<RecordId, RecordData> = this.records): RecordId[] {
    if (this.recipe.idType !== "text") return records.has(typed) ? [typed] : [];
    const want = String(typed).trim().toLowerCase();
    const key = this.keys.get(want);
    if (key !== undefined && records.has(key)) return [key];
    const tf = this.recipe.titleField;
    if (!tf || want === "") return [];
    const words = want.split(/\s+/);
    const exact: RecordId[] = [];
    const partial: RecordId[] = [];
    for (const [id, r] of records) {
      const name = String(r[tf] ?? "").toLowerCase();
      if (!name) continue;
      if (name.replace(/\s+/g, " ").trim() === words.join(" ")) exact.push(id);
      else if (words.every((w) => name.includes(w))) partial.push(id);
    }
    return exact.length ? exact : partial;
  }

  /** The stored key for exactly what was typed (no name matching), e.g. to check a new SKU is free. */
  keyFor(typed: RecordId): RecordId | undefined {
    if (this.recipe.idType !== "text") return this.records.has(typed) ? typed : undefined;
    return this.keys.get(String(typed).trim().toLowerCase());
  }

  /** "A12 screen (SMA12PSPC)": how a matched record is named in a message. */
  private describe(id: RecordId): string {
    const tf = this.recipe.titleField;
    const name = tf ? this.records.get(id)?.[tf] : undefined;
    return name ? `${name} (${this.label(id)})` : this.label(id);
  }

  private label(id: RecordId) {
    return recordLabel(this.recipe, id);
  }

  // ---- cache ---------------------------------------------------------------

  /** Normalise one API record to the recipe's fields (dates → yyyy-mm-dd, empties → null). */
  normalize(raw: Record<string, unknown>): RecordData {
    const out: RecordData = {};
    for (const f of this.recipe.fields) {
      const v = raw[f.name];
      if (v === null || v === undefined || v === "") out[f.name] = null;
      else if (f.type === "date") out[f.name] = String(v).slice(0, 10);
      else out[f.name] = String(v);
    }
    return decodeParts(this.recipe, out);
  }

  /** Fetch the full list (also how the bar refreshes each time it opens). */
  async refresh(): Promise<void> {
    const res = await this.call(this.adapter.listAction);
    const rows = res?.[this.adapter.listKey];
    if (!Array.isArray(rows)) throw new PortalError("BAD_RESPONSE", `Servicell sent no ${this.recipe.noun} list`);
    this.records.clear();
    this.search.clear();
    this.keys.clear();
    for (const raw of rows) {
      let id: RecordId;
      if (this.recipe.idType === "text") {
        const key = raw?.[this.recipe.idColumn];
        if (key === null || key === undefined || String(key) === "") continue;
        id = String(key);
        this.keys.set(id.toLowerCase(), id);
      } else {
        id = Number(raw?.[this.recipe.idColumn]);
        if (!Number.isInteger(id)) continue;
      }
      this.records.set(id, this.normalize(raw));
      this.search.set(
        id,
        this.adapter.searchFields.map((k) => String(raw[k] ?? "")).join(" ").toLowerCase(),
      );
    }
    this.loadedAt = this.now();
  }

  get size() {
    return this.records.size;
  }

  get(id: RecordId): RecordData | undefined {
    return this.records.get(this.resolveId(id));
  }

  /** The stored ID for a typed ID or name, when exactly one record matches (e.g. "a12 screen" → "SMA12PSPC"). */
  idFor(id: RecordId): RecordId | undefined {
    const r = this.resolveId(id);
    return this.records.has(r) ? r : undefined;
  }

  /** Recent-looking IDs, newest first, for Tab completion. Text IDs keep list order. */
  ids(): RecordId[] {
    const all = [...this.records.keys()];
    return this.recipe.idType === "text" ? all : (all as number[]).sort((a, b) => b - a);
  }

  /** IDs one typo away (e.g. #1248 → #1284), closest first. */
  suggestIds(id: RecordId, limit = 3): RecordId[] {
    const s = String(id).toLowerCase();
    return [...this.records.keys()]
      .map((k) => ({ k, d: editDistance(s, String(k).toLowerCase()) }))
      .filter((x) => x.d === 1)
      .sort((a, b) =>
        typeof a.k === "number" && typeof b.k === "number" && typeof id === "number"
          ? Math.abs(a.k - id) - Math.abs(b.k - id)
          : 0,
      )
      .slice(0, limit)
      .map((x) => x.k);
  }

  // ---- preview ---------------------------------------------------------------

  private undoability(command: Plannable, record: RecordData): true | string {
    if (command.kind === "update") return true;
    const claimedBy = this.adapter.claimField ? record[this.adapter.claimField] : null;
    switch (command.action) {
      case "claim":
        return isEmpty(claimedBy) ? true : `Can't be undone: ${claimedBy}'s claim can't be restored`;
      case "unclaim":
        return isEmpty(claimedBy) || claimedBy === this.opts.me()
          ? true
          : `Can't be undone: ${claimedBy}'s claim can't be restored`;
      default:
        return `Can't be undone: the portal has no way to reverse "${command.action}"`;
    }
  }

  private planFor(command: Plannable, records: Map<RecordId, RecordData>, now: Date): Preview {
    const items: RecordPlan[] = [];
    const missing: Preview["missing"] = [];
    const problems: string[] = [];
    const ctx = { now, me: this.opts.me() };

    if (command.kind === "action" && !this.adapter.actions[command.action]) {
      problems.push(`"${command.action}" isn't supported for this workspace`);
    }

    const seen = new Set<RecordId>();
    for (const typed of command.ids) {
      let id: RecordId = typed;
      if (this.recipe.idType === "text") {
        const m = this.match(typed, records);
        if (m.length > 1) {
          const shown = m.slice(0, 3).map((x) => this.describe(x)).join(", ");
          problems.push(
            `"${typed}" matches ${m.length} ${this.recipe.plural}: ${shown}${m.length > 3 ? ", …" : ""}. Add more of the name, or use the ${this.recipe.fieldMap.get(this.recipe.idColumn)?.label ?? "key"}`,
          );
          continue;
        }
        if (m.length === 1) id = m[0];
      }
      // Two names for the same record (or the same SKU twice) only change it once.
      if (seen.has(id)) continue;
      seen.add(id);
      const record = records.get(id);
      if (!record) {
        missing.push({ id: typed, suggestions: this.suggestIds(typed) });
        continue;
      }
      const plan = planChanges(this.recipe, command, record, ctx);
      if (plan.blocked) problems.push(`${this.label(id)}: ${plan.blocked}`);
      if (command.kind === "update") {
        const writable = (field: string) => {
          if (this.adapter.adjust?.field === field) return true;
          const target = this.recipe.fieldMap.get(field)?.part?.of ?? field;
          return this.adapter.updatable.includes(target);
        };
        const bad = plan.changes.filter((c) => !writable(c.field));
        for (const c of bad) problems.push(`${c.label} can't be changed through the portal API`);
        const role = this.opts.role?.() ?? "";
        for (const c of plan.changes) {
          const roles = this.recipe.fieldMap.get(c.field)?.roles;
          if (roles && !roles.includes(role)) problems.push(`Only ${roles.join(" or ")} accounts can change ${c.label.toLowerCase()}`);
        }
      }
      items.push({ id, record, plan, undo: this.undoability(command, record) });
    }

    for (const m of missing) {
      const hint = m.suggestions.length ? ` Did you mean ${m.suggestions.map((s) => `#${s}`).join(" or ")}?` : "";
      const hint2 = m.suggestions.length ? ` Did you mean ${m.suggestions.map((s) => this.label(s)).join(" or ")}?` : "";
      problems.push(`No ${this.recipe.noun} ${this.label(m.id)} among active ${this.recipe.plural}.${this.recipe.idType === "text" ? hint2 : hint}`);
    }

    const writable = problems.length === 0 && items.some((i) => !i.plan.noop);
    return { command, items, missing, problems: [...new Set(problems)], writable, now };
  }

  /** What would change, from the cached list. Never writes. */
  preview(command: Plannable): Preview {
    return this.planFor(command, this.records, this.now());
  }

  // ---- write -------------------------------------------------------------------

  private static fingerprint(p: Preview): string {
    return JSON.stringify(
      p.items.map((i) => ({ id: i.id, changes: i.plan.changes, blocked: i.plan.blocked, noop: i.plan.noop })),
    ) + JSON.stringify(p.missing.map((m) => m.id)) + JSON.stringify(p.problems);
  }

  private summary(command: Plannable, plan: ChangePlan): string {
    if (command.kind === "action") {
      return this.recipe.actions.find((a) => a.name === command.action)?.label ?? command.action;
    }
    const first = plan.changes[0];
    if (first && command.op === "add") {
      const n = Number(command.value);
      return `${first.label} ${n > 0 ? "+" : ""}${n} → ${first.afterLabel}`;
    }
    return first ? `${first.label} → ${first.afterLabel}` : "No change";
  }

  /**
   * Write a previewed change. Refetches first; if the fresh plan differs from
   * the preview, returns "stale" with the new preview and writes nothing.
   */
  async apply(preview: Preview): Promise<ApplyResult> {
    if (!preview.writable) throw new PortalError("NOT_WRITABLE", preview.problems[0] ?? "Nothing to change");

    await this.refresh();
    const fresh = this.planFor(preview.command, this.records, preview.now);
    if (Executor.fingerprint(fresh) !== Executor.fingerprint(preview)) {
      return {
        status: "stale",
        preview: fresh,
        message: "The record changed since the preview. Check the new preview and apply again.",
      };
    }

    const command = preview.command;
    const todo = fresh.items.filter((i) => !i.plan.noop);
    const entries: HistoryEntry[] = [];
    const notices = new Set<string>();

    for (const [n, item] of todo.entries()) {
      try {
        if (command.kind === "update") {
          await this.write(item.id, item.record, item.plan.changes, {
            op: command.op === "set" ? "set" : "add",
            link: command.link,
            reason: command.reason,
          });
        } else {
          await this.callFor(this.adapter.actions[command.action], item.id, {});
        }
      } catch (e) {
        return {
          status: "partial",
          entries,
          failedId: item.id,
          error: PortalError.from(e),
          notStarted: todo.slice(n + 1).map((i) => i.id),
        };
      }
      // Reflect the write in the cache so the next preview is right.
      this.records.set(item.id, withChanges(this.recipe, item.record, item.plan.changes));

      item.plan.notices.forEach((x) => notices.add(x));
      const entry: HistoryEntry = {
        seq: ++this.seq,
        at: this.now(),
        recipe: this.recipe.noun,
        id: item.id,
        summary: this.summary(command, item.plan),
        kind: command.kind,
        action: command.kind === "action" ? command.action : undefined,
        changes: item.plan.changes,
        undo: item.undo,
      };
      this.history.push(entry);
      entries.push(entry);
    }
    return { status: "done", entries, notices: [...notices] };
  }

  // ---- undo ----------------------------------------------------------------------

  /** Restore history saved by an earlier run (JSON turns dates into strings). */
  loadHistory(entries: HistoryEntry[]) {
    for (const e of entries) this.history.push({ ...e, at: new Date(e.at) });
    this.seq = Math.max(this.seq, ...this.history.map((h) => h.seq));
  }

  /** The most recent change that can still be undone. */
  lastUndoable(): HistoryEntry | undefined {
    return [...this.history].reverse().find((h) => h.undo === true && !h.undone && h.kind !== "undo");
  }

  async undo(entry: HistoryEntry | undefined = this.lastUndoable()): Promise<UndoResult> {
    if (!entry) return { status: "refused", message: "Nothing to undo" };
    if (entry.undone) return { status: "refused", message: "Already undone" };
    if (entry.undo !== true) return { status: "refused", message: entry.undo };

    await this.refresh();
    const current = this.records.get(entry.id);
    if (!current) return { status: "refused", message: `${this.label(entry.id)} is no longer among active ${this.recipe.plural}` };
    const drifted = entry.changes.filter((c) => !same(current[c.field], c.after));
    if (drifted.length) {
      const c = drifted[0];
      const f = this.recipe.fieldMap.get(c.field)!;
      const now = current[c.field];
      const label = isEmpty(now) ? "empty" : f.type === "enum" ? valueLabel(f, now!) : now;
      return {
        status: "refused",
        message: `Not undone: ${this.label(entry.id)} changed since (${c.label} is now ${label})`,
      };
    }

    const statusChange = entry.changes.find((c) => c.field === "status");
    const steps: [string, Record<string, unknown>][] = [];
    if (entry.kind === "update") {
      // Same path as the change itself: parts rebuild their holder from the current
      // text, and a counted field goes back through its adjust action.
      const back = entry.changes.map((c) => ({ field: c.field, before: c.after, after: isEmpty(c.before) ? null : c.before }));
      await this.write(entry.id, current, back, { reason: `Undo: ${entry.summary}` });
    } else if (entry.action === "claim") {
      steps.push([this.adapter.actions.unclaim, {}]);
      if (statusChange) steps.push(["update", { status: statusChange.before }]);
    } else if (entry.action === "unclaim") {
      steps.push([this.adapter.actions.claim, {}]);
      // Re-claiming a received job moves it to fixing; put the status back.
      if (current.status === "received") steps.push(["update", { status: "received" }]);
    } else {
      return { status: "refused", message: "This change can't be undone" };
    }

    // In order, one at a time: the server runs batched calls concurrently.
    for (const [action, data] of steps) await this.callFor(action, entry.id, data);

    entry.undone = true;
    const reversed = entry.changes.map((c) => ({
      ...c,
      before: c.after,
      after: c.before,
      beforeLabel: c.afterLabel,
      afterLabel: c.beforeLabel,
    }));
    this.records.set(entry.id, withChanges(this.recipe, current, reversed));

    const undoEntry: HistoryEntry = {
      seq: ++this.seq,
      at: this.now(),
      recipe: entry.recipe,
      id: entry.id,
      summary: `Undo: ${entry.summary}`,
      kind: "undo",
      changes: reversed,
      undo: "Undo entries can't be undone; make the change again instead",
    };
    this.history.push(undoEntry);
    const notified = !!statusChange || steps.some(([, d]) => "status" in d);
    return { status: "done", message: notified ? "Undone (staff notified)" : "Undone", entry: undoEntry };
  }

  // ---- create and find ---------------------------------------------------------

  /** Permanent: the portal hard-deletes, so there is no history entry and no undo. */
  async delete(typed: RecordId): Promise<string> {
    if (!this.recipe.rules.allowDelete || !this.adapter.deleteAction) {
      throw new PortalError("NOT_ALLOWED", `Deleting ${this.recipe.plural} isn't allowed`);
    }
    const id = this.resolveId(typed);
    await this.callFor(this.adapter.deleteAction, id, {});
    this.records.delete(id);
    this.search.delete(id);
    return `Deleted ${this.recipe.label} ${this.label(id)}`;
  }

  /** Create with the next free ID. Not undoable. */
  async create(command: Extract<Command, { kind: "create" }>): Promise<HistoryEntry> {
    if (!this.recipe.rules.allowCreate) throw new PortalError("NOT_ALLOWED", `Creating ${this.recipe.plural} isn't allowed`);
    let id: RecordId;
    if (this.adapter.lastIdAction) {
      const res = await this.call(this.adapter.lastIdAction);
      const lastId = Number(res?.lastId);
      if (!Number.isInteger(lastId)) throw new PortalError("BAD_RESPONSE", "Servicell didn't say which ID is next");
      id = lastId + 1;
    } else {
      id = String(command.values[this.recipe.idColumn] ?? "").trim();
      if (!id) throw new PortalError("NOT_ALLOWED", `A new ${this.recipe.noun} needs its ${this.recipe.idColumn}`);
      const taken = this.keyFor(id);
      if (taken !== undefined) throw new PortalError("NOT_ALLOWED", `${this.recipe.label} ${this.label(taken)} already exists`);
    }
    await this.call(this.adapter.createAction, null, this.adapter.createData(id, command.values));
    await this.refresh().catch(() => undefined);
    const changes: FieldChange[] = Object.entries(command.values).map(([field, value]) => ({
      field,
      label: this.recipe.fieldMap.get(field)?.label ?? field,
      before: null,
      after: value,
      beforeLabel: "—",
      afterLabel: value,
      source: "command",
    }));
    const entry: HistoryEntry = {
      seq: ++this.seq,
      at: this.now(),
      recipe: this.recipe.noun,
      id,
      summary: `Created ${this.recipe.label} ${this.label(id)}`,
      kind: "create",
      changes,
      undo: "Can't be undone from Docket (delete it instead)",
    };
    this.history.push(entry);
    return entry;
  }

  /** Search the cached list: every text term must appear, every filter must match. */
  find(command: Extract<Command, { kind: "find" }>, limit = 20): { id: RecordId; record: RecordData }[] {
    const terms = command.text.map((t) => t.toLowerCase());
    const out: { id: RecordId; record: RecordData }[] = [];
    for (const id of this.ids()) {
      const record = this.records.get(id)!;
      if (!command.filters.every((f) => record[f.field] === f.value)) continue;
      const hay = this.search.get(id) ?? "";
      if (!terms.every((t) => hay.includes(t))) continue;
      out.push({ id, record });
      if (out.length >= limit) break;
    }
    return out;
  }
}
