// Recipes that ship with Docket. User-edited recipes (Settings → Recipes) come later.
import servicell from "../../recipes/servicell.json";
import { loadRecipes } from "./recipes";

export const builtinRecipes = loadRecipes([servicell]);
