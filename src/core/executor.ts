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
import { valueLabel, type CompiledRecipe } from "./recipes";
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

export interface Adapter {
  listAction: string;
  listKey: string;
  createAction: string;
  lastIdAction: string;
  deleteAction: string;
  /** Fields the update action accepts. */
  updatable: string[];
  /** Recipe action name → API action. */
  actions: Record<string, string>;
  createData: (id: number, values: Record<string, string>) => Record<string, unknown>;
  searchFields: string[];
  /** Field holding who claimed the record (for undoing claim/unclaim). */
  claimField: string;
}

type Plannable = Extract<Command, { kind: "update" } | { kind: "action" }>;

export interface RecordPlan {
  id: number;
  record: RecordData;
  plan: ChangePlan;
  /** true, or why this change can't be undone. */
  undo: true | string;
}

export interface Preview {
  command: Plannable;
  items: RecordPlan[];
  missing: { id: number; suggestions: number[] }[];
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
  id: number;
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
  | { status: "partial"; entries: HistoryEntry[]; failedId: number; error: PortalError; notStarted: number[] };

export type UndoResult =
  | { status: "done"; message: string; entry: HistoryEntry }
  | { status: "refused"; message: string };

const isEmpty = (v: string | null | undefined) => v === null || v === undefined || String(v).trim() === "";
const same = (a: string | null | undefined, b: string | null | undefined) =>
  (isEmpty(a) && isEmpty(b)) || a === b;

export interface ExecutorOptions {
  /** Signed-in username, for $me and claim rules. */
  me: () => string;
  now?: () => Date;
}

export class Executor {
  private readonly records = new Map<number, RecordData>();
  private readonly search = new Map<number, string>();
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
    return out;
  }

  /** Fetch the full list (also how the bar refreshes each time it opens). */
  async refresh(): Promise<void> {
    const res = await this.call(this.adapter.listAction);
    const rows = res?.[this.adapter.listKey];
    if (!Array.isArray(rows)) throw new PortalError("BAD_RESPONSE", "Servicell sent no job list");
    this.records.clear();
    this.search.clear();
    for (const raw of rows) {
      const id = Number(raw?.[this.recipe.idColumn]);
      if (!Number.isInteger(id)) continue;
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

  get(id: number): RecordData | undefined {
    return this.records.get(id);
  }

  /** Recent-looking IDs, newest first, for Tab completion. */
  ids(): number[] {
    return [...this.records.keys()].sort((a, b) => b - a);
  }

  /** IDs one typo away (e.g. #1248 → #1284), closest first. */
  suggestIds(id: number, limit = 3): number[] {
    const s = String(id);
    return [...this.records.keys()]
      .map((k) => ({ k, d: editDistance(s, String(k)) }))
      .filter((x) => x.d === 1)
      .sort((a, b) => Math.abs(a.k - id) - Math.abs(b.k - id))
      .slice(0, limit)
      .map((x) => x.k);
  }

  // ---- preview ---------------------------------------------------------------

  private undoability(command: Plannable, record: RecordData): true | string {
    if (command.kind === "update") return true;
    const claimedBy = record[this.adapter.claimField];
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

  private planFor(command: Plannable, records: Map<number, RecordData>, now: Date): Preview {
    const items: RecordPlan[] = [];
    const missing: Preview["missing"] = [];
    const problems: string[] = [];
    const ctx = { now, me: this.opts.me() };

    if (command.kind === "action" && !this.adapter.actions[command.action]) {
      problems.push(`"${command.action}" isn't supported for this workspace`);
    }

    for (const id of command.ids) {
      const record = records.get(id);
      if (!record) {
        missing.push({ id, suggestions: this.suggestIds(id) });
        continue;
      }
      const plan = planChanges(this.recipe, command, record, ctx);
      if (plan.blocked) problems.push(`#${id}: ${plan.blocked}`);
      if (command.kind === "update") {
        const bad = plan.changes.filter((c) => !this.adapter.updatable.includes(c.field));
        for (const c of bad) problems.push(`${c.label} can't be changed through the portal API`);
      }
      items.push({ id, record, plan, undo: this.undoability(command, record) });
    }

    for (const m of missing) {
      const hint = m.suggestions.length ? ` Did you mean ${m.suggestions.map((s) => `#${s}`).join(" or ")}?` : "";
      problems.push(`No ${this.recipe.noun} #${m.id} among active ${this.recipe.plural}.${hint}`);
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
          const data = Object.fromEntries(item.plan.changes.map((c) => [c.field, c.after]));
          await this.call("update", item.id, data);
        } else {
          await this.call(this.adapter.actions[command.action], item.id, {});
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
      const rec = { ...item.record };
      for (const c of item.plan.changes) rec[c.field] = c.after;
      this.records.set(item.id, rec);

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
    if (!current) return { status: "refused", message: `#${entry.id} is no longer among active ${this.recipe.plural}` };
    const drifted = entry.changes.filter((c) => !same(current[c.field], c.after));
    if (drifted.length) {
      const c = drifted[0];
      const f = this.recipe.fieldMap.get(c.field)!;
      const now = current[c.field];
      const label = isEmpty(now) ? "empty" : f.type === "enum" ? valueLabel(f, now!) : now;
      return {
        status: "refused",
        message: `Not undone: #${entry.id} changed since (${c.label} is now ${label})`,
      };
    }

    const statusChange = entry.changes.find((c) => c.field === "status");
    const steps: [string, Record<string, unknown>][] = [];
    if (entry.kind === "update") {
      steps.push(["update", Object.fromEntries(entry.changes.map((c) => [c.field, isEmpty(c.before) ? null : c.before]))]);
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
    for (const [action, data] of steps) await this.call(action, entry.id, data);

    entry.undone = true;
    const reversed = entry.changes.map((c) => ({
      ...c,
      before: c.after,
      after: c.before,
      beforeLabel: c.afterLabel,
      afterLabel: c.beforeLabel,
    }));
    const record = { ...current };
    for (const c of reversed) record[c.field] = c.after;
    this.records.set(entry.id, record);

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
  async delete(id: number): Promise<string> {
    if (!this.recipe.rules.allowDelete) throw new PortalError("NOT_ALLOWED", `Deleting ${this.recipe.plural} isn't allowed`);
    await this.call(this.adapter.deleteAction, id, {});
    this.records.delete(id);
    this.search.delete(id);
    return `Deleted ${this.recipe.label} #${id}`;
  }

  /** Create with the next free ID. Not undoable. */
  async create(command: Extract<Command, { kind: "create" }>): Promise<HistoryEntry> {
    if (!this.recipe.rules.allowCreate) throw new PortalError("NOT_ALLOWED", `Creating ${this.recipe.plural} isn't allowed`);
    const res = await this.call(this.adapter.lastIdAction);
    const lastId = Number(res?.lastId);
    if (!Number.isInteger(lastId)) throw new PortalError("BAD_RESPONSE", "Servicell didn't say which ID is next");
    const id = lastId + 1;
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
      summary: `Created ${this.recipe.label} #${id}`,
      kind: "create",
      changes,
      undo: "Can't be undone from Docket (delete it instead)",
    };
    this.history.push(entry);
    return entry;
  }

  /** Search the cached list: every text term must appear, every filter must match. */
  find(command: Extract<Command, { kind: "find" }>, limit = 20): { id: number; record: RecordData }[] {
    const terms = command.text.map((t) => t.toLowerCase());
    const out: { id: number; record: RecordData }[] = [];
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
