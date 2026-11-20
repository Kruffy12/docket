import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { Card, ChipLayer } from "./bar/parts";
import { builtinRecipes } from "./core/builtin";
import { complete } from "./core/complete";
import { Executor, PortalError, type Adapter, type HistoryEntry, type Preview } from "./core/executor";
import { parse, type ParseResult } from "./core/parser";
import { recordLabel, valueLabel, type CompiledRecipe, type RecordId } from "./core/recipes";
import type { RecordData } from "./core/rules";
import { inventoryAdapter, servicellAdapter } from "./core/servicell";
import { portal, portalTransport, type Me } from "./portal";
import "./App.css";

// What shows under the input, in priority order:
//   1. a typed confirm (delete, or more than 5 jobs)
//   2. the stamp after a save (the bar then closes)
//   3. a result (undone, stale, error…), kept until the user types again
//   4. the live preview, derived from what's typed + the job cache (never stored)

// Jobs first (the default noun); each recipe gets its own cache and undo history.
const ADAPTERS: Record<string, Adapter> = { job: servicellAdapter, item: inventoryAdapter };
const RECIPES = builtinRecipes.filter((r) => ADAPTERS[r.noun]);
const recipeOf = (noun: string): CompiledRecipe => RECIPES.find((r) => r.noun === noun) ?? RECIPES[0];
const BAR_WIDTH = 640;
const MAX_CARDS = 5;
// An older change is undone through the `undo` preview, not straight from Ctrl+Z.
const QUICK_UNDO_MS = 60_000;

// shortcut: localStorage lives in the WebView profile on this PC only; move to a file if history must survive a reinstall.
const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(key);
      return v ? (JSON.parse(v) as T) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable: history just won't persist */
    }
  },
};

function describeRecord(recipe: CompiledRecipe, id: RecordId, r: RecordData): string {
  return [
    recordLabel(recipe, id),
    ...recipe.preview.map((name) => {
      const f = recipe.fieldMap.get(name)!;
      const v = r[name];
      if (v === null || v === undefined) return null;
      return f.type === "enum" ? valueLabel(f, v) : v;
    }),
  ]
    .filter(Boolean)
    .join(" · ");
}

