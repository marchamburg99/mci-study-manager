use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const DENIED: &str = "Dateizugriff außerhalb des freigegebenen Vaults blockiert";
static SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Serialize)]
pub struct DocEntry {
    pub name: String,
    pub path: String,
    pub size: u64,
}

#[derive(Debug, Serialize)]
pub struct NoteEntry {
    pub path: String,
    pub content: String,
}

#[derive(Default, Deserialize, Serialize)]
struct RootGrants {
    roots: Vec<PathBuf>,
}

struct ActiveRoot {
    selected: PathBuf,
    canonical: PathBuf,
}

struct SourceGrant {
    file: File,
    expires: Instant,
}

pub struct Vault {
    home: PathBuf,
    config: PathBuf,
    grants: RootGrants,
    grants_bytes: Option<Vec<u8>>,
    active: Option<ActiveRoot>,
    sources: HashMap<PathBuf, SourceGrant>,
}

fn io_error(error: io::Error) -> String {
    format!("Dateioperation fehlgeschlagen ({:?})", error.kind())
}

fn absolute(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(DENIED.into());
    }
    Ok(())
}

fn path_string(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| "Dateipfad ist kein gültiger UTF-8-Text".into())
}

fn canonical_missing(path: &Path) -> Result<PathBuf, String> {
    absolute(path)?;
    match fs::symlink_metadata(path) {
        Ok(_) => fs::canonicalize(path).map_err(io_error),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let parent = path.parent().ok_or(DENIED)?;
            let parent = canonical_missing(parent)?;
            if parent.exists() && !fs::metadata(&parent).map_err(io_error)?.is_dir() {
                return Err("Übergeordneter Pfad ist kein Ordner".into());
            }
            Ok(parent.join(path.file_name().ok_or(DENIED)?))
        }
        Err(error) => Err(io_error(error)),
    }
}

fn read_bytes(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_file() => return Err("Pfad ist keine reguläre Datei".into()),
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error(error)),
    }
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io_error(error)),
    }
}

fn identifier() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "{nanos}-{}-{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

fn create_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

struct TempFile(PathBuf);

