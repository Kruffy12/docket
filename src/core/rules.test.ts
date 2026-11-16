import { describe, expect, it } from "vitest";
import { builtinRecipes } from "./builtin";
import { parse } from "./parser";
import { planChanges, type RecordData } from "./rules";

const job = builtinRecipes[0];
const NOW = new Date(2026, 10, 10, 9, 30);
const ctx = { now: NOW, me: "eric" };

function plan(input: string, record: RecordData) {
  const r = parse(input, builtinRecipes, { now: NOW });
  if (r.command?.kind !== "update" && r.command?.kind !== "action") throw new Error(`not plannable: ${input}`);
  return planChanges(job, r.command, record, ctx);
}

const base: RecordData = {
  status: "fixing",
  payment: "unpaid",
  priority: "low",
  notes: "",
  claimedBy: "sam",
  dateCompleted: null,
  calledStatus: "not_called",
};

describe("status effects and notices", () => {
  it("resolved sets the completion date when empty", () => {
    const pl = plan("job 1284 resolved", base);
    expect(pl.changes).toEqual([
      expect.objectContaining({ field: "status", beforeLabel: "Fixing", afterLabel: "Resolved", source: "command" }),
      expect.objectContaining({ field: "dateCompleted", before: null, after: "2026-11-10", source: "effect" }),
    ]);
  });

  it("resolved leaves an existing completion date alone", () => {
    const pl = plan("job 1284 r", { ...base, dateCompleted: "2026-11-01" });
    expect(pl.changes.map((c) => c.field)).toEqual(["status"]);
  });

  it("ready sets the date and warns that staff get the pickup push", () => {
    const pl = plan("job 1284 ready", base);
    expect(pl.changes.map((c) => c.field)).toEqual(["status", "dateCompleted"]);
    expect(pl.notices).toEqual(['Staff get the "Device ready for pickup" push']);
  });

  it("every status change notifies staff", () => {
    expect(plan("job 1284 test", base).notices).toEqual(['Staff get a "Job status updated" push']);
    expect(plan("job 1284 abn", base).notices[0]).toMatch(/Abandoned/);
  });

  it("payment and priority changes send no push", () => {
    expect(plan("job 1284 cash", base).notices).toEqual([]);
    expect(plan("job 1284 high", base).notices).toEqual([]);
  });

  it("no change when the record already has the value", () => {
    const pl = plan("job 1284 ready", { ...base, status: "ready" });
    expect(pl).toEqual({ changes: [], notices: [], noop: true });
  });

  it("testing has no effects", () => {
    expect(plan("job 1284 test", base).changes.map((c) => c.field)).toEqual(["status"]);
  });
});

describe("notes append to existing text", () => {
  it("adds a new line under existing notes", () => {
    const pl = plan('job 1284 note "screen ordered"', { ...base, notes: "Cracked screen\n" });
    expect(pl.changes[0]).toMatchObject({ before: "Cracked screen\n", after: "Cracked screen\nscreen ordered" });
  });

  it("starts the notes when empty", () => {
    expect(plan("job 1284 note screen ordered", { ...base, notes: null }).changes[0].after).toBe("screen ordered");
  });
});

describe("actions", () => {
  it("claiming a received job takes it and moves it to fixing", () => {
    const pl = plan("job 1284 claim", { ...base, status: "received", claimedBy: null });
    expect(pl.changes).toEqual([
      expect.objectContaining({ field: "claimedBy", before: null, after: "eric" }),
      expect.objectContaining({ field: "status", before: "received", after: "fixing" }),
    ]);
  });

  it("claiming works from any status; only received moves to fixing", () => {
    const pl = plan("job 1284 claim", { ...base, status: "testing" });
    expect(pl.blocked).toBeUndefined();
    expect(pl.changes).toEqual([expect.objectContaining({ field: "claimedBy", before: "sam", after: "eric" })]);
  });

  it("claiming a job you already hold changes nothing", () => {
    expect(plan("job 1284 claim", { ...base, claimedBy: "eric" }).noop).toBe(true);
  });

  it("unclaim clears the claim", () => {
    expect(plan("job 1284 unclaim", base).changes).toEqual([
      expect.objectContaining({ field: "claimedBy", before: "sam", after: null, afterLabel: "—" }),
    ]);
  });

  it("treats empty string and null as the same (no — → — change)", () => {
    expect(plan("job 1284 unclaim", { ...base, claimedBy: "" })).toEqual({ changes: [], notices: [], noop: true });
  });

  it("called is only allowed on ready jobs", () => {
    const blocked = plan("job 1284 called", base);
    expect(blocked.blocked).toBe("Mark customer called only works when status is Ready (it's Fixing)");
    expect(blocked.changes).toEqual([]);

    const okPlan = plan("job 1284 called", { ...base, status: "ready" });
    expect(okPlan.blocked).toBeUndefined();
    expect(okPlan.changes).toEqual([
      expect.objectContaining({ field: "calledStatus", beforeLabel: "Not called", afterLabel: "Called" }),
    ]);
  });
});
