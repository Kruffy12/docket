// Recipes that ship with Docket. User-edited recipes (Settings → Recipes) come later.
import servicell from "../../recipes/servicell.json";
import inventory from "../../recipes/inventory.json";
import { loadRecipes } from "./recipes";

// Jobs stay first: they're the default for `find` and for the bar's examples.
export const builtinRecipes = loadRecipes([servicell, inventory]);
