use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime};

use reqwest::header::{HeaderValue, ACCEPT, CONTENT_TYPE, COOKIE, SET_COOKIE};
use reqwest::{Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use tauri::webview::{Cookie, NewWindowResponse};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

use crate::sakai_credentials::{self, SecretStore, StorageError, Store, MAX_STORED_BYTES};

const ORIGIN: &str = "https://sakai.mci4me.at";
const HOST: &str = "sakai.mci4me.at";
const LOGIN_WINDOW: &str = "sakai-login";
const MAX_JSON_BYTES: usize = 5 * 1024 * 1024;
const MAX_PDF_BYTES: usize = 15 * 1024 * 1024;
const MAX_SITES: usize = 500;
const PAGE_SIZE: usize = 100;
const MAX_ITEMS: usize = 5000;
const MAX_COOKIES: usize = 64;
const MAX_COOKIE_BYTES: usize = 16 * 1024;
const MAX_RETENTION: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const AUTO_LOGIN_COOLDOWN: Duration = Duration::from_secs(30);
const MAX_LOGIN_HTML_BYTES: usize = 512 * 1024;
const MAX_LESSON_NODES: usize = 1000;
const MAX_LESSON_DEPTH: usize = 20;
const MAX_LESSON_TEXT: usize = 1024 * 1024;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Failure {
    Denied,
    Disconnected,
    Cancelled,
    Expired,
    Network,
    Response,
    Schema,
    Limit,
    Busy,
    Persistence,
}

impl Failure {
    fn message(self) -> String {
        match self {
            Self::Denied => "Sakai-Zugriff nicht freigegeben",
            Self::Disconnected | Self::Expired => "SAKAI_AUTH_REQUIRED",
            Self::Cancelled => "SAKAI_CANCELLED",
            Self::Network => "Sakai-Anfrage fehlgeschlagen",
            Self::Response => "Sakai meldet eine unerwartete Antwort",
            Self::Schema => "Sakai-Antwort hat ein unbekanntes Datenformat",
            Self::Limit => {
                "Sakai-Daten überschreiten die Sicherheitsgrenze; Ergebnis unvollständig"
            }
            Self::Busy => "Sakai-Anmeldung konnte nicht gestartet werden",
            Self::Persistence => "Sakai-Sitzung konnte nicht sicher gespeichert oder entfernt werden. Bitte erneut versuchen.",
        }
        .into()
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SakaiStatus {
    pub connected: bool,
    pub login_open: bool,
    pub remember_session: bool,
    pub persistence_error: bool,
    pub auto_login: bool,
    pub auto_login_rejected: bool,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct SakaiSite {
    pub id: String,
    pub title: String,
    #[serde(deserialize_with = "nullable_text")]
    pub description: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SakaiAnnouncement {
    pub id: String,
    pub title: String,
    pub body: String,
    pub created_on: i64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SakaiResource {
    pub title: String,
    pub url: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, deserialize_with = "resource_size")]
    pub size: u64,
    #[serde(default)]
    pub modified_date: Option<String>,
}

#[derive(Serialize)]
pub struct SakaiPdfDownload {
    pub path: String,
    pub bytes: usize,
}

impl SakaiPdfDownload {
    fn new(path: String, bytes: &[u8]) -> Self {
        Self {
            path,
            bytes: bytes.len(),
        }
    }
}

#[derive(Serialize)]
pub struct SakaiSnapshot {
    pub site: SakaiSite,
    pub announcements: Vec<SakaiAnnouncement>,
    pub resources: Vec<SakaiResource>,
    pub lessons: Vec<SakaiLesson>,
    pub warnings: Vec<String>,
}

#[derive(Serialize)]
pub struct SakaiLesson {
    pub title: String,
    pub html: String,
    pub url: String,
}

#[derive(Deserialize)]
struct SiteCollection {
    site_collection: Vec<SakaiSite>,
}

#[derive(Deserialize)]
struct SiteDetails {
    #[serde(flatten)]
    site: SakaiSite,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SitePage {
    site_id: String,
    tools: Vec<SiteTool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SiteTool {
    tool_id: String,
}

fn has_lessons(site_id: &str, pages: &[SitePage]) -> Result<bool, Failure> {
    if pages.len() > MAX_ITEMS {
        return Err(Failure::Limit);
    }
    let mut found = false;
    let mut tools = 0;
    for page in pages {
        if page.site_id != site_id {
            return Err(Failure::Schema);
        }
        tools += page.tools.len();
        if tools > MAX_ITEMS {
            return Err(Failure::Limit);
        }
        for tool in &page.tools {
            if tool.tool_id.trim().is_empty() || tool.tool_id.len() > 256 {
                return Err(Failure::Schema);
            }
            found |= tool.tool_id == "sakai.lessonbuildertool";
        }
    }
    Ok(found)
}

#[derive(Deserialize)]
struct AnnouncementCollection {
    announcement_collection: Vec<SakaiAnnouncement>,
}

#[derive(Deserialize)]
struct ContentCollection {
    content_collection: Vec<ContentResource>,
}

#[derive(Deserialize)]
struct ContentResource {
    #[serde(flatten)]
    resource: SakaiResource,
    hidden: Option<bool>,
    visible: Option<bool>,
}

#[derive(Deserialize)]
struct LessonsCollection {
    lessons_collection: Vec<LessonRoot>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LessonRoot {
    id: u64,
    lesson_title: String,
    hidden: bool,
    release_date: Option<ReleaseDate>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ReleaseDate {
    Millis(u64),
    Text(String),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LessonNode {
    id: u64,
    #[serde(rename = "type")]
    kind: u32,
    name: Option<String>,
    html: Option<String>,
    url: Option<String>,
    hidden: Option<bool>,
    release_date: Option<ReleaseDate>,
    contents_list: Option<Vec<LessonNode>>,
}

#[derive(Default)]
struct LessonBudget {
    nodes: usize,
    text_bytes: usize,
}

fn nullable_text<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    Ok(Option::<String>::deserialize(deserializer)?.unwrap_or_default())
}

fn resource_size<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Size {
        Number(u64),
        Text(String),
    }
    match Option::<Size>::deserialize(deserializer)? {
        None => Ok(0),
        Some(Size::Number(size)) => Ok(size),
        Some(Size::Text(size)) => size.parse().map_err(serde::de::Error::custom),
    }
}

#[derive(Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SessionCookie {
    name: String,
    value: String,
    path: String,
    secure: bool,
    expires: Option<SystemTime>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SavedSession {
    version: u8,
    origin: String,
    created_at: SystemTime,
    retain_until: SystemTime,
    cookies: Vec<SessionCookie>,
}

impl SavedSession {
    fn validate(&self, now: SystemTime) -> Result<(), Failure> {
        if self.version != 1
            || self.origin != ORIGIN
            || self.created_at > now
            || self
                .retain_until
                .duration_since(self.created_at)
                .ok()
                .is_none_or(|duration| duration.is_zero() || duration > MAX_RETENTION)
            || self.cookies.is_empty()
            || self.cookies.len() > MAX_COOKIES
        {
            return Err(Failure::Schema);
        }
        if self.retain_until <= now {
            return Err(Failure::Expired);
        }
        let mut pairs = HashSet::new();
        for cookie in &self.cookies {
            if !valid_cookie_pair(&cookie.name, &cookie.value)
                || !cookie.path.starts_with('/')
                || cookie.path.len() > 4096
                || cookie.path.bytes().any(|b| b.is_ascii_control())
                || !pairs.insert((&cookie.name, &cookie.path))
            {
                return Err(Failure::Schema);
            }
            if cookie.expires.is_some_and(|expiry| expiry <= now) {
                return Err(Failure::Expired);
            }
        }
        cookie_header(&self.cookies, &endpoint("/direct/site.json", &[])?, now)?;
        Ok(())
    }

    fn decode(bytes: &[u8], now: SystemTime) -> Result<Self, Failure> {
        if bytes.len() > MAX_STORED_BYTES {
            return Err(Failure::Limit);
        }
        let saved: Self = serde_json::from_slice(bytes).map_err(|_| Failure::Schema)?;
        saved.validate(now)?;
        Ok(saved)
    }

    fn encode(&self, now: SystemTime) -> Result<Vec<u8>, Failure> {
        self.validate(now)?;
        let bytes = serde_json::to_vec(self).map_err(|_| Failure::Schema)?;
        if bytes.len() > MAX_STORED_BYTES {
            return Err(Failure::Limit);
        }
        Ok(bytes)
    }
}

#[derive(Default)]
struct Session {
    generation: u64,
    login: bool,
    login_window: Option<WebviewWindow>,
    connected: bool,
    client: Option<Client>,
    cookies: Vec<SessionCookie>,
    sites: HashMap<String, SakaiSite>,
    pdfs: HashSet<(String, String)>,
    remember_session: bool,
    persistence_error: bool,
    preference_revision: u64,
    forget_pending: bool,
    marker_revoked: bool,
    restore_attempted: bool,
    retained_from: Option<SystemTime>,
    retain_until: Option<SystemTime>,
    persistence_dirty: bool,
    auto_login: bool,
    auto_login_rejected: bool,
    last_auto_login: Option<Instant>,
    auto_login_epoch: u64,
}

impl Session {
    fn reset(&mut self) -> Result<u64, Failure> {
        let next = self.generation.checked_add(1);
        *self = Self {
            generation: next.unwrap_or(self.generation),
            remember_session: self.remember_session,
            persistence_error: self.persistence_error,
            preference_revision: self.preference_revision,
            forget_pending: self.forget_pending,
            marker_revoked: self.marker_revoked,
            restore_attempted: true,
            auto_login: self.auto_login,
            auto_login_rejected: self.auto_login_rejected,
            last_auto_login: self.last_auto_login,
            auto_login_epoch: self.auto_login_epoch,
            ..Self::default()
        };
        next.ok_or(Failure::Limit)
    }

    fn status(&self) -> SakaiStatus {
        SakaiStatus {
            connected: self.connected,
            login_open: self.login,
            remember_session: self.remember_session,
            persistence_error: self.persistence_error,
            auto_login: self.auto_login,
            auto_login_rejected: self.auto_login_rejected,
        }
    }

    /// Invalidates every in-flight credential check so it can neither store a password
    /// nor flip the auto-login flags after the user turned the feature off.
    fn cancel_auto_login(&mut self) -> u64 {
        self.auto_login = false;
        self.auto_login_rejected = false;
        self.auto_login_epoch = self.auto_login_epoch.wrapping_add(1);
        self.auto_login_epoch
    }

    fn auto_login_due(&self, now: Instant) -> bool {
        self.auto_login
            && !self.auto_login_rejected
            && !self.connected
            && !self.login
            && self
                .last_auto_login
                .is_none_or(|last| now.duration_since(last) >= AUTO_LOGIN_COOLDOWN)
    }

    fn revoke(&mut self) -> Result<(), Failure> {
        self.remember_session = false;
        self.forget_pending = true;
        self.marker_revoked = false;
        self.persistence_dirty = false;
        self.preference_revision = self
            .preference_revision
            .checked_add(1)
            .ok_or(Failure::Limit)?;
        Ok(())
    }

    fn complete_login(&mut self, generation: u64) -> Result<Option<WebviewWindow>, Failure> {
        self.check(generation)?;
        self.connected = true;
        self.login = false;
        Ok(self.login_window.take())
    }

    fn check(&self, generation: u64) -> Result<(), Failure> {
        if self.generation != generation {
            return Err(Failure::Cancelled);
        }
        if self.client.is_none() {
            return Err(Failure::Disconnected);
        }
        Ok(())
    }

    fn active(&self) -> Result<u64, Failure> {
        if !self.connected {
            return Err(Failure::Disconnected);
        }
        self.check(self.generation)?;
        Ok(self.generation)
    }
}

pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<SakaiState>() {
        state.clear_ram();
    }
}

#[derive(Clone)]
pub struct SakaiState {
    session: Arc<Mutex<Session>>,
    requests: Arc<tauri::async_runtime::Mutex<()>>,
    store: Arc<dyn Store>,
    login_store: Arc<dyn SecretStore>,
    keychain: Arc<Mutex<()>>,
}

impl Default for SakaiState {
    fn default() -> Self {
        Self::new(None)
    }
}

impl SakaiState {
    pub fn new(config: Option<std::path::PathBuf>) -> Self {
        Self {
            session: Arc::new(Mutex::new(Session::default())),
            requests: Arc::new(tauri::async_runtime::Mutex::new(())),
            store: sakai_credentials::native_store(config),
            login_store: sakai_credentials::native_login_store(),
            keychain: Arc::new(Mutex::new(())),
        }
    }

    fn lock(&self) -> Result<MutexGuard<'_, Session>, Failure> {
        self.session.lock().map_err(|_| Failure::Disconnected)
    }

    fn invalidate(&self, generation: u64) {
        let window = if let Ok(mut session) = self.lock() {
            if session.generation == generation {
                let window = session.login_window.take();
                let _ = session.reset();
                window
            } else {
                None
            }
        } else {
            None
        };
        destroy_login(window);
    }

    fn clear_ram(&self) {
        let generation = self.lock().map(|session| session.generation);
        if let Ok(generation) = generation {
            self.invalidate(generation);
        }
    }

    fn cancel_login(&self, generation: u64) {
        let window = if let Ok(mut session) = self.lock() {
            if session.generation == generation && session.login {
                let window = session.login_window.take();
                let _ = session.reset();
                window
            } else {
                None
            }
        } else {
            None
        };
        destroy_login(window);
    }

    fn disable_marker(&self, session: &mut Session) -> Result<(), StorageError> {
        if !session.forget_pending || session.marker_revoked {
            return Ok(());
        }
        let result = self.store.set_enabled(false);
        session.marker_revoked = result.is_ok();
        session.persistence_error |= result.is_err();
        result
    }

    fn drain_forget(&self) -> Result<(), StorageError> {
        let (revision, marker) = {
            let mut session = self.session.lock().map_err(|_| StorageError)?;
            if !session.forget_pending {
                return Ok(());
            }
            let marker = self.disable_marker(&mut session);
            (session.preference_revision, marker)
        };
        // Even a failed tombstone must not prevent the exact-record deletion attempt.
        let deletion = self.store.delete();
        let result = marker.and(deletion);
        let mut session = self.session.lock().map_err(|_| StorageError)?;
        if session.preference_revision == revision {
            session.forget_pending = result.is_err();
            session.persistence_error = result.is_err();
        }
        result
    }

    async fn forget(&self) -> Result<(), Failure> {
        {
            let mut session = self.lock()?;
            // This phase cannot wait behind a native Keychain dialog.
            let _ = self.disable_marker(&mut session);
        }
        let state = self.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _keychain = state.keychain.lock().map_err(|_| Failure::Persistence)?;
            state.drain_forget().map_err(|_| Failure::Persistence)
        })
        .await
        .map_err(|_| Failure::Persistence)?
    }

    fn persist_sync(&self, generation: u64, revision: u64) -> Result<(), Failure> {
        let _keychain = self.keychain.lock().map_err(|_| Failure::Persistence)?;
        self.drain_forget().map_err(|_| Failure::Persistence)?;
        let saved = {
            let session = self.lock()?;
            session.check(generation)?;
            if session.preference_revision != revision
                || !session.remember_session
                || !session.connected
            {
                return Err(Failure::Cancelled);
            }
            let created_at = session.retained_from.ok_or(Failure::Persistence)?;
            SavedSession {
                version: 1,
                origin: ORIGIN.into(),
                created_at,
                retain_until: session.retain_until.ok_or(Failure::Persistence)?,
                cookies: session.cookies.clone(),
            }
        };
        let written = saved
            .encode(SystemTime::now())
            .map_err(|_| StorageError)
            .and_then(|bytes| self.store.write(&bytes));
        // A revocation may have arrived while the native Keychain prompt was open.
        self.drain_forget().map_err(|_| Failure::Persistence)?;
        let mut session = self.lock()?;
        session.check(generation)?;
        if session.preference_revision != revision || !session.remember_session {
            return Err(Failure::Cancelled);
        }
        let result = written.and_then(|()| self.store.set_enabled(true));
        session.persistence_error = result.is_err();
        if result.is_ok() {
            session.persistence_dirty = false;
            session.marker_revoked = false;
        }
        result.map_err(|_| Failure::Persistence)
    }

    async fn persist(&self, generation: u64, retry: bool) -> Result<(), Failure> {
        let revision = {
            let session = self.lock()?;
            session.check(generation)?;
            if !session.connected
                || !session.remember_session
                || (!retry && (!session.persistence_dirty || session.persistence_error))
            {
                return Ok(());
            }
            session.preference_revision
        };
        let state = self.clone();
        let result =
            tauri::async_runtime::spawn_blocking(move || state.persist_sync(generation, revision))
                .await
                .map_err(|_| Failure::Persistence)?;
        match result {
            Err(Failure::Persistence) => {
                let mut session = self.lock()?;
                if session.generation == generation && session.preference_revision == revision {
                    session.persistence_error = true;
                }
                Ok(())
            }
            other => other,
        }
    }

    fn load_saved_sync(&self, generation: u64) -> Result<(), Failure> {
        let _keychain = self.keychain.lock().map_err(|_| Failure::Persistence)?;
        self.drain_forget().map_err(|_| Failure::Persistence)?;
        let revision = {
            let session = self.lock()?;
            if session.generation != generation {
                return Err(Failure::Cancelled);
            }
            session.preference_revision
        };
        let enabled = self.store.enabled();
        {
            let mut session = self.lock()?;
            if session.generation != generation || session.preference_revision != revision {
                return Err(Failure::Cancelled);
            }
            match enabled {
                Ok(false) => return Ok(()),
                Ok(true) => session.remember_session = true,
                Err(_) => {
                    session.persistence_error = true;
                    return Ok(());
                }
            }
        }
        let result = self.store.read();
        let mut session = self.lock()?;
        if session.generation != generation || session.preference_revision != revision {
            return Err(Failure::Cancelled);
        }
        let bytes = match result {
            Ok(Some(bytes)) => bytes,
            Ok(None) => Vec::new(),
            Err(_) => {
                session.persistence_error = true;
                return Ok(());
            }
        };
        match SavedSession::decode(&bytes, SystemTime::now()) {
            Ok(saved) => {
                session.remember_session = true;
                session.persistence_error = false;
                session.retained_from = Some(saved.created_at);
                session.retain_until = Some(saved.retain_until);
                session.cookies = saved.cookies;
                session.client = Some(http_client()?);
            }
            Err(error) => {
                session.revoke()?;
                drop(session);
                let failed = self.drain_forget().is_err();
                let mut session = self.lock()?;
                if session.generation == generation {
                    session.persistence_error = failed || error != Failure::Expired;
                }
            }
        }
        Ok(())
    }

    async fn request_failed(&self, generation: u64, failure: Failure) -> Result<(), Failure> {
        if !matches!(failure, Failure::Expired | Failure::Network) {
            return Ok(());
        }
        let forget = {
            let mut session = self.lock()?;
            session.check(generation)?;
            if session.login {
                session.cookies.clear();
                session.client = None;
                return Ok(());
            }
            if failure == Failure::Expired {
                session.revoke()?;
            }
            session.reset()?;
            failure == Failure::Expired
        };
        if forget {
            let _ = self.forget().await;
        }
        Ok(())
    }
}

fn destroy_login(window: Option<WebviewWindow>) {
    if let Some(window) = window {
        let _ = window.destroy();
    }
}

fn main_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err(Failure::Denied.message());
    }
    Ok(())
}

fn same_origin(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some(HOST)
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
}

fn checked_url(value: &str) -> Result<Url, Failure> {
    if value.len() > 8192 {
        return Err(Failure::Denied);
    }
    let url = Url::parse(value).map_err(|_| Failure::Denied)?;
    if !same_origin(&url) || url.fragment().is_some() {
        return Err(Failure::Denied);
    }
    Ok(url)
}

fn valid_id(id: &str) -> bool {
    id.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
}

fn endpoint(path: &str, params: &[(&str, String)]) -> Result<Url, Failure> {
    let mut url = checked_url(&format!("{ORIGIN}{path}"))?;
    if !url.path().starts_with("/direct/") || url.query().is_some() {
        return Err(Failure::Denied);
    }
    url.query_pairs_mut()
        .extend_pairs(params.iter().map(|(key, value)| (*key, value.as_str())))
        .append_pair("_validateSession", "true");
    Ok(url)
}

fn path_matches(cookie_path: &str, request_path: &str) -> bool {
    request_path == cookie_path
        || request_path
            .strip_prefix(cookie_path)
            .is_some_and(|rest| cookie_path.ends_with('/') || rest.starts_with('/'))
}

fn valid_cookie_pair(name: &str, value: &str) -> bool {
    let value = value
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .unwrap_or(value);
    !name.is_empty()
        && name.len() <= 256
        && value.len() <= 4096
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
        && value
            .bytes()
            .all(|b| matches!(b, 0x21 | 0x23..=0x2b | 0x2d..=0x3a | 0x3c..=0x5b | 0x5d..=0x7e))
}

fn stored_cookie(
    cookie: Cookie<'_>,
    url: Option<&Url>,
    now: SystemTime,
) -> Result<SessionCookie, Failure> {
    // WK exports a Domain even for host-only cookies. Keep the bridge pinned to this exact host.
    if cookie
        .domain()
        .is_some_and(|domain| !domain.eq_ignore_ascii_case(HOST))
        || (url.is_none() && cookie.domain().is_none())
        || (url.is_none() && cookie.path().is_none_or(|path| !path.starts_with('/')))
        || !valid_cookie_pair(cookie.name(), cookie.value())
    {
        return Err(Failure::Denied);
    }
    let default_path = url.and_then(|url| url.path().rsplit_once('/').map(|(parent, _)| parent));
    let path = cookie
        .path()
        .filter(|path| path.starts_with('/'))
        .or(default_path.filter(|path| !path.is_empty()))
        .unwrap_or("/");
    if path.len() > 4096 || path.bytes().any(|b| b.is_ascii_control()) {
        return Err(Failure::Denied);
    }
    let expires = match cookie.max_age() {
        Some(age) if age.whole_seconds() <= 0 => Some(now),
        Some(age) => Some(
            now.checked_add(Duration::from_secs(age.whole_seconds() as u64))
                .ok_or(Failure::Limit)?,
        ),
        None => cookie.expires_datetime().map(SystemTime::from),
    };
    Ok(SessionCookie {
        name: cookie.name().into(),
        value: cookie.value().into(),
        path: path.into(),
        secure: cookie.secure().unwrap_or(false),
        expires,
    })
}

fn cookie_header(
    cookies: &[SessionCookie],
    url: &Url,
    now: SystemTime,
) -> Result<HeaderValue, Failure> {
    if !same_origin(url) {
        return Err(Failure::Denied);
    }
    let mut matching: Vec<_> = cookies
        .iter()
        .filter(|cookie| {
            (!cookie.secure || url.scheme() == "https")
                && cookie.expires.is_none_or(|expires| expires > now)
                && path_matches(&cookie.path, url.path())
        })
        .collect();
    matching.sort_by_key(|cookie| std::cmp::Reverse(cookie.path.len()));
    if matching.is_empty() {
        return Err(Failure::Expired);
    }
    let mut header = String::new();
    for cookie in matching {
        if !header.is_empty() {
            header.push_str("; ");
        }
        if header
            .len()
            .saturating_add(cookie.name.len())
            .saturating_add(cookie.value.len())
            .saturating_add(1)
            > MAX_COOKIE_BYTES
        {
            return Err(Failure::Limit);
        }
        header.push_str(&cookie.name);
        header.push('=');
        header.push_str(&cookie.value);
    }
    let mut header = HeaderValue::from_str(&header).map_err(|_| Failure::Denied)?;
    header.set_sensitive(true);
    Ok(header)
}

fn update_cookies(
    cookies: &mut Vec<SessionCookie>,
    headers: &reqwest::header::HeaderMap,
    url: &Url,
) -> Result<(), Failure> {
    let now = SystemTime::now();
    cookies.retain(|cookie| cookie.expires.is_none_or(|expires| expires > now));
    for header in headers.get_all(SET_COOKIE) {
        let raw = header.to_str().map_err(|_| Failure::Schema)?;
        if raw.len() > MAX_COOKIE_BYTES {
            return Err(Failure::Limit);
        }
        let parsed = Cookie::parse(raw).map_err(|_| Failure::Schema)?;
        if parsed
            .domain()
            .is_some_and(|domain| !domain.eq_ignore_ascii_case(HOST))
        {
            continue;
        }
        let cookie = stored_cookie(parsed, Some(url), now)?;
        cookies.retain(|old| old.name != cookie.name || old.path != cookie.path);
        if cookie.expires.is_none_or(|expires| expires > now) {
            cookies.push(cookie);
        }
        if cookies.len() > MAX_COOKIES {
            return Err(Failure::Limit);
        }
    }
    Ok(())
}

fn http_client() -> Result<Client, Failure> {
    Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .referer(false)
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|_| Failure::Network)
}

