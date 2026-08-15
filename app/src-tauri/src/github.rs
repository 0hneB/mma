//! GitHub sign-in (OAuth device flow) and issue access on behalf of the signed-in user.
//!
//! The frontend cannot run this itself: `github.com/login/device/code` and
//! `/login/oauth/access_token` send no CORS headers, so the token exchange has to happen
//! outside the webview. Once obtained, the token stays here -- it is never handed to JS.
//!
//! Device flow rather than a redirect: a desktop app has no callback URL, and the user
//! authorizes in their own browser instead of typing credentials into our window.
//!
//! This is a GitHub *App*, not an OAuth App, so a user-to-server token is bounded by the
//! app's installation on [`REPO`]. Signing in grants us nothing on the user's own repos.

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::storage;
use crate::types::AppResult;
use crate::util::blocking;

pub(crate) const CLIENT_ID: &str = "Iv23liRIs8ykMt8IFai2";

const REPO: &str = "ccmdi/mma";
const API: &str = "https://api.github.com";
const SECRET_NAME: &str = "github";

const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const TOKEN_URL: &str = "https://github.com/login/oauth/access_token";

/// GitHub rejects API calls without one.
fn user_agent() -> String {
    format!("mma/{}", env!("CARGO_PKG_VERSION"))
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

/// The user-to-server token, cached from the credential store.
static SESSION: storage::SessionCell = storage::SessionCell::new(SECRET_NAME);

fn session() -> AppResult<Option<String>> {
    SESSION.get()
}

fn set_session(token: Option<String>) -> AppResult<()> {
    SESSION.set(token)
}

fn require_session() -> AppResult<String> {
    session()?.ok_or_else(|| "not signed in to GitHub".into())
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// What the user needs in order to authorize: the code to type and where to type it.
#[derive(serde::Serialize, specta::Type, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCodeInfo {
    pub user_code: String,
    pub verification_uri: String,
    /// Seconds until `user_code` stops working.
    pub expires_in: u32,
}

#[derive(serde::Serialize, serde::Deserialize, specta::Type, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GhUser {
    pub login: String,
    pub avatar_url: Option<String>,
}

#[derive(serde::Serialize, specta::Type, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IssueRef {
    pub number: u32,
    pub url: String,
}

#[derive(serde::Serialize, serde::Deserialize, specta::Type, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IssueComment {
    pub author: String,
    pub body: String,
    /// ISO-8601, as GitHub returns it.
    pub created_at: String,
}

#[derive(serde::Serialize, serde::Deserialize, specta::Type, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum IssueState {
    Open,
    Closed,
}

/// What became of a report, and what has been said on it. One shape for both transports so a
/// signed-in and an anonymous report render identically.
#[derive(serde::Serialize, serde::Deserialize, specta::Type, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IssueThread {
    pub state: IssueState,
    /// `completed`, `not_planned` or `reopened`. Absent on an open issue, and on issues closed
    /// before GitHub recorded a reason.
    pub state_reason: Option<String>,
    pub comments: Vec<IssueComment>,
}

/// The device code is a bearer credential for the pending authorization, so it stays here
/// rather than round-tripping through JS between `start_login` and `poll_login`.
struct Pending {
    device_code: String,
    interval: Duration,
    deadline: Instant,
}

fn pending() -> &'static Mutex<Option<Pending>> {
    static S: OnceLock<Mutex<Option<Pending>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

// ---------------------------------------------------------------------------
// Device flow
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u32,
    interval: u64,
}

/// One poll of the token endpoint. GitHub returns HTTP 200 for the in-progress states too,
/// so the outcome lives in the body, not the status.
enum Poll {
    Token(String),
    Pending,
    /// Server says we are polling too fast; back off permanently by this much.
    SlowDown,
    Failed(String),
}

fn parse_token_response(body: &serde_json::Value) -> Poll {
    if let Some(token) = body.get("access_token").and_then(|v| v.as_str()) {
        return Poll::Token(token.to_string());
    }
    match body.get("error").and_then(|v| v.as_str()) {
        Some("authorization_pending") => Poll::Pending,
        Some("slow_down") => Poll::SlowDown,
        Some("expired_token") => Poll::Failed("the sign-in code expired".into()),
        Some("access_denied") => Poll::Failed("sign-in was denied".into()),
        Some(other) => Poll::Failed(format!("GitHub returned {other}")),
        None => Poll::Failed("unrecognised response from GitHub".into()),
    }
}

