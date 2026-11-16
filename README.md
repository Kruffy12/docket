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
