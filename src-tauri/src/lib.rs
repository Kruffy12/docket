//! Docket shell (Phase 1): tray icon, global hotkey, bar window toggle,
//! autostart and single-instance. No data access lives here yet.

mod portal_api;

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, RunEvent, WebviewWindow, WindowEvent,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const BAR_LABEL: &str = "bar";

fn bar_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space)
}

fn bar_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(BAR_LABEL)
}

/// Centre the bar horizontally in the upper third of the monitor under the cursor.
fn position_bar(app: &AppHandle, bar: &WebviewWindow) {
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| bar.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());

    let (Some(monitor), Ok(size)) = (monitor, bar.outer_size()) else {
        return;
    };
    let area = monitor.work_area();
    let x = area.position.x + (area.size.width as i32 - size.width as i32) / 2;
    let y = area.position.y + area.size.height as i32 / 4;
    let _ = bar.set_position(PhysicalPosition::new(x, y));
}

fn show_bar(app: &AppHandle) {
    if let Some(bar) = bar_window(app) {
        position_bar(app, &bar);
        let _ = bar.show();
        let _ = bar.unminimize();
        let _ = bar.set_focus();
        // The bar refreshes its job cache each time it opens.
        let _ = bar.emit("bar-shown", ());
    }
}

/// When the bar last hid because it lost focus. Clicking the tray icon steals focus first,
/// so without this a tray click on an open bar would hide it and then reopen it.
static BLUR_HIDDEN_AT: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);

fn toggle_bar(app: &AppHandle) {
    let just_blurred = BLUR_HIDDEN_AT
        .lock()
        .map(|t| t.is_some_and(|t| t.elapsed() < std::time::Duration::from_millis(400)))
        .unwrap_or(false);
    if just_blurred {
        return;
    }
    if let Some(bar) = bar_window(app) {
        if bar.is_visible().unwrap_or(false) {
            let _ = bar.hide();
        } else {
            show_bar(app);
        }
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open bar", true, Some("Ctrl+Shift+Space"))?;
    let pause = CheckMenuItem::with_id(app, "pause", "Pause hotkey", true, false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Docket", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &sep, &pause, &sep, &quit])?;

    let pause_item = pause.clone();
    TrayIconBuilder::with_id("docket-tray")
        .icon(app.default_window_icon().cloned().expect("bundle icon missing"))
        .tooltip("Docket")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open" => show_bar(app),
            "pause" => {
                let paused = pause_item.is_checked().unwrap_or(false);
                let gs = app.global_shortcut();
                let result = if paused {
                    gs.unregister(bar_shortcut())
                } else {
                    gs.register(bar_shortcut())
                };
                if let Err(e) = result {
                    eprintln!("[docket] pause toggle failed: {e}");
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_bar(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // Must be registered first: a second launch just surfaces the existing bar.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_bar(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed && shortcut == &bar_shortcut() {
                        toggle_bar(app);
                    }
                })
                .build(),
        )
        .manage(portal_api::Portal::new())
        .invoke_handler(tauri::generate_handler![
            portal_api::portal_login,
            portal_api::portal_logout,
            portal_api::portal_session,
            portal_api::portal_call,
        ])
        .setup(|app| {
            let handle = app.handle();

            build_tray(handle)?;

            // Opened by hand (Start menu, desktop icon): show the bar. Started at login: stay in the tray.
            if !std::env::args().any(|a| a == "--autostart") {
                show_bar(handle);
            }

            if let Err(e) = handle.global_shortcut().register(bar_shortcut()) {
                // Another app may own Ctrl+Shift+Space; keep running from the tray.
                eprintln!("[docket] could not register Ctrl+Shift+Space: {e}");
            }

            // Only the installed/release build registers itself to run at login,
            // so `tauri dev` never writes a target\debug path into the Run key.
            #[cfg(not(debug_assertions))]
            {
                use tauri_plugin_autostart::ManagerExt;
                let autostart = handle.autolaunch();
                if !autostart.is_enabled().unwrap_or(false) {
                    if let Err(e) = autostart.enable() {
                        eprintln!("[docket] could not enable autostart: {e}");
                    }
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != BAR_LABEL {
                return;
            }
            match event {
                // The bar is never destroyed (Alt+F4 included); it only hides.
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.hide();
                }
                // Clicking anywhere else hides it, like Start or PowerToys Run. A save in flight still finishes.
                WindowEvent::Focused(false) => {
                    if window.is_visible().unwrap_or(false) {
                        if let Ok(mut t) = BLUR_HIDDEN_AT.lock() {
                            *t = Some(std::time::Instant::now());
                        }
                    }
                    let _ = window.hide();
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Docket");

    app.run(|_app, event| {
        // Tray app: stay alive with no visible windows. Only an explicit
        // app.exit(..) (which carries an exit code) actually quits.
        if let RunEvent::ExitRequested { api, code, .. } = event {
            if code.is_none() {
                api.prevent_exit();
            }
        }
    });
}
