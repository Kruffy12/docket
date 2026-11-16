# Servicell portal API: what Docket relies on

Read from the deployed `api` Edge Function source (version 7) on 10 Nov 2026.
If the function changes, re-check this list and `src/core/servicell.ts`.

**Endpoint:** `POST https://lakusziubvqhqhrlkdhd.supabase.co/functions/v1/api`

**Body:** `{ session, action, id, data }`. The function also accepts
`{ session, calls: [...] }`, but runs those calls concurrently. Docket never uses
that form for steps that must happen in order.

**Origin:** browser origins outside `SC_ALLOWED_ORIGINS` get a 403. Docket calls
from Rust, which sends no Origin header.

## Errors

| Reply | Meaning |
|---|---|
| HTTP 401 `{ error: "SESSION_INVALID" }` | Session ended; Docket clears the stored token and asks to sign in |
| HTTP 503 `{ maintenance: true }` | Maintenance mode |
| `{ success: false, error, forbidden? }` | Refused (role, rule, not found) |

## Actions Docket may call (allow-listed in `src-tauri/src/portal_api.rs`)

| Action | Notes |
|---|---|
| `login` | `data: { username, password, remember }` → `{ success, token, username, role, secondaryRole, displayName }`. Failures: `locked` + `minutes`, `remaining`, or `revoked` |
| `ping` | Public. `{ success, api: 2, maintenance }` |
| `list` | All non-archived jobs (camelCase fields). No single-job fetch exists |
| `lastid` | `{ lastId }`; next job ID is `lastId + 1` |
| `update` | Only `status, notes, dateCompleted, priority, payment, estimatedCompletion`. Empty → null. Does **not** set `dateCompleted` itself. Any `status` in the update pushes to **staff** ("Device ready for pickup", "Abandoned device", or "Job status updated"), even if unchanged |
| `claimjob` | Sets `claimedBy` to you (not `technician`); `received` → `fixing`. Non-managers can't take a job someone else claimed |
| `unclaim` | Clears `claimedBy`. Non-managers can only release their own |
| `markcalled` | Ready jobs only. Sets `calledStatus: "called"`. No way to reverse |
| `create` | `data: { repairId, customerName, device, jobType, … }`. Status starts `received` |
| `delete` | **Hard delete**, no archive and no way back. Only the job's creator, its claimer or a manager; logged as `JOB_DELETE` in the audit log. Docket sends it for one job at a time, after the job number is typed to confirm |

Not allowed from Docket: everything else.

## Field formats

- Dates (`dateCompleted`, `estimatedCompletion`) are `timestamptz` stored as midnight UTC. Docket sends `YYYY-MM-DD` and reads the first 10 characters.
- `calledStatus`: `not_called` or `called`.
- `technician` is set when the job is created; claims change `claimedBy`.