impl TempFile {
    fn write(parent: &Path, content: &[u8]) -> Result<Self, String> {
        for _ in 0..100 {
            let path = parent.join(format!(".mci-tmp-{}", identifier()));
            let mut file = match create_file(&path) {
                Ok(file) => file,
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(io_error(error)),
            };
            let temp = Self(path);
            file.write_all(content).map_err(io_error)?;
            file.sync_all().map_err(io_error)?;
            return Ok(temp);
        }
        Err("Temporäre Datei konnte nicht reserviert werden".into())
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

impl Vault {
    pub fn new(home: PathBuf, config: PathBuf) -> Result<Self, String> {
        let home = fs::canonicalize(home).map_err(io_error)?;
        let config = canonical_missing(&config)?;
        let grants_bytes = read_bytes(&config.join("vault-grants.json"))?;
        let grants = match &grants_bytes {
            Some(bytes) => {
                serde_json::from_slice(bytes).map_err(|_| "Vault-Freigaben sind beschädigt")?
            }
            None => RootGrants::default(),
        };
        Ok(Self {
            home,
            config,
            grants,
            grants_bytes,
            active: None,
            sources: HashMap::new(),
        })
    }

    fn root_candidate(&self, path: &Path) -> Result<PathBuf, String> {
        let canonical = canonical_missing(path)?;
        if canonical.parent().is_none()
            || self.home.starts_with(&canonical)
            || self.config.starts_with(&canonical)
            || canonical.starts_with(&self.config)
        {
            return Err(
                "Vault muss ein spezifischer Ordner außerhalb der Anwendungskonfiguration sein"
                    .into(),
            );
        }
        match fs::metadata(&canonical) {
            Ok(metadata) if !metadata.is_dir() => return Err("Vault-Pfad ist kein Ordner".into()),
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_error(error)),
        }
        Ok(canonical)
    }

    pub fn approve_root(&mut self, path: &Path) -> Result<String, String> {
        let canonical = self.root_candidate(path)?;
        if !fs::metadata(&canonical).map_err(io_error)?.is_dir() {
            return Err("Vault-Pfad ist kein Ordner".into());
        }
        let result = path_string(&canonical)?;
        if self.grants.roots.contains(&canonical) {
            return Ok(result);
        }
        let mut roots = self.grants.roots.clone();
        roots.push(canonical);
        let grants = RootGrants { roots };
        let bytes = serde_json::to_vec(&grants)
            .map_err(|_| "Vault-Freigabe konnte nicht gespeichert werden")?;
        fs::create_dir_all(&self.config).map_err(io_error)?;
        if fs::canonicalize(&self.config).map_err(io_error)? != self.config {
            return Err(DENIED.into());
        }
        let target = self.config.join("vault-grants.json");
        let temp = TempFile::write(&self.config, &bytes)?;
        if read_bytes(&target)? != self.grants_bytes {
            return Err("CONFLICT".into());
        }
        fs::rename(&temp.0, &target).map_err(io_error)?;
        self.grants = grants;
        self.grants_bytes = Some(bytes);
        Ok(result)
    }

    pub fn activate(&mut self, path: &Path) -> Result<(), String> {
        let canonical = self.root_candidate(path)?;
        let approved = self.grants.roots.contains(&canonical);
        if !approved && canonical != self.root_candidate(&self.home.join("MCI"))? {
            return Err(
                "Vault-Ordner muss zuerst über die native Ordnerauswahl freigegeben werden".into(),
            );
        }
        fs::create_dir_all(&canonical).map_err(io_error)?;
        if fs::canonicalize(&canonical).map_err(io_error)? != canonical {
            return Err(DENIED.into());
        }
        self.active = Some(ActiveRoot {
            selected: path.to_path_buf(),
            canonical,
        });
        Ok(())
    }

    fn root(&self) -> Result<&ActiveRoot, String> {
        let root = self
            .active
            .as_ref()
            .ok_or("Vault-Pfad ist noch nicht konfiguriert")?;
        if fs::canonicalize(&root.selected).map_err(io_error)? != root.canonical
            || fs::canonicalize(&root.canonical).map_err(io_error)? != root.canonical
        {
            return Err(DENIED.into());
        }
        Ok(root)
    }

    fn resolve(&self, path: &Path) -> Result<PathBuf, String> {
        absolute(path)?;
        let root = self.root()?;
        let relative = path
            .strip_prefix(&root.canonical)
            .or_else(|_| path.strip_prefix(&root.selected))
            .map_err(|_| DENIED)?;
        let mut current = root.canonical.clone();
        let mut missing = false;
        for part in relative.components() {
            let Component::Normal(name) = part else {
                return Err(DENIED.into());
            };
            current.push(name);
            if missing {
                continue;
            }
            match fs::symlink_metadata(&current) {
                Ok(metadata) => {
                    if metadata.file_type().is_symlink() {
                        return Err(DENIED.into());
                    }
                    if fs::canonicalize(&current).map_err(io_error)? != current {
                        return Err(DENIED.into());
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => missing = true,
                Err(error) => return Err(io_error(error)),
            }
        }
        Ok(current)
    }

    fn writable(&self, path: &Path) -> Result<PathBuf, String> {
        let path = self.resolve(path)?;
        let root = &self.root()?.canonical;
        if path == *root
            || ["history", "trash"]
                .iter()
                .any(|name| path.starts_with(root.join(".mci-manager").join(name)))
        {
            return Err("Geschützter Vault-Pfad".into());
        }
        Ok(path)
    }

    fn create_dirs(&self, path: &Path) -> Result<PathBuf, String> {
        let path = self.resolve(path)?;
        fs::create_dir_all(&path).map_err(io_error)?;
        self.resolve(&path)
    }

    pub fn ensure_dir(&self, path: &Path) -> Result<(), String> {
        if self.resolve(path)? == self.root()?.canonical {
            return Ok(());
        }
        self.create_dirs(&self.writable(path)?)?;
        Ok(())
    }

    pub fn read_text(&self, path: &Path) -> Result<Option<String>, String> {
        read_bytes(&self.resolve(path)?)?
            .map(|bytes| {
                String::from_utf8(bytes).map_err(|_| "Datei ist kein gültiger UTF-8-Text".into())
            })
            .transpose()
    }

    pub fn save_sakai_pdf(&self, root: &Path, bytes: &[u8]) -> Result<String, String> {
        if self.resolve(root)? != self.root()?.canonical {
            return Err(DENIED.into());
        }
        if bytes.len() > 15 * 1024 * 1024 || !bytes.starts_with(b"%PDF-") {
            return Err("Sakai-Datei ist keine PDF oder größer als 15 MiB".into());
        }
        let digest = format!("{:x}", Sha256::digest(bytes));
        let relative = format!("Studium/Quellen/Sakai-{digest}.pdf");
        let path = self.writable(&root.join(&relative))?;
        if let Some(previous) = read_bytes(&path)? {
            return if previous == bytes {
                Ok(relative)
            } else {
                Err("CONFLICT".into())
            };
        }
        let parent = self.create_dirs(path.parent().ok_or(DENIED)?)?;
        let temp = TempFile::write(&parent, bytes)?;
        self.writable(&path)?;
        // Linking the fully written file publishes it without replacing an existing original.
        match fs::hard_link(&temp.0, &path) {
            Ok(()) => Ok(relative),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                if read_bytes(&path)?.as_deref() == Some(bytes) {
                    Ok(relative)
                } else {
                    Err("CONFLICT".into())
                }
            }
            Err(error) => Err(io_error(error)),
        }
    }

    fn archive_target(&self, kind: &str, source: &Path) -> Result<PathBuf, String> {
        let root = &self.root()?.canonical;
        let relative = source.strip_prefix(root).map_err(|_| DENIED)?;
        let base = self.create_dirs(&root.join(".mci-manager").join(kind))?;
        for _ in 0..100 {
            let revision = self.resolve(&base.join(identifier()))?;
            match fs::create_dir(&revision) {
                Ok(()) => {
                    let target = revision.join(relative);
                    self.create_dirs(target.parent().ok_or(DENIED)?)?;
                    return self.resolve(&target);
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(io_error(error)),
            }
        }
        Err("Archivziel konnte nicht reserviert werden".into())
    }

    pub fn save_text(
        &self,
        path: &Path,
        content: &str,
        expected: Option<&str>,
    ) -> Result<(), String> {
        let path = self.writable(path)?;
        let previous = read_bytes(&path)?;
        if previous.as_deref() != expected.map(str::as_bytes) {
            return Err("CONFLICT".into());
        }
        let parent = self.create_dirs(path.parent().ok_or(DENIED)?)?;
        let temp = TempFile::write(&parent, content.as_bytes())?;
        if let Some(previous) = &previous {
            let backup = self.archive_target("history", &path)?;
            let mut file = create_file(&backup).map_err(io_error)?;
            file.write_all(previous).map_err(io_error)?;
            file.sync_all().map_err(io_error)?;
        }
        self.writable(&path)?;
        self.resolve(&temp.0)?;
        // The command mutex serializes in-process operations. Another process can still
        // write between this final comparison and rename: this is not multi-process CAS.
        // Likewise, path checks cannot stop a hostile local process racing directory renames.
        if read_bytes(&path)? != previous {
            return Err("CONFLICT".into());
        }
        fs::rename(&temp.0, &path).map_err(io_error)
    }

    pub fn approve_source(&mut self, path: &Path) -> Result<String, String> {
        absolute(path)?;
        let canonical = fs::canonicalize(path).map_err(io_error)?;
        if !fs::metadata(&canonical).map_err(io_error)?.is_file() {
            return Err("Nur reguläre Dateien können importiert werden".into());
        }
        let name = path_string(&canonical)?;
        let file = File::open(&canonical).map_err(io_error)?;
        if !file.metadata().map_err(io_error)?.is_file() {
            return Err("Nur reguläre Dateien können importiert werden".into());
        }
        self.sources
            .retain(|_, grant| grant.expires > Instant::now());
        if self.sources.len() >= 256 {
            return Err("Zu viele Dateifreigaben; bitte Import abschließen".into());
        }
        self.sources.insert(
            canonical,
            SourceGrant {
                file,
                expires: Instant::now() + Duration::from_secs(900),
            },
        );
        Ok(name)
    }

    pub fn copy_into(&mut self, source: &Path, dest: &Path) -> Result<String, String> {
        absolute(source)?;
        let canonical = fs::canonicalize(source).map_err(io_error)?;
        let grant = self
            .sources
            .get(&canonical)
            .filter(|grant| grant.expires > Instant::now())
            .ok_or("Quelldatei ist nicht durch native Auswahl oder Drop freigegeben")?;
        let mut source_file = grant.file.try_clone().map_err(io_error)?;
        source_file.seek(SeekFrom::Start(0)).map_err(io_error)?;
        let dest = self.create_dirs(&self.writable(dest)?)?;
        let name = source
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("Ungültiger Dateiname")?;
        let stem = Path::new(name)
            .file_stem()
            .and_then(|name| name.to_str())
            .ok_or("Ungültiger Dateiname")?;
        let extension = Path::new(name)
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| format!(".{ext}"))
            .unwrap_or_default();
        for index in 0..10_000 {
            let name = if index == 0 {
                name.to_string()
            } else {
                format!("{stem}-{index}{extension}")
            };
            let target = self.writable(&dest.join(name))?;
            let result = path_string(&target)?;
            let mut file = match create_file(&target) {
                Ok(file) => file,
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(io_error(error)),
            };
            if let Err(error) = io::copy(&mut source_file, &mut file).and_then(|_| file.sync_all())
            {
                // Remove only the new, incomplete copy; existing targets were never opened.
                let _ = fs::remove_file(&target);
                return Err(io_error(error));
            }
            self.sources.remove(&canonical);
            return Ok(result);
        }
        Err("Kein freier Dateiname verfügbar".into())
    }

    fn entries(&self, dir: &Path) -> Result<Vec<PathBuf>, String> {
        let dir = self.resolve(dir)?;
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(io_error(error)),
        };
        let mut paths = Vec::new();
        for entry in entries {
            paths.push(self.resolve(&entry.map_err(io_error)?.path())?);
        }
        paths.sort();
        Ok(paths)
    }

    pub fn list_docs(&self, dir: &Path) -> Result<Vec<DocEntry>, String> {
        let mut docs = Vec::new();
        for path in self.entries(dir)? {
            let metadata = fs::metadata(&path).map_err(io_error)?;
            if !metadata.is_file() || path.file_name().is_some_and(|name| name == ".DS_Store") {
                continue;
            }
            docs.push(DocEntry {
                name: path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or("Ungültiger Dateiname")?
                    .to_string(),
                path: path_string(&path)?,
                size: metadata.len(),
            });
        }
        docs.sort_by_key(|doc| doc.name.to_lowercase());
        Ok(docs)
    }

    fn scan_notes(
        &self,
        dir: &Path,
        depth: usize,
        notes: &mut Vec<NoteEntry>,
    ) -> Result<(), String> {
        for path in self.entries(dir)? {
            if path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with('.'))
            {
                continue;
            }
            let metadata = fs::metadata(&path).map_err(io_error)?;
            if depth == 0 {
                if metadata.is_file() && path.extension().is_some_and(|ext| ext == "md") {
                    if let Some(content) = self.read_text(&path)? {
                        notes.push(NoteEntry {
                            path: path_string(&path)?,
                            content,
                        });
                    }
                }
            } else if metadata.is_dir() {
                self.scan_notes(&path, depth - 1, notes)?;
            }
        }
        Ok(())
    }