fn append_bytes(body: &mut Vec<u8>, chunk: &[u8], maximum: usize) -> Result<(), Failure> {
    if chunk.len() > maximum.saturating_sub(body.len()) {
        return Err(Failure::Limit);
    }
    body.extend_from_slice(chunk);
    Ok(())
}

fn validate_pdf_max_bytes(max_bytes: usize) -> Result<(), Failure> {
    if !(1..=MAX_PDF_BYTES).contains(&max_bytes) {
        return Err(Failure::Limit);
    }
    Ok(())
}

fn check_content_length(length: Option<u64>, maximum: usize) -> Result<(), Failure> {
    if length.is_some_and(|length| length > maximum as u64) {
        return Err(Failure::Limit);
    }
    Ok(())
}

fn response_status(state: &SakaiState, generation: u64, status: StatusCode) -> Result<(), Failure> {
    state.lock()?.check(generation)?;
    if status == StatusCode::UNAUTHORIZED {
        return Err(Failure::Expired);
    }
    if !status.is_success() {
        return Err(Failure::Response);
    }
    Ok(())
}

fn login_redirect(url: &Url, status: StatusCode, location: Option<&HeaderValue>) -> bool {
    status.is_redirection()
        && location
            .and_then(|value| value.to_str().ok())
            .filter(|value| value.len() <= 8192)
            .and_then(|value| url.join(value).ok())
            .is_some_and(|target| {
                same_origin(&target)
                    && matches!(
                        target.path().trim_end_matches('/'),
                        "/login" | "/relogin" | "/portal/login" | "/portal/relogin"
                    )
            })
}

async fn request_bytes(
    state: &SakaiState,
    generation: u64,
    url: Url,
    pdf: bool,
    maximum: usize,
) -> Result<Vec<u8>, Failure> {
    let result = request_bytes_inner(state, generation, url, pdf, maximum).await;
    if let Err(failure) = result {
        state.request_failed(generation, failure).await?;
    }
    result
}

async fn request_bytes_inner(
    state: &SakaiState,
    generation: u64,
    url: Url,
    pdf: bool,
    maximum: usize,
) -> Result<Vec<u8>, Failure> {
    if !same_origin(&url) || url.fragment().is_some() {
        return Err(Failure::Denied);
    }
    let (client, header) = {
        let session = state.lock()?;
        session.check(generation)?;
        (
            session.client.clone().ok_or(Failure::Disconnected)?,
            cookie_header(&session.cookies, &url, SystemTime::now()),
        )
    };
    let header = header?;
    let response = client
        .get(url.clone())
        .header(COOKIE, header)
        .header(
            ACCEPT,
            if pdf {
                "application/pdf"
            } else {
                "application/json"
            },
        )
        .send()
        .await;
    state.lock()?.check(generation)?;
    let mut response = response.map_err(|_| Failure::Network)?;
    if login_redirect(
        &url,
        response.status(),
        response.headers().get(reqwest::header::LOCATION),
    ) {
        return Err(Failure::Expired);
    }
    response_status(state, generation, response.status())?;
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim();
    if content_type.eq_ignore_ascii_case("text/html") {
        return Err(Failure::Expired);
    }
    if (pdf && !content_type.eq_ignore_ascii_case("application/pdf"))
        || (!pdf && !content_type.eq_ignore_ascii_case("application/json"))
    {
        return Err(Failure::Schema);
    }
    {
        let mut session = state.lock()?;
        session.check(generation)?;
        let previous = session.cookies.clone();
        update_cookies(&mut session.cookies, response.headers(), &url)?;
        session.persistence_dirty |= previous.len() != session.cookies.len()
            || previous
                .iter()
                .any(|cookie| !session.cookies.contains(cookie));
    }
    check_content_length(response.content_length(), maximum)?;
    let mut body = Vec::new();
    loop {
        let chunk = response.chunk().await;
        state.lock()?.check(generation)?;
        let Some(chunk) = chunk.map_err(|_| Failure::Network)? else {
            break;
        };
        append_bytes(&mut body, &chunk, maximum)?;
    }
    state.lock()?.check(generation)?;
    if pdf && !body.starts_with(b"%PDF-") {
        return Err(Failure::Schema);
    }
    if pdf {
        state.persist(generation, false).await?;
    }
    Ok(body)
}

