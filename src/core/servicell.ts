// How Docket talks to Servicell's `api` Edge Function (read from its source,
// 10 Nov 2026). Everything Servicell-specific lives here; the executor is generic.

import type { Adapter } from "./executor";

export const servicellAdapter: Adapter = {
  listAction: "list",
  listKey: "jobs",
  createAction: "create",
  lastIdAction: "lastid",
  // Hard delete; the server allows only the job's creator, its claimer or a manager, and audits it.
  deleteAction: "delete",
  // Jobs.update only accepts these keys; anything else is silently ignored by
  // the server, so the executor refuses to preview a change to any other field.
  // `inspection` needs the api function's update to accept it (see docs/servicell-api.md).
  updatable: ["status", "notes", "dateCompleted", "priority", "payment", "estimatedCompletion", "inspection"],
  actions: {
    claim: "claimjob",
    unclaim: "unclaim",
    called: "markcalled",
  },
  createData: (id, values) => ({ repairId: id, ...values }),
  searchFields: ["id", "customerName", "customerPhone", "device", "jobType", "issue"],
  claimField: "claimedBy",
};

// Inventory: records keyed by SKU. Counts change only through adjuststock, which
// logs a stock movement (with the job it was used on) and sends low-stock pushes.
export const inventoryAdapter: Adapter = {
  listAction: "listinventory",
  listKey: "items",
  createAction: "createitem",
  updateAction: "updateitem",
  idParam: "sku",
  // Renaming sends the current SKU as `sku` and the new one here. Unverified against the live portal.
  renameKey: "newSku",
  // Cost is manager-only on the server (other roles' edits are ignored); the recipe says so too.
  updatable: ["sku", "name", "category", "minQty", "salePrice", "costPrice", "supplier", "location", "compat", "notes"],
  actions: {},
  createData: (id, values) => ({ sku: id, name: values.name, qty: 0 }),
  searchFields: ["sku", "name", "category", "compat", "location", "supplier"],
  adjust: {
    field: "qty",
    action: "adjuststock",
    data: (a) => ({
      type: a.type,
      qty: a.qty,
      jobId: a.link === undefined ? "" : String(a.link),
      reason: a.reason ?? "",
    }),
  },
};