    pub fn discover_notes(&self, dir: &Path) -> Result<Vec<NoteEntry>, String> {
        let canonical = self.resolve(dir)?;
        let depth = canonical
            .strip_prefix(&self.root()?.canonical)
            .map_err(|_| DENIED)?
            .components()
            .count();
        if depth > 1 {
            return Err("Notizsuche benötigt den Vault- oder Semesterordner".into());
        }
        let mut notes = Vec::new();
        self.scan_notes(&canonical, 3 - depth, &mut notes)?;
        for note in &mut notes {
            let relative = Path::new(&note.path)
                .strip_prefix(&canonical)
                .map_err(|_| DENIED)?;
            note.path = path_string(&dir.join(relative))?;
        }
        notes.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(notes)
    }

    pub fn knowledge_document_to_open(&self, path: &Path) -> Result<String, String> {
        let path = self.resolve(path)?;
        let relative = path
            .strip_prefix(&self.root()?.canonical)
            .map_err(|_| DENIED)?;
        let parts = relative
            .iter()
            .map(|part| part.to_str().ok_or(DENIED))
            .collect::<Result<Vec<_>, _>>()?;
        if parts
            .iter()
            .any(|part| part.starts_with('.') || matches!(*part, "history" | "trash"))
        {
            return Err("Geschützter Vault-Pfad".into());
        }
        let extension = path.extension().and_then(|ext| ext.to_str());
        let allowed = match parts.as_slice() {
            ["README.md"] => true,
            ["Studium", _] => extension == Some("md"),
            ["Studium", "Quellen", _] => extension == Some("pdf"),
            ["Studium", ..] => false,
            [_, "_Semester.md"] => true,
            [_, _, _] | [_, _, _, _] => extension == Some("md"),
            _ => false,
        };
        if !allowed {
            return Err(
                "Nur freigegebene Wissensnotizen und Quellen-PDFs können geöffnet werden".into(),
            );
        }
        let metadata = fs::symlink_metadata(&path).map_err(io_error)?;
        if !metadata.is_file() {
            return Err("Pfad ist keine reguläre Datei".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o111 != 0 {
                return Err("Ausführbare Dateien dürfen nicht als Wissen geöffnet werden".into());
            }
        }
        path_string(&path)
    }

    pub fn document_to_open(&self, path: &Path) -> Result<String, String> {
        let path = self.resolve(path)?;
        let relative = path
            .strip_prefix(&self.root()?.canonical)
            .map_err(|_| DENIED)?;
        if relative.components().count() < 5
            || relative.components().nth(3) != Some(Component::Normal("docs".as_ref()))
        {
            return Err("Nur Dokumente in einem Termin-docs-Ordner können geöffnet werden".into());
        }
        let extension = path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if ![
            "pdf", "txt", "md", "csv", "json", "doc", "docx", "odt", "rtf", "xls", "xlsx", "ods",
            "ppt", "pptx", "odp", "png", "jpg", "jpeg", "gif", "webp",
        ]
        .contains(&extension.as_str())
        {
            return Err("Dieser Dateityp darf nicht über die App geöffnet werden".into());
        }
        if !fs::metadata(&path).map_err(io_error)?.is_file() {
            return Err("Pfad ist keine reguläre Datei".into());
        }
        path_string(&path)
    }

    pub fn path_to_reveal(&self, path: &Path) -> Result<PathBuf, String> {
        let path = self.resolve(path)?;
        let metadata = fs::metadata(&path).map_err(io_error)?;
        if !metadata.is_file() && !metadata.is_dir() {
            return Err("Nur reguläre Dateien und Ordner können angezeigt werden".into());
        }
        Ok(path)
    }

    pub fn trash(&self, path: &Path) -> Result<(), String> {
        let path = self.writable(path)?;
        if !fs::metadata(&path).map_err(io_error)?.is_file() {
            return Err("Nur reguläre Dateien können entfernt werden".into());
        }
        let target = self.archive_target("trash", &path)?;
        self.writable(&path)?;
        self.resolve(&target)?;
        fs::rename(&path, &target).map_err(io_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier, Mutex};

    struct Fixture {
        base: PathBuf,
        home: PathBuf,
        config: PathBuf,
        root: PathBuf,
        vault: Vault,
    }

    impl Fixture {
        fn new() -> Self {
            let base = std::env::temp_dir().join(format!("mci-vault-test-{}", identifier()));
            fs::create_dir(&base).unwrap();
            let base = fs::canonicalize(base).unwrap();
            let home = base.join("home");
            let config = base.join("config");
            fs::create_dir(&home).unwrap();
            let root = home.join("MCI");
            let mut vault = Vault::new(home.clone(), config.clone()).unwrap();
            vault.activate(&root).unwrap();
            Self {
                base,
                home,
                config,
                root,
                vault,
            }
        }

        fn note(&self) -> PathBuf {
            self.root.join("semester/fach/termin/notes.md")
        }

        fn archive_files(&self, kind: &str) -> Vec<PathBuf> {
            fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
                for entry in fs::read_dir(dir).unwrap() {
                    let path = entry.unwrap().path();
                    if path.is_dir() {
                        walk(&path, out);
                    } else {
                        out.push(path);
                    }
                }
            }
            let mut files = Vec::new();
            walk(&self.root.join(".mci-manager").join(kind), &mut files);
            files
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.base).unwrap();
        }
    }

