import { describe, expect, it } from "vitest";
import { builtinRecipes } from "./builtin";
import { decodeParts, encodeParts } from "./checklist";
import { complete } from "./complete";
import { Executor, PortalError, type Transport } from "./executor";
import { parse } from "./parser";
import { inventoryAdapter, servicellAdapter } from "./servicell";

const NOW = new Date(2026, 10, 10, 9, 30);
const job = builtinRecipes.find((r) => r.noun === "job")!;
const item = builtinRecipes.find((r) => r.noun === "item")!;
const p = (s: string) => parse(s, builtinRecipes, { now: NOW });

type Raw = Record<string, any>;
type Call = { action: string; id: number | null; data: Record<string, any> };

/** Mirrors the api function's job update (inspection included) and its inventory actions. */
class FakeApi implements Transport {
  calls: Call[] = [];
  constructor(
    public jobs: Raw[] = [],
    public items: Raw[] = [],
  ) {}
  private item(sku: unknown) {
    const i = this.items.find((x) => x.sku === sku);
    if (!i) throw new PortalError("API", "Item not found");
    return i;
  }
  async call(action: string, id: number | null = null, data: Record<string, any> = {}) {
    if (!action.startsWith("list")) this.calls.push({ action, id, data });
    switch (action) {
      case "list":
        return { jobs: this.jobs.map((j) => ({ ...j })) };
      case "update": {
        const j = this.jobs.find((x) => x.id === id)!;
        for (const [k, v] of Object.entries(data)) j[k] = v || null;
        return { success: true };
      }
      case "listinventory":
        return { items: this.items.map((i) => ({ ...i })) };
      case "updateitem": {
        const i = this.item(data.sku);
        for (const [k, v] of Object.entries(data)) if (k !== "sku") i[k] = v;
        return { success: true };
      }
      case "adjuststock": {
        const i = this.item(data.sku);
        const before = i.qty;
        i.qty = data.type === "set" ? data.qty : data.type === "remove" ? Math.max(0, i.qty - data.qty) : i.qty + data.qty;
        return { success: true, sku: data.sku, newQty: i.qty, qtyBefore: before };
      }
      case "createitem":
        this.items.push({ sku: data.sku, name: data.name, qty: data.qty ?? 0, minQty: 1 });
        return { success: true, sku: data.sku };
    }
    throw new PortalError("NOT_ALLOWED", action);
  }
}

const INSPECTION = "SIM Tray: Present; SIM Card: Missing; Case: Not Brought; Charger: Not Brought";

function jobs(api: FakeApi, role = "manager") {
  return new Executor(api, job, servicellAdapter, { me: () => "eric", role: () => role, now: () => NOW });
}
function stock(api: FakeApi, role = "manager") {
  return new Executor(api, item, inventoryAdapter, { me: () => "eric", role: () => role, now: () => NOW });
}
const screen = () => ({ sku: "SMA12PSPC", name: "A12 screen", qty: 3, minQty: 1, salePrice: 85, costPrice: 40, location: "Drawer B" });

