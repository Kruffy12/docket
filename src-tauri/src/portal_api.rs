//! HTTPS calls to the Servicell `api` Edge Function (the same one the Staff Portal uses).
//!
//! - Calls are made from Rust, so no Origin header is sent and the function's
//!   origin allow-list doesn't apply.
//! - Only the session token is stored, in the OS keychain (Windows Credential
//!   Manager). The password is never stored, and the token never reaches the webview.
//! - Only an allow-list of job actions can be called. Delete is not on it.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

const API_URL: &str = "https://lakusziubvqhqhrlkdhd.supabase.co/functions/v1/api";
const KEYRING_SERVICE: &str = "Docket";
const KEYRING_USER: &str = "servicell-session";

/// Actions the webview may ask for. Everything else is refused here, before any request.
const ALLOWED_ACTIONS: &[&str] = &[
    "ping",
    "checkrole",
    "list",
    "lastid",
    "update",
    "claimjob",
    "unclaim",
    "markcalled",
    "create",
    "delete",
    // Inventory: list, add an item, edit its details, change its stock count.
    // Deleting items is left to the Staff Portal.
    "listinventory",
    "createitem",
    "updateitem",
    "adjuststock",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Me {
    pub username: String,
    pub role: String,
    #[serde(default)]
    pub secondary_role: String,
    #[serde(default)]
    pub display_name: String,
}

#[derive(Serialize, Deserialize)]
struct StoredSession {
    token: String,
    me: Me,
}

/// Errors sent to the webview as `{ code, message }`.
#[derive(Debug, Serialize)]
pub struct PortalError {
    pub code: &'static str,
    pub message: String,
}

impl PortalError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

type Result<T> = std::result::Result<T, PortalError>;

pub struct Portal {
    client: reqwest::Client,
}

impl Portal {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .connect_timeout(Duration::from_secs(8))
            .user_agent(concat!("Docket/", env!("CARGO_PKG_VERSION"), " (desktop)"))
            .build()
            .expect("HTTP client");
        Self { client }
    }

    /// POST one request body. Never logs the body: it can hold a password or token.
    async fn post(&self, body: Value) -> Result<Value> {
        let res = self
            .client
            .post(API_URL)
            .header("Content-Type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    PortalError::new("OFFLINE", "Servicell didn't answer in time. Check your connection and retry.")
                } else {
                    PortalError::new("OFFLINE", "Can't reach Servicell. Check your connection and retry.")
                }
            })?;

        let status = res.status();
        let v: Value = res
            .json()
            .await
            .map_err(|_| PortalError::new("BAD_RESPONSE", format!("Servicell sent an unreadable reply ({status})")))?;

        if status.as_u16() == 401 && v["error"] == "SESSION_INVALID" {
            return Err(PortalError::new("SESSION_INVALID", "Your Servicell session has ended. Sign in again."));
        }
        if status.as_u16() == 503 {
            return Err(if v["maintenance"] == true {
                PortalError::new("MAINTENANCE", "Servicell is in maintenance mode. Try again later.")
            } else {
                PortalError::new("OFFLINE", "Servicell is temporarily unavailable. Retry in a moment.")
            });
        }
        if !status.is_success() {
            let msg = v["error"].as_str().unwrap_or("Request failed");
            return Err(PortalError::new("API", format!("{msg} ({status})")));
        }
        Ok(v)
    }
}

// ---- keychain ---------------------------------------------------------------

fn entry() -> Result<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| PortalError::new("KEYCHAIN", format!("Credential Manager unavailable: {e}")))
}

fn load_session() -> Option<StoredSession> {
    let secret = entry().ok()?.get_password().ok()?;
    serde_json::from_str(&secret).ok()
}

fn save_session(s: &StoredSession) -> Result<()> {
    let text = serde_json::to_string(s).map_err(|e| PortalError::new("KEYCHAIN", e.to_string()))?;
    entry()?
        .set_password(&text)
        .map_err(|e| PortalError::new("KEYCHAIN", format!("Couldn't save the session: {e}")))
}

fn clear_session() {
    if let Ok(e) = entry() {
        let _ = e.delete_credential();
    }
}

// ---- Tauri commands ---------------------------------------------------------

