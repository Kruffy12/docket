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
  updatable: ["status", "notes", "dateCompleted", "priority", "payment", "estimatedCompletion"],
  actions: {
    claim: "claimjob",
    unclaim: "unclaim",
    called: "markcalled",
  },
  createData: (id, values) => ({ repairId: id, ...values }),
  searchFields: ["id", "customerName", "customerPhone", "device", "jobType", "issue"],
  claimField: "claimedBy",
};