describe("inspection checklist", () => {
  it("reads each item out of the stored text", () => {
    const r = decodeParts(job, { inspection: `${INSPECTION}; Other: eSIM; keep; this` });
    expect(r).toMatchObject({ simTray: "present", simCard: "missing", case: "not-brought", charger: "not-brought", other: "eSIM; keep; this" });
  });

  it("treats the placeholder and free text as no checklist", () => {
    expect(decodeParts(job, { inspection: "No damage noted" }).case).toBeNull();
    expect(decodeParts(job, { inspection: "Screen Broken" }).simTray).toBeNull();
  });

  it("changes one item in place and keeps the rest exactly", () => {
    expect(encodeParts(job, "inspection", `${INSPECTION}; Other: eSIM`, { case: "present" })).toBe(
      "SIM Tray: Present; SIM Card: Missing; Case: Present; Charger: Not Brought; Other: eSIM",
    );
  });

  it("adds a missing item in portal order, and an empty checklist goes back to the placeholder", () => {
    expect(encodeParts(job, "inspection", "SIM Tray: Present; Charger: Present", { simCard: "missing" })).toBe(
      "SIM Tray: Present; SIM Card: Missing; Charger: Present",
    );
    expect(encodeParts(job, "inspection", "No damage noted", { other: "eSIM" })).toBe("Other: eSIM");
    expect(encodeParts(job, "inspection", "Other: eSIM", { other: null })).toBe("No damage noted");
    expect(encodeParts(job, "inspection", "Screen Broken", { case: "present" })).toBe("Screen Broken; Case: Present");
  });

  it("parses an item after its name, never as a bare value", () => {
    expect(p("job 1284 case present").command).toMatchObject({ kind: "update", field: "case", value: "present" });
    expect(p("job 1284 charger missing").command).toMatchObject({ field: "charger", value: "not-brought" });
    expect(p("job 1284 sim no").command).toMatchObject({ field: "simCard", value: "missing" });
    expect(p("job 1284 present").status).toBe("error");
    // Existing words keep their meaning.
    expect(p("job 1284 card").command).toMatchObject({ field: "payment", value: "paid-card" });
  });

  it("writes only the inspection text, and undo puts it back", async () => {
    const api = new FakeApi([{ id: 7, status: "fixing", inspection: `${INSPECTION}; Other: eSIM` }]);
    const ex = jobs(api);
    await ex.refresh();
    const preview = ex.preview(p("job 7 case present").command as any);
    expect(preview.writable).toBe(true);
    expect(preview.items[0].plan.changes).toEqual([
      expect.objectContaining({ field: "case", beforeLabel: "Not Brought", afterLabel: "Present" }),
    ]);
    const res = await ex.apply(preview);
    expect(res.status).toBe("done");
    expect(api.calls).toEqual([
      { action: "update", id: 7, data: { inspection: "SIM Tray: Present; SIM Card: Missing; Case: Present; Charger: Not Brought; Other: eSIM" } },
    ]);
    expect(ex.get(7)?.case).toBe("present");

    const undo = await ex.undo();
    expect(undo.status).toBe("done");
    expect(api.jobs[0].inspection).toBe(`${INSPECTION}; Other: eSIM`);
  });

  it("can set the whole inspection text", async () => {
    const api = new FakeApi([{ id: 7, status: "fixing", inspection: INSPECTION }]);
    const ex = jobs(api);
    await ex.refresh();
    await ex.apply(ex.preview(p('job 7 insp "Screen Broken"').command as any));
    expect(api.calls[0].data).toEqual({ inspection: "Screen Broken" });
  });
});