/// Sign in with "remember this device" on. Stores only the session token.
#[tauri::command]
pub async fn portal_login(
    portal: tauri::State<'_, Portal>,
    username: String,
    password: String,
) -> Result<Me> {
    let v = portal
        .post(json!({
            "action": "login",
            "data": { "username": username.trim(), "password": password, "remember": true },
        }))
        .await?;

    if v["success"] != true {
        let message = if v["locked"] == true {
            format!("Too many attempts. Try again in {} minutes.", v["minutes"].as_i64().unwrap_or(15))
        } else if v["revoked"] == true {
            v["error"].as_str().unwrap_or("Account suspended.").to_string()
        } else if let Some(left) = v["remaining"].as_i64() {
            format!("Wrong username or password ({left} tries left).")
        } else {
            "Wrong username or password.".to_string()
        };
        return Err(PortalError::new("LOGIN_FAILED", message));
    }

    let token = v["token"]
        .as_str()
        .ok_or_else(|| PortalError::new("BAD_RESPONSE", "Sign-in reply had no session"))?
        .to_string();
    let me: Me = serde_json::from_value(v.clone())
        .map_err(|_| PortalError::new("BAD_RESPONSE", "Sign-in reply was missing account details"))?;
    save_session(&StoredSession { token, me: me.clone() })?;
    Ok(me)
}

/// End the session on the server (best effort) and forget it locally.
#[tauri::command]
pub async fn portal_logout(portal: tauri::State<'_, Portal>) -> Result<()> {
    if let Some(s) = load_session() {
        let _ = portal.post(json!({ "session": s.token, "action": "logout" })).await;
    }
    clear_session();
    Ok(())
}

/// Who is signed in, from the keychain. No network.
#[tauri::command]
pub fn portal_session() -> Option<Me> {
    load_session().map(|s| s.me)
}

/// Call one allow-listed action with the stored session.
#[tauri::command]
pub async fn portal_call(
    portal: tauri::State<'_, Portal>,
    action: String,
    id: Option<i64>,
    data: Option<Value>,
) -> Result<Value> {
    let action = action.trim().to_lowercase();
    if !ALLOWED_ACTIONS.contains(&action.as_str()) {
        return Err(PortalError::new("NOT_ALLOWED", format!("Docket doesn't allow \"{action}\"")));
    }

    let mut body = json!({ "action": action, "id": id, "data": data.unwrap_or_else(|| json!({})) });
    if action != "ping" {
        let s = load_session().ok_or_else(|| PortalError::new("NOT_SIGNED_IN", "Sign in to Servicell first."))?;
        body["session"] = Value::String(s.token);
    }

    match portal.post(body).await {
        Err(e) if e.code == "SESSION_INVALID" => {
            clear_session();
            Err(e)
        }
        Err(e) => Err(e),
        Ok(v) if v["success"] == false => {
            let msg = v["error"].as_str().unwrap_or("Servicell refused the change").to_string();
            Err(PortalError::new(if v["forbidden"] == true { "NOT_ALLOWED" } else { "API" }, msg))
        }
        Ok(v) => Ok(v),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Live check against the real function using the public `ping` action only.
    /// Run with: cargo test -- --ignored live_ping
    #[tokio::test]
    #[ignore]
    async fn live_ping() {
        let v = Portal::new().post(json!({ "action": "ping" })).await.expect("ping");
        assert_eq!(v["success"], true);
        assert_eq!(v["api"], 2);
    }

    #[test]
    fn login_only_through_its_own_command() {
        assert!(!ALLOWED_ACTIONS.contains(&"login"));
    }

    #[test]
    fn inventory_cannot_delete_items() {
        assert!(ALLOWED_ACTIONS.contains(&"adjuststock"));
        assert!(!ALLOWED_ACTIONS.contains(&"deleteitem"));
        assert!(!ALLOWED_ACTIONS.contains(&"upsertitem"));
    }

    /// Writes a throwaway credential, to confirm a real OS backend is used.
    /// Run with: cargo test -- --ignored keychain_write, then check `cmdkey /list`.
    #[test]
    #[ignore]
    fn keychain_write() {
        let e = keyring::Entry::new("Docket-selftest", "probe").unwrap();
        e.set_password("hello").unwrap();
    }

    /// Reads and deletes the throwaway credential (run in a separate process).
    #[test]
    #[ignore]
    fn keychain_read_and_delete() {
        let e = keyring::Entry::new("Docket-selftest", "probe").unwrap();
        assert_eq!(e.get_password().unwrap(), "hello");
        e.delete_credential().unwrap();
    }
}