    #[test]
    fn only_default_or_native_approved_specific_roots_can_activate() {
        let mut fixture = Fixture::new();
        for path in [
            PathBuf::from("/"),
            fixture.home.clone(),
            fixture.base.clone(),
            PathBuf::from("relative"),
            fixture.config.clone(),
        ] {
            assert!(fixture.vault.activate(&path).is_err());
        }
        let custom = fixture.base.join("custom");
        fs::create_dir(&custom).unwrap();
        assert!(fixture.vault.activate(&custom).is_err());
        fixture.vault.approve_root(&custom).unwrap();
        assert_eq!(fixture.vault.root().unwrap().canonical, fixture.root);
        let mut reloaded = Vault::new(fixture.home.clone(), fixture.config.clone()).unwrap();
        reloaded.activate(&custom).unwrap();
        assert_eq!(reloaded.root().unwrap().canonical, custom);
        assert!(reloaded
            .save_text(&fixture.config.join("vault-grants.json"), "{}", None)
            .is_err());
    }

    #[test]
    fn malformed_or_changed_persisted_grants_fail_closed() {
        let mut fixture = Fixture::new();
        fs::create_dir(&fixture.config).unwrap();
        fs::write(fixture.config.join("vault-grants.json"), "invalid").unwrap();
        assert!(Vault::new(fixture.home.clone(), fixture.config.clone()).is_err());
        let custom = fixture.base.join("custom");
        fs::create_dir(&custom).unwrap();
        assert_eq!(fixture.vault.approve_root(&custom).unwrap_err(), "CONFLICT");
        assert!(fixture.vault.activate(&custom).is_err());
    }

