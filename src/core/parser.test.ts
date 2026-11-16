import { describe, expect, it } from "vitest";
import { builtinRecipes } from "./builtin";
import { parse, type Command, type ParseResult } from "./parser";

// Tuesday 10 Nov 2026, 9:30 local.
const NOW = new Date(2026, 10, 10, 9, 30);
const p = (input: string, bulkLimit?: number) => parse(input, builtinRecipes, { now: NOW, bulkLimit });

function ok(input: string): Command {
  const r = p(input);
  expect(r.status, `${input} → ${r.message ?? ""}`).toBe("ok");
  return r.command!;
}

const roles = (r: ParseResult) => r.tokens.map((t) => t.role);

describe("spec command table", () => {
  it("job 1284 resolved", () => {
    expect(ok("job 1284 resolved")).toEqual({
      kind: "update",
      recipe: "job",
      ids: [1284],
      field: "status",
      value: "resolved",
      op: "set",
      confirm: "enter",
    });
  });

  it("j1284 r (aliases, glued noun) means the same", () => {
    expect(ok("j1284 r")).toEqual(ok("job 1284 resolved"));
  });

  it("job 1284 ready", () => {
    expect(ok("job 1284 ready")).toMatchObject({ field: "status", value: "ready" });
  });

  it("job 1284 cash sets payment", () => {
    expect(ok("job 1284 cash")).toMatchObject({ field: "payment", value: "paid-cash" });
  });

  it("job 1284 high sets priority", () => {
    expect(ok("job 1284 high")).toMatchObject({ field: "priority", value: "high" });
  });

  it('job 1284 note "screen ordered" appends', () => {
    expect(ok('job 1284 note "screen ordered"')).toMatchObject({
      field: "notes",
      value: "screen ordered",
      op: "append",
    });
  });

  it("note text works without quotes too", () => {
    expect(ok("job 1284 note screen ordered, ETA mon")).toMatchObject({
      field: "notes",
      value: "screen ordered, ETA mon",
    });
  });

  it("job 1284 eta fri → this Friday", () => {
    const r = p("job 1284 eta fri");
    expect(r.command).toMatchObject({ field: "estimatedCompletion", value: "2026-11-13", op: "set" });
    expect(r.tokens.at(-1)).toMatchObject({ role: "date", display: "Fri 13 Nov" });
  });

  it("claim / unclaim / called are actions", () => {
    for (const action of ["claim", "unclaim", "called"]) {
      expect(ok(`job 1284 ${action}`)).toEqual({
        kind: "action",
        recipe: "job",
        ids: [1284],
        action,
        confirm: "enter",
      });
    }
  });

  it("job 1284 alone is a read-only view", () => {
    expect(ok("job 1284")).toEqual({ kind: "view", recipe: "job", ids: [1284] });
  });

  it("job 1290,1301 resolved is a bulk update needing Shift+Enter", () => {
    expect(ok("job 1290,1301 resolved")).toMatchObject({ ids: [1290, 1301], confirm: "shift-enter" });
  });

  it('new job "iPhone 13" "Customer Name" screen', () => {
    expect(ok('new job "iPhone 13" "Customer Name" screen')).toEqual({
      kind: "create",
      recipe: "job",
      values: { device: "iPhone 13", customerName: "Customer Name", jobType: "screen" },
      confirm: "enter",
    });
  });

  it("find samsung fixing", () => {
    expect(ok("find samsung fixing")).toEqual({
      kind: "find",
      recipe: "job",
      text: ["samsung"],
      filters: [{ field: "status", value: "fixing" }],
    });
  });

  it("undo", () => {
    expect(ok("undo")).toEqual({ kind: "undo" });
  });

  it("@float", () => {
    expect(ok("@float")).toEqual({ kind: "workspace", name: "float" });
  });
});