describe("inventory commands", () => {
  it("parses stock changes with a job and a reason", () => {
    expect(p("item sma12pspc -1 job 1284 screen swap").command).toMatchObject({
      kind: "update",
      recipe: "item",
      ids: ["sma12pspc"],
      field: "qty",
      op: "add",
      value: "-1",
      link: 1284,
      reason: "screen swap",
    });
    expect(p('stock SMA12PSPC +10 "from supplier"').command).toMatchObject({ value: "10", op: "add", reason: "from supplier" });
    expect(p("part SMA12PSPC -1 j1284").command).toMatchObject({ link: 1284 });
    expect(p("item SMA12PSPC set 4").command).toMatchObject({ field: "qty", op: "set", value: "4" });
    expect(p("item SMA12PSPC price 25.50").command).toMatchObject({ field: "salePrice", value: "25.5", op: "set" });
    expect(p('item "AB 12" loc "Drawer B"').command).toMatchObject({ ids: ["AB 12"], field: "location", value: "Drawer B" });
    expect(p('new item ABC123 "iPhone 13 screen"').command).toMatchObject({
      kind: "create",
      values: { sku: "ABC123", name: "iPhone 13 screen" },
    });
    expect(p("item SMA12PSPC price abc").status).toBe("error");
    expect(p("item SMA12PSPC min 1.5").status).toBe("error");
    expect(p("item SMA12PSPC +0").status).toBe("error");
    expect(p("item SMA12PSPC delete").status).toBe("error");
    // Jobs still read numbers only.
    expect(p("job SMA12PSPC").status).toBe("error");
  });

  it("removes stock through adjuststock, tied to the job, and undo adds it back", async () => {
    const api = new FakeApi([], [screen()]);
    const ex = stock(api);
    await ex.refresh();
    const preview = ex.preview(p("item sma12pspc -1 job 1284 screen swap").command as any);
    expect(preview.items[0].id).toBe("SMA12PSPC");
    expect(preview.items[0].plan.changes[0]).toMatchObject({ field: "qty", before: "3", after: "2" });
    const res = await ex.apply(preview);
    expect(res.status === "done" && res.entries[0].summary).toBe("Stock -1 → 2");
    expect(api.calls).toEqual([
      { action: "adjuststock", id: null, data: { sku: "SMA12PSPC", type: "remove", qty: 1, jobId: "1284", reason: "screen swap" } },
    ]);

    const undo = await ex.undo();
    expect(undo.status).toBe("done");
    expect(api.calls[1]).toMatchObject({ action: "adjuststock", data: { sku: "SMA12PSPC", type: "add", qty: 1 } });
    expect(api.items[0].qty).toBe(3);
  });

  it("sets a count with type set", async () => {
    const api = new FakeApi([], [screen()]);
    const ex = stock(api);
    await ex.refresh();
    await ex.apply(ex.preview(p("item SMA12PSPC qty 7").command as any));
    expect(api.calls[0].data).toMatchObject({ sku: "SMA12PSPC", type: "set", qty: 7 });
    expect(api.items[0].qty).toBe(7);
  });

  it("won't take more than is in stock", async () => {
    const api = new FakeApi([], [screen()]);
    const ex = stock(api);
    await ex.refresh();
    const preview = ex.preview(p("item SMA12PSPC -5").command as any);
    expect(preview.writable).toBe(false);
    expect(preview.problems[0]).toMatch(/Stock is 3/);
  });

  it("edits details through updateitem, keyed by SKU", async () => {
    const api = new FakeApi([], [screen()]);
    const ex = stock(api);
    await ex.refresh();
    await ex.apply(ex.preview(p("item SMA12PSPC price 90").command as any));
    expect(api.calls[0]).toEqual({ action: "updateitem", id: null, data: { sku: "SMA12PSPC", salePrice: "90" } });
    await ex.undo();
    expect(api.calls[1]).toEqual({ action: "updateitem", id: null, data: { sku: "SMA12PSPC", salePrice: "85" } });
  });

  it("only lets managers change cost", async () => {
    const api = new FakeApi([], [screen()]);
    const cashier = stock(api, "cashier");
    await cashier.refresh();
    const preview = cashier.preview(p("item SMA12PSPC cost 30").command as any);
    expect(preview.writable).toBe(false);
    expect(preview.problems).toContain("Only manager accounts can change cost");
  });

  it("names a missing SKU and suggests a near one", async () => {
    const api = new FakeApi([], [screen()]);
    const ex = stock(api);
    await ex.refresh();
    const preview = ex.preview(p("item SMA12PSPX -1").command as any);
    expect(preview.problems[0]).toBe("No item SMA12PSPX among active items. Did you mean SMA12PSPC?");
  });

  it("creates with the typed SKU and refuses one that exists", async () => {
    const api = new FakeApi([], [screen()]);
    const ex = stock(api);
    await ex.refresh();
    const entry = await ex.create(p('new item NEW1 "Charging port"').command as any);
    expect(entry.id).toBe("NEW1");
    expect(api.calls[0]).toEqual({ action: "createitem", id: null, data: { sku: "NEW1", name: "Charging port", qty: 0 } });
    await expect(ex.create(p("new item sma12pspc Dupe").command as any)).rejects.toThrow(/already exists/);
  });

  it("finds items by name or SKU", async () => {
    const api = new FakeApi([], [screen(), { sku: "159", name: "iPhone 11 battery", qty: 2, minQty: 1 }]);
    const ex = stock(api);
    await ex.refresh();
    expect(ex.find(p("find item battery").command as any).map((h) => h.id)).toEqual(["159"]);
  });

  it("completes SKUs with Tab", () => {
    const c = complete("item sma", builtinRecipes, { recordIds: (n) => (n === "item" ? ["SMA12PSPC", "SMS23SCP"] : []) });
    expect(c.items.map((i) => i.text)).toEqual(["SMA12PSPC"]);
  });
});
