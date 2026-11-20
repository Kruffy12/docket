# Docket

Keyboard-first command bar that lives in the Windows tray. See `Docket — Product Spec.pdf`.

**Status: Phase 4 (feel), slimmed down.** Docket is just the bar: no History or
Settings window (the Staff Portal covers the rest). Opening Docket.exe shows the bar;
starting at login stays in the tray. Clicking outside the bar hides it.

- Sign in with your portal account; only the session token is kept, in Windows
  Credential Manager. API notes: `docs/servicell-api.md`.
- Tokens turn into chips as you type; a preview card shows before → after.
- Enter saves, the new value is stamped, and the bar closes. Reopen and Ctrl+Z to undo.
- ↑/↓ recall past commands. Undo history survives restarts (per user, this PC only).
- More than 5 jobs, and `job N delete`, need the number typed to confirm. Delete is permanent.
- Inspection checklist: `job 1284 case present`, `job 1284 charger missing`, `job 1284 sim no`, `job 1284 tray missing`, `job 1284 other "eSIM"`, or the whole text with `job 1284 insp "…"`. `job 1284` shows the current checklist. Needs the `inspection` line in the portal function's update (see `docs/servicell-api.md`).
- Inventory, by SKU (`item`, also `part`, `stock`, `inv`): `item SMA12PSPC -1 job 1284 screen swap`, `stock SMA12PSPC +10 "from supplier"`, `item SMA12PSPC set 4` (the count), `price 25`, `min 2`, `cost 40` (managers), `loc "Drawer B"`, `name`, `cat`, `supplier`, `fits`, `note`. `new item SKU "Name"` adds one; `find item battery` searches. Stock changes go through the portal's stock log with the job number, and Ctrl+Z undoes them with the opposite change. Items can't be deleted from Docket.

Left out of the spec on purpose: History and Settings windows, sound, frosted backdrop,
undo toast window, ambiguous-match pick list.

## Test

```bash
npm test
```

## Run

```bash
npm install
npm run tauri dev
```

The bar starts hidden. Press `Ctrl+Shift+Space` or left-click the tray icon. `Esc` hides it.
Right-click the tray for Pause hotkey / Quit.

## Build an installer

```bash
npm run tauri build
```

Installers land in `src-tauri/target/release/bundle/` (`msi/` and `nsis/`).
The installed app registers itself to start at login on first launch.