function ago(at: Date): string {
  const s = (Date.now() - at.getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function Lines({ lines, error }: { lines: string[]; error?: boolean }) {
  if (!lines.length) return null;
  return <div className={`lines${error ? " is-error" : ""}`}>{lines.join("\n")}</div>;
}

function PreviewView({ p }: { p: Preview }) {
  const recipe = recipeOf(p.command.recipe);
  const notices = [...new Set(p.items.flatMap((i) => (i.plan.noop ? [] : i.plan.notices)))];
  return (
    <>
      {p.items.slice(0, MAX_CARDS).map((item) => (
        <Card
          key={item.id}
          recipe={recipe}
          id={item.id}
          record={item.record}
          compact={p.items.length > 1}
          changes={item.plan.noop ? undefined : item.plan.changes}
          note={item.plan.noop ? "Already like that, skipped" : item.undo !== true ? item.undo : undefined}
        />
      ))}
      {p.items.length > MAX_CARDS && <Lines lines={[`+${p.items.length - MAX_CARDS} more`]} />}
      <Lines lines={p.problems} error />
      <Lines lines={notices} />
    </>
  );
}

interface Live {
  lines?: string[];
  error?: boolean;
  preview?: Preview;
  cards?: { recipe: CompiledRecipe; id: RecordId; record: RecordData }[];
  /** The input with a mistyped record number replaced by the likely one (Tab). */
  fix?: string;
  /** How to apply, e.g. "↵ apply". */
  hint?: string;
}

type Confirm = { kind: "delete"; recipe: string; id: RecordId } | { kind: "bulk"; preview: Preview; count: number };

interface Result {
  lines: string[];
  error?: boolean;
  preview?: Preview;
}

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [input, setInput] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [stamp, setStamp] = useState<{ entries: HistoryEntry[]; notices: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  // Bumped whenever the job cache or history changes, so derived views recompute.
  const [cacheVersion, setCacheVersion] = useState(0);
  const [recent, setRecent] = useState<string[]>(() => store.get("docket.recent", []));
  const [recentIdx, setRecentIdx] = useState(-1);
  const [loginUser, setLoginUser] = useState("");
  const [loginPass, setLoginPass] = useState("");

  const inputRef = useRef<HTMLInputElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const userRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const lastHeight = useRef(0);
  const meRef = useRef<Me | null | undefined>(undefined);
  meRef.current = me;
  const confirmRef = useRef<Confirm | null>(null);
  confirmRef.current = confirm;

  const executors = useMemo(
    () =>
      new Map(
        RECIPES.map((r) => [
          r.noun,
          new Executor(portalTransport, r, ADAPTERS[r.noun], {
            me: () => meRef.current?.username ?? "",
            role: () => meRef.current?.role ?? "",
          }),
        ]),
      ),
    [],
  );
  const exec = (noun: string) => executors.get(noun) ?? executors.get(RECIPES[0].noun)!;
  // Jobs keep the original history key, so history from before inventory still loads.
  const historyKeyFor = (noun: string, user: string) =>
    noun === RECIPES[0].noun ? `docket.history.${user}` : `docket.history.${user}.${noun}`;
  /** The newest change across every recipe that can still be undone. */
  const lastUndoable = (): HistoryEntry | undefined =>
    [...executors.values()]
      .map((e) => e.lastUndoable())
      .filter((e): e is HistoryEntry => !!e)
      .sort((a, b) => b.at.getTime() - a.at.getTime())[0];

  const parsed: ParseResult = useMemo(() => parse(input, builtinRecipes), [input]);

  const focusInput = () => (meRef.current ? inputRef : userRef).current?.focus();
  const saveHistory = () => {
    const user = meRef.current?.username;
    if (!user) return;
    for (const [noun, e] of executors) store.set(historyKeyFor(noun, user), e.history.slice(-200));
  };

  const show = (r: Result | null) => {
    setStamp(null);
    setResult(r);
  };

  const handleError = useCallback((e: unknown) => {
    const err = PortalError.from(e);
    if (err.code === "SESSION_INVALID" || err.code === "NOT_SIGNED_IN") setMe(null);
    const retry = err.code === "OFFLINE" || err.code === "MAINTENANCE" || err.code === "BAD_RESPONSE";
    setStamp(null);
    setResult({ lines: [retry ? `${err.message} · ↵ retry` : err.message], error: true });
  }, []);

  const refresh = useCallback(async () => {
    if (!meRef.current) return;
    const results = await Promise.allSettled([...executors.values()].map((e) => e.refresh()));
    setCacheVersion((v) => v + 1);
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) handleError(failed.reason);
  }, [executors, handleError]);

  // Session on start; reset and refresh the job list every time the bar opens.
  useEffect(() => {
    portal.session().then((s) => setMe(s ?? null)).catch(() => setMe(null));
    const unlisten = listen("bar-shown", () => {
      setResult(null);
      setStamp(null);
      setConfirm(null);
      void refresh();
      focusInput();
    });
    return () => void unlisten.then((f) => f());
  }, [refresh]);

  // Per user: their saved undo history, then a fresh job list.
  useEffect(() => {
    for (const [noun, e] of executors) {
      e.history.length = 0;
      if (me) e.loadHistory(store.get(historyKeyFor(noun, me.username), []));
    }
    if (me) void refresh();
    setCacheVersion((v) => v + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, executors, refresh]);

  const fixFor = (recipe: CompiledRecipe, id: RecordId, to: RecordId | undefined) => {
    const t = parsed.tokens.find((t) => t.role === "record" && t.display === recordLabel(recipe, id));
    return t && to !== undefined ? input.slice(0, t.start) + String(to) + input.slice(t.end) : undefined;
  };

  // Live preview: derived from the typed command and the cache. Never writes.
  const live: Live = useMemo(() => {
    const c = parsed.command;
    if (parsed.status === "empty") return {};
    if (parsed.status !== "ok" || !c) return { lines: [parsed.message ?? ""], error: parsed.status === "error" };
    const recipe = recipeOf("recipe" in c ? c.recipe : RECIPES[0].noun);
    const executor = exec(recipe.noun);
    if (!executor.loadedAt && c.kind !== "undo" && c.kind !== "workspace") return { lines: [`Loading ${recipe.plural}…`] };
    const label = (id: RecordId) => recordLabel(recipe, id);
    switch (c.kind) {
      case "view": {
        // A name can match several items: show them (up to the card limit) so one can be picked.
        const matched = c.ids.map((id) => ({ id, keys: executor.match(id) }));
        const shown = new Set<RecordId>();
        const cards = matched.flatMap(({ keys }) =>
          keys.flatMap((key) => {
            const record = executor.get(key);
            if (!record || shown.has(key)) return [];
            shown.add(key);
            return [{ recipe, id: key, record }];
          }),
        ).slice(0, MAX_CARDS);
        const lost = matched.filter((m) => m.keys.length === 0).map((m) => m.id);
        const many = matched.filter((m) => m.keys.length > 1);
        // Text that holds checklist parts (e.g. the inspection) isn't on the card; show it for one record.
        const holders = [...new Set(recipe.fields.flatMap((f) => (f.part ? [f.part.of] : [])))];
        const held =
          cards.length === 1 ? holders.flatMap((h) => (cards[0].record[h] ? [`${recipe.fieldMap.get(h)!.label}: ${cards[0].record[h]}`] : [])) : [];
        const lines = held.concat(
          many.map((m) => `"${m.id}" matches ${m.keys.length} ${recipe.plural}. Add more of the name, or use the ${recipe.fieldMap.get(recipe.idColumn)?.label ?? "key"}`),
          lost.map((id) => {
            const s = executor.suggestIds(id)[0];
            return `No ${recipe.noun} ${label(id)} among active ${recipe.plural}.${s !== undefined ? ` Did you mean ${label(s)}? Tab` : ""}`;
          }),
        );
        return {
          cards,
          lines,
          error: lost.length > 0,
          fix: lost.length ? fixFor(recipe, lost[0], executor.suggestIds(lost[0])[0]) : undefined,
        };
      }
      case "update":
      case "action": {
        const p = executor.preview(c);
        const n = p.items.filter((i) => !i.plan.noop).length;
        const hint =
          c.confirm === "typed"
            ? `↵ then type ${n} to confirm`
            : c.confirm === "shift-enter"
              ? `Shift+↵ apply to ${n} ${recipe.plural}`
              : "↵ apply";
        const m = p.missing[0];
        const lines: string[] = [];
        if (c.kind === "update" && c.link !== undefined) {
          // The record a stock change names (e.g. the job a part went into), shown so a typo is caught.
          const linkNoun = recipe.fieldMap.get(c.field)?.link;
          const linked = linkNoun ? recipeOf(linkNoun) : undefined;
          const rec = linked ? exec(linked.noun).get(c.link) : undefined;
          if (linked) {
            lines.push(
              rec
                ? `For ${describeRecord(linked, c.link, rec)}`
                : `For ${linked.label} ${recordLabel(linked, c.link)} (not among active ${linked.plural})`,
            );
          }
        }
        if (c.kind === "update" && c.reason) lines.push(`Reason: ${c.reason}`);
        return {
          preview: p,
          lines,
          hint: p.writable ? hint : undefined,
          fix: m && fixFor(recipe, m.id, m.suggestions[0]),
        };
      }
      case "create": {
        const v = Object.entries(c.values)
          .map(([k, val]) => `${recipe.fieldMap.get(k)?.label}: ${val}`)
          .join(" · ");
        if (recipe.idType === "text" && executor.keyFor(c.values[recipe.idColumn] ?? "") !== undefined) {
          return { lines: [`${recipe.label} ${c.values[recipe.idColumn]} already exists`], error: true };
        }
        const what = recipe.idType === "text" ? `New ${recipe.noun}` : `New ${recipe.noun} (next free ID)`;
        return { lines: [`${what} · ${v}`, "Can't be undone from Docket"], hint: "↵ create" };
      }
      case "find": {
        const hits = executor.find(c, 6);
        return {
          lines: hits.length ? hits.map((h) => describeRecord(recipe, h.id, h.record)) : [`No matching active ${recipe.plural}`],
        };
      }
      case "undo": {
        const last = lastUndoable();
        return last
          ? {
              lines: [`Undo ${recordLabel(recipeOf(last.recipe), last.id)}: ${last.summary} (${ago(last.at)})`],
              hint: "↵ undo",
            }
          : { lines: ["Nothing to undo"] };
      }
      case "workspace":
        return { lines: ["Only the Servicell workspace exists for now"] };
      case "delete": {
        const record = executor.get(c.id);
        if (!record) return { lines: [`No ${recipe.noun} ${label(c.id)} among active ${recipe.plural}`], error: true };
        return {
          cards: [{ recipe, id: c.id, record }],
          lines: [`Deletes this ${recipe.noun} for good. Can't be undone.`],
          error: true,
          hint: `↵ then type the ${recipe.noun} number to confirm`,
        };
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed, executors, cacheVersion]);

  // Grow or shrink the window to fit the content; keep chips under the scrolled text.
  useLayoutEffect(() => {
    if (layerRef.current && inputRef.current) layerRef.current.scrollLeft = inputRef.current.scrollLeft;
    const h = rootRef.current?.offsetHeight;
    if (!h || h === lastHeight.current) return;
    lastHeight.current = h;
    void getCurrentWindow().setSize(new LogicalSize(BAR_WIDTH, Math.min(Math.max(h, 64), 520)));
  });

  /** Run a network step with the bar marked busy; saves history and keeps the keyboard alive afterwards. */
  const guarded = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
      saveHistory();
      setCacheVersion((v) => v + 1);
      requestAnimationFrame(focusInput);
    }
  };

  const remember = (cmd: string) => {
    const next = [cmd, ...recent.filter((r) => r !== cmd)].slice(0, 50);
    setRecent(next);
    store.set("docket.recent", next);
  };

  const undoLast = () =>
    guarded(async () => {
      const last = lastUndoable();
      const res = last ? await exec(last.recipe).undo(last) : await exec(RECIPES[0].noun).undo();
      show({ lines: [res.message], error: res.status === "refused" });
    });

  const applyPreview = (p: Preview) =>
    guarded(async () => {
      const recipe = recipeOf(p.command.recipe);
      const res = await exec(recipe.noun).apply(p);
      if (res.status === "stale") {
        show({ lines: [res.message], error: true, preview: res.preview });
      } else if (res.status === "partial") {
        const l = (id: RecordId) => recordLabel(recipe, id);
        const ok = res.entries.map((e) => l(e.id)).join(", ") || "none";
        const rest = res.notStarted.map(l).join(", ") || "none";
        show({ lines: [`Stopped at ${l(res.failedId)}: ${res.error.message}`, `Saved: ${ok}. Not started: ${rest}`], error: true });
      } else {
        setInput("");
        setResult(null);
        setStamp({ entries: res.entries, notices: res.notices });
        // The stamp lands, then the bar gets out of the way. Ctrl+Z on reopening undoes it.
        setTimeout(() => void getCurrentWindow().hide(), 600);
      }
    });

  const run = (shift: boolean) => {
    if (confirm) {
      const want = confirm.kind === "delete" ? confirm.id : confirm.count;
      const pending = confirm;
      setConfirm(null);
      setInput("");
      if (input.trim() !== String(want)) {
        show({ lines: [`Didn't match ${want}: nothing ${pending.kind === "delete" ? "deleted" : "changed"}`] });
        return;
      }
      if (pending.kind === "delete") {
        return guarded(async () => show({ lines: [await exec(pending.recipe).delete(pending.id)] }));
      }
      return applyPreview(pending.preview);
    }

    const c = parsed.command;
    if (parsed.status !== "ok" || !c) return;
    const recipe = recipeOf("recipe" in c ? c.recipe : RECIPES[0].noun);
    const executor = exec(recipe.noun);

    if (c.kind === "update" || c.kind === "action") {
      const p = live.preview;
      if (!p || !p.writable) return;
      if (c.confirm === "shift-enter" && !shift) {
        show({ lines: [`${c.ids.length} ${recipe.plural} at once: press Shift+↵`], preview: p });
        return;
      }
      remember(input.trim());
      if (c.confirm === "typed") {
        setInput("");
        setConfirm({ kind: "bulk", preview: p, count: p.items.filter((i) => !i.plan.noop).length });
        return;
      }
      return applyPreview(p);
    }
    if (c.kind === "create") {
      if (live.error) return;
      remember(input.trim());
      return guarded(async () => {
        const entry = await executor.create(c);
        setInput("");
        show({ lines: [entry.summary] });
      });
    }
    if (c.kind === "delete") {
      // Refresh first so the confirm step shows current data and a job that's already gone is caught.
      return guarded(async () => {
        await executor.refresh();
        const id = executor.idFor(c.id);
        if (id === undefined) {
          show({ lines: [`No ${recipe.noun} ${recordLabel(recipe, c.id)} among active ${recipe.plural}: nothing deleted`], error: true });
          return;
        }
        setInput("");
        setConfirm({ kind: "delete", recipe: recipe.noun, id });
      });
    }
    if (c.kind === "undo") {
      setInput("");
      return undoLast();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (busy && e.key !== "Escape") {
      e.preventDefault();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      void run(e.shiftKey);
    } else if (e.key === "Tab") {
      e.preventDefault();
      if (live.fix && !confirm) {
        setInput(live.fix);
        return;
      }
      const c = complete(input, builtinRecipes, {
        recordIds: (noun) => {
          const ids = exec(noun).ids();
          return recipeOf(noun).idType === "text" ? ids : ids.slice(0, 50);
        },
        recordNames: (noun) => {
          const tf = recipeOf(noun).titleField;
          const e = exec(noun);
          return tf ? e.ids().flatMap((id) => (e.get(id)?.[tf] ? [String(e.get(id)![tf])] : [])) : [];
        },
      });
      const first = c.items[0];
      if (first) {
        setResult(null);
        setInput(input.slice(0, c.from) + first.text + " ");
      }
    } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !confirm) {
      e.preventDefault();
      const idx = e.key === "ArrowUp" ? Math.min(recentIdx + 1, recent.length - 1) : recentIdx - 1;
      setRecentIdx(Math.max(idx, -1));
      setResult(null);
      setInput(idx >= 0 ? recent[idx] : "");
    } else if (e.key === "z" && e.ctrlKey && input === "" && !confirm) {
      e.preventDefault();
      const last = lastUndoable();
      if (last && Date.now() - last.at.getTime() > QUICK_UNDO_MS) setInput("undo");
      else void undoLast();
    } else if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      void portal.logout().catch(() => undefined).then(() => {
        setMe(null);
        show({ lines: ["Signed out"] });
        requestAnimationFrame(focusInput);
      });
    }
  };

  // Esc cancels a confirm, otherwise hides the bar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (confirmRef.current) {
        setConfirm(null);
        setInput("");
        setResult({ lines: ["Cancelled: nothing changed"] });
        return;
      }
      void getCurrentWindow().hide();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const signIn = (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !loginUser || !loginPass) return;
    const password = loginPass;
    setLoginPass("");
    void guarded(async () => {
      const who = await portal.login(loginUser, password);
      setMe(who);
      show({ lines: [`Signed in as ${who.displayName || who.username}`] });
    });
  };

  if (me === undefined) return <main className="bar" ref={rootRef} />;

  if (me === null) {
    return (
      <main className="bar" ref={rootRef}>
        <form className="bar-input signin" onSubmit={signIn}>
          <span className="prompt">Servicell</span>
          <input
            ref={userRef}
            autoFocus
            placeholder="username"
            value={loginUser}
            readOnly={busy}
            onChange={(e) => {
              setResult(null);
              setLoginUser(e.target.value);
            }}
            autoComplete="username"
            aria-label="Username"
          />
          <input
            type="password"
            placeholder="password"
            value={loginPass}
            readOnly={busy}
            onChange={(e) => setLoginPass(e.target.value)}
            autoComplete="current-password"
            aria-label="Password"
          />
          <button type="submit" disabled={busy || !loginUser || !loginPass}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        {result && (
          <div className="bar-body">
            <Lines lines={result.lines} error={result.error} />
          </div>
        )}
        <footer className="bar-hints">
          <span>Remembers this device · only the session is stored, in Credential Manager</span>
        </footer>
      </main>
    );
  }

  let body: React.ReactNode;
  let hint: string | undefined;
  if (confirm?.kind === "delete") {
    const recipe = recipeOf(confirm.recipe);
    const record = exec(recipe.noun).get(confirm.id);
    body = (
      <>
        {record && <Card recipe={recipe} id={confirm.id} record={record} />}
        <Lines lines={[`Type ${confirm.id} and press ↵ to delete it for good. Can't be undone. Esc cancels.`]} error />
      </>
    );
  } else if (confirm?.kind === "bulk") {
    body = (
      <>
        <PreviewView p={confirm.preview} />
        <Lines
          lines={[`Type ${confirm.count} and press ↵ to change ${confirm.count} ${recipeOf(confirm.preview.command.recipe).plural}. Esc cancels.`]}
          error
        />
      </>
    );
  } else if (stamp) {
    body = (
      <>
        {stamp.entries.slice(0, MAX_CARDS).map((e) => (
          <Card
            key={`${e.recipe}-${e.seq}`}
            recipe={recipeOf(e.recipe)}
            id={e.id}
            record={exec(e.recipe).get(e.id) ?? {}}
            changes={e.changes}
            compact={stamp.entries.length > 1}
            stamp
          />
        ))}
        <Lines lines={stamp.notices} />
      </>
    );
  } else if (result) {
    body = (
      <>
        <Lines lines={result.lines} error={result.error} />
        {result.preview && <PreviewView p={result.preview} />}
      </>
    );
  } else if (parsed.status === "empty") {
    const last = lastUndoable();
    const lines = [
      ...(last ? [`Ctrl+Z undoes ${recordLabel(recipeOf(last.recipe), last.id)} ${last.summary} · ${ago(last.at)}`] : []),
      ...recent.slice(0, 3).map((r) => `↑ ${r}`),
    ];
    body = lines.length ? <Lines lines={lines} /> : null;
  } else {
    hint = live.hint;
    body = (
      <>
        {live.cards?.map((c) => (
          <Card key={c.id} recipe={c.recipe} id={c.id} record={c.record} compact={(live.cards?.length ?? 0) > 1} />
        ))}
        {live.preview && <PreviewView p={live.preview} />}
        {live.lines && <Lines lines={live.lines} error={live.error} />}
      </>
    );
  }

  return (
    <main className="bar" ref={rootRef}>
      <div className="bar-input">
        <span className="prompt">›</span>
        <div className="input-wrap">
          <ChipLayer input={input} tokens={confirm ? [] : parsed.tokens} busy={busy} layerRef={layerRef} />
          <input
            ref={inputRef}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            placeholder={
              confirm?.kind === "delete"
                ? `type ${confirm.id} to delete`
                : confirm?.kind === "bulk"
                  ? `type ${confirm.count} to confirm`
                  : "job 1284 resolved"
            }
            aria-label="Command"
            value={input}
            readOnly={busy}
            onScroll={(e) => {
              if (layerRef.current) layerRef.current.scrollLeft = e.currentTarget.scrollLeft;
            }}
            onChange={(e) => {
              setResult(null);
              setStamp(null);
              setRecentIdx(-1);
              setInput(e.target.value);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <span className="workspace">{busy ? "Saving…" : `Servicell · ${me.username}`}</span>
      </div>
      {body && <div className="bar-body">{body}</div>}
      <footer className="bar-hints">
        {hint ? <span className="hint-main">{hint}</span> : <span>↵ apply</span>}
        <span>Tab complete</span>
        <span>↑ recent</span>
        <span>Ctrl+Z undo</span>
        <span>Esc close</span>
      </footer>
    </main>
  );
}