fn request_device_code() -> AppResult<DeviceCodeResponse> {
    if CLIENT_ID.is_empty() {
        return Err("GitHub sign-in is not configured in this build".into());
    }
    let resp = crate::proxy_client()
        .post(DEVICE_CODE_URL)
        .header("Accept", "application/json")
        .header("User-Agent", user_agent())
        .json(&serde_json::json!({ "client_id": CLIENT_ID }))
        .send()?;
    if !resp.status().is_success() {
        return Err(format!("GitHub device code request returned {}", resp.status()).into());
    }
    Ok(resp.json()?)
}

fn poll_once(device_code: &str) -> AppResult<Poll> {
    let resp = crate::proxy_client()
        .post(TOKEN_URL)
        .header("Accept", "application/json")
        .header("User-Agent", user_agent())
        .json(&serde_json::json!({
            "client_id": CLIENT_ID,
            "device_code": device_code,
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
        }))
        .send()?;
    let body: serde_json::Value = resp.json()?;
    Ok(parse_token_response(&body))
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

/// GitHub's own explanation of a failure. A 422 carries an `errors` array naming the offending
/// field, which is the only thing that makes a validation failure actionable.
fn error_detail(resp: reqwest::blocking::Response) -> String {
    let status = resp.status().to_string();
    match resp.json::<serde_json::Value>() {
        Ok(body) => detail_from(&body, &status),
        Err(_) => status,
    }
}

fn detail_from(body: &serde_json::Value, status: &str) -> String {
    let message = body
        .get("message")
        .and_then(|m| m.as_str())
        .unwrap_or_default();
    let errors: Vec<String> = body
        .get("errors")
        .and_then(|e| e.as_array())
        .map(|items| {
            items
                .iter()
                .map(|e| {
                    let field = e.get("field").and_then(|f| f.as_str()).unwrap_or("?");
                    let detail = e
                        .get("message")
                        .or_else(|| e.get("code"))
                        .and_then(|m| m.as_str())
                        .unwrap_or("invalid");
                    format!("{field}: {detail}")
                })
                .collect()
        })
        .unwrap_or_default();
    if errors.is_empty() {
        format!("{status} {message}").trim_end().to_string()
    } else {
        format!("{status} {message} ({})", errors.join("; "))
    }
}

fn get(token: &str, url: &str) -> AppResult<serde_json::Value> {
    let resp = crate::proxy_client()
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .header("Authorization", format!("Bearer {token}"))
        .header("User-Agent", user_agent())
        .send()?;
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        set_session(None)?;
        return Err("GitHub session expired".into());
    }
    if !status.is_success() {
        return Err(format!("GitHub {} for {url}", error_detail(resp)).into());
    }
    Ok(resp.json()?)
}

fn fetch_me() -> AppResult<Option<GhUser>> {
    let Some(token) = session()? else {
        return Ok(None);
    };
    // A rejected token clears the session inside `get`, so surface "signed out" rather than an
    // error the settings panel would have to special-case.
    match get(&token, &format!("{API}/user")) {
        Ok(v) => Ok(Some(GhUser {
            login: v
                .get("login")
                .and_then(|l| l.as_str())
                .ok_or("GitHub profile had no login")?
                .to_string(),
            avatar_url: v
                .get("avatar_url")
                .and_then(|a| a.as_str())
                .map(String::from),
        })),
        Err(_) if session()?.is_none() => Ok(None),
        Err(e) => Err(e),
    }
}

