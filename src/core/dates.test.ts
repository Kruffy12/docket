import { describe, expect, it } from "vitest";
import { parseDate, toIsoDate } from "./dates";

const TUE = new Date(2026, 10, 10, 9, 30); // Tue 10 Nov 2026
const FRI = new Date(2026, 10, 13, 18, 0); // Fri 13 Nov 2026
const iso = (s: string, now = TUE) => parseDate(s, now)?.iso ?? null;

describe("parseDate", () => {
  it("today and tomorrow", () => {
    expect(iso("today")).toBe("2026-11-10");
    expect(iso("tomorrow")).toBe("2026-11-11");
    expect(iso("TMR")).toBe("2026-11-11");
  });

  it("weekdays mean the next such day", () => {
    expect(iso("fri")).toBe("2026-11-13");
    expect(iso("friday")).toBe("2026-11-13");
    expect(iso("mon")).toBe("2026-11-16");
    expect(iso("thurs")).toBe("2026-11-12");
  });

  it("a weekday that is today means today", () => {
    expect(iso("tue")).toBe("2026-11-10");
    expect(iso("fri", FRI)).toBe("2026-11-13");
  });

  it("relative days and weeks", () => {
    expect(iso("+3")).toBe("2026-11-13");
    expect(iso("3d")).toBe("2026-11-13");
    expect(iso("+2w")).toBe("2026-11-24");
    expect(iso("+30")).toBe("2026-12-10");
  });

  it("ISO dates, validated", () => {
    expect(iso("2026-12-01")).toBe("2026-12-01");
    expect(iso("2026-02-30")).toBeNull();
  });

  it("month and day, rolling to next year once past", () => {
    expect(iso("nov 14")).toBe("2026-11-14");
    expect(iso("14 nov")).toBe("2026-11-14");
    expect(iso("november 10")).toBe("2026-11-10");
    expect(iso("nov 9")).toBe("2027-11-09");
    expect(iso("jan 5")).toBe("2027-01-05");
    expect(iso("feb 30")).toBeNull();
  });

  it("rejects ambiguous and unknown forms", () => {
    expect(iso("3/4")).toBeNull();
    expect(iso("3")).toBeNull();
    expect(iso("someday")).toBeNull();
    expect(iso("next fri")).toBeNull();
  });

  it("labels", () => {
    expect(parseDate("fri", TUE)?.label).toBe("Fri 13 Nov");
  });
});

describe("toIsoDate uses the local calendar date, not UTC", () => {
  it("runs in a timezone where UTC and local dates differ (guards this suite)", () => {
    const d = new Date(2026, 10, 10, 0, 30);
    expect(d.toISOString().slice(0, 10)).toBe("2026-11-09");
  });

  it("late evening and early morning stay on the local day", () => {
    // Tests run in Pacific/Auckland (UTC+13), where the UTC date differs.
    expect(toIsoDate(new Date(2026, 10, 10, 0, 30))).toBe("2026-11-10");
    expect(toIsoDate(new Date(2026, 10, 10, 23, 59))).toBe("2026-11-10");
    expect(iso("today", new Date(2026, 10, 10, 8, 0))).toBe("2026-11-10");
  });
});