async fn json<T: serde::de::DeserializeOwned>(
    state: &SakaiState,
    generation: u64,
    url: Url,
) -> Result<T, Failure> {
    let bytes = request_bytes(state, generation, url, false, MAX_JSON_BYTES).await?;
    let value = serde_json::from_slice(&bytes).map_err(|_| Failure::Schema)?;
    state.lock()?.check(generation)?;
    state.persist(generation, false).await?;
    Ok(value)
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct LoginCredentials {
    version: u8,
    eid: String,
    pw: String,
    /// Persisted so a password Sakai refused is never retried after an app restart.
    #[serde(default)]
    rejected: bool,
}

impl LoginCredentials {
    fn new(eid: &str, pw: &str) -> Result<Self, Failure> {
        let credentials = Self {
            version: 1,
            eid: eid.trim().into(),
            pw: pw.into(),
            rejected: false,
        };
        credentials.validate()?;
        Ok(credentials)
    }

    fn validate(&self) -> Result<(), Failure> {
        if self.version != 1
            || self.eid.is_empty()
            || self.eid.len() > 256
            || self.eid.chars().any(|c| c.is_control() || c.is_whitespace())
            || self.pw.is_empty()
            || self.pw.len() > 1024
            || self.pw.chars().any(char::is_control)
        {
            return Err(Failure::Schema);
        }
        Ok(())
    }

    fn decode(bytes: &[u8]) -> Result<Self, Failure> {
        let credentials: Self = serde_json::from_slice(bytes).map_err(|_| Failure::Schema)?;
        credentials.validate()?;
        Ok(credentials)
    }

    fn encode(&self) -> Result<Vec<u8>, Failure> {
        self.validate()?;
        serde_json::to_vec(self).map_err(|_| Failure::Schema)
    }

    fn form_body(&self) -> String {
        let mut url = Url::parse("https://form.invalid/").expect("static URL");
        url.query_pairs_mut()
            .append_pair("eid", &self.eid)
            .append_pair("pw", &self.pw)
            .append_pair("submit", "Log in");
        url.query().unwrap_or_default().into()
    }
}

/// Signs in with stored credentials on a private cookie set and returns it only after
/// Sakai confirms an authenticated session. Never touches the shared session state,
/// so a rejected password cannot revoke or reset an existing connection.
async fn perform_login(credentials: &LoginCredentials) -> Result<Vec<SessionCookie>, Failure> {
    let client = http_client()?;
    let mut cookies = Vec::new();
    let form_url = checked_url(&format!("{ORIGIN}/portal/login"))?;
    let response = client
        .get(form_url.clone())
        .send()
        .await
        .map_err(|_| Failure::Network)?;
    update_cookies(&mut cookies, response.headers(), &form_url)?;
    drain_bounded(response, MAX_LOGIN_HTML_BYTES).await?;

    let login_url = checked_url(&format!("{ORIGIN}/portal/relogin"))?;
    let mut request = client
        .post(login_url.clone())
        .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(credentials.form_body());
    if let Ok(header) = cookie_header(&cookies, &login_url, SystemTime::now()) {
        request = request.header(COOKIE, header);
    }
    let response = request.send().await.map_err(|_| Failure::Network)?;
    if response.status().is_server_error() {
        return Err(Failure::Response);
    }
    update_cookies(&mut cookies, response.headers(), &login_url)?;
    drain_bounded(response, MAX_LOGIN_HTML_BYTES).await?;

    // With _validateSession Sakai answers 401 for anonymous sessions, so this is the
    // authoritative success check regardless of how the login page responded.
    let check_url = endpoint(
        "/direct/site.json",
        &[("_limit", "1".into()), ("_start", "0".into())],
    )?;
    let response = client
        .get(check_url.clone())
        .header(COOKIE, cookie_header(&cookies, &check_url, SystemTime::now())?)
        .header(ACCEPT, "application/json")
        .send()
        .await
        .map_err(|_| Failure::Network)?;
    if response.status() == StatusCode::UNAUTHORIZED
        || login_redirect(
            &check_url,
            response.status(),
            response.headers().get(reqwest::header::LOCATION),
        )
    {
        return Err(Failure::Expired);
    }
    if !response.status().is_success() {
        return Err(Failure::Response);
    }
    update_cookies(&mut cookies, response.headers(), &check_url)?;
    let body = drain_bounded(response, MAX_JSON_BYTES).await?;
    let collection: SiteCollection = serde_json::from_slice(&body).map_err(|_| Failure::Schema)?;
    if collection.site_collection.len() > 1 {
        return Err(Failure::Schema);
    }
    if cookies.is_empty() {
        return Err(Failure::Expired);
    }
    Ok(cookies)
}

async fn drain_bounded(mut response: reqwest::Response, maximum: usize) -> Result<Vec<u8>, Failure> {
    check_content_length(response.content_length(), maximum)?;
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Failure::Network)? {
        append_bytes(&mut body, &chunk, maximum)?;
    }
    Ok(body)
}

impl SakaiState {
    fn read_login_sync(&self) -> Result<Option<LoginCredentials>, Failure> {
        let _keychain = self.keychain.lock().map_err(|_| Failure::Persistence)?;
        match self.login_store.read() {
            Ok(Some(bytes)) => LoginCredentials::decode(&bytes).map(Some),
            Ok(None) => Ok(None),
            Err(_) => Err(Failure::Persistence),
        }
    }

    /// Writes only while `epoch` is current. Disable and disconnect bump the epoch before
    /// they wait for the Keychain lock, so their deletion always runs after this write.
    fn write_login_sync(&self, credentials: &LoginCredentials, epoch: u64) -> Result<(), Failure> {
        let bytes = credentials.encode()?;
        let _keychain = self.keychain.lock().map_err(|_| Failure::Persistence)?;
        if self.lock()?.auto_login_epoch != epoch {
            return Err(Failure::Cancelled);
        }
        self.login_store
            .write(&bytes)
            .map_err(|_| Failure::Persistence)
    }

    fn delete_login_sync(&self) -> Result<(), Failure> {
        let _keychain = self.keychain.lock().map_err(|_| Failure::Persistence)?;
        self.login_store.delete().map_err(|_| Failure::Persistence)
    }

    /// Adopts a verified cookie set into the current generation unless a manual login
    /// or another connection won the race in the meantime.
    fn install_login(&self, generation: u64, cookies: Vec<SessionCookie>) -> Result<bool, Failure> {
        let mut session = self.lock()?;
        if session.generation != generation || session.login || session.connected {
            return Ok(false);
        }
        let now = SystemTime::now();
        session.cookies = cookies;
        session.client = Some(http_client()?);
        session.connected = true;
        session.persistence_dirty = true;
        session.retained_from = Some(now);
        session.retain_until = now.checked_add(MAX_RETENTION);
        Ok(true)
    }
}

