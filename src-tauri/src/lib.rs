mod calendar;
mod sakai;
mod sakai_credentials;
mod vault;

use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use vault::{DocEntry, NoteEntry, Vault};

struct VaultState(Mutex<Vault>);

impl VaultState {
    fn lock(&self) -> Result<MutexGuard<'_, Vault>, String> {
        self.0
            .lock()
            .map_err(|_| "Vault-Sperre fehlgeschlagen".into())
    }
}

// A newtype makes the IPC key mandatory while accepting an explicit JSON null.
#[derive(serde::Deserialize)]
struct Expected(Option<String>);

#[tauri::command]
async fn fetch_ical(url: String) -> Result<String, String> {
    calendar::fetch(&url).await
}

#[tauri::command]
fn set_vault_root(path: String, state: State<VaultState>) -> Result<(), String> {
    state.lock()?.activate(Path::new(&path))
}

#[tauri::command]
async fn choose_vault_root(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, VaultState>,
) -> Result<Option<String>, String> {
    let selected = app
        .dialog()
        .file()
        .set_parent(&window)
        .blocking_pick_folder();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|_| "Ungültiger Ordner".to_string())?;
    state.lock()?.approve_root(&path).map(Some)
}

#[tauri::command]
async fn pick_documents(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, VaultState>,
) -> Result<Vec<String>, String> {
    let selected = app
        .dialog()
        .file()
        .set_parent(&window)
        .blocking_pick_files();
    let mut vault = state.lock()?;
    selected
        .unwrap_or_default()
        .into_iter()
        .map(|file| {
            let path = file
                .into_path()
                .map_err(|_| "Ungültige Datei".to_string())?;
            vault.approve_source(&path)
        })
        .collect()
}

#[tauri::command]
fn ensure_dir(path: String, state: State<VaultState>) -> Result<(), String> {
    state.lock()?.ensure_dir(Path::new(&path))
}

#[tauri::command]
fn read_text_file(path: String, state: State<VaultState>) -> Result<Option<String>, String> {
    state.lock()?.read_text(Path::new(&path))
}

#[tauri::command]
fn save_text_file(
    path: String,
    content: String,
    expected: Expected,
    state: State<VaultState>,
) -> Result<(), String> {
    state
        .lock()?
        .save_text(Path::new(&path), &content, expected.0.as_deref())
}

#[tauri::command]
fn discover_notes(dir: String, state: State<VaultState>) -> Result<Vec<NoteEntry>, String> {
    state.lock()?.discover_notes(Path::new(&dir))
}

#[tauri::command]
fn copy_file_into(
    src: String,
    dest_dir: String,
    state: State<VaultState>,
) -> Result<String, String> {
    state
        .lock()?
        .copy_into(Path::new(&src), Path::new(&dest_dir))
}

#[tauri::command]
fn list_docs(dir: String, state: State<VaultState>) -> Result<Vec<DocEntry>, String> {
    state.lock()?.list_docs(Path::new(&dir))
}

#[tauri::command]
fn open_knowledge_file(
    path: String,
    app: tauri::AppHandle,
    state: State<VaultState>,
) -> Result<(), String> {
    let vault = state.lock()?;
    let path = vault.knowledge_document_to_open(Path::new(&path))?;
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|_| "Öffnen fehlgeschlagen".into())
}

#[tauri::command]
fn open_vault_file(
    path: String,
    app: tauri::AppHandle,
    state: State<VaultState>,
) -> Result<(), String> {
    let vault = state.lock()?;
    let path = vault.document_to_open(Path::new(&path))?;
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|_| "Öffnen fehlgeschlagen".into())
}

#[tauri::command]
fn open_external_url(url: String, app: tauri::AppHandle) -> Result<(), String> {
    let url = external_url(&url)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| "Weblink konnte nicht geöffnet werden".into())
}

fn external_url(value: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(value).map_err(|_| "Ungültiger Weblink")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Nur HTTP(S)-Links ohne Zugangsdaten können geöffnet werden".into());
    }
    Ok(url.to_string())
}

