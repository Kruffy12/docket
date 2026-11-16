import { beforeEach, describe, expect, it } from "vitest";
import { builtinRecipes } from "./builtin";
import { Executor, PortalError, type Transport } from "./executor";
import { parse } from "./parser";
import { servicellAdapter } from "./servicell";

const NOW = new Date(2026, 10, 10, 9, 30);
const job = builtinRecipes[0];

type Raw = Record<string, any>;

/** In-memory stand-in for the Servicell `api` function, mirroring its job actions. */
class FakeApi implements Transport {
  jobs: Raw[];
  calls: { action: string; id: number | null; data?: Record<string, unknown> }[] = [];
  failOn?: (action: string, id: number | null) => PortalError | undefined;
  /** Runs before each `list` reply (simulates someone else editing). */
  beforeList?: (n: number) => void;
  private lists = 0;

  constructor(jobs: Raw[]) {
    this.jobs = jobs.map((j) => ({ ...j }));
  }

  private find(id: number | null) {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) throw new PortalError("API", "Job not found");
    return j;
  }

  async call(action: string, id: number | null = null, data: Record<string, unknown> = {}) {
    const err = this.failOn?.(action, id);
    if (err) throw err;
    if (action !== "list") this.calls.push({ action, id, data });
    switch (action) {
      case "list":
        this.beforeList?.(this.lists++);
        return { jobs: this.jobs.map((j) => ({ ...j })) };
      case "update": {
        const j = this.find(id);
        for (const [k, v] of Object.entries(data)) j[k] = v || null;
        return { success: true };
      }
      case "claimjob": {
        const j = this.find(id);
        j.claimedBy = "eric";
        if (j.status === "received") j.status = "fixing";
        return { success: true };
      }
      case "unclaim":
        this.find(id).claimedBy = null;
        return { success: true };
      case "markcalled":
        this.find(id).calledStatus = "called";
        return { success: true };
      case "lastid":
        return { lastId: Math.max(...this.jobs.map((j) => j.id)) };
      case "delete":
        this.find(id);
        this.jobs = this.jobs.filter((j) => j.id !== id);
        return { success: true };
      case "create":
        this.jobs.push({ id: data.repairId, status: "received", ...data });
        return { success: true };
    }
    throw new Error(`unexpected action ${action}`);
  }

  writes() {
    return this.calls.map((c) => [c.action, c.id, c.data]);
  }
}

const seed = (): Raw[] => [
  {
    id: 1284,
    customerName: "Ana",
    device: "iPhone 13",
    status: "fixing",
    payment: "unpaid",
    priority: "low",
    notes: "Cracked screen",
    claimedBy: "sam",
    dateCompleted: null,
    estimatedCompletion: "2026-11-02T00:00:00+00:00",
    calledStatus: "not_called",
  },
  { id: 1290, customerName: "Ben", device: "Galaxy S22", status: "received", claimedBy: null, notes: "" },
  { id: 1301, customerName: "Cal", device: "Pixel 7", status: "ready", claimedBy: "eric", calledStatus: "not_called" },
  { id: 1833, customerName: "Dee", device: "Moto G", status: "testing", claimedBy: null },
];

let api: FakeApi;
let ex: Executor;

function cmd(input: string) {
  const r = parse(input, builtinRecipes, { now: NOW });
  if (r.status !== "ok") throw new Error(`${input}: ${r.message}`);
  return r.command!;
}

function preview(input: string) {
  const c = cmd(input);
  if (c.kind !== "update" && c.kind !== "action") throw new Error("not plannable");
  return ex.preview(c);
}

beforeEach(async () => {
  api = new FakeApi(seed());
  ex = new Executor(api, job, servicellAdapter, { me: () => "eric", now: () => NOW });
  await ex.refresh();
});

describe("cache", () => {
  it("normalises dates to yyyy-mm-dd and empties to null", () => {
    expect(ex.get(1284)).toMatchObject({ estimatedCompletion: "2026-11-02", dateCompleted: null, status: "fixing" });
    expect(ex.get(1290)!.notes).toBeNull();
    expect(ex.size).toBe(4);
  });

  it("suggests a near ID for a typo", () => {
    expect(ex.suggestIds(1248)).toEqual([1284]);
  });
});

