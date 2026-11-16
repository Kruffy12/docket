import { describe, expect, it } from "vitest";
import servicell from "../../recipes/servicell.json";
import { loadRecipe, loadRecipes, RecipeError } from "./recipes";

const clone = () => structuredClone(servicell) as Record<string, any>;

function issuesOf(input: unknown): string[] {
  try {
    loadRecipe(input);
  } catch (e) {
    expect(e).toBeInstanceOf(RecipeError);
    return (e as RecipeError).issues;
  }
  throw new Error("expected the recipe to be rejected");
}

describe("servicell recipe", () => {
  const job = loadRecipe(servicell);

  it("loads with the real job values", () => {
    expect(job.fieldMap.get("status")!.values!.map((v) => v.value)).toEqual([
      "received", "fixing", "testing", "ready", "resolved", "unsuccessful", "abandoned",
    ]);
    expect(job.fieldMap.get("payment")!.values!.map((v) => v.value)).toEqual([
      "unpaid", "pending", "partial", "paid-cash", "paid-card", "paid", "settled",
    ]);
    expect(job.fieldMap.get("priority")!.values!.map((v) => v.value)).toEqual(["low", "high"]);
  });

  it("keeps read-only fields out of the lexicon", () => {
    const words = job.lexicon.map((e) => e.word);
    expect(words).not.toContain("technician");
    expect(words).not.toContain("claimedby");
    expect(words).not.toContain("customername");
    expect(words).not.toContain("called_status");
    expect(words).toEqual(expect.arrayContaining(["status", "note", "eta", "claim", "cash", "r"]));
  });

  it("has job, j, jobs and ticket as nouns", () => {
    expect(job.nounWords).toEqual(["job", "j", "jobs", "ticket"]);
  });
});

describe("validation", () => {
  it("rejects a non-object", () => {
    expect(issuesOf(42)).toEqual(["recipe must be an object"]);
  });

  it("rejects a word that means two things", () => {
    const r = clone();
    r.fields[1].values[0].aliases = ["r"]; // "r" already means status → resolved
    expect(issuesOf(r).join()).toMatch(/"r" means both/);
  });

  it("allows an alias equal to its own value", () => {
    const r = clone();
    r.fields[1].values[0].aliases = ["unpaid"];
    expect(() => loadRecipe(r)).not.toThrow();
  });

  it("rejects reserved words and noun clashes", () => {
    const r = clone();
    r.fields[2].aliases = ["find", "ticket"];
    const issues = issuesOf(r).join();
    expect(issues).toMatch(/"find" is a reserved word/);
    expect(issues).toMatch(/"ticket" is both a noun/);
  });

  it("rejects a bad default field", () => {
    const r = clone();
    r.defaultField = "claimedBy";
    expect(issuesOf(r).join()).toMatch(/must be editable/);
    r.defaultField = "nope";
    expect(issuesOf(r).join()).toMatch(/is not a field/);
  });

  it("checks effects, rules and preview references", () => {
    const r = clone();
    r.fields[0].effects[0].set = "closedOn";
    r.actions[2].requires.in = ["done"];
    r.preview.push("colour");
    const issues = issuesOf(r).join("\n");
    expect(issues).toMatch(/unknown field "closedOn"/);
    expect(issues).toMatch(/"done" is not a value of "status"/);
    expect(issues).toMatch(/preview field "colour"/);
  });

  it("rejects words with spaces", () => {
    const r = clone();
    r.fields[0].values[0].aliases = ["just in"];
    expect(issuesOf(r).join()).toMatch(/must be one lowercase word/);
  });

  it("rejects two recipes sharing a noun word", () => {
    const other = clone();
    other.noun = "task";
    other.aliases = ["j"];
    expect(() => loadRecipes([servicell, other])).toThrow(/"j" is a noun word for both/);
  });
});