describe("aliases and explicit fields", () => {
  it.each([
    ["rec", "received"],
    ["fix", "fixing"],
    ["test", "testing"],
    ["rdy", "ready"],
    ["r", "resolved"],
    ["fail", "unsuccessful"],
    ["abn", "abandoned"],
  ])("status alias %s → %s", (alias, value) => {
    expect(ok(`job 1284 ${alias}`)).toMatchObject({ field: "status", value });
  });

  it.each([
    ["unpaid", "unpaid"],
    ["pend", "pending"],
    ["part", "partial"],
    ["cash", "paid-cash"],
    ["card", "paid-card"],
    ["paid", "paid"],
    ["settled", "settled"],
  ])("payment alias %s → %s", (alias, value) => {
    expect(ok(`job 1284 ${alias}`)).toMatchObject({ field: "payment", value });
  });

  it("low / high", () => {
    expect(ok("job 1284 low")).toMatchObject({ field: "priority", value: "low" });
  });

  it("explicit field names and aliases", () => {
    expect(ok("job 1284 status ready")).toMatchObject({ field: "status", value: "ready" });
    expect(ok("job 1284 pay card")).toMatchObject({ field: "payment", value: "paid-card" });
    expect(ok("job 1284 prio high")).toMatchObject({ field: "priority", value: "high" });
    expect(ok("job 1284 due tomorrow")).toMatchObject({ field: "estimatedCompletion", value: "2026-11-11" });
  });

  it("ticket and jobs are noun aliases; matching ignores case", () => {
    expect(ok("ticket 1284 r")).toMatchObject({ ids: [1284], value: "resolved" });
    expect(ok("JOB 1284 Resolved")).toMatchObject({ value: "resolved" });
    expect(ok("jobs 1290,1301 r")).toMatchObject({ ids: [1290, 1301] });
  });

  it("values are canonical; chips show the label and colour", () => {
    const r = p("job 1284 cash");
    expect(r.tokens.at(-1)).toMatchObject({ role: "value", display: "Paid (cash)", field: "payment", color: "green" });
  });
});

describe("records", () => {
  it("accepts #1284", () => {
    expect(ok("job #1284 r")).toMatchObject({ ids: [1284] });
  });

  it("accepts comma lists with spaces and dedupes", () => {
    expect(ok("job 1290, 1301 ,1302,1290 r")).toMatchObject({ ids: [1290, 1301, 1302] });
  });

  it("ids need commas between them", () => {
    // "1290" after "1302" has no comma, so it's read as the change → error.
    const r = p("job 1290,1302 1290");
    expect(r.status).toBe("error");
  });

  it("confirm level follows the bulk limit", () => {
    expect(ok("job 1,2,3,4,5 r")).toMatchObject({ confirm: "shift-enter" });
    expect(ok("job 1,2,3,4,5,6 r")).toMatchObject({ confirm: "typed" });
    expect(p("job 1,2,3,4,5,6 r", 10).command).toMatchObject({ confirm: "shift-enter" });
  });

  it("glued noun gives separate noun and record chips with correct offsets", () => {
    const r = p("j1284 r");
    expect(r.tokens.slice(0, 2)).toEqual([
      { role: "noun", text: "j", start: 0, end: 1, display: "Job" },
      { role: "record", text: "1284", start: 1, end: 5, display: "#1284" },
    ]);
  });

  it("one chip per id with source offsets", () => {
    const r = p("job 1290, 1301 resolved");
    expect(r.tokens.filter((t) => t.role === "record").map((t) => [t.start, t.end, t.display])).toEqual([
      [4, 8, "#1290"],
      [10, 14, "#1301"],
    ]);
    expect(roles(r)).toEqual(["noun", "record", "record", "value"]);
  });
});

describe("fuzzy matching", () => {
  it("resolvd → resolved, flagged as corrected", () => {
    const r = p("job 1284 resolvd");
    expect(r.command).toMatchObject({ value: "resolved" });
    expect(r.tokens.at(-1)).toMatchObject({ display: "Resolved", corrected: true });
  });

  it("transpositions count as one edit", () => {
    expect(ok("tikcet 1284 r")).toMatchObject({ ids: [1284] });
    expect(ok("job 1284 unpiad")).toMatchObject({ value: "unpaid" });
  });

  it("a typo equally close to two meanings is an error, not a guess", () => {
    const r = p("job 1284 uclaim ");
    expect(r.status).toBe("error");
    expect(r.suggestions).toEqual(expect.arrayContaining(["claim", "unclaim"]));
  });

  it("short words must be exact", () => {
    expect(p("jbo 1284 r").status).toBe("error");
    expect(p("job 1284 rdz ").status).toBe("error");
  });

  it("exact matches always beat fuzzy ones", () => {
    // "paid" is exact for payment even though it's one edit from other words.
    expect(ok("job 1284 paid")).toMatchObject({ field: "payment", value: "paid" });
  });

  it("find terms are never fuzzy-matched", () => {
    expect(ok("find pixle resolvd")).toMatchObject({ text: ["pixle", "resolvd"], filters: [] });
  });
});