/// Comments on an issue, oldest first. Bot chatter is included: a signed-in user can read the
/// whole thread on github.com anyway, so filtering here would only hide it from our own UI.
pub(crate) fn parse_comments(v: &serde_json::Value) -> Vec<IssueComment> {
    v.as_array()
        .map(|items| {
            items
                .iter()
                .map(|c| IssueComment {
                    author: c
                        .get("user")
                        .and_then(|u| u.get("login"))
                        .and_then(|l| l.as_str())
                        .unwrap_or("unknown")
                        .to_string(),
                    body: c
                        .get("body")
                        .and_then(|b| b.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    created_at: c
                        .get("created_at")
                        .and_then(|d| d.as_str())
                        .unwrap_or_default()
                        .to_string(),
                })
                .collect()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Begin device-flow sign-in. Returns the code to show the user; call
/// [`github_poll_login`] afterwards to wait for them to finish authorizing.
#[tauri::command]
#[specta::specta]
pub async fn github_start_login() -> AppResult<DeviceCodeInfo> {
    blocking(|| {
        let d = request_device_code()?;
        let info = DeviceCodeInfo {
            user_code: d.user_code,
            verification_uri: d.verification_uri,
            expires_in: d.expires_in,
        };
        *pending().lock()? = Some(Pending {
            device_code: d.device_code,
            // GitHub's `interval` is a floor; going under it earns a `slow_down`.
            interval: Duration::from_secs(d.interval.max(1)),
            deadline: Instant::now() + Duration::from_secs(d.expires_in as u64),
        });
        Ok(info)
    })
    .await?
}

/// Wait for the user to authorize the code from [`github_start_login`], then store the token.
/// Resolves with the signed-in account.
#[tauri::command]
#[specta::specta]
pub async fn github_poll_login() -> AppResult<GhUser> {
    let token = blocking(|| {
        let (device_code, mut interval, deadline) = {
            let g = pending().lock()?;
            let p = g.as_ref().ok_or("no sign-in is in progress")?;
            (p.device_code.clone(), p.interval, p.deadline)
        };
        loop {
            if Instant::now() >= deadline {
                return Err("timed out waiting for GitHub sign-in".into());
            }
            std::thread::sleep(interval);
            match poll_once(&device_code)? {
                Poll::Token(t) => return Ok::<String, crate::types::AppError>(t),
                Poll::Pending => {}
                Poll::SlowDown => interval += Duration::from_secs(5),
                Poll::Failed(msg) => return Err(msg.into()),
            }
        }
    })
    .await??;

    *pending().lock()? = None;
    set_session(Some(token))?;
    match blocking(fetch_me).await?? {
        Some(user) => Ok(user),
        None => Err("signed in, but GitHub rejected the token".into()),
    }
}

/// The signed-in user, or `None` when there is no session (or it was rejected).
#[tauri::command]
#[specta::specta]
pub async fn github_me() -> AppResult<Option<GhUser>> {
    blocking(fetch_me).await?
}

#[tauri::command]
#[specta::specta]
pub async fn github_logout() -> AppResult<()> {
    blocking(|| set_session(None)).await?
}

/// Local-only check: is a token stored? Says nothing about its validity.
#[tauri::command]
#[specta::specta]
pub async fn github_has_session() -> AppResult<bool> {
    blocking(|| Ok(session()?.is_some())).await?
}

/// File an issue as the signed-in user.
///
/// Labels are sent even though only accounts with push access may set them: GitHub drops them
/// silently for everyone else rather than failing, so sending costs nothing and they land for
/// maintainers. Closing the gap for outside reporters is the worker's job.
#[tauri::command]
#[specta::specta]
pub async fn github_create_issue(
    title: String,
    body: String,
    labels: Vec<String>,
) -> AppResult<IssueRef> {
    blocking(move || {
        let token = require_session()?;
        // Scrubbed on this transport too: the log tail is pre-scrubbed, but diagnostics
        // values can carry home-directory paths.
        let title = crate::feedback::scrub(&title);
        let body = crate::feedback::scrub(&body);
        let resp = crate::proxy_client()
            .post(format!("{API}/repos/{REPO}/issues"))
            .header("Accept", "application/vnd.github+json")
            .header("Authorization", format!("Bearer {token}"))
            .header("User-Agent", user_agent())
            .json(&serde_json::json!({ "title": title, "body": body, "labels": labels }))
            .send()?;
        if !resp.status().is_success() {
            return Err(format!("GitHub rejected the report: {}", error_detail(resp)).into());
        }
        let v: serde_json::Value = resp.json()?;
        Ok(IssueRef {
            number: v.get("number").and_then(|n| n.as_u64()).unwrap_or(0) as u32,
            url: v
                .get("html_url")
                .and_then(|u| u.as_str())
                .unwrap_or_default()
                .to_string(),
        })
    })
    .await?
}

/// One of our issues and its comments, read as the signed-in user.
#[tauri::command]
#[specta::specta]
pub async fn github_issue_thread(number: u32) -> AppResult<IssueThread> {
    blocking(move || {
        let token = require_session()?;
        let issue = get(&token, &format!("{API}/repos/{REPO}/issues/{number}"))?;
        let comments = get(
            &token,
            &format!("{API}/repos/{REPO}/issues/{number}/comments?per_page=100"),
        )?;
        Ok(IssueThread {
            state: match issue.get("state").and_then(|s| s.as_str()) {
                Some("closed") => IssueState::Closed,
                _ => IssueState::Open,
            },
            state_reason: issue
                .get("state_reason")
                .and_then(|s| s.as_str())
                .map(str::to_string),
            comments: parse_comments(&comments),
        })
    })
    .await?
}

#[cfg(test)]
#[path = "github.test.rs"]
mod tests;