#[tauri::command]
fn reveal_vault_path(
    path: String,
    app: tauri::AppHandle,
    state: State<VaultState>,
) -> Result<(), String> {
    let vault = state.lock()?;
    let path = vault.path_to_reveal(Path::new(&path))?;
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|_| "Anzeigen im Dateimanager fehlgeschlagen".into())
}

#[tauri::command]
fn delete_file(path: String, state: State<VaultState>) -> Result<(), String> {
    state.lock()?.trash(Path::new(&path))
}

fn approve_drop(app: &tauri::AppHandle, paths: &[std::path::PathBuf]) {
    if let Ok(mut vault) = app.state::<VaultState>().lock() {
        for path in paths {
            // Unsupported or unreadable drops receive no grant; import then fails closed.
            let _ = vault.approve_source(path);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            // RunEvent plugins run before Tauri emits the window's JS drop event.
            tauri::plugin::Builder::<_, ()>::new("vault-drop")
                .on_event(|app, event| {
                    if let tauri::RunEvent::WindowEvent {
                        label,
                        event:
                            tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }),
                        ..
                    } = event
                    {
                        if label == "main" {
                            approve_drop(app, paths);
                        }
                    }
                })
                .build(),
        )
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                sakai::shutdown(window.app_handle());
            }
        })
        .setup(|app| {
            let vault = Vault::new(app.path().home_dir()?, app.path().app_config_dir()?)
                .map_err(std::io::Error::other)?;
            app.manage(VaultState(Mutex::new(vault)));
            app.manage(sakai::SakaiState::new(app.path().app_config_dir().ok()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sakai::sakai_begin_login,
            sakai::sakai_connect,
            sakai::sakai_disconnect,
            sakai::sakai_status,
            sakai::sakai_poll_login,
            sakai::sakai_set_remember_session,
            sakai::sakai_enable_auto_login,
            sakai::sakai_disable_auto_login,
            sakai::sakai_sites,
            sakai::sakai_site_snapshot,
            sakai::sakai_download_pdf,
            fetch_ical,
            set_vault_root,
            choose_vault_root,
            pick_documents,
            ensure_dir,
            read_text_file,
            save_text_file,
            discover_notes,
            copy_file_into,
            list_docs,
            open_knowledge_file,
            open_vault_file,
            open_external_url,
            reveal_vault_path,
            delete_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{external_url, Expected};

    #[test]
    fn external_links_accept_http_and_https_and_return_the_parsed_url() {
        assert_eq!(
            external_url("HTTPS://Example.invalid/resource?q=one#section").unwrap(),
            "https://example.invalid/resource?q=one#section"
        );
        assert_eq!(
            external_url("http://example.invalid:8080/resource").unwrap(),
            "http://example.invalid:8080/resource"
        );
    }

    #[test]
    fn external_links_reject_other_schemes_missing_hosts_and_credentials() {
        for url in [
            "javascript:alert('private-token')",
            "file:///private-token",
            "mailto:private-token@example.invalid",
            "data:text/html,private-token",
            "ftp://example.invalid/private-token",
            "https://",
            "http://?private-token",
            "/private-token",
            "https://private-token@example.invalid/",
            "https://private-token:secret@example.invalid/",
            "https://:secret@example.invalid/",
        ] {
            let error = external_url(url).unwrap_err();
            assert!(!error.contains("private-token"));
            assert!(!error.contains("secret"));
            assert!(!error.contains("example.invalid"));
        }
    }

    #[test]
    fn expected_accepts_string_or_explicit_null_but_is_required() {
        #[derive(serde::Deserialize)]
        struct Args {
            expected: Expected,
        }

        assert!(serde_json::from_str::<Args>("{}").is_err());
        assert!(serde_json::from_str::<Args>(r#"{"expected":false}"#).is_err());
        assert!(serde_json::from_str::<Args>(r#"{"expected":null}"#)
            .unwrap()
            .expected
            .0
            .is_none());
        assert_eq!(
            serde_json::from_str::<Args>(r#"{"expected":"previous"}"#)
                .unwrap()
                .expected
                .0
                .as_deref(),
            Some("previous")
        );
    }
}