    #[test]
    fn absent_is_null_but_invalid_utf8_directories_and_not_a_directory_are_errors() {
        let fixture = Fixture::new();
        assert_eq!(fixture.vault.read_text(&fixture.note()).unwrap(), None);
        assert!(fixture.vault.read_text(&fixture.root).is_err());
        let invalid = fixture.root.join("invalid");
        fs::write(&invalid, [0xff]).unwrap();
        assert!(fixture.vault.read_text(&invalid).is_err());
        assert!(fixture.vault.read_text(&invalid.join("child")).is_err());
        assert!(fixture.vault.list_docs(&invalid).is_err());
        assert!(fixture
            .vault
            .list_docs(&fixture.root.join("missing"))
            .unwrap()
            .is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn permission_failures_are_not_absence() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = Fixture::new();
        let path = fixture.root.join("private");
        fs::write(&path, "private").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
        // Root can read mode-000 files, so only assert the permission branch when enforced.
        if fs::read(&path).is_err() {
            assert!(fixture.vault.read_text(&path).is_err());
        }
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    }

    #[test]
    fn every_operation_rejects_outside_and_traversal_paths() {
        let mut fixture = Fixture::new();
        let source = fixture.base.join("source.pdf");
        fs::write(&source, "source").unwrap();
        fixture.vault.approve_source(&source).unwrap();
        let outside = fixture.base.join("outside");
        let traversal = fixture.root.join("missing/../../outside");
        let sibling_prefix = fixture.home.join("MCI-other/file");
        for path in [&outside, &traversal, &sibling_prefix] {
            assert!(fixture.vault.read_text(path).is_err());
            assert!(fixture.vault.save_text(path, "bad", None).is_err());
            assert!(fixture.vault.ensure_dir(path).is_err());
            assert!(fixture.vault.list_docs(path).is_err());
            assert!(fixture.vault.discover_notes(path).is_err());
            assert!(fixture.vault.copy_into(&source, path).is_err());
            assert!(fixture.vault.trash(path).is_err());
            assert!(fixture.vault.document_to_open(path).is_err());
            assert!(fixture.vault.path_to_reveal(path).is_err());
        }
        assert!(!outside.exists());
        assert!(!fixture.home.join("MCI-other").exists());
    }

    #[cfg(unix)]
    #[test]
    fn child_symlinks_are_rejected_even_with_missing_targets_or_internal_destinations() {
        use std::os::unix::fs::symlink;
        let mut fixture = Fixture::new();
        let outside = fixture.base.join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("secret"), "untouched").unwrap();
        let source = fixture.base.join("source.pdf");
        fs::write(&source, "source").unwrap();
        fixture.vault.approve_source(&source).unwrap();
        symlink(&outside, fixture.root.join("escape")).unwrap();
        symlink(fixture.root.join("absent"), fixture.root.join("dangling")).unwrap();
        symlink(&fixture.root, fixture.root.join("inside")).unwrap();
        for name in ["escape", "dangling", "inside"] {
            let link = fixture.root.join(name);
            assert!(fixture.vault.read_text(&link.join("secret")).is_err());
            assert!(fixture
                .vault
                .save_text(&link.join("new/notes.md"), "bad", None)
                .is_err());
            assert!(fixture.vault.ensure_dir(&link.join("new")).is_err());
            assert!(fixture.vault.list_docs(&link).is_err());
            assert!(fixture.vault.copy_into(&source, &link).is_err());
            assert!(fixture.vault.trash(&link.join("secret")).is_err());
            assert!(fixture.vault.path_to_reveal(&link).is_err());
        }
        assert!(fixture.vault.discover_notes(&fixture.root).is_err());
        assert_eq!(
            fs::read_to_string(outside.join("secret")).unwrap(),
            "untouched"
        );
        assert!(!outside.join("new").exists());
    }

    #[cfg(unix)]
    #[test]
    fn selected_root_alias_is_canonicalized_but_retargeting_is_denied() {
        use std::os::unix::fs::symlink;
        let mut fixture = Fixture::new();
        let custom = fixture.base.join("custom");
        let alternate = fixture.base.join("alternate");
        let alias = fixture.base.join("alias");
        fs::create_dir(&custom).unwrap();
        fs::create_dir(&alternate).unwrap();
        symlink(&custom, &alias).unwrap();
        fixture.vault.approve_root(&alias).unwrap();
        fixture.vault.activate(&alias).unwrap();
        fixture
            .vault
            .save_text(&alias.join("note.md"), "okay", None)
            .unwrap();
        let note = alias.join("semester/fach/termin/notes.md");
        fixture.vault.save_text(&note, "identity", None).unwrap();
        let notes = fixture
            .vault
            .discover_notes(&alias.join("semester"))
            .unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(Path::new(&notes[0].path), note);
        let renamed = alias.join("semester/fach/termin/2026-10-05 0900 Databases.md");
        fs::rename(&note, &renamed).unwrap();
        for dir in [&alias, &alias.join("semester")] {
            let notes = fixture.vault.discover_notes(dir).unwrap();
            assert_eq!(notes.len(), 1);
            assert_eq!(Path::new(&notes[0].path), renamed);
            assert_eq!(notes[0].content, "identity");
        }
        assert_eq!(fs::read_to_string(custom.join("note.md")).unwrap(), "okay");
        fs::remove_file(&alias).unwrap();
        symlink(&alternate, &alias).unwrap();
        assert!(fixture
            .vault
            .save_text(&alias.join("note.md"), "bad", None)
            .is_err());
        assert!(fixture.vault.discover_notes(&alias).is_err());
        assert!(!alternate.join("note.md").exists());
    }