/// Signs in silently with stored credentials. `force` skips the cooldown for the first
/// check after app start, when the stored state is not known yet.
async fn try_auto_login(state: &SakaiState, generation: u64, force: bool) -> Result<(), Failure> {
    let epoch = {
        let mut session = state.lock()?;
        let now = Instant::now();
        if session.generation != generation
            || session.connected
            || session.login
            || session.auto_login_rejected
            || (!force && !session.auto_login_due(now))
        {
            return Ok(());
        }
        session.last_auto_login = Some(now);
        session.auto_login_epoch
    };
    let set_flags = |enabled: bool, rejected: bool| -> Result<bool, Failure> {
        let mut session = state.lock()?;
        if session.auto_login_epoch != epoch {
            return Ok(false);
        }
        session.auto_login = enabled;
        session.auto_login_rejected = rejected;
        Ok(true)
    };
    let worker = state.clone();
    let credentials = tauri::async_runtime::spawn_blocking(move || worker.read_login_sync())
        .await
        .map_err(|_| Failure::Persistence)?;
    let mut credentials = match credentials {
        Ok(Some(credentials)) => credentials,
        Ok(None) => {
            set_flags(false, false)?;
            return Ok(());
        }
        Err(error) => {
            set_flags(false, false)?;
            return Err(error);
        }
    };
    if !set_flags(true, credentials.rejected)? || credentials.rejected {
        return Ok(());
    }
    match perform_login(&credentials).await {
        Ok(cookies) => {
            if state.lock()?.auto_login_epoch == epoch && state.install_login(generation, cookies)? {
                state.persist(generation, false).await?;
            }
            Ok(())
        }
        Err(Failure::Expired) => {
            // Stop retrying a rejected password so Sakai never locks the account.
            if set_flags(true, true)? {
                credentials.rejected = true;
                let worker = state.clone();
                let _ = tauri::async_runtime::spawn_blocking(move || {
                    worker.write_login_sync(&credentials, epoch)
                })
                .await;
            }
            Ok(())
        }
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub async fn sakai_enable_auto_login(
    app: AppHandle,
    window: WebviewWindow,
    eid: String,
    pw: String,
) -> Result<SakaiStatus, String> {
    main_window(&window)?;
    let state = app.state::<SakaiState>();
    let credentials = LoginCredentials::new(&eid, &pw).map_err(|_| "SAKAI_LOGIN_INVALID".to_string())?;
    // A new epoch also retires any silent attempt still running with older credentials.
    let epoch = state.lock().map_err(Failure::message)?.cancel_auto_login();
    let cookies = match perform_login(&credentials).await {
        Ok(cookies) => cookies,
        Err(Failure::Expired) => return Err("SAKAI_LOGIN_REJECTED".into()),
        Err(error) => return Err(error.message()),
    };
    let _request = state.requests.lock().await;
    let worker = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || worker.write_login_sync(&credentials, epoch))
        .await
        .map_err(|_| Failure::Persistence.message())?
        .map_err(Failure::message)?;
    let generation = {
        let mut session = state.lock().map_err(Failure::message)?;
        if session.auto_login_epoch != epoch {
            return Err(Failure::Cancelled.message());
        }
        session.auto_login = true;
        session.auto_login_rejected = false;
        session.restore_attempted = true;
        session.generation
    };
    if state
        .install_login(generation, cookies)
        .map_err(Failure::message)?
    {
        state
            .persist(generation, false)
            .await
            .map_err(Failure::message)?;
    }
    let status = state.lock().map_err(Failure::message)?.status();
    Ok(status)
}

#[tauri::command]
pub async fn sakai_disable_auto_login(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<SakaiStatus, String> {
    main_window(&window)?;
    let state = app.state::<SakaiState>();
    state.lock().map_err(Failure::message)?.cancel_auto_login();
    let worker = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || worker.delete_login_sync())
        .await
        .map_err(|_| Failure::Persistence.message())?
        .map_err(Failure::message)?;
    let status = state.lock().map_err(Failure::message)?.status();
    Ok(status)
}

#[tauri::command]
pub async fn sakai_begin_login(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    main_window(&window)?;
    let state = app.state::<SakaiState>();
    let generation = {
        let mut session = state.lock().map_err(Failure::message)?;
        if session.connected {
            return Err("Sakai ist bereits verbunden".into());
        }
        if session.login {
            let login = session.login_window.clone();
            drop(session);
            if let Some(login) = login {
                login.show().map_err(|_| Failure::Busy.message())?;
                return login.set_focus().map_err(|_| Failure::Busy.message());
            }
            return Err(Failure::Busy.message());
        }
        if session.remember_session || session.persistence_error {
            session.forget_pending = true;
            session.marker_revoked = false;
        }
        let generation = session.reset().map_err(Failure::message)?;
        session.login = true;
        generation
    };
    // Retire an earlier saved session before accepting a new login generation.
    let _ = state.forget().await;
    if state.lock().map_err(Failure::message)?.generation != generation {
        return Err(Failure::Cancelled.message());
    }
    let handle = app.clone();
    let created = tauri::async_runtime::spawn_blocking(move || {
        let login_url = checked_url(&format!("{ORIGIN}/portal/login")).map_err(Failure::message)?;
        WebviewWindowBuilder::new(
            &handle,
            format!("{LOGIN_WINDOW}-{generation}"),
            WebviewUrl::External(login_url),
        )
        .title("Sakai anmelden · sakai.mci4me.at")
        .inner_size(960.0, 760.0)
        .incognito(true)
        .devtools(false)
        .on_navigation(same_origin)
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_download(|_, _| false)
        .build()
        .map_err(|_| Failure::Busy.message())
    })
    .await
    .map_err(|_| Failure::Busy.message());
    let login = match created.and_then(|result| result) {
        Ok(login) => login,
        Err(error) => {
            state.invalidate(generation);
            return Err(error);
        }
    };
    let handle = app.clone();
    login.on_window_event(move |event| {
        if matches!(
            event,
            WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
        ) {
            handle.state::<SakaiState>().cancel_login(generation);
        }
    });
    let mut session = state.lock().map_err(Failure::message)?;
    if session.generation != generation {
        drop(session);
        let _ = login.destroy();
        return Err(Failure::Cancelled.message());
    }
    session.login_window = Some(login);
    Ok(())
}

fn login_landing(url: &Url) -> bool {
    same_origin(url)
        && (url.path() == "/portal"
            || url.path() == "/portal/"
            || url
                .path()
                .strip_prefix("/portal/site/")
                .is_some_and(|site| !site.is_empty()))
}

async fn validate_session(state: &SakaiState, generation: u64) -> Result<(), Failure> {
    let collection: SiteCollection = json(
        state,
        generation,
        endpoint(
            "/direct/site.json",
            &[("_limit", "1".into()), ("_start", "0".into())],
        )?,
    )
    .await?;
    if collection.site_collection.len() > 1
        || collection
            .site_collection
            .iter()
            .any(|site| !valid_site(site))
    {
        return Err(Failure::Schema);
    }
    Ok(())
}

async fn restore_session(state: &SakaiState, generation: u64) -> Result<(), Failure> {
    let worker = state.clone();
    tauri::async_runtime::spawn_blocking(move || worker.load_saved_sync(generation))
        .await
        .map_err(|_| Failure::Persistence)??;
    let has_client = {
        let session = state.lock()?;
        if session.generation != generation {
            return Err(Failure::Cancelled);
        }
        session.client.is_some()
    };
    if !has_client {
        return Ok(());
    }
    if let Err(error) = validate_session(state, generation).await {
        let mut session = state.lock()?;
        if session.generation == generation {
            session.cookies.clear();
            session.client = None;
        }
        return Err(error);
    }
    state.lock()?.complete_login(generation)?;
    state.persist(generation, false).await
}

async fn connect(state: &SakaiState, poll: bool) -> Result<SakaiStatus, Failure> {
    let requested_generation = state.lock()?.generation;
    let _request = state.requests.lock().await;
    let login = {
        let mut session = state.lock()?;
        if session.generation != requested_generation {
            return Err(Failure::Cancelled);
        }
        if session.connected || (poll && !session.login) {
            return Ok(session.status());
        }
        if session.login && session.login_window.is_none() {
            return Ok(session.status());
        }
        if !session.login {
            session.restore_attempted = true;
        }
        session.login_window.clone()
    };
    let generation = requested_generation;
    let Some(login) = login else {
        restore_session(state, generation).await?;
        return Ok(state.lock()?.status());
    };
    let cookie_window = login.clone();
    let cookies = tauri::async_runtime::spawn_blocking(move || {
        let url = cookie_window.url().map_err(|_| Failure::Response)?;
        if !login_landing(&url) {
            return Ok(None);
        }
        let cookies = cookie_window.cookies().map_err(|_| Failure::Response)?;
        // Navigation can race the asynchronous WK cookie enumeration.
        if !login_landing(&cookie_window.url().map_err(|_| Failure::Response)?) {
            return Ok(None);
        }
        Ok::<_, Failure>(Some(cookies))
    })
    .await;
    if state.lock()?.generation != generation {
        return Err(Failure::Cancelled);
    }
    let Some(cookies) = cookies.map_err(|_| Failure::Response)?? else {
        return Ok(state.lock()?.status());
    };
    let now = SystemTime::now();
    let cookies: Vec<_> = cookies
        .into_iter()
        .filter(|cookie| {
            cookie
                .domain()
                .is_some_and(|domain| domain.eq_ignore_ascii_case(HOST))
        })
        .map(|cookie| stored_cookie(cookie, None, now))
        .collect::<Result<_, _>>()?;
    if cookies.is_empty() {
        return Ok(state.lock()?.status());
    }
    if cookies.len() > MAX_COOKIES {
        return Err(Failure::Limit);
    }
    let client = http_client()?;
    {
        let mut session = state.lock()?;
        if session.generation != generation {
            return Err(Failure::Cancelled);
        }
        if !session.login {
            return Err(Failure::Disconnected);
        }
        session.cookies = cookies;
        session.client = Some(client);
        session.persistence_dirty = true;
        session.retained_from = Some(now);
        session.retain_until = now.checked_add(MAX_RETENTION);
    }
    if let Err(error) = validate_session(state, generation).await {
        let mut session = state.lock()?;
        if session.generation != generation {
            return Err(Failure::Cancelled);
        }
        session.cookies.clear();
        session.client = None;
        if error == Failure::Expired {
            return Ok(session.status());
        }
        return Err(error);
    }
    let window = state.lock()?.complete_login(generation)?;
    destroy_login(window);
    state.persist(generation, true).await?;
    Ok(state.lock()?.status())
}

#[tauri::command]
pub async fn sakai_connect(app: AppHandle, window: WebviewWindow) -> Result<SakaiStatus, String> {
    main_window(&window)?;
    connect(&app.state::<SakaiState>(), false)
        .await
        .map_err(Failure::message)
}

#[tauri::command]
pub async fn sakai_poll_login(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<SakaiStatus, String> {
    main_window(&window)?;
    connect(&app.state::<SakaiState>(), true)
        .await
        .map_err(Failure::message)
}

#[tauri::command]
pub async fn sakai_disconnect(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    main_window(&window)?;
    let state = app.state::<SakaiState>();
    let window = {
        let mut session = state.lock().map_err(Failure::message)?;
        let window = session.login_window.take();
        session.revoke().map_err(Failure::message)?;
        session.cancel_auto_login();
        session.reset().map_err(Failure::message)?;
        window
    };
    destroy_login(window);
    let forgotten = state.forget().await;
    // Disconnecting must also stop silent sign-in, otherwise the next check reconnects.
    let worker = state.inner().clone();
    let deleted = tauri::async_runtime::spawn_blocking(move || worker.delete_login_sync())
        .await
        .map_err(|_| Failure::Persistence)
        .and_then(|result| result);
    forgotten.and(deleted).map_err(Failure::message)
}

#[tauri::command]
pub async fn sakai_set_remember_session(
    app: AppHandle,
    window: WebviewWindow,
    remember: bool,
) -> Result<SakaiStatus, String> {
    main_window(&window)?;
    let state = app.state::<SakaiState>();
    let (generation, connected) = {
        let mut session = state.lock().map_err(Failure::message)?;
        // A preference change invalidates in-flight storage work, not the login window.
        session.revoke().map_err(Failure::message)?;
        session.remember_session = remember;
        session.restore_attempted = true;
        if remember {
            session.persistence_dirty = true;
            if session.retained_from.is_none() {
                let now = SystemTime::now();
                session.retained_from = Some(now);
                session.retain_until = now.checked_add(MAX_RETENTION);
            }
        }
        (session.generation, session.connected)
    };
    let forgotten = state.forget().await;
    if remember && connected && forgotten.is_ok() {
        let _request = state.requests.lock().await;
        state
            .persist(generation, true)
            .await
            .map_err(Failure::message)?;
    }
    let status = state.lock().map_err(Failure::message)?.status();
    Ok(status)
}

#[tauri::command]
pub async fn sakai_status(app: AppHandle, window: WebviewWindow) -> Result<SakaiStatus, String> {
    main_window(&window)?;
    status(&app.state::<SakaiState>())
        .await
        .map_err(Failure::message)
}

async fn status(state: &SakaiState) -> Result<SakaiStatus, Failure> {
    let generation = state.lock()?.generation;
    let _request = state.requests.lock().await;
    let retry_auto_login = {
        let mut session = state.lock()?;
        if session.generation != generation {
            return Err(Failure::Cancelled);
        }
        if session.login || session.connected {
            return Ok(session.status());
        }
        if session.restore_attempted && !session.auto_login_due(Instant::now()) {
            return Ok(session.status());
        }
        let retry = session.restore_attempted;
        session.restore_attempted = true;
        retry
    };
    if retry_auto_login {
        // A failed silent sign-in leaves the app offline; the next check retries.
        let _ = try_auto_login(state, generation, false).await;
        return Ok(state.lock()?.status());
    }
    match restore_session(state, generation).await {
        Ok(()) | Err(Failure::Network | Failure::Expired) => {}
        Err(Failure::Persistence) => {
            state.lock()?.persistence_error = true;
        }
        Err(error) => return Err(error),
    }
    let generation = state.lock()?.generation;
    let _ = try_auto_login(state, generation, true).await;
    Ok(state.lock()?.status())
}

fn valid_site(site: &SakaiSite) -> bool {
    valid_id(&site.id) && !site.title.is_empty() && site.title.len() <= 4096
}

fn append_sites(
    sites: &mut Vec<SakaiSite>,
    ids: &mut HashSet<String>,
    page: Vec<SakaiSite>,
    limit: usize,
) -> Result<bool, Failure> {
    if page.len() > limit || page.len() > MAX_SITES.saturating_sub(sites.len()) {
        return Err(Failure::Limit);
    }
    let finished = page.is_empty();
    for site in page {
        if !valid_site(&site) || !ids.insert(site.id.clone()) {
            return Err(Failure::Schema);
        }
        sites.push(site);
    }
    Ok(finished)
}

async fn sites(app: &AppHandle) -> Result<Vec<SakaiSite>, Failure> {
    let state = app.state::<SakaiState>();
    let generation = state.lock()?.active()?;
    let _request = state.requests.lock().await;
    state.lock()?.check(generation)?;
    let mut sites = Vec::new();
    let mut ids = HashSet::new();
    let mut requests = 0;
    loop {
        requests += 1;
        if requests > MAX_SITES + 1 {
            return Err(Failure::Limit);
        }
        let limit = PAGE_SIZE.min(MAX_SITES.saturating_sub(sites.len())).max(1);
        let url = endpoint(
            "/direct/site.json",
            &[
                ("_limit", limit.to_string()),
                ("_start", sites.len().to_string()),
            ],
        )?;
        let page: SiteCollection = json(&state, generation, url).await?;
        if append_sites(&mut sites, &mut ids, page.site_collection, limit)? {
            break;
        }
    }
    let mut session = state.lock()?;
    session.check(generation)?;
    session.sites = sites
        .iter()
        .map(|site| (site.id.clone(), site.clone()))
        .collect();
    session.pdfs.clear();
    Ok(sites)
}

#[tauri::command]
pub async fn sakai_sites(app: AppHandle, window: WebviewWindow) -> Result<Vec<SakaiSite>, String> {
    main_window(&window)?;
    sites(&app).await.map_err(Failure::message)
}

fn resource_url(site_id: &str, value: &str) -> Result<Url, Failure> {
    if !valid_id(site_id) {
        return Err(Failure::Denied);
    }
    let url = checked_url(value)?;
    if url.query().is_some()
        || !url
            .path()
            .starts_with(&format!("/access/content/group/{site_id}/"))
    {
        return Err(Failure::Denied);
    }
    let raw_path = value
        .split_once("://")
        .and_then(|(_, rest)| rest.split_once('/'))
        .map(|(_, path)| path)
        .ok_or(Failure::Denied)?;
    if raw_path
        .split('/')
        .any(|segment| !safe_path_segment(segment))
    {
        return Err(Failure::Denied);
    }
    Ok(url)
}

fn safe_path_segment(segment: &str) -> bool {
    let mut decoded = segment.as_bytes().to_vec();
    for _ in 0..8 {
        if decoded == b"."
            || decoded == b".."
            || decoded
                .iter()
                .any(|b| b.is_ascii_control() || b"/\\;".contains(b))
        {
            return false;
        }
        let mut next = Vec::new();
        let mut index = 0;
        let mut changed = false;
        while index < decoded.len() {
            if decoded[index] == b'%' && index + 2 < decoded.len() {
                let high = (decoded[index + 1] as char).to_digit(16);
                let low = (decoded[index + 2] as char).to_digit(16);
                if let (Some(high), Some(low)) = (high, low) {
                    next.push((high * 16 + low) as u8);
                    index += 3;
                    changed = true;
                    continue;
                }
            }
            next.push(decoded[index]);
            index += 1;
        }
        if !changed {
            return true;
        }
        decoded = next;
    }
    false
}

fn released(date: &Option<ReleaseDate>, now: SystemTime) -> Result<bool, Failure> {
    let millis = match date {
        None => return Ok(true),
        Some(ReleaseDate::Millis(value)) => *value,
        Some(ReleaseDate::Text(value)) if value.is_empty() => return Ok(true),
        Some(ReleaseDate::Text(_)) => return Err(Failure::Schema),
    };
    if millis > 253402300799999 {
        return Err(Failure::Schema);
    }
    Ok(millis as u128
        <= now
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_err(|_| Failure::Schema)?
            .as_millis())
}

fn lesson_link(site_id: &str, value: Option<&str>) -> Result<String, Failure> {
    let base = format!("{ORIGIN}/portal/site/{site_id}");
    let Some(value) = value else { return Ok(base) };
    let Ok(url) = checked_url(value) else {
        return Ok(base);
    };
    let path = format!("/portal/site/{site_id}");
    if url.query().is_none()
        && path_matches(&path, url.path())
        && url.path().split('/').all(safe_path_segment)
    {
        Ok(url.to_string())
    } else {
        Ok(base)
    }
}

fn collect_lesson(
    node: LessonNode,
    site_id: &str,
    root_title: &str,
    depth: usize,
    budget: &mut LessonBudget,
    lessons: &mut Vec<SakaiLesson>,
    visible: bool,
) -> Result<(), Failure> {
    budget.nodes += 1;
    if budget.nodes > MAX_LESSON_NODES || depth > MAX_LESSON_DEPTH {
        return Err(Failure::Limit);
    }
    if node.id == 0 {
        return Err(Failure::Schema);
    }
    let visible = visible
        && matches!(node.kind, 2 | 5 | 14)
        && node.hidden != Some(true)
        && released(&node.release_date, SystemTime::now())?;
    if let Some(html) = node.html.filter(|html| !html.trim().is_empty()) {
        let title = node
            .name
            .as_deref()
            .filter(|name| !name.is_empty())
            .unwrap_or(root_title);
        budget.text_bytes = budget
            .text_bytes
            .saturating_add(title.len())
            .saturating_add(html.len());
        if budget.text_bytes > MAX_LESSON_TEXT {
            return Err(Failure::Limit);
        }
        if visible && node.kind == 5 {
            lessons.push(SakaiLesson {
                title: title.into(),
                html,
                url: lesson_link(site_id, node.url.as_deref())?,
            });
        }
    }
    for child in node.contents_list.unwrap_or_default() {
        collect_lesson(
            child,
            site_id,
            root_title,
            depth + 1,
            budget,
            lessons,
            visible,
        )?;
    }
    Ok(())
}

async fn lessons(
    state: &SakaiState,
    generation: u64,
    site_id: &str,
) -> Result<Vec<SakaiLesson>, Failure> {
    let roots: LessonsCollection = json(
        state,
        generation,
        endpoint(&format!("/direct/lessons/site/{site_id}.json"), &[])?,
    )
    .await?;
    if roots.lessons_collection.len() > 50 {
        return Err(Failure::Limit);
    }
    let mut ids = HashSet::new();
    let mut lessons = Vec::new();
    let mut budget = LessonBudget::default();
    for root in roots.lessons_collection {
        if root.id == 0 || !ids.insert(root.id) {
            return Err(Failure::Schema);
        }
        if root.hidden || !released(&root.release_date, SystemTime::now())? {
            continue;
        }
        let tree: LessonNode = json(
            state,
            generation,
            endpoint(
                &format!("/direct/lessons/lesson/{}.json", root.id),
                &[("fullTree", "true".into())],
            )?,
        )
        .await?;
        if tree.id != root.id {
            return Err(Failure::Schema);
        }
        collect_lesson(
            tree,
            site_id,
            &root.lesson_title,
            1,
            &mut budget,
            &mut lessons,
            true,
        )?;
    }
    Ok(lessons)
}

#[derive(Clone, Copy)]
enum SnapshotStage {
    Site,
    Announcements,
    Resources,
    Lessons,
}

impl SnapshotStage {
    fn message(self, failure: Failure) -> String {
        if matches!(
            failure,
            Failure::Disconnected | Failure::Expired | Failure::Cancelled
        ) {
            return failure.message();
        }
        let stage = match self {
            Self::Site => "site",
            Self::Announcements => "announcements",
            Self::Resources => "resources",
            Self::Lessons => "lessons",
        };
        format!("SAKAI_SNAPSHOT:{stage}:{}", failure.message())
    }
}

async fn snapshot(app: &AppHandle, site_id: &str) -> Result<SakaiSnapshot, String> {
    let mut stage = SnapshotStage::Site;
    let result: Result<SakaiSnapshot, Failure> = async {
        let state = app.state::<SakaiState>();
        let generation = state.lock()?.active()?;
        let _request = state.requests.lock().await;
        {
            let mut session = state.lock()?;
            session.check(generation)?;
            if !session.sites.contains_key(site_id) {
                return Err(Failure::Denied);
            }
            session.pdfs.retain(|(id, _)| id != site_id);
        }
        let details: SiteDetails = json(
            &state,
            generation,
            endpoint(&format!("/direct/site/{site_id}.json"), &[])?,
        )
        .await?;
        if details.site.id != site_id || !valid_site(&details.site) {
            return Err(Failure::Schema);
        }
        stage = SnapshotStage::Announcements;
        let mut warnings = Vec::new();
        let announcement_url = endpoint(
            &format!("/direct/announcement/site/{site_id}.json"),
            &[("n", "200".into()), ("d", "365".into()), ("a", "0".into())],
        )?;
        let announcements: AnnouncementCollection = json(&state, generation, announcement_url).await?;
        let announcements = announcements.announcement_collection;
        if announcements.len() > 200 {
            return Err(Failure::Limit);
        }
        if announcements
            .iter()
            .any(|item| item.id.is_empty() || item.id.len() > 256 || item.created_on < 0)
        {
            return Err(Failure::Schema);
        }
        if announcements.len() == 200 {
            warnings.push("Die Obergrenze von 200 Ankündigungen wurde erreicht; ältere Einträge fehlen möglicherweise.".into());
        }
        stage = SnapshotStage::Resources;
        state.lock()?.check(generation)?;
        let content_url = endpoint(&format!("/direct/content/site/{site_id}.json"), &[])?;
        let content: ContentCollection = json(&state, generation, content_url).await?;
        let resources = admit_resources(site_id, content)?;
        stage = SnapshotStage::Lessons;
        let pages: Vec<SitePage> = json(
            &state,
            generation,
            endpoint(&format!("/direct/site/{site_id}/pages.json"), &[])?,
        )
        .await?;
        let lessons = if has_lessons(site_id, &pages)? {
            lessons(&state, generation, site_id).await?
        } else {
            Vec::new()
        };
        stage = SnapshotStage::Resources;
        let mut session = state.lock()?;
        session.check(generation)?;
        session.pdfs.retain(|(id, _)| id != site_id);
        for resource in &resources {
            if resource.kind.eq_ignore_ascii_case("application/pdf")
                && resource.size <= MAX_PDF_BYTES as u64
            {
                session.pdfs.insert((site_id.into(), resource.url.clone()));
            }
        }
        Ok(SakaiSnapshot {
            site: details.site,
            announcements,
            resources,
            lessons,
            warnings,
        })
    }
    .await;
    result.map_err(|failure| stage.message(failure))
}

fn admit_resources(
    site_id: &str,
    collection: ContentCollection,
) -> Result<Vec<SakaiResource>, Failure> {
    if collection.content_collection.len() > MAX_ITEMS {
        return Err(Failure::Limit);
    }
    let mut resources = Vec::new();
    for entry in collection.content_collection {
        if entry.hidden != Some(false)
            || entry.visible != Some(true)
            || entry.resource.kind == "collection"
        {
            continue;
        }
        let mut resource = entry.resource;
        if resource.title.is_empty() || resource.title.len() > 4096 || resource.kind.is_empty() {
            return Err(Failure::Schema);
        }
        resource.url = resource_url(site_id, &resource.url)?.to_string();
        resources.push(resource);
    }
    Ok(resources)
}

#[tauri::command]
pub async fn sakai_site_snapshot(
    app: AppHandle,
    window: WebviewWindow,
    site_id: String,
) -> Result<SakaiSnapshot, String> {
    main_window(&window)?;
    snapshot(&app, &site_id).await
}

async fn download_pdf(
    app: &AppHandle,
    site_id: &str,
    url: &str,
    max_bytes: usize,
) -> Result<(u64, Vec<u8>), String> {
    let state = app.state::<SakaiState>();
    let generation = state
        .lock()
        .map_err(Failure::message)?
        .active()
        .map_err(Failure::message)?;
    let _request = state.requests.lock().await;
    let url = resource_url(site_id, url).map_err(Failure::message)?;
    {
        let session = state.lock().map_err(Failure::message)?;
        session.check(generation).map_err(Failure::message)?;
        if !session.pdfs.contains(&(site_id.into(), url.to_string())) {
            return Err(Failure::Denied.message());
        }
    }
    let bytes = request_bytes(&state, generation, url, true, max_bytes)
        .await
        .map_err(Failure::message)?;
    Ok((generation, bytes))
}

#[tauri::command]
pub async fn sakai_download_pdf(
    app: AppHandle,
    window: WebviewWindow,
    root: String,
    site_id: String,
    url: String,
    max_bytes: usize,
) -> Result<SakaiPdfDownload, String> {
    main_window(&window)?;
    validate_pdf_max_bytes(max_bytes).map_err(Failure::message)?;
    let url = resource_url(&site_id, &url)
        .map_err(Failure::message)?
        .to_string();
    let (generation, bytes) = download_pdf(&app, &site_id, &url, max_bytes).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<SakaiState>();
        let session = state.lock().map_err(Failure::message)?;
        session.check(generation).map_err(Failure::message)?;
        session.active().map_err(Failure::message)?;
        if !session.pdfs.contains(&(site_id, url)) {
            return Err(Failure::Denied.message());
        }
        let vault = app.state::<super::VaultState>();
        let result = vault
            .lock()?
            .save_sakai_pdf(std::path::Path::new(&root), &bytes);
        session.check(generation).map_err(Failure::message)?;
        result.map(|path| SakaiPdfDownload::new(path, &bytes))
    })
    .await
    .map_err(|_| Failure::Response.message())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sakai_credentials::test_store::{MemorySecret, MemoryStore};

    #[test]
    fn snapshot_failures_identify_the_stage_with_static_messages() {
        assert_eq!(
            [
                SnapshotStage::Site.message(Failure::Denied),
                SnapshotStage::Announcements.message(Failure::Response),
                SnapshotStage::Resources.message(Failure::Schema),
                SnapshotStage::Lessons.message(Failure::Limit),
            ],
            [
                "SAKAI_SNAPSHOT:site:Sakai-Zugriff nicht freigegeben",
                "SAKAI_SNAPSHOT:announcements:Sakai meldet eine unerwartete Antwort",
                "SAKAI_SNAPSHOT:resources:Sakai-Antwort hat ein unbekanntes Datenformat",
                "SAKAI_SNAPSHOT:lessons:Sakai-Daten überschreiten die Sicherheitsgrenze; Ergebnis unvollständig",
            ]
        );
    }

    #[test]
    fn snapshot_failures_preserve_session_control_messages() {
        assert_eq!(
            [
                SnapshotStage::Site.message(Failure::Disconnected),
                SnapshotStage::Announcements.message(Failure::Expired),
                SnapshotStage::Resources.message(Failure::Cancelled),
                SnapshotStage::Lessons.message(Failure::Cancelled),
            ],
            [
                "SAKAI_AUTH_REQUIRED",
                "SAKAI_AUTH_REQUIRED",
                "SAKAI_CANCELLED",
                "SAKAI_CANCELLED",
            ]
        );
    }

    fn memory_state(store: &MemoryStore) -> SakaiState {
        SakaiState {
            store: Arc::new(store.clone()),
            ..SakaiState::default()
        }
    }

    fn synthetic_saved() -> SavedSession {
        let now = SystemTime::now();
        SavedSession {
            version: 1,
            origin: ORIGIN.into(),
            created_at: now,
            retain_until: now + MAX_RETENTION,
            cookies: vec![
                SessionCookie {
                    name: "session".into(),
                    value: "synthetic-session".into(),
                    path: "/".into(),
                    secure: true,
                    expires: None,
                },
                SessionCookie {
                    name: "route".into(),
                    value: "synthetic-route".into(),
                    path: "/".into(),
                    secure: true,
                    expires: Some(now + Duration::from_secs(3600)),
                },
            ],
        }
    }

    fn authenticate_synthetic(state: &SakaiState) {
        let saved = synthetic_saved();
        let mut session = state.lock().unwrap();
        session.client = Some(http_client().unwrap());
        session.connected = true;
        session.remember_session = true;
        session.cookies = saved.cookies;
        session.retained_from = Some(saved.created_at);
        session.retain_until = Some(saved.retain_until);
        session.persistence_dirty = true;
    }

    #[test]
    fn status_is_exact_camel_case_and_contains_no_session_secrets() {
        let state = SakaiState::default();
        authenticate_synthetic(&state);
        assert_eq!(
            serde_json::to_value(state.lock().unwrap().status()).unwrap(),
            serde_json::json!({
                "connected": true, "loginOpen": false, "rememberSession": true, "persistenceError": false,
                "autoLogin": false, "autoLoginRejected": false
            })
        );
    }

    #[test]
    fn login_credentials_reject_malformed_input_and_encode_form_safely() {
        assert!(LoginCredentials::new("ab1234@mci4me.at", "").is_err());
        assert!(LoginCredentials::new("", "secret").is_err());
        assert!(LoginCredentials::new("ab 1234@mci4me.at", "secret").is_err());
        assert!(LoginCredentials::new("ab1234@mci4me.at", "line\nbreak").is_err());
        let credentials = LoginCredentials::new("  ab1234@mci4me.at ", "p&w=+ ü").unwrap();
        assert_eq!(credentials.eid, "ab1234@mci4me.at");
        assert_eq!(
            credentials.form_body(),
            "eid=ab1234%40mci4me.at&pw=p%26w%3D%2B+%C3%BC&submit=Log+in"
        );
        let decoded = LoginCredentials::decode(&credentials.encode().unwrap()).unwrap();
        assert_eq!((decoded.eid, decoded.pw), (credentials.eid, credentials.pw));
        assert!(LoginCredentials::decode(br#"{"version":2,"eid":"a","pw":"b"}"#).is_err());
    }

    #[test]
    fn auto_login_flags_survive_resets_and_respect_rejection_and_cooldown() {
        let mut session = Session {
            auto_login: true,
            ..Session::default()
        };
        let now = Instant::now();
        assert!(session.auto_login_due(now));
        session.last_auto_login = Some(now);
        assert!(!session.auto_login_due(now + Duration::from_secs(5)));
        assert!(session.auto_login_due(now + AUTO_LOGIN_COOLDOWN));
        session.auto_login_rejected = true;
        session.reset().unwrap();
        assert!(session.auto_login && session.auto_login_rejected);
        assert!(!session.auto_login_due(now + AUTO_LOGIN_COOLDOWN));
    }

    #[test]
    fn startup_without_stored_credentials_disables_auto_login_without_network() {
        let secret = MemorySecret::default();
        let state = SakaiState {
            login_store: Arc::new(secret.clone()),
            ..SakaiState::default()
        };
        state.lock().unwrap().auto_login = true;
        let status = tauri::async_runtime::block_on(status(&state)).unwrap();
        assert!(!status.connected && !status.auto_login && !status.auto_login_rejected);
    }

    #[test]
    fn persisted_rejection_blocks_startup_login_without_network() {
        let secret = MemorySecret::default();
        let mut credentials = LoginCredentials::new("ab1234@mci4me.at", "old-password").unwrap();
        credentials.rejected = true;
        *secret.0.lock().unwrap() = Some(credentials.encode().unwrap());
        let state = SakaiState {
            login_store: Arc::new(secret),
            ..SakaiState::default()
        };
        let status = tauri::async_runtime::block_on(status(&state)).unwrap();
        assert!(status.auto_login && status.auto_login_rejected && !status.connected);
    }

    #[test]
    fn cancelled_auto_login_cannot_store_credentials_afterwards() {
        let secret = MemorySecret::default();
        let state = SakaiState {
            login_store: Arc::new(secret.clone()),
            ..SakaiState::default()
        };
        let epoch = state.lock().unwrap().cancel_auto_login();
        state.lock().unwrap().cancel_auto_login();
        let credentials = LoginCredentials::new("ab1234@mci4me.at", "secret").unwrap();
        assert_eq!(
            state.write_login_sync(&credentials, epoch).unwrap_err(),
            Failure::Cancelled
        );
        assert!(secret.0.lock().unwrap().is_none());
        let current = state.lock().unwrap().auto_login_epoch;
        state.write_login_sync(&credentials, current).unwrap();
        assert!(secret.0.lock().unwrap().is_some());
    }

    #[test]
    fn rejected_auto_login_is_not_retried_by_status_checks() {
        let secret = MemorySecret::default();
        *secret.0.lock().unwrap() = Some(
            LoginCredentials::new("ab1234@mci4me.at", "secret")
                .unwrap()
                .encode()
                .unwrap(),
        );
        let state = SakaiState {
            login_store: Arc::new(secret),
            ..SakaiState::default()
        };
        {
            let mut session = state.lock().unwrap();
            session.restore_attempted = true;
            session.auto_login = true;
            session.auto_login_rejected = true;
        }
        let status = tauri::async_runtime::block_on(status(&state)).unwrap();
        assert!(status.auto_login && status.auto_login_rejected && !status.connected);
        assert!(state.lock().unwrap().last_auto_login.is_none());
    }

    #[test]
    fn absent_or_invalid_opt_in_never_reads_keychain_and_status_restores_only_once() {
        for invalid in [false, true] {
            let store = MemoryStore::default();
            store.0.lock().unwrap().fail_marker = invalid;
            store.0.lock().unwrap().bytes =
                Some(synthetic_saved().encode(SystemTime::now()).unwrap());
            let state = memory_state(&store);
            let status = tauri::async_runtime::block_on(status(&state)).unwrap();
            assert!(!status.connected && !status.remember_session && !status.login_open);
            assert_eq!(status.persistence_error, invalid);
            tauri::async_runtime::block_on(super::status(&state)).unwrap();
            assert_eq!(store.0.lock().unwrap().events, ["marker"]);
        }
    }

    #[test]
    fn opt_in_roundtrip_keeps_session_cookies_original_expiries_and_retention() {
        let store = MemoryStore::default();
        let state = memory_state(&store);
        authenticate_synthetic(&state);
        let original = state.lock().unwrap().cookies.clone();
        let retained_from = state.lock().unwrap().retained_from;
        state.persist_sync(0, 0).unwrap();
        assert_eq!(store.0.lock().unwrap().events, ["write", "enable"]);
        let restored = memory_state(&store);
        restored.load_saved_sync(0).unwrap();
        let session = restored.lock().unwrap();
        assert!(session.remember_session);
        assert!(
            !session.connected,
            "A stored cookie is not proof of server authentication"
        );
        assert!(session.cookies == original);
        assert_eq!(session.retained_from, retained_from);
        assert!(session.cookies[0].expires.is_none());
        drop(session);
        let bytes = store.0.lock().unwrap().bytes.clone().unwrap();
        let saved = SavedSession::decode(&bytes, SystemTime::now()).unwrap();
        assert_eq!(saved.retain_until, retained_from.unwrap() + MAX_RETENTION);
    }

    #[test]
    fn saved_sessions_reject_version_origin_expiry_and_malformed_cookies() {
        let valid = synthetic_saved();
        let now = valid.created_at;
        assert!(valid.validate(now).is_ok());
        let mut invalid = valid.clone();
        invalid.version = 2;
        assert_eq!(invalid.validate(now), Err(Failure::Schema));
        invalid = valid.clone();
        invalid.origin = "https://sakai.mci4me.at.evil.invalid".into();
        assert_eq!(invalid.validate(now), Err(Failure::Schema));
        invalid = valid.clone();
        invalid.retain_until += Duration::from_nanos(1);
        assert_eq!(invalid.validate(now), Err(Failure::Schema));
        assert_eq!(valid.validate(valid.retain_until), Err(Failure::Expired));
        assert_eq!(
            valid.validate(now - Duration::from_secs(1)),
            Err(Failure::Schema)
        );
        invalid = valid.clone();
        invalid.cookies[1].expires = Some(now);
        assert_eq!(invalid.validate(now), Err(Failure::Expired));
        for (name, value, path) in [
            ("bad=name", "value", "/"),
            ("ok", "bad; injected=1", "/"),
            ("ok", "value", "relative"),
            ("ok", "value", "/\r\n"),
        ] {
            invalid = valid.clone();
            invalid.cookies[0].name = name.into();
            invalid.cookies[0].value = value.into();
            invalid.cookies[0].path = path.into();
            assert_eq!(invalid.validate(now), Err(Failure::Schema));
        }
        invalid = valid.clone();
        invalid.cookies.push(invalid.cookies[0].clone());
        assert_eq!(invalid.validate(now), Err(Failure::Schema));
        for bytes in [b"{}".as_slice(), b"not-json", b"[]"] {
            assert!(SavedSession::decode(bytes, now).is_err());
        }
        let mut document = serde_json::to_value(&valid).unwrap();
        document["cookies"][0]["domain"] = serde_json::json!("mci4me.at");
        assert!(SavedSession::decode(&serde_json::to_vec(&document).unwrap(), now).is_err());
    }

    #[test]
    fn rotation_never_extends_a_restored_local_deadline() {
        let store = MemoryStore::default();
        let mut saved = synthetic_saved();
        saved.retain_until = saved.created_at + Duration::from_secs(600);
        store.0.lock().unwrap().enabled = true;
        store.0.lock().unwrap().bytes = Some(saved.encode(SystemTime::now()).unwrap());
        let state = memory_state(&store);
        state.load_saved_sync(0).unwrap();
        {
            let mut session = state.lock().unwrap();
            session.complete_login(0).unwrap();
            session.cookies[0].value = "synthetic-rotation".into();
        }
        state.persist_sync(0, 0).unwrap();
        let bytes = store.0.lock().unwrap().bytes.clone().unwrap();
        assert_eq!(
            SavedSession::decode(&bytes, SystemTime::now())
                .unwrap()
                .retain_until,
            saved.retain_until
        );
    }

    #[test]
    fn redirects_to_login_expire_auth_but_other_redirects_do_not() {
        let url = endpoint("/direct/site.json", &[]).unwrap();
        for target in [
            "/portal/login",
            "/portal/relogin?reason=expired",
            "https://sakai.mci4me.at/login",
        ] {
            let location = HeaderValue::from_str(target).unwrap();
            assert!(login_redirect(&url, StatusCode::FOUND, Some(&location)));
            assert!(!login_redirect(&url, StatusCode::OK, Some(&location)));
        }
        for target in [
            "https://other.invalid/portal/login",
            "http://sakai.mci4me.at/portal/login",
            "/portal",
            "/access/content",
        ] {
            assert!(!login_redirect(
                &url,
                StatusCode::FOUND,
                Some(&HeaderValue::from_str(target).unwrap())
            ));
        }
        assert!(!login_redirect(&url, StatusCode::FOUND, None));
    }

    #[test]
    fn saved_session_cookie_count_and_serialized_size_are_bounded() {
        let mut saved = synthetic_saved();
        let now = saved.created_at;
        saved.cookies.clear();
        assert!(saved.validate(now).is_err());
        for i in 0..MAX_COOKIES {
            saved.cookies.push(SessionCookie {
                name: format!("cookie{i}"),
                value: "synthetic".into(),
                path: "/".into(),
                secure: true,
                expires: None,
            });
        }
        assert!(saved.encode(now).is_ok());
        saved.cookies.push(SessionCookie {
            name: "overflow".into(),
            value: "synthetic".into(),
            path: "/".into(),
            secure: true,
            expires: None,
        });
        assert!(saved.encode(now).is_err());
        let mut bytes = synthetic_saved().encode(SystemTime::now()).unwrap();
        bytes.resize(MAX_STORED_BYTES, b' ');
        assert!(SavedSession::decode(&bytes, SystemTime::now()).is_ok());
        bytes.push(b' ');
        assert!(matches!(
            SavedSession::decode(&bytes, SystemTime::now()),
            Err(Failure::Limit)
        ));
        saved.cookies.pop();
        for cookie in saved.cookies.iter_mut().skip(1) {
            cookie.path = format!("/portal/{}", "p".repeat(2000));
        }
        assert_eq!(saved.encode(now), Err(Failure::Limit));
    }

    #[test]
    fn failed_persistence_keeps_connection_but_reports_error_and_never_enables_marker() {
        let store = MemoryStore::default();
        let state = memory_state(&store);
        authenticate_synthetic(&state);
        store.0.lock().unwrap().fail_write = true;
        tauri::async_runtime::block_on(state.persist(0, true)).unwrap();
        let status = state.lock().unwrap().status();
        assert!(status.connected && status.remember_session && status.persistence_error);
        assert!(!store.0.lock().unwrap().enabled);
        assert_eq!(store.0.lock().unwrap().events, ["write"]);
        tauri::async_runtime::block_on(state.persist(0, false)).unwrap();
        assert_eq!(store.0.lock().unwrap().events, ["write"]);
        store.0.lock().unwrap().fail_write = false;
        tauri::async_runtime::block_on(state.persist(0, true)).unwrap();
        assert!(!state.lock().unwrap().persistence_error);
        assert!(store.0.lock().unwrap().enabled);
    }

    #[test]
    fn denied_keychain_read_keeps_opt_in_visible_without_assuming_authentication() {
        let store = MemoryStore::default();
        store.0.lock().unwrap().enabled = true;
        store.0.lock().unwrap().fail_read = true;
        let state = memory_state(&store);
        let status = tauri::async_runtime::block_on(status(&state)).unwrap();
        assert!(status.remember_session && status.persistence_error);
        assert!(!status.connected && !status.login_open);
        assert_eq!(store.0.lock().unwrap().events, ["marker", "read"]);
        assert!(store.0.lock().unwrap().enabled);
    }

    #[test]
    fn malformed_or_locally_expired_storage_is_revoked_before_use() {
        let mut expired = synthetic_saved();
        expired.created_at -= MAX_RETENTION;
        expired.retain_until -= MAX_RETENTION;
        for bytes in [
            b"not-json".to_vec(),
            vec![b'x'; MAX_STORED_BYTES + 1],
            serde_json::to_vec(&expired).unwrap(),
        ] {
            let store = MemoryStore::default();
            store.0.lock().unwrap().enabled = true;
            store.0.lock().unwrap().bytes = Some(bytes);
            let state = memory_state(&store);
            state.load_saved_sync(0).unwrap();
            assert!(!state.lock().unwrap().connected);
            assert!(!state.lock().unwrap().remember_session);
            assert!(state.lock().unwrap().cookies.is_empty());
            assert!(!store.0.lock().unwrap().enabled);
            assert_eq!(
                store.0.lock().unwrap().events,
                ["marker", "read", "disable", "delete"]
            );
        }
    }

    #[test]
    fn failed_delete_leaves_tombstone_and_can_be_retried_without_restoring_secrets() {
        let store = MemoryStore::default();
        let state = memory_state(&store);
        authenticate_synthetic(&state);
        state.persist_sync(0, 0).unwrap();
        store.0.lock().unwrap().fail_delete = true;
        state.lock().unwrap().revoke().unwrap();
        state.clear_ram();
        assert_eq!(
            tauri::async_runtime::block_on(state.forget()),
            Err(Failure::Persistence)
        );
        assert!(state.lock().unwrap().persistence_error);
        assert!(!store.0.lock().unwrap().enabled);
        store.0.lock().unwrap().events.clear();
        let restarted = memory_state(&store);
        restarted.load_saved_sync(0).unwrap();
        assert!(!restarted.lock().unwrap().connected);
        assert_eq!(store.0.lock().unwrap().events, ["marker"]);
        store.0.lock().unwrap().fail_delete = false;
        tauri::async_runtime::block_on(state.forget()).unwrap();
        assert!(!state.lock().unwrap().persistence_error);
        assert!(store.0.lock().unwrap().bytes.is_none());
    }

    #[test]
    fn marker_failure_still_attempts_deletion_and_reports_retryable_error() {
        let store = MemoryStore::default();
        let state = memory_state(&store);
        authenticate_synthetic(&state);
        state.persist_sync(0, 0).unwrap();
        store.0.lock().unwrap().fail_marker = true;
        store.0.lock().unwrap().events.clear();
        state.lock().unwrap().revoke().unwrap();
        state.clear_ram();
        assert_eq!(
            tauri::async_runtime::block_on(state.forget()),
            Err(Failure::Persistence)
        );
        assert!(store.0.lock().unwrap().bytes.is_none());
        assert!(store.0.lock().unwrap().events.contains(&"delete"));
        assert!(state.lock().unwrap().persistence_error);
        assert!(state.lock().unwrap().forget_pending);
        store.0.lock().unwrap().fail_marker = false;
        tauri::async_runtime::block_on(state.forget()).unwrap();
        assert!(!store.0.lock().unwrap().enabled);
        assert!(!state.lock().unwrap().persistence_error);
    }

    #[test]
    fn revocation_disables_restore_before_blocked_keychain_io_finishes() {
        for reading in [true, false] {
            let store = MemoryStore::default();
            store.0.lock().unwrap().enabled = true;
            store.0.lock().unwrap().bytes =
                Some(synthetic_saved().encode(SystemTime::now()).unwrap());
            let state = memory_state(&store);
            if !reading {
                authenticate_synthetic(&state);
            }
            let (entered_tx, entered_rx) = std::sync::mpsc::channel();
            let (continue_tx, continue_rx) = std::sync::mpsc::channel();
            let blocked: Box<dyn FnOnce() + Send> = Box::new(move || {
                entered_tx.send(()).unwrap();
                continue_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            });
            if reading {
                store.0.lock().unwrap().during_read = Some(blocked);
            } else {
                store.0.lock().unwrap().during_write = Some(blocked);
            }
            let worker = state.clone();
            let operation = std::thread::spawn(move || {
                if reading {
                    worker.load_saved_sync(0)
                } else {
                    worker.persist_sync(0, 0)
                }
            });
            entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            state.lock().unwrap().revoke().unwrap();
            state.clear_ram();
            let (disabled_tx, disabled_rx) = std::sync::mpsc::channel();
            store.0.lock().unwrap().after_disable = Some(Box::new(move || {
                disabled_tx.send(()).unwrap();
            }));
            let worker = state.clone();
            let forget =
                std::thread::spawn(move || tauri::async_runtime::block_on(worker.forget()));
            disabled_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            assert!(!store.0.lock().unwrap().enabled);
            assert!(store.0.lock().unwrap().bytes.is_some());
            let restarted = memory_state(&store);
            restarted.load_saved_sync(0).unwrap();
            assert!(restarted.lock().unwrap().client.is_none());
            continue_tx.send(()).unwrap();
            assert_eq!(operation.join().unwrap(), Err(Failure::Cancelled));
            forget.join().unwrap().unwrap();
            assert!(store.0.lock().unwrap().bytes.is_none());
            assert!(!store.0.lock().unwrap().enabled);
        }
    }

    #[test]
    fn forget_during_a_blocked_save_cannot_reenable_the_marker() {
        let store = MemoryStore::default();
        let state = memory_state(&store);
        authenticate_synthetic(&state);
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (continue_tx, continue_rx) = std::sync::mpsc::channel();
        store.0.lock().unwrap().during_write = Some(Box::new(move || {
            entered_tx.send(()).unwrap();
            continue_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        }));
        let worker = state.clone();
        let save = std::thread::spawn(move || worker.persist_sync(0, 0));
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        state.lock().unwrap().revoke().unwrap();
        state.clear_ram();
        continue_tx.send(()).unwrap();
        assert_eq!(save.join().unwrap(), Err(Failure::Cancelled));
        assert!(!store.0.lock().unwrap().enabled);
        assert!(store.0.lock().unwrap().bytes.is_none());
        assert_eq!(
            store.0.lock().unwrap().events,
            ["write", "disable", "delete"]
        );
        assert!(!state.lock().unwrap().connected);
    }

    #[test]
    fn stale_restore_cannot_override_disconnect_new_login_or_opt_out() {
        for new_login in [false, true] {
            let store = MemoryStore::default();
            store.0.lock().unwrap().enabled = true;
            store.0.lock().unwrap().bytes =
                Some(synthetic_saved().encode(SystemTime::now()).unwrap());
            let state = memory_state(&store);
            let worker = state.clone();
            store.0.lock().unwrap().during_read = Some(Box::new(move || {
                let mut session = worker.lock().unwrap();
                session.revoke().unwrap();
                if new_login {
                    session.reset().unwrap();
                    session.login = true;
                }
            }));
            assert_eq!(state.load_saved_sync(0), Err(Failure::Cancelled));
            assert!(!state.lock().unwrap().remember_session);
            assert!(!state.lock().unwrap().connected);
            assert!(state.lock().unwrap().cookies.is_empty());
        }
    }

    #[test]
    fn shutdown_keeps_opted_in_store_but_clears_ram() {
        let store = MemoryStore::default();
        let state = memory_state(&store);
        authenticate_synthetic(&state);
        state.persist_sync(0, 0).unwrap();
        store.0.lock().unwrap().events.clear();
        state.clear_ram();
        assert!(store.0.lock().unwrap().enabled);
        assert!(store.0.lock().unwrap().bytes.is_some());
        assert!(store.0.lock().unwrap().events.is_empty());
        assert!(state.lock().unwrap().cookies.is_empty());
        assert!(state.lock().unwrap().client.is_none());
        assert!(!state.lock().unwrap().connected);
    }

    #[test]
    fn pending_login_auth_and_network_failures_leave_form_and_generation_intact() {
        for failure in [Failure::Expired, Failure::Network] {
            let store = MemoryStore::default();
            let state = memory_state(&store);
            authenticate_synthetic(&state);
            {
                let mut session = state.lock().unwrap();
                session.login = true;
                session.connected = false;
            }
            tauri::async_runtime::block_on(state.request_failed(0, failure)).unwrap();
            let status = state.lock().unwrap().status();
            assert!(status.login_open && !status.connected && status.remember_session);
            assert_eq!(state.lock().unwrap().generation, 0);
            assert!(store.0.lock().unwrap().events.is_empty());
        }
    }

    #[test]
    fn intentional_login_destroy_is_ignored_but_pending_close_cancels_generation() {
        let state = SakaiState::default();
        authenticate_synthetic(&state);
        state.lock().unwrap().login = true;
        state.lock().unwrap().complete_login(0).unwrap();
        state.cancel_login(0);
        assert!(state.lock().unwrap().connected);
        assert!(!state.lock().unwrap().login);
        assert_eq!(state.lock().unwrap().generation, 0);
        state.lock().unwrap().login = true;
        state.cancel_login(0);
        assert_eq!(state.lock().unwrap().generation, 1);
        assert!(!state.lock().unwrap().connected);
        assert!(matches!(
            state.lock().unwrap().complete_login(0),
            Err(Failure::Cancelled)
        ));
    }

    #[test]
    fn poll_during_window_creation_waits_without_keychain_or_cookie_access() {
        let store = MemoryStore::default();
        let state = memory_state(&store);
        state.lock().unwrap().login = true;
        let status = tauri::async_runtime::block_on(connect(&state, true)).unwrap();
        assert!(status.login_open && !status.connected);
        assert!(store.0.lock().unwrap().events.is_empty());
    }

    #[test]
    fn only_same_origin_portal_landings_allow_cookie_handoff() {
        for url in [
            "https://sakai.mci4me.at/portal",
            "https://sakai.mci4me.at/portal/",
            "https://sakai.mci4me.at/portal/site/course",
        ] {
            assert!(login_landing(&Url::parse(url).unwrap()));
        }
        for url in [
            "https://sakai.mci4me.at/portal/login",
            "https://sakai.mci4me.at/portal/relogin",
            "https://sakai.mci4me.at/login",
            "https://sakai.mci4me.at/portal/site/",
            "https://sakai.mci4me.at/portal/sites",
            "https://other.invalid/portal",
            "http://sakai.mci4me.at/portal",
            "https://sakai.mci4me.at:444/portal",
            "https://user@sakai.mci4me.at/portal",
        ] {
            assert!(!login_landing(&Url::parse(url).unwrap()));
        }
    }

    #[test]
    fn network_failure_keeps_saved_session_disconnected_and_auth_expiry_revokes_it() {
        for failure in [Failure::Network, Failure::Expired] {
            let store = MemoryStore::default();
            let state = memory_state(&store);
            authenticate_synthetic(&state);
            state.persist_sync(0, 0).unwrap();
            tauri::async_runtime::block_on(state.request_failed(0, failure)).unwrap();
            assert!(!state.lock().unwrap().connected);
            assert_eq!(store.0.lock().unwrap().enabled, failure == Failure::Network);
            assert_eq!(
                store.0.lock().unwrap().bytes.is_some(),
                failure == Failure::Network
            );
        }
    }

    #[test]
    fn unauthenticated_or_unchanged_cookies_never_overwrite_saved_session() {
        let store = MemoryStore::default();
        let state = memory_state(&store);
        authenticate_synthetic(&state);
        state.persist_sync(0, 0).unwrap();
        store.0.lock().unwrap().events.clear();
        tauri::async_runtime::block_on(state.persist(0, false)).unwrap();
        assert!(store.0.lock().unwrap().events.is_empty());
        {
            let mut session = state.lock().unwrap();
            session.connected = false;
            session.persistence_dirty = true;
        }
        tauri::async_runtime::block_on(state.persist(0, true)).unwrap();
        assert!(store.0.lock().unwrap().events.is_empty());
        {
            let mut session = state.lock().unwrap();
            session.connected = true;
            session.cookies[0].value = "rotated-synthetic".into();
        }
        tauri::async_runtime::block_on(state.persist(0, false)).unwrap();
        assert_eq!(store.0.lock().unwrap().events, ["write", "enable"]);
        let bytes = store.0.lock().unwrap().bytes.clone().unwrap();
        assert_eq!(
            SavedSession::decode(&bytes, SystemTime::now())
                .unwrap()
                .cookies[0]
                .value,
            "rotated-synthetic"
        );
    }

    #[test]
    fn requests_reject_other_origins_credentials_fragments_and_ports() {
        for url in [
            "http://sakai.mci4me.at/direct/site.json",
            "https://sakai.mci4me.at.evil.invalid/direct/site.json",
            "https://sakai.mci4me.at:444/direct/site.json",
            "https://user:secret@sakai.mci4me.at/direct/site.json",
            "https://sakai.mci4me.at/direct/site.json#private-token",
            "file:///private-token",
            "//sakai.mci4me.at/direct/site.json",
        ] {
            assert_eq!(checked_url(url).err(), Some(Failure::Denied));
        }
        assert!(checked_url("https://sakai.mci4me.at:443/direct/site.json").is_ok());
    }

    #[test]
    fn every_json_endpoint_requires_a_valid_session() {
        let url = endpoint("/direct/site.json", &[("_limit", "100".into())]).unwrap();
        assert_eq!(url.query(), Some("_limit=100&_validateSession=true"));
        assert!(endpoint("/portal/logout", &[]).is_err());
    }

    #[test]
    fn cookie_paths_observe_segment_boundaries_and_case() {
        assert!(path_matches("/", "/direct/site.json"));
        assert!(path_matches("/direct", "/direct/site.json"));
        assert!(path_matches("/direct", "/direct"));
        assert!(path_matches("/direct/", "/direct/site.json"));
        assert!(!path_matches("/direct", "/direct-other/site.json"));
        assert!(!path_matches("/Direct", "/direct/site.json"));
        assert!(!path_matches("/portal", "/direct/site.json"));
    }

    #[test]
    fn cookie_bridge_rejects_parent_domains_and_header_injection() {
        let now = SystemTime::now();
        let parent = Cookie::build(("session", "secret"))
            .domain("mci4me.at")
            .path("/")
            .build();
        assert!(matches!(
            stored_cookie(parent, None, now),
            Err(Failure::Denied)
        ));
        assert!(!valid_cookie_pair("session", "secret\r\nInjected: true"));
        assert!(!valid_cookie_pair("session", "secret; other=value"));
        assert!(!valid_cookie_pair("bad=name", "value"));
    }

    #[test]
    fn cookies_are_sorted_by_path_and_expired_cookies_are_excluded() {
        let now = SystemTime::now();
        let mut cookies = vec![
            stored_cookie(
                Cookie::build(("session", "root"))
                    .domain(HOST)
                    .path("/")
                    .secure(true)
                    .build(),
                None,
                now,
            )
            .unwrap(),
            stored_cookie(
                Cookie::build(("session", "direct"))
                    .domain(HOST)
                    .path("/direct")
                    .build(),
                None,
                now,
            )
            .unwrap(),
            stored_cookie(
                Cookie::build(("old", "expired"))
                    .domain(HOST)
                    .path("/")
                    .build(),
                None,
                now,
            )
            .unwrap(),
        ];
        cookies[2].expires = Some(now);
        let header = cookie_header(
            &cookies,
            &checked_url(&format!("{ORIGIN}/direct/site.json")).unwrap(),
            now,
        )
        .unwrap();
        assert_eq!(header.to_str().unwrap(), "session=direct; session=root");
        assert!(header.is_sensitive());
        assert!(cookie_header(
            &cookies,
            &Url::parse("http://sakai.mci4me.at/direct/site.json").unwrap(),
            now
        )
        .is_err());
    }

    #[test]
    fn response_cookies_can_rotate_and_delete_a_session_without_extending_scope() {
        let url = checked_url(&format!("{ORIGIN}/direct/site.json")).unwrap();
        let mut cookies = Vec::new();
        let mut headers = reqwest::header::HeaderMap::new();
        headers.append(
            SET_COOKIE,
            HeaderValue::from_static("session=first; Path=/; Secure; HttpOnly"),
        );
        update_cookies(&mut cookies, &headers, &url).unwrap();
        headers.insert(
            SET_COOKIE,
            HeaderValue::from_static("session=second; Path=/; Secure"),
        );
        update_cookies(&mut cookies, &headers, &url).unwrap();
        assert_eq!(
            cookie_header(&cookies, &url, SystemTime::now()).unwrap(),
            "session=second"
        );
        headers.insert(
            SET_COOKIE,
            HeaderValue::from_static("session=; Path=/; Max-Age=0"),
        );
        update_cookies(&mut cookies, &headers, &url).unwrap();
        assert!(matches!(
            cookie_header(&cookies, &url, SystemTime::now()),
            Err(Failure::Expired)
        ));
    }

    #[test]
    fn disconnect_and_old_failures_cannot_revive_or_reset_a_new_session() {
        let state = SakaiState::default();
        {
            let mut session = state.lock().unwrap();
            session.client = Some(http_client().unwrap());
            session.connected = true;
        }
        let old = state.lock().unwrap().active().unwrap();
        state.invalidate(old);
        assert_eq!(state.lock().unwrap().check(old), Err(Failure::Cancelled));
        {
            let mut session = state.lock().unwrap();
            session.client = Some(http_client().unwrap());
            session.connected = true;
        }
        let new = state.lock().unwrap().active().unwrap();
        state.invalidate(old);
        assert_eq!(state.lock().unwrap().active(), Ok(new));
    }

    #[test]
    fn bytes_are_bounded_before_allocation_and_exact_limit_is_allowed() {
        let mut bytes = Vec::new();
        append_bytes(&mut bytes, &[1, 2, 3], 3).unwrap();
        assert_eq!(append_bytes(&mut bytes, &[4], 3), Err(Failure::Limit));
        assert_eq!(bytes, [1, 2, 3]);
        assert_eq!(append_bytes(&mut Vec::new(), &[1], 0), Err(Failure::Limit));
    }

    #[test]
    fn pdf_budgets_require_one_byte_through_fifteen_mib_inclusive() {
        assert_eq!(MAX_PDF_BYTES, 15 * 1024 * 1024);
        assert_eq!(validate_pdf_max_bytes(0), Err(Failure::Limit));
        assert_eq!(validate_pdf_max_bytes(1), Ok(()));
        assert_eq!(validate_pdf_max_bytes(MAX_PDF_BYTES - 1), Ok(()));
        assert_eq!(validate_pdf_max_bytes(MAX_PDF_BYTES), Ok(()));
        assert_eq!(
            validate_pdf_max_bytes(MAX_PDF_BYTES + 1),
            Err(Failure::Limit)
        );
        assert_eq!(validate_pdf_max_bytes(usize::MAX), Err(Failure::Limit));
    }

    #[test]
    fn content_length_cannot_exceed_the_requested_pdf_budget() {
        assert_eq!(check_content_length(None, 5), Ok(()));
        assert_eq!(check_content_length(Some(0), 5), Ok(()));
        assert_eq!(check_content_length(Some(1), 1), Ok(()));
        assert_eq!(check_content_length(Some(5), 5), Ok(()));
        assert_eq!(check_content_length(Some(6), 5), Err(Failure::Limit));
        assert_eq!(
            check_content_length(Some(MAX_PDF_BYTES as u64), 5),
            Err(Failure::Limit)
        );
        assert_eq!(
            check_content_length(Some(u64::MAX), MAX_PDF_BYTES),
            Err(Failure::Limit)
        );
    }

    #[test]
    fn streamed_pdf_bytes_stop_at_the_budget_with_missing_or_small_content_length() {
        assert_eq!(check_content_length(None, 5), Ok(()));
        assert_eq!(check_content_length(Some(1), 5), Ok(()));
        let mut bytes = Vec::new();
        append_bytes(&mut bytes, b"%PDF", 5).unwrap();
        assert_eq!(append_bytes(&mut bytes, b"-1", 5), Err(Failure::Limit));
        assert_eq!(bytes, b"%PDF");
        append_bytes(&mut bytes, b"-", 5).unwrap();
        assert_eq!(append_bytes(&mut bytes, b"", 5), Ok(()));
        assert_eq!(append_bytes(&mut bytes, b"1", 5), Err(Failure::Limit));
        assert_eq!(bytes, b"%PDF-");
    }

    #[test]
    fn pdf_streams_allow_exactly_fifteen_mib_and_reject_the_next_byte() {
        let mut bytes = b"%PDF-".to_vec();
        append_bytes(&mut bytes, &vec![0; MAX_PDF_BYTES - 5], MAX_PDF_BYTES).unwrap();
        assert_eq!(bytes.len(), MAX_PDF_BYTES);
        assert_eq!(
            append_bytes(&mut bytes, &[0], MAX_PDF_BYTES),
            Err(Failure::Limit)
        );
        assert_eq!(bytes.len(), MAX_PDF_BYTES);
    }

    #[test]
    fn json_content_length_and_streams_remain_capped_at_five_mib() {
        assert_eq!(MAX_JSON_BYTES, 5 * 1024 * 1024);
        assert_eq!(
            check_content_length(Some(MAX_JSON_BYTES as u64), MAX_JSON_BYTES),
            Ok(())
        );
        assert_eq!(
            check_content_length(Some(MAX_JSON_BYTES as u64 + 1), MAX_JSON_BYTES),
            Err(Failure::Limit)
        );
        let mut bytes = Vec::new();
        append_bytes(&mut bytes, &vec![b' '; MAX_JSON_BYTES], MAX_JSON_BYTES).unwrap();
        assert_eq!(
            append_bytes(&mut bytes, b" ", MAX_JSON_BYTES),
            Err(Failure::Limit)
        );
        assert_eq!(bytes.len(), MAX_JSON_BYTES);
    }

    #[test]
    fn pdf_download_result_serializes_the_path_and_actual_body_length() {
        let mut bytes = Vec::with_capacity(64);
        append_bytes(&mut bytes, b"%PDF-1.7\n%%EOF\n", MAX_PDF_BYTES).unwrap();
        let result = SakaiPdfDownload::new("sakai/file.pdf".into(), &bytes);
        assert_eq!(result.path, "sakai/file.pdf");
        assert_eq!(result.bytes, 15);
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            serde_json::json!({ "path": "sakai/file.pdf", "bytes": 15 })
        );
    }

    #[test]
    fn pagination_rejects_repeated_pages_and_excess_sites() {
        let site = SakaiSite {
            id: "course".into(),
            title: "Course".into(),
            description: String::new(),
        };
        let mut sites = Vec::new();
        let mut ids = HashSet::new();
        assert_eq!(
            append_sites(&mut sites, &mut ids, vec![site.clone()], 1),
            Ok(false)
        );
        assert_eq!(
            append_sites(&mut sites, &mut ids, vec![site.clone()], 1),
            Err(Failure::Schema)
        );
        let mut full = vec![site.clone(); MAX_SITES];
        assert_eq!(
            append_sites(&mut full, &mut HashSet::new(), vec![site], 1),
            Err(Failure::Limit)
        );
        assert_eq!(
            append_sites(&mut full, &mut HashSet::new(), Vec::new(), 1),
            Ok(true)
        );
    }

    #[test]
    fn only_observed_site_file_paths_can_be_downloaded() {
        assert!(resource_url(
            "course",
            &format!("{ORIGIN}/access/content/group/course/file.pdf")
        )
        .is_ok());
        assert!(resource_url(
            "course",
            &format!("{ORIGIN}/access/content/group/other/file.pdf")
        )
        .is_err());
        assert!(resource_url(
            "course",
            &format!("{ORIGIN}/access/content/group/course/../other/file.pdf")
        )
        .is_err());
        assert!(resource_url("course", &format!("{ORIGIN}/portal/logout")).is_err());
        assert!(resource_url(
            "../course",
            &format!("{ORIGIN}/access/content/group/course/file.pdf")
        )
        .is_err());
    }

    #[test]
    fn typed_json_discards_private_fields_and_rejects_wrong_envelopes() {
        let parsed: SiteCollection = serde_json::from_str(r#"{"site_collection":[{"id":"course","title":"Course","description":null,"owner":"private-owner","props":{"secret":"private-token"},"groups":["private-group"]}]}"#).unwrap();
        let output = serde_json::to_string(&parsed.site_collection).unwrap();
        assert_eq!(
            output,
            r#"[{"id":"course","title":"Course","description":""}]"#
        );
        assert!(serde_json::from_str::<SiteCollection>("{}").is_err());
        assert!(serde_json::from_str::<SiteCollection>("<html>Login</html>").is_err());
    }

    #[test]
    fn authentication_and_cancellation_use_stable_machine_codes() {
        assert_eq!(Failure::Expired.message(), "SAKAI_AUTH_REQUIRED");
        assert_eq!(Failure::Disconnected.message(), "SAKAI_AUTH_REQUIRED");
        assert_eq!(Failure::Cancelled.message(), "SAKAI_CANCELLED");
        assert_eq!(
            SakaiState::default().lock().unwrap().active(),
            Err(Failure::Disconnected)
        );
    }

    #[test]
    fn generation_exhaustion_still_clears_the_session() {
        let mut session = Session {
            generation: u64::MAX,
            connected: true,
            client: Some(http_client().unwrap()),
            ..Session::default()
        };
        assert_eq!(session.reset(), Err(Failure::Limit));
        assert!(!session.connected);
        assert!(session.client.is_none());
    }

    #[test]
    fn unauthorized_clears_ram_and_old_unauthorized_responses_cannot_clear_a_new_session() {
        let state = SakaiState::default();
        {
            let mut session = state.lock().unwrap();
            session.client = Some(http_client().unwrap());
            session.connected = true;
            session
                .pdfs
                .insert(("course".into(), "observed-pdf".into()));
        }
        assert_eq!(
            response_status(&state, 0, StatusCode::UNAUTHORIZED),
            Err(Failure::Expired)
        );
        tauri::async_runtime::block_on(state.request_failed(0, Failure::Expired)).unwrap();
        assert!(!state.lock().unwrap().connected);
        assert!(state.lock().unwrap().pdfs.is_empty());
        {
            let mut session = state.lock().unwrap();
            session.client = Some(http_client().unwrap());
            session.connected = true;
        }
        assert_eq!(
            response_status(&state, 0, StatusCode::UNAUTHORIZED),
            Err(Failure::Cancelled)
        );
        assert!(state.lock().unwrap().connected);
        assert_eq!(
            response_status(&state, 1, StatusCode::FOUND),
            Err(Failure::Response)
        );
        assert_eq!(
            response_status(&state, 1, StatusCode::FORBIDDEN),
            Err(Failure::Response)
        );
    }

    #[test]
    fn site_ids_match_the_frontend_constraints() {
        assert!(valid_id("Course-1_A.b"));
        assert!(valid_id(&"a".repeat(128)));
        assert!(!valid_id(&"a".repeat(129)));
        assert!(!valid_id("~personal"));
        assert!(!valid_id(".hidden"));
        assert!(!valid_id("course/path"));
    }

    #[test]
    fn short_site_pages_do_not_end_pagination() {
        let page: SiteCollection = serde_json::from_str(
            r#"{"site_collection":[{"id":"course","title":"Course","description":""}]}"#,
        )
        .unwrap();
        let mut sites = Vec::new();
        let mut ids = HashSet::new();
        assert_eq!(
            append_sites(&mut sites, &mut ids, page.site_collection, 100),
            Ok(false)
        );
        assert_eq!(sites.len(), 1);
        assert_eq!(
            append_sites(&mut sites, &mut ids, Vec::new(), 100),
            Ok(true)
        );
    }

    #[test]
    fn encoded_folder_names_are_allowed_but_encoded_traversal_is_rejected() {
        assert!(resource_url(
            "course",
            &format!("{ORIGIN}/access/content/group/course/Folder%20One/%C3%9Cbung.pdf")
        )
        .is_ok());
        for path in [
            "folder/../file.pdf",
            "%2e%2e/file.pdf",
            "%252e%252e/file.pdf",
            "folder%2ffile.pdf",
            "folder%255cfile.pdf",
            "file%00.pdf",
            "..;/file.pdf",
        ] {
            assert!(resource_url(
                "course",
                &format!("{ORIGIN}/access/content/group/course/{path}")
            )
            .is_err());
        }
    }

    #[test]
    fn hidden_or_unconfirmed_resources_never_become_download_candidates() {
        let content: ContentCollection = serde_json::from_str(r#"{"content_collection":[
            {"title":"Visible","url":"https://sakai.mci4me.at/access/content/group/course/a.pdf","type":"application/pdf","size":20,"modifiedDate":"20260824120605431","hidden":false,"visible":true},
            {"title":"Hidden","url":"https://sakai.mci4me.at/access/content/group/course/b.pdf","type":"application/pdf","size":20,"hidden":true,"visible":true},
            {"title":"Invisible","url":"https://sakai.mci4me.at/access/content/group/course/c.pdf","type":"application/pdf","size":20,"hidden":false,"visible":false},
            {"title":"Unknown","url":"https://sakai.mci4me.at/access/content/group/course/d.pdf","type":"application/pdf","size":20,"visible":true},
            {"title":"Folder","url":"unused","type":"collection","hidden":false,"visible":true}
        ]}"#).unwrap();
        let resources = admit_resources("course", content).unwrap();
        assert_eq!(resources.len(), 1);
        assert_eq!(resources[0].title, "Visible");
        assert_eq!(
            resources[0].modified_date.as_deref(),
            Some("20260824120605431")
        );
    }

    #[test]
    fn invalid_required_resource_sections_fail_instead_of_becoming_empty() {
        let content: ContentCollection = serde_json::from_str(r#"{"content_collection":[{"title":"Foreign","url":"https://other.invalid/file.pdf","type":"application/pdf","size":20,"hidden":false,"visible":true}]}"#).unwrap();
        assert!(matches!(
            admit_resources("course", content),
            Err(Failure::Denied)
        ));
        assert!(serde_json::from_str::<ContentCollection>("{}").is_err());
        assert!(serde_json::from_str::<AnnouncementCollection>("{}").is_err());
        assert!(
            serde_json::from_str::<SiteDetails>(r#"{"id":"course","title":"Course"}"#).is_err()
        );
    }

    #[test]
    fn site_pages_action_distinguishes_installed_and_absent_lessons() {
        let absent: Vec<SitePage> = serde_json::from_str(r#"[{"id":"overview","siteId":"course","tools":[{"id":"placement","toolId":"sakai.announcements"}]}]"#).unwrap();
        let present: Vec<SitePage> = serde_json::from_str(r#"[{"id":"lesson-page","siteId":"course","tools":[{"id":"placement","toolId":"sakai.lessonbuildertool"}]}]"#).unwrap();
        assert_eq!(has_lessons("course", &absent), Ok(false));
        assert_eq!(has_lessons("course", &present), Ok(true));
        assert_eq!(has_lessons("course", &[]), Ok(false));
    }

    #[test]
    fn site_pages_action_rejects_unknown_or_incomplete_tool_lists() {
        assert!(serde_json::from_str::<Vec<SitePage>>(r#"{"site_collection":[]}"#).is_err());
        assert!(serde_json::from_str::<Vec<SitePage>>(r#"[{"siteId":"course"}]"#).is_err());
        assert!(
            serde_json::from_str::<Vec<SitePage>>(r#"[{"siteId":"course","tools":null}]"#).is_err()
        );
        assert!(serde_json::from_str::<Vec<SitePage>>(
            r#"[{"siteId":"course","tools":[{"id":"sakai.lessonbuildertool"}]}]"#
        )
        .is_err());
        assert!(serde_json::from_str::<Vec<SitePage>>(r#"[{"tools":[]}]"#).is_err());
        assert!(serde_json::from_str::<LessonNode>("{}").is_err());
    }

    #[test]
    fn site_pages_action_rejects_wrong_sites_and_empty_tool_ids() {
        let other_site: Vec<SitePage> =
            serde_json::from_str(r#"[{"siteId":"other","tools":[]}]"#).unwrap();
        let empty_tool: Vec<SitePage> =
            serde_json::from_str(r#"[{"siteId":"course","tools":[{"toolId":""}]}]"#).unwrap();
        assert_eq!(has_lessons("course", &other_site), Err(Failure::Schema));
        assert_eq!(has_lessons("course", &empty_tool), Err(Failure::Schema));
    }

    #[test]
    fn site_pages_action_does_not_ignore_invalid_data_after_a_lesson_tool() {
        let pages: Vec<SitePage> = serde_json::from_str(r#"[{"siteId":"course","tools":[{"toolId":"sakai.lessonbuildertool"}]},{"siteId":"other","tools":[]}]"#).unwrap();
        assert_eq!(has_lessons("course", &pages), Err(Failure::Schema));
    }

    #[test]
    fn site_pages_action_bounds_the_tool_count() {
        let pages = vec![SitePage {
            site_id: "course".into(),
            tools: (0..=MAX_ITEMS)
                .map(|_| SiteTool {
                    tool_id: "sakai.announcements".into(),
                })
                .collect(),
        }];
        assert_eq!(has_lessons("course", &pages), Err(Failure::Limit));
    }

    fn lesson_node() -> LessonNode {
        serde_json::from_str(r#"{"id":1,"type":5,"name":"Text","html":"<p>Visible</p>","url":"https://other.invalid/grade","contentsList":null}"#).unwrap()
    }

    #[test]
    fn lessons_emit_only_text_and_site_links_and_hide_whole_hidden_subtrees() {
        let mut output = Vec::new();
        let mut budget = LessonBudget::default();
        collect_lesson(
            lesson_node(),
            "course",
            "Course",
            1,
            &mut budget,
            &mut output,
            true,
        )
        .unwrap();
        assert_eq!(output.len(), 1);
        assert_eq!(output[0].html, "<p>Visible</p>");
        assert_eq!(output[0].url, format!("{ORIGIN}/portal/site/course"));
        let mut hidden = lesson_node();
        hidden.hidden = Some(true);
        hidden.contents_list = Some(vec![lesson_node()]);
        collect_lesson(
            hidden,
            "course",
            "Course",
            1,
            &mut budget,
            &mut output,
            true,
        )
        .unwrap();
        assert_eq!(output.len(), 1);
        assert_eq!(budget.nodes, 3);
    }

    #[test]
    fn lessons_enforce_node_depth_and_text_limits_even_on_hidden_nodes() {
        let mut budget = LessonBudget {
            nodes: MAX_LESSON_NODES,
            text_bytes: 0,
        };
        assert_eq!(
            collect_lesson(
                lesson_node(),
                "course",
                "Course",
                1,
                &mut budget,
                &mut Vec::new(),
                true
            ),
            Err(Failure::Limit)
        );
        assert_eq!(
            collect_lesson(
                lesson_node(),
                "course",
                "Course",
                MAX_LESSON_DEPTH + 1,
                &mut LessonBudget::default(),
                &mut Vec::new(),
                false
            ),
            Err(Failure::Limit)
        );
        let mut budget = LessonBudget {
            nodes: 0,
            text_bytes: MAX_LESSON_TEXT,
        };
        assert_eq!(
            collect_lesson(
                lesson_node(),
                "course",
                "Course",
                1,
                &mut budget,
                &mut Vec::new(),
                false
            ),
            Err(Failure::Limit)
        );
    }

    #[test]
    fn lessons_discard_unknown_and_activity_node_types_with_their_subtrees() {
        let mut activity = lesson_node();
        activity.kind = 9;
        activity.contents_list = Some(vec![lesson_node()]);
        let mut output = Vec::new();
        collect_lesson(
            activity,
            "course",
            "Course",
            1,
            &mut LessonBudget::default(),
            &mut output,
            true,
        )
        .unwrap();
        assert!(output.is_empty());
        let mut unknown = lesson_node();
        unknown.kind = 999;
        collect_lesson(
            unknown,
            "course",
            "Course",
            1,
            &mut LessonBudget::default(),
            &mut output,
            true,
        )
        .unwrap();
        assert!(output.is_empty());
    }

    #[test]
    fn unreleased_lessons_are_not_emitted() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(10);
        assert_eq!(released(&None, now), Ok(true));
        assert_eq!(released(&Some(ReleaseDate::Millis(10_000)), now), Ok(true));
        assert_eq!(released(&Some(ReleaseDate::Millis(10_001)), now), Ok(false));
        assert_eq!(
            released(&Some(ReleaseDate::Text("unknown".into())), now),
            Err(Failure::Schema)
        );
    }

    #[test]
    fn supplied_site_fixtures_match_the_native_parsers() {
        let Some(directory) = std::env::var_os("SAKAI_FIXTURE_DIR") else {
            return;
        };
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Fixture {
            site: SiteDetails,
            announcements: AnnouncementCollection,
            content: ContentCollection,
            lessons: Option<LessonsCollection>,
            #[serde(default)]
            lesson_trees: Vec<TreeFixture>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct TreeFixture {
            root_id: u64,
            status: u16,
            data: Option<serde_json::Value>,
        }
        let entries = std::fs::read_dir(directory)
            .unwrap_or_else(|_| panic!("Fixture directory unavailable"));
        let mut fixtures = 0;
        let mut trees = 0;
        let mut text_rows = 0;
        for entry in entries {
            let path = entry
                .unwrap_or_else(|_| panic!("Fixture entry unavailable"))
                .path();
            if path.extension().is_none_or(|extension| extension != "json") {
                continue;
            }
            fixtures += 1;
            let bytes = std::fs::read(path).unwrap_or_else(|_| panic!("Fixture read failed"));
            let fixture: Fixture = serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| panic!("Fixture {fixtures}: required section schema invalid"));
            assert!(
                valid_site(&fixture.site.site),
                "Fixture {fixtures}: invalid site"
            );
            assert!(fixture.announcements.announcement_collection.len() <= 200);
            admit_resources(&fixture.site.site.id, fixture.content)
                .unwrap_or_else(|_| panic!("Fixture {fixtures}: resource admission failed"));
            let Some(roots) = fixture.lessons else {
                continue;
            };
            assert!(roots.lessons_collection.len() <= 50);
            let roots: HashMap<_, _> = roots
                .lessons_collection
                .into_iter()
                .map(|root| (root.id, root))
                .collect();
            let mut budget = LessonBudget::default();
            let mut output = Vec::new();
            for tree in fixture.lesson_trees {
                if tree.status != 200 {
                    continue;
                }
                let Some(data) = tree.data.filter(|data| !data.is_null()) else {
                    continue;
                };
                let root = roots
                    .get(&tree.root_id)
                    .unwrap_or_else(|| panic!("Fixture {fixtures}: ungranted lesson root"));
                if root.hidden || !released(&root.release_date, SystemTime::now()).unwrap() {
                    continue;
                }
                let node: LessonNode = serde_json::from_value(data)
                    .unwrap_or_else(|_| panic!("Fixture {fixtures}: lesson tree schema invalid"));
                assert!(
                    node.id == root.id,
                    "Fixture {fixtures}: lesson root mismatch"
                );
                collect_lesson(
                    node,
                    &fixture.site.site.id,
                    &root.lesson_title,
                    1,
                    &mut budget,
                    &mut output,
                    true,
                )
                .unwrap_or_else(|_| panic!("Fixture {fixtures}: lesson traversal failed"));
                trees += 1;
            }
            text_rows += output.len();
        }
        assert!(
            fixtures >= 14,
            "Expected at least 14 supplied site fixtures"
        );
        assert!(trees > 0, "No available lesson trees were exercised");
        assert!(text_rows > 0, "No lesson text was extracted");
        println!("Verified {fixtures} site fixtures, {trees} lesson trees, {text_rows} text rows");
    }
}