describe("incomplete input (still typing) is not an error", () => {
  it.each([
    ["", "empty", "command"],
    ["jo", "incomplete", "command"],
    ["job", "incomplete", "record"],
    ["job ", "incomplete", "record"],
    ["job 1290,", "incomplete", "record"],
    ["job #", "incomplete", "record"],
    ["job 1290,#", "incomplete", "record"],
    ["job 1284 status", "incomplete", "value"],
    ["job 1284 status ", "incomplete", "value"],
    ["job 1284 note", "incomplete", "text"],
    ['job 1284 note "screen ord', "incomplete", "text"],
    ["job 1284 res", "incomplete", "change"],
    ["job 1284 eta", "incomplete", "date"],
    ["job 1284 eta fr", "incomplete", "date"],
    ["job 1284 eta nov", "incomplete", "date"],
    ["new", "incomplete", "noun"],
    ["new jo", "incomplete", "noun"],
    ['new job "iPhone 13"', "incomplete", "arg"],
    ["find", "incomplete", "search"],
    ["@", "incomplete", "workspace"],
  ])("%j → %s, next %s", (input, status, next) => {
    const r = p(input);
    expect(r.status).toBe(status);
    expect(r.next.kind).toBe(next);
    expect(r.tokens.some((t) => t.error)).toBe(false);
  });

  it("a prefix becomes an error once the user moves on", () => {
    const r = p("job 1284 res ");
    expect(r.status).toBe("error");
    expect(r.suggestions).toContain("resolved");
  });

  it("create says which argument comes next", () => {
    expect(p('new job "iPhone 13"').next).toEqual({ kind: "arg", recipe: "job", field: "customerName" });
  });

  it("typing a number offers records; a space after it offers changes", () => {
    expect(p("job 128").next.kind).toBe("record");
    expect(p("job 1284 ").next.kind).toBe("change");
  });
});

describe("errors flag the wrong token", () => {
  function err(input: string, badText: string) {
    const r = p(input);
    expect(r.status).toBe("error");
    const bad = r.tokens.find((t) => t.error);
    expect(bad?.text).toBe(badText);
    return r;
  }

  it("unknown noun", () => {
    err("flob 1284 r", "flob");
  });

  it("missing noun suggests one", () => {
    expect(err("1284 resolved", "1284").suggestions).toContain("job");
  });

  it("bad record", () => {
    err("job abc r", "abc");
    err("job 12a4 r", "12a4");
  });

  it("unknown value", () => {
    err("job 1284 banana", "banana");
  });

  it("value that belongs to another field", () => {
    err("job 1284 status cash", "cash");
  });

  it("extra words after a value or action", () => {
    err("job 1284 resolved now", "now");
    err("job 1284 claim now", "now");
    err("undo 3", "3");
    err("@float extra", "extra");
  });

  it("technician can't be set directly", () => {
    expect(err("job 1284 technician sam", "technician").message).toMatch(/claim/);
  });

  it("read-only fields", () => {
    expect(err("job 1284 device Pixel", "device").message).toMatch(/read-only/);
  });

  it("bad date underlines the whole date", () => {
    err("job 1284 eta next blue moon", "next blue moon");
    err("job 1284 eta 3/4", "3/4");
  });

  it("quoted text where a field or value belongs", () => {
    err('job 1284 "resolved"', '"resolved"');
  });

  it("empty note", () => {
    err('job 1284 note ""', '""');
  });

  it("later tokens stay as neutral chips", () => {
    const r = p("job 1284 banana split");
    expect(r.tokens.map((t) => [t.role, !!t.error])).toEqual([
      ["noun", false],
      ["record", false],
      ["unknown", true],
      ["unknown", false],
    ]);
  });
});

describe("create and find details", () => {
  it("the last create argument takes the rest of the line", () => {
    expect(ok('new job "Galaxy S22" "Jane Doe" screen replacement')).toMatchObject({
      values: { device: "Galaxy S22", customerName: "Jane Doe", jobType: "screen replacement" },
    });
  });

  it("find with an explicit noun and quoted text", () => {
    expect(ok('find job "pixel 7" ready')).toEqual({
      kind: "find",
      recipe: "job",
      text: ["pixel 7"],
      filters: [{ field: "status", value: "ready" }],
    });
  });
});
