import { describe, expect, it } from "vitest";
import { builtinRecipes } from "./builtin";
import { complete } from "./complete";
import { editDistance, maxEdits } from "./fuzzy";
import { tokenize } from "./tokenize";

const NOW = new Date(2026, 10, 10, 9, 30);
const c = (input: string, recentIds?: number[]) => complete(input, builtinRecipes, { now: NOW, recentIds });
const texts = (input: string, recentIds?: number[]) => c(input, recentIds).items.map((i) => i.text);

describe("Tab completion", () => {
  it("offers commands and nouns on an empty line", () => {
    expect(texts("")).toEqual(expect.arrayContaining(["job", "new", "find", "undo"]));
  });

  it("completes the noun being typed", () => {
    expect(c("jo")).toMatchObject({ from: 0, to: 2, items: [{ text: "job" }, { text: "jobs" }] });
  });

  it("completes recent record ids", () => {
    expect(texts("job 12", [1833, 1284, 1290, 1001])).toEqual(["1284", "1290"]);
    expect(texts("job ", [1833, 1284])).toEqual(["1833", "1284"]);
  });

  it("completes values, canonical names first", () => {
    expect(texts("job 1284 re")).toEqual(["ready", "received", "resolved", "rec"]);
    const r = c("job 1284 re");
    expect(r.from).toBe(9);
  });

  it("after a field, offers only that field's values", () => {
    expect(texts("job 1284 pay ")).toEqual(
      expect.arrayContaining(["unpaid", "pending", "partial", "paid-cash", "paid-card", "paid", "settled"]),
    );
    expect(texts("job 1284 pay ")).not.toContain("resolved");
  });

  it("offers fields and actions after a record", () => {
    expect(texts("job 1284 cl")).toEqual(["claim"]);
    expect(texts("job 1284 n")).toEqual(["notes", "note"]);
  });

  it("completes date words", () => {
    expect(texts("job 1284 eta f")).toEqual(["friday", "february"]);
  });

  it("nothing after an error", () => {
    expect(texts("job abc ")).toEqual([]);
  });
});

describe("building blocks", () => {
  it("edit distance counts transpositions as one", () => {
    expect(editDistance("resolvd", "resolved")).toBe(1);
    expect(editDistance("tikcet", "ticket")).toBe(1);
    expect(editDistance("", "abc")).toBe(3);
  });

  it("typo budget grows with length", () => {
    expect([3, 4, 5, 6, 9].map(maxEdits)).toEqual([0, 1, 1, 2, 2]);
  });

  it("tokenize keeps quotes together and records offsets", () => {
    expect(tokenize('job  1284 note "a b"')).toEqual([
      { text: "job", raw: "job", start: 0, end: 3, quoted: false, unterminated: false },
      { text: "1284", raw: "1284", start: 5, end: 9, quoted: false, unterminated: false },
      { text: "note", raw: "note", start: 10, end: 14, quoted: false, unterminated: false },
      { text: "a b", raw: '"a b"', start: 15, end: 20, quoted: true, unterminated: false },
    ]);
    expect(tokenize('"open')[0]).toMatchObject({ text: "open", unterminated: true });
  });
});