describe("preview", () => {
  it("shows the change and its effects without writing", () => {
    const p = preview("job 1284 resolved");
    expect(p.writable).toBe(true);
    expect(p.items[0].plan.changes.map((c) => [c.field, c.after])).toEqual([
      ["status", "resolved"],
      ["dateCompleted", "2026-11-10"],
    ]);
    expect(api.calls).toEqual([]);
  });

  it("not found among active jobs, with a suggestion", () => {
    const p = preview("job 1248 r");
    expect(p.writable).toBe(false);
    expect(p.problems).toEqual(["No job #1248 among active jobs. Did you mean #1284?"]);
  });

  it("says before Enter which changes can't be undone", () => {
    expect(preview("job 1301 called").items[0].undo).toMatch(/Can't be undone/);
    expect(preview("job 1284 claim").items[0].undo).toMatch(/sam's claim/);
    expect(preview("job 1290 claim").items[0].undo).toBe(true);
  });

  it("a rule violation blocks the write", () => {
    const p = preview("job 1284 called");
    expect(p.writable).toBe(false);
    expect(p.problems[0]).toMatch(/only works when status is Ready/);
  });
});

describe("apply", () => {
  it("writes one update with the effect fields included", async () => {
    const res = await ex.apply(preview("job 1284 resolved"));
    expect(res.status).toBe("done");
    expect(api.writes()).toEqual([["update", 1284, { status: "resolved", dateCompleted: "2026-11-10" }]]);
    expect(ex.get(1284)!.status).toBe("resolved");
  });

  it("passes on the staff push notice", async () => {
    const res = await ex.apply(preview("job 1284 ready"));
    expect(res.status === "done" && res.notices).toEqual(['Staff get the "Device ready for pickup" push']);
  });

  it("stops when the record changed since the preview, writing nothing", async () => {
    const p = preview("job 1284 resolved");
    api.beforeList = () => {
      api.jobs[0].status = "ready";
      api.jobs[0].dateCompleted = "2026-11-09T00:00:00+00:00";
    };
    const res = await ex.apply(p);
    expect(res.status).toBe("stale");
    expect(api.calls).toEqual([]);
    if (res.status === "stale") {
      expect(res.preview.items[0].plan.changes.map((c) => c.beforeLabel)).toEqual(["Ready"]);
    }
  });

  it("recomputes a note append on fresh notes (stale if someone else added a note)", async () => {
    const p = preview('job 1284 note "screen ordered"');
    api.beforeList = () => (api.jobs[0].notes = "Cracked screen\nCustomer called");
    expect((await ex.apply(p)).status).toBe("stale");
    expect(api.calls).toEqual([]);

    // Applying the fresh preview appends under the latest text.
    const again = await ex.apply(preview('job 1284 note "screen ordered"'));
    expect(again.status).toBe("done");
    expect(api.writes()).toEqual([["update", 1284, { notes: "Cracked screen\nCustomer called\nscreen ordered" }]]);
  });

  it("skips records with nothing to change; sends zero calls when all are no-ops", async () => {
    const p = preview("job 1301 ready");
    expect(p.writable).toBe(false);
    await expect(ex.apply(p)).rejects.toThrow(/Nothing to change/);
    expect(api.calls).toEqual([]);

    const bulk = preview("job 1284,1301 ready");
    const res = await ex.apply(bulk);
    expect(res.status).toBe("done");
    expect(api.writes().map((w) => w[1])).toEqual([1284]);
  });

  it("bulk goes one at a time and stops at the first failure", async () => {
    api.failOn = (action, id) => (action === "update" && id === 1290 ? new PortalError("API", "Server said no") : undefined);
    const res = await ex.apply(preview("job 1284,1290,1833 r"));
    expect(res.status).toBe("partial");
    if (res.status === "partial") {
      expect(res.entries.map((e) => e.id)).toEqual([1284]);
      expect(res.failedId).toBe(1290);
      expect(res.notStarted).toEqual([1833]);
      expect(res.error.message).toBe("Server said no");
    }
    expect(ex.history.map((h) => h.id)).toEqual([1284]); // the written one can still be undone
  });

  it("maps actions to the portal's action names", async () => {
    await ex.apply(preview("job 1290 claim"));
    await ex.apply(preview("job 1301 called"));
    expect(api.writes()).toEqual([
      ["claimjob", 1290, {}],
      ["markcalled", 1301, {}],
    ]);
  });

  it("passes SESSION_INVALID through as its own error", async () => {
    api.failOn = (action) => (action === "list" ? new PortalError("SESSION_INVALID", "Sign in again") : undefined);
    await expect(ex.apply(preview("job 1284 r"))).rejects.toMatchObject({ code: "SESSION_INVALID" });
    await expect(ex.refresh()).rejects.toBeInstanceOf(PortalError);
  });

  it("wraps plain { code, message } rejections from the Rust side", async () => {
    const t: Transport = { call: () => Promise.reject({ code: "OFFLINE", message: "Can't reach Servicell" }) };
    const e2 = new Executor(t, job, servicellAdapter, { me: () => "eric" });
    await expect(e2.refresh()).rejects.toMatchObject({ code: "OFFLINE", message: "Can't reach Servicell" });
  });
});

describe("undo", () => {
  it("sends the old values back, clearing with null", async () => {
    await ex.apply(preview("job 1284 resolved"));
    const res = await ex.undo();
    expect(res).toMatchObject({ status: "done", message: "Undone (staff notified)" });
    expect(api.writes().at(-1)).toEqual(["update", 1284, { status: "fixing", dateCompleted: null }]);
    expect(api.jobs[0]).toMatchObject({ status: "fixing", dateCompleted: null });
  });

  it("a priority undo doesn't notify", async () => {
    await ex.apply(preview("job 1284 high"));
    expect(await ex.undo()).toMatchObject({ status: "done", message: "Undone" });
  });

  it("refuses if the record changed since Docket wrote it", async () => {
    await ex.apply(preview("job 1284 resolved"));
    api.jobs[0].status = "ready";
    const res = await ex.undo();
    expect(res).toEqual({ status: "refused", message: "Not undone: #1284 changed since (Status is now Ready)" });
    expect(api.writes()).toHaveLength(1);
  });

  it("undoing a claim of a received job is unclaim, then status back, in order", async () => {
    await ex.apply(preview("job 1290 claim"));
    expect(api.jobs[1]).toMatchObject({ claimedBy: "eric", status: "fixing" });
    const res = await ex.undo();
    expect(res.status).toBe("done");
    expect(api.writes().slice(1)).toEqual([
      ["unclaim", 1290, {}],
      ["update", 1290, { status: "received" }],
    ]);
    expect(api.jobs[1]).toMatchObject({ claimedBy: null, status: "received" });
  });

  it("refuses called and create, with a reason", async () => {
    await ex.apply(preview("job 1301 called"));
    expect(await ex.undo(ex.history.at(-1))).toMatchObject({ status: "refused", message: expect.stringMatching(/Can't be undone/) });

    const c = cmd('new job "iPhone 15" "Eve" screen');
    if (c.kind !== "create") throw new Error();
    const created = await ex.create(c);
    expect(await ex.undo(created)).toMatchObject({ status: "refused", message: expect.stringMatching(/Can't be undone/) });
  });

  it("undoes a change restored from an earlier run", async () => {
    await ex.apply(preview("job 1284 high"));
    const saved = JSON.parse(JSON.stringify(ex.history));
    const next = new Executor(api, job, servicellAdapter, { me: () => "eric", now: () => NOW });
    next.loadHistory(saved);
    expect(next.lastUndoable()?.at).toBeInstanceOf(Date);
    expect(await next.undo()).toMatchObject({ status: "done" });
    expect(api.jobs.find((j) => j.id === 1284)?.priority).toBe("low");
  });

  it("undo never undoes twice", async () => {
    await ex.apply(preview("job 1284 high"));
    const first = ex.lastUndoable()!;
    await ex.undo(first);
    expect(await ex.undo(first)).toEqual({ status: "refused", message: "Already undone" });
    expect(await ex.undo()).toEqual({ status: "refused", message: "Nothing to undo" });
  });
});

describe("delete", () => {
  it("parses one job only", () => {
    expect(cmd("job 1284 delete")).toEqual({ kind: "delete", recipe: "job", id: 1284 });
    expect(parse("job 1284,1290 delete", builtinRecipes, { now: NOW })).toMatchObject({ status: "error", message: "Delete one job at a time" });
    expect(parse("job 1284 delete now", builtinRecipes, { now: NOW }).status).toBe("error");
  });

  it("sends one delete, drops it from the cache, and leaves nothing to undo", async () => {
    expect(await ex.delete(1290)).toBe("Deleted Job #1290");
    expect(api.writes()).toEqual([["delete", 1290, {}]]);
    expect(ex.get(1290)).toBeUndefined();
    expect(ex.lastUndoable()).toBeUndefined();
  });
});

describe("create and find", () => {
  it("creates with the next free ID", async () => {
    const c = cmd('new job "iPhone 15" "Eve" screen');
    if (c.kind !== "create") throw new Error();
    const entry = await ex.create(c);
    expect(entry.id).toBe(1834);
    expect(api.writes()).toEqual([
      ["lastid", null, {}],
      ["create", null, { repairId: 1834, device: "iPhone 15", customerName: "Eve", jobType: "screen" }],
    ]);
    expect(ex.get(1834)).toBeDefined();
  });

  it("finds by text and filter, newest first", () => {
    const c = cmd("find pixel ready");
    if (c.kind !== "find") throw new Error();
    expect(ex.find(c).map((r) => r.id)).toEqual([1301]);
    const all = cmd("find e");
    if (all.kind !== "find") throw new Error();
    expect(ex.find(all).map((r) => r.id)).toEqual([1833, 1301, 1290, 1284]);
  });
});