    #[test]
    fn all_writes_compare_bytes_and_preserve_previous_versions() {
        let fixture = Fixture::new();
        let path = fixture.note();
        fixture
            .vault
            .save_text(&path, "original\r\n", None)
            .unwrap();
        assert_eq!(
            fixture.vault.save_text(&path, "bad", None).unwrap_err(),
            "CONFLICT"
        );
        assert_eq!(
            fixture
                .vault
                .save_text(&path, "bad", Some("original\n"))
                .unwrap_err(),
            "CONFLICT"
        );
        let before = File::open(&path).unwrap();
        fixture
            .vault
            .save_text(&path, "updated", Some("original\r\n"))
            .unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "updated");
        assert_eq!(
            before.metadata().unwrap().len(),
            "original\r\n".len() as u64
        );
        let backups = fixture.archive_files("history");
        assert_eq!(backups.len(), 1);
        assert!(backups[0].ends_with("semester/fach/termin/notes.md"));
        assert_eq!(fs::read_to_string(&backups[0]).unwrap(), "original\r\n");
        fs::write(&path, "external").unwrap();
        assert_eq!(
            fixture
                .vault
                .save_text(&path, "bad", Some("updated"))
                .unwrap_err(),
            "CONFLICT"
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "external");
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    }

    #[test]
    fn concurrent_stale_writes_have_exactly_one_winner() {
        let fixture = Fixture::new();
        let path = fixture.note();
        fixture.vault.save_text(&path, "original", None).unwrap();
        let mut vault = Vault::new(fixture.home.clone(), fixture.config.clone()).unwrap();
        vault.activate(&fixture.root).unwrap();
        let shared = Arc::new(Mutex::new(vault));
        let start = Arc::new(Barrier::new(3));
        let handles: Vec<_> = ["first", "second"]
            .into_iter()
            .map(|content| {
                let shared = shared.clone();
                let start = start.clone();
                let path = path.clone();
                std::thread::spawn(move || {
                    start.wait();
                    shared
                        .lock()
                        .unwrap()
                        .save_text(&path, content, Some("original"))
                })
            })
            .collect();
        start.wait();
        let results: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, Err(error) if error == "CONFLICT"))
                .count(),
            1
        );
        assert_eq!(fixture.archive_files("history").len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn backup_failure_preserves_original_and_cleans_temporary_file() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let path = fixture.note();
        fixture.vault.save_text(&path, "original", None).unwrap();
        fs::create_dir(fixture.root.join(".mci-manager")).unwrap();
        symlink(&fixture.base, fixture.root.join(".mci-manager/history")).unwrap();
        assert!(fixture
            .vault
            .save_text(&path, "bad", Some("original"))
            .is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "original");
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    }

    #[test]
    fn copy_requires_native_grants_and_reserves_without_overwrite() {
        let mut fixture = Fixture::new();
        let source = fixture.base.join("paper.pdf");
        let docs = fixture.root.join("semester/fach/termin/docs");
        fs::write(&source, "import").unwrap();
        assert!(fixture.vault.copy_into(&source, &docs).is_err());
        assert!(!docs.exists());
        assert!(fixture.vault.approve_source(&fixture.base.clone()).is_err());
        fixture.vault.ensure_dir(&docs).unwrap();
        fs::write(docs.join("paper.pdf"), "existing").unwrap();
        fixture.vault.approve_source(&source).unwrap();
        let copied = fixture.vault.copy_into(&source, &docs).unwrap();
        assert_eq!(Path::new(&copied), docs.join("paper-1.pdf"));
        assert_eq!(fs::read_to_string(copied).unwrap(), "import");
        assert_eq!(
            fs::read_to_string(docs.join("paper.pdf")).unwrap(),
            "existing"
        );
        assert!(fixture.vault.copy_into(&source, &docs).is_err());
    }

    #[test]
    fn native_import_grant_keeps_the_selected_file_open_and_expires() {
        let mut fixture = Fixture::new();
        let source = fixture.base.join("paper.pdf");
        let docs = fixture.root.join("semester/fach/termin/docs");
        fs::write(&source, "selected").unwrap();
        fixture.vault.approve_source(&source).unwrap();
        fs::rename(&source, fixture.base.join("old.pdf")).unwrap();
        fs::write(&source, "replacement").unwrap();
        let copied = fixture.vault.copy_into(&source, &docs).unwrap();
        assert_eq!(fs::read_to_string(copied).unwrap(), "selected");
        fixture.vault.approve_source(&source).unwrap();
        fixture.vault.sources.get_mut(&source).unwrap().expires = Instant::now();
        assert!(fixture.vault.copy_into(&source, &docs).is_err());
    }

    #[test]
    fn discovery_finds_mixed_named_and_legacy_markdown_notes() {
        let fixture = Fixture::new();
        let appointment = fixture.root.join("semester/fach/termin");
        let expected = [
            ("2026-10-05 0900 Databases.md", "named note"),
            ("extra.md", "unindexed note"),
            ("notes.md", "legacy note"),
        ];
        for (name, content) in expected {
            fixture
                .vault
                .save_text(&appointment.join(name), content, None)
                .unwrap();
        }
        for dir in [&fixture.root, &fixture.root.join("semester")] {
            let notes = fixture.vault.discover_notes(dir).unwrap();
            assert_eq!(notes.len(), expected.len());
            for (note, (name, content)) in notes.iter().zip(expected) {
                assert_eq!(Path::new(&note.path), appointment.join(name));
                assert_eq!(note.content, content);
            }
        }
        fs::write(appointment.join(expected[0].0), [0xff]).unwrap();
        assert!(fixture.vault.discover_notes(&fixture.root).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn discovery_rejects_named_note_symlinks() {
        use std::os::unix::fs::symlink;
        for target in ["outside.md", "home/MCI/inside.md", "missing.md"] {
            let fixture = Fixture::new();
            let appointment = fixture.root.join("semester/fach/termin");
            fs::create_dir_all(&appointment).unwrap();
            fs::write(fixture.base.join("outside.md"), "outside").unwrap();
            fs::write(fixture.root.join("inside.md"), "inside").unwrap();
            symlink(
                fixture.base.join(target),
                appointment.join("2026-10-05 0900 Databases.md"),
            )
            .unwrap();
            for dir in [&fixture.root, &fixture.root.join("semester")] {
                assert!(matches!(
                    fixture.vault.discover_notes(dir),
                    Err(error) if error == DENIED
                ));
            }
        }
    }

    #[test]
    fn discovery_returns_full_paths_and_propagates_note_errors() {
        let fixture = Fixture::new();
        fixture
            .vault
            .save_text(&fixture.note(), "note", None)
            .unwrap();
        for path in [
            "README.md",
            "semester/README.md",
            "semester/fach/README.md",
            "semester/fach/termin/.hidden.md",
            "semester/fach/termin/uppercase.MD",
            "semester/fach/termin/notes.txt",
            "semester/fach/termin/docs/notes.md",
            "semester/fach/termin/docs/2026-10-05 0900 Databases.md",
            "semester/fach/termin/child/notes.md",
            "semester/fach/termin/directory.md/notes.md",
            "semester/fach/.hidden/notes.md",
            "semester/.hidden/termin/notes.md",
            ".hidden/fach/termin/notes.md",
        ] {
            fixture
                .vault
                .save_text(&fixture.root.join(path), "ignore", None)
                .unwrap();
        }
        for dir in [&fixture.root, &fixture.root.join("semester")] {
            let notes = fixture.vault.discover_notes(dir).unwrap();
            assert_eq!(notes.len(), 1);
            assert_eq!(notes[0].path, fixture.note().to_str().unwrap());
            assert_eq!(notes[0].content, "note");
        }
        assert!(fixture
            .vault
            .discover_notes(&fixture.root.join("semester/fach"))
            .is_err());
        assert!(fixture
            .vault
            .discover_notes(&fixture.root.join("semester/fach/termin"))
            .is_err());
        fs::write(fixture.note(), [0xff]).unwrap();
        assert!(fixture.vault.discover_notes(&fixture.root).is_err());
    }

    #[test]
    fn deletion_is_recoverable_and_archives_are_protected() {
        let fixture = Fixture::new();
        let path = fixture.note();
        fixture.vault.save_text(&path, "recover", None).unwrap();
        fixture.vault.trash(&path).unwrap();
        assert!(!path.exists());
        let files = fixture.archive_files("trash");
        assert_eq!(files.len(), 1);
        assert!(files[0].ends_with("semester/fach/termin/notes.md"));
        assert_eq!(fs::read_to_string(&files[0]).unwrap(), "recover");
        assert!(fixture.vault.trash(&files[0]).is_err());
        assert!(fixture
            .vault
            .save_text(&files[0], "bad", Some("recover"))
            .is_err());
        assert!(fixture
            .vault
            .ensure_dir(&fixture.root.join(".mci-manager/history/new"))
            .is_err());
        assert!(fixture.vault.trash(&fixture.root.join("semester")).is_err());
    }

    #[test]
    fn revealing_requires_an_existing_regular_file_or_directory() {
        let fixture = Fixture::new();
        let docs = fixture.root.join("semester/fach/termin/docs");
        fixture.vault.ensure_dir(&docs).unwrap();
        let file = docs.join("paper.pdf");
        fs::write(&file, "data").unwrap();
        assert_eq!(fixture.vault.path_to_reveal(&file).unwrap(), file);
        assert_eq!(fixture.vault.path_to_reveal(&docs).unwrap(), docs);
        assert_eq!(
            fixture.vault.path_to_reveal(&fixture.root).unwrap(),
            fixture.root
        );
        assert!(fixture
            .vault
            .path_to_reveal(&docs.join("absent.pdf"))
            .is_err());
        #[cfg(unix)]
        {
            let fifo_path = docs.join("fifo");
            assert!(std::process::Command::new("mkfifo")
                .arg(&fifo_path)
                .status()
                .unwrap()
                .success());
            assert!(fixture.vault.path_to_reveal(&fifo_path).is_err());
        }
    }

    #[test]
    fn knowledge_opening_accepts_only_scoped_markdown_and_source_pdfs() {
        let fixture = Fixture::new();
        for relative in [
            "README.md",
            "Studium/Studienwissen.md",
            "Studium/Quellen/Studienordnung.pdf",
            "semester/_Semester.md",
            "semester/fach/Fach.md",
            "semester/fach/Fach - Sakai.md",
            "semester/fach/termin/notes.md",
            "semester/fach/termin/Lernpräsentation.md",
        ] {
            let path = fixture.root.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "knowledge").unwrap();
            assert_eq!(
                fixture.vault.knowledge_document_to_open(&path).unwrap(),
                path.to_str().unwrap()
            );
            assert!(fixture.vault.document_to_open(&path).is_err());
        }
    }

    #[test]
    fn knowledge_opening_rejects_other_scopes_extensions_and_hidden_components() {
        let fixture = Fixture::new();
        for relative in [
            "other.md",
            "README.pdf",
            "Studium/paper.pdf",
            "Studium/script.command",
            "Studium/Quellen/note.md",
            "Studium/Quellen/script.command",
            "Studium/Quellen/nested/paper.pdf",
            "Studium/nested/note.md",
            "semester/notes.md",
            "semester/fach/paper.pdf",
            "semester/fach/page.html",
            "semester/fach/script.command",
            "semester/fach/termin/page.html",
            "semester/fach/termin/slides.pptx",
            "semester/fach/termin/script.command",
            "semester/fach/termin/docs/note.md",
            "semester/fach/termin/docs/paper.pdf",
            "Studium/.hidden.md",
            "Studium/Quellen/.hidden.pdf",
            ".semester/fach/note.md",
            "semester/.fach/note.md",
            "semester/fach/.hidden.md",
            "semester/fach/.termin/note.md",
            "semester/fach/termin/.hidden.md",
            ".mci-manager/history/note.md",
            ".mci-manager/trash/note.md",
            "history/fach/note.md",
            "semester/trash/note.md",
        ] {
            let path = fixture.root.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "blocked").unwrap();
            assert!(
                fixture.vault.knowledge_document_to_open(&path).is_err(),
                "{relative}"
            );
        }
        assert!(fixture
            .vault
            .document_to_open(&fixture.root.join("semester/fach/termin/docs/paper.pdf"))
            .is_ok());
    }

    #[test]
    fn knowledge_opening_requires_existing_regular_files() {
        let fixture = Fixture::new();
        for relative in [
            "README.md",
            "Studium/Studienwissen.md",
            "Studium/Quellen/paper.pdf",
            "semester/_Semester.md",
            "semester/fach/Fach.md",
        ] {
            let path = fixture.root.join(relative);
            assert!(fixture.vault.knowledge_document_to_open(&path).is_err());
            fs::create_dir_all(&path).unwrap();
            assert!(fixture.vault.knowledge_document_to_open(&path).is_err());
        }
        assert!(fixture
            .vault
            .knowledge_document_to_open(&fixture.root)
            .is_err());
    }

    #[test]
    fn knowledge_opening_rejects_outside_paths_and_traversal() {
        let fixture = Fixture::new();
        let sibling = fixture.home.join("MCI-other");
        fs::create_dir(&sibling).unwrap();
        fs::write(sibling.join("README.md"), "outside").unwrap();
        fs::write(fixture.base.join("README.md"), "outside").unwrap();
        fs::write(fixture.root.join("README.md"), "inside").unwrap();
        fs::create_dir(fixture.root.join("Studium")).unwrap();
        for path in [
            fixture.base.join("README.md"),
            sibling.join("README.md"),
            fixture.root.join("../MCI/README.md"),
            fixture.root.join("Studium/../README.md"),
            PathBuf::from("README.md"),
            PathBuf::from("Studium/../README.md"),
        ] {
            assert!(fixture.vault.knowledge_document_to_open(&path).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn knowledge_opening_preserves_root_aliases_and_trailing_spaces() {
        use std::os::unix::fs::symlink;
        let mut fixture = Fixture::new();
        let custom = fixture.base.join("knowledge vault ");
        let alias = fixture.base.join("vault alias ");
        fs::create_dir(&custom).unwrap();
        fs::write(custom.join("README.md"), "knowledge").unwrap();
        symlink(&custom, &alias).unwrap();
        fixture.vault.approve_root(&alias).unwrap();
        fixture.vault.activate(&alias).unwrap();
        for root in [&custom, &alias] {
            assert_eq!(
                fixture
                    .vault
                    .knowledge_document_to_open(&root.join("README.md"))
                    .unwrap(),
                custom.join("README.md").to_str().unwrap()
            );
        }
        fs::remove_file(&alias).unwrap();
        symlink(&fixture.root, &alias).unwrap();
        assert!(fixture
            .vault
            .knowledge_document_to_open(&custom.join("README.md"))
            .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn knowledge_opening_rejects_file_and_directory_symlinks() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let outside = fixture.base.join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("note.md"), "outside").unwrap();
        fs::write(outside.join("paper.pdf"), "outside").unwrap();
        fs::create_dir_all(fixture.root.join("Studium/Quellen")).unwrap();
        fs::create_dir(fixture.root.join("semester")).unwrap();
        symlink(outside.join("note.md"), fixture.root.join("README.md")).unwrap();
        symlink(
            outside.join("paper.pdf"),
            fixture.root.join("Studium/Quellen/paper.pdf"),
        )
        .unwrap();
        symlink(&outside, fixture.root.join("semester/fach")).unwrap();
        for relative in [
            "README.md",
            "Studium/Quellen/paper.pdf",
            "semester/fach/note.md",
        ] {
            assert!(fixture
                .vault
                .knowledge_document_to_open(&fixture.root.join(relative))
                .is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn knowledge_opening_rejects_executable_markdown_and_pdfs() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = Fixture::new();
        for relative in [
            "README.md",
            "Studium/Quellen/paper.pdf",
            "semester/fach/termin/Lernpräsentation.md",
        ] {
            let path = fixture.root.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "executable").unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            assert!(fixture.vault.knowledge_document_to_open(&path).is_err());
        }
    }

    #[test]
    fn sakai_pdfs_are_content_addressed_and_never_replace_modified_originals() {
        let fixture = Fixture::new();
        let bytes = b"%PDF-1.7\nexample\n%%EOF";
        let relative = fixture.vault.save_sakai_pdf(&fixture.root, bytes).unwrap();
        assert!(relative.starts_with("Studium/Quellen/Sakai-"));
        assert_eq!(fs::read(fixture.root.join(&relative)).unwrap(), bytes);
        assert_eq!(
            fixture.vault.save_sakai_pdf(&fixture.root, bytes).unwrap(),
            relative
        );
        assert!(fixture
            .vault
            .knowledge_document_to_open(&fixture.root.join(&relative))
            .is_ok());
        fs::write(fixture.root.join(&relative), b"personal annotation").unwrap();
        assert_eq!(
            fixture
                .vault
                .save_sakai_pdf(&fixture.root, bytes)
                .unwrap_err(),
            "CONFLICT"
        );
        assert_eq!(
            fs::read(fixture.root.join(&relative)).unwrap(),
            b"personal annotation"
        );
        assert!(!fixture.root.join(".mci-manager/history").exists());
    }

    #[test]
    fn sakai_pdf_import_requires_the_active_root_and_bounded_pdf_bytes() {
        let mut fixture = Fixture::new();
        for bytes in [
            Vec::new(),
            b"<html>Login required</html>".to_vec(),
            vec![0; 15 * 1024 * 1024 + 1],
        ] {
            assert!(fixture.vault.save_sakai_pdf(&fixture.root, &bytes).is_err());
        }
        assert!(!fixture.root.join("Studium").exists());
        let bytes = b"%PDF-1.7\nexample";
        for root in [
            &fixture.home,
            &fixture.root.join("Studium"),
            &fixture.root.join("../MCI"),
        ] {
            assert!(fixture.vault.save_sakai_pdf(root, bytes).is_err());
        }
        let custom = fixture.home.join("Other Vault");
        fs::create_dir(&custom).unwrap();
        fixture.vault.approve_root(&custom).unwrap();
        fixture.vault.activate(&custom).unwrap();
        assert!(fixture.vault.save_sakai_pdf(&fixture.root, bytes).is_err());
        assert!(!fixture.root.join("Studium").exists());
    }

    #[cfg(unix)]
    #[test]
    fn sakai_pdf_import_rejects_symlinks_and_accepts_the_exact_root_alias() {
        use std::os::unix::fs::symlink;
        let mut fixture = Fixture::new();
        let custom = fixture.home.join("MCIt ").join("MCIt");
        fs::create_dir_all(&custom).unwrap();
        let alias = fixture.home.join("Alias");
        symlink(&custom, &alias).unwrap();
        fixture.vault.approve_root(&alias).unwrap();
        fixture.vault.activate(&alias).unwrap();
        let bytes = b"%PDF-1.7\nexample";
        let relative = fixture.vault.save_sakai_pdf(&alias, bytes).unwrap();
        assert_eq!(fs::read(custom.join(relative)).unwrap(), bytes);
        let outside = fixture.home.join("Outside");
        fs::create_dir(&outside).unwrap();
        fixture.vault.activate(&fixture.root).unwrap();
        symlink(&outside, fixture.root.join("Studium")).unwrap();
        assert!(fixture.vault.save_sakai_pdf(&fixture.root, bytes).is_err());
        assert!(fs::read_dir(&outside).unwrap().next().is_none());
    }

    #[test]
    fn opening_is_limited_to_regular_documents_in_termin_docs() {
        let fixture = Fixture::new();
        let docs = fixture.root.join("semester/fach/termin/docs");
        fixture.vault.ensure_dir(&docs).unwrap();
        for name in ["paper.pdf", "script.command", "page.html"] {
            fs::write(docs.join(name), "data").unwrap();
        }
        assert!(fixture
            .vault
            .document_to_open(&docs.join("paper.pdf"))
            .is_ok());
        assert!(fixture
            .vault
            .document_to_open(&docs.join("script.command"))
            .is_err());
        assert!(fixture
            .vault
            .document_to_open(&docs.join("page.html"))
            .is_err());
        assert!(fixture.vault.document_to_open(&docs).is_err());
        assert!(fixture.vault.document_to_open(&fixture.note()).is_err());
    }
}
