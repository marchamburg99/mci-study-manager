use std::path::PathBuf;
use std::sync::Arc;

pub const MAX_STORED_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StorageError;

pub trait Store: Send + Sync {
    fn enabled(&self) -> Result<bool, StorageError>;
    fn set_enabled(&self, enabled: bool) -> Result<(), StorageError>;
    fn read(&self) -> Result<Option<Vec<u8>>, StorageError>;
    fn write(&self, bytes: &[u8]) -> Result<(), StorageError>;
    fn delete(&self) -> Result<(), StorageError>;
}

pub struct UnavailableStore {
    failed: bool,
}

impl Store for UnavailableStore {
    fn enabled(&self) -> Result<bool, StorageError> {
        if self.failed {
            Err(StorageError)
        } else {
            Ok(false)
        }
    }
    fn set_enabled(&self, _: bool) -> Result<(), StorageError> {
        Err(StorageError)
    }
    fn read(&self) -> Result<Option<Vec<u8>>, StorageError> {
        Err(StorageError)
    }
    fn write(&self, _: &[u8]) -> Result<(), StorageError> {
        Err(StorageError)
    }
    fn delete(&self) -> Result<(), StorageError> {
        Err(StorageError)
    }
}

pub fn native_store(config: Option<PathBuf>) -> Arc<dyn Store> {
    #[cfg(all(target_os = "macos", not(test)))]
    if let Some(config) = config {
        let marker = native::Marker(config);
        return match marker.claim_owner() {
            Ok(ownership) => Arc::new(native::KeychainStore {
                marker,
                _ownership: ownership,
            }),
            Err(_) => Arc::new(UnavailableStore { failed: true }),
        };
    }
    #[cfg(any(not(target_os = "macos"), test))]
    let _ = config;
    Arc::new(UnavailableStore { failed: false })
}

#[cfg(test)]
pub mod test_store {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    pub struct Memory {
        pub enabled: bool,
        pub bytes: Option<Vec<u8>>,
        pub events: Vec<&'static str>,
        pub fail_marker: bool,
        pub fail_read: bool,
        pub fail_write: bool,
        pub fail_delete: bool,
        pub during_read: Option<Box<dyn FnOnce() + Send>>,
        pub during_write: Option<Box<dyn FnOnce() + Send>>,
        pub after_disable: Option<Box<dyn FnOnce() + Send>>,
    }

    #[derive(Clone, Default)]
    pub struct MemoryStore(pub Arc<Mutex<Memory>>);

    impl Store for MemoryStore {
        fn enabled(&self) -> Result<bool, StorageError> {
            let mut memory = self.0.lock().unwrap();
            memory.events.push("marker");
            if memory.fail_marker {
                return Err(StorageError);
            }
            Ok(memory.enabled)
        }
        fn set_enabled(&self, enabled: bool) -> Result<(), StorageError> {
            let mut memory = self.0.lock().unwrap();
            memory
                .events
                .push(if enabled { "enable" } else { "disable" });
            if memory.fail_marker {
                return Err(StorageError);
            }
            memory.enabled = enabled;
            let callback = if enabled {
                None
            } else {
                memory.after_disable.take()
            };
            drop(memory);
            if let Some(callback) = callback {
                callback();
            }
            Ok(())
        }
        fn read(&self) -> Result<Option<Vec<u8>>, StorageError> {
            let (bytes, callback) = {
                let mut memory = self.0.lock().unwrap();
                memory.events.push("read");
                if memory.fail_read {
                    return Err(StorageError);
                }
                (memory.bytes.clone(), memory.during_read.take())
            };
            if let Some(callback) = callback {
                callback();
            }
            Ok(bytes)
        }
        fn write(&self, bytes: &[u8]) -> Result<(), StorageError> {
            let callback = {
                let mut memory = self.0.lock().unwrap();
                memory.events.push("write");
                if memory.fail_write {
                    return Err(StorageError);
                }
                memory.during_write.take()
            };
            if let Some(callback) = callback {
                callback();
            }
            self.0.lock().unwrap().bytes = Some(bytes.to_vec());
            Ok(())
        }
        fn delete(&self) -> Result<(), StorageError> {
            let mut memory = self.0.lock().unwrap();
            memory.events.push("delete");
            assert!(
                !memory.enabled || memory.fail_marker,
                "Revocation must be attempted before deletion"
            );
            if memory.fail_delete {
                return Err(StorageError);
            }
            memory.bytes = None;
            Ok(())
        }
    }
}

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use std::fs::{self, File, OpenOptions};
    use std::io::{Read, Write};
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
    use std::path::{Component, Path};
    use std::sync::atomic::{AtomicU64, Ordering};

    const MARKER: &str = "sakai-session-opt-in";
    const OWNER: &str = "sakai-session-owner.lock";
    const ENABLED: &[u8] = b"sakai-session-v1:enabled\n";
    const DISABLED: &[u8] = b"sakai-session-v1:disabled\n";
    const O_NOFOLLOW: i32 = 0x100;
    static TEMP_ID: AtomicU64 = AtomicU64::new(0);

    pub(super) struct Marker(pub PathBuf);

    impl Marker {
        pub(super) fn claim_owner(&self) -> Result<File, StorageError> {
            let directory = self.directory(true)?;
            let owner = fs::symlink_metadata(&directory)
                .map_err(|_| StorageError)?
                .uid();
            let path = directory.join(OWNER);
            Self::metadata(&path, owner)?;
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .mode(0o600)
                .custom_flags(O_NOFOLLOW)
                .open(&path)
                .map_err(|_| StorageError)?;
            let opened = file.metadata().map_err(|_| StorageError)?;
            let current = Self::metadata(&path, owner)?.ok_or(StorageError)?;
            if opened.dev() != current.dev() || opened.ino() != current.ino() {
                return Err(StorageError);
            }
            file.try_lock().map_err(|_| StorageError)?;
            // Never unlink or replace this inode: workers keep the owning Store alive.
            Ok(file)
        }

        fn directory(&self, create: bool) -> Result<PathBuf, StorageError> {
            if !self.0.is_absolute() {
                return Err(StorageError);
            }
            let mut path = PathBuf::new();
            for component in self.0.components() {
                if !matches!(component, Component::RootDir | Component::Normal(_)) {
                    return Err(StorageError);
                }
                path.push(component);
                match fs::symlink_metadata(&path) {
                    Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {}
                    Err(error) if create && error.kind() == std::io::ErrorKind::NotFound => {
                        fs::DirBuilder::new()
                            .mode(0o700)
                            .create(&path)
                            .map_err(|_| StorageError)?;
                    }
                    _ => return Err(StorageError),
                }
            }
            let meta = fs::symlink_metadata(&path).map_err(|_| StorageError)?;
            if meta.mode() & 0o022 != 0 {
                return Err(StorageError);
            }
            Ok(path)
        }

        fn metadata(path: &Path, owner: u32) -> Result<Option<fs::Metadata>, StorageError> {
            match fs::symlink_metadata(path) {
                Ok(meta)
                    if meta.is_file()
                        && meta.nlink() == 1
                        && meta.uid() == owner
                        && meta.mode() & 0o777 == 0o600
                        && meta.len() <= 64 =>
                {
                    Ok(Some(meta))
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
                _ => Err(StorageError),
            }
        }

        pub(super) fn enabled(&self) -> Result<bool, StorageError> {
            if !self.0.try_exists().map_err(|_| StorageError)? {
                return Ok(false);
            }
            let directory = self.directory(false)?;
            let owner = fs::symlink_metadata(&directory)
                .map_err(|_| StorageError)?
                .uid();
            let path = directory.join(MARKER);
            let Some(before) = Self::metadata(&path, owner)? else {
                return Ok(false);
            };
            let file = OpenOptions::new()
                .read(true)
                .custom_flags(O_NOFOLLOW)
                .open(&path)
                .map_err(|_| StorageError)?;
            let after = file.metadata().map_err(|_| StorageError)?;
            if before.dev() != after.dev() || before.ino() != after.ino() {
                return Err(StorageError);
            }
            let mut bytes = Vec::new();
            file.take(65)
                .read_to_end(&mut bytes)
                .map_err(|_| StorageError)?;
            match bytes.as_slice() {
                ENABLED => Ok(true),
                DISABLED => Ok(false),
                _ => Err(StorageError),
            }
        }

        pub(super) fn set_enabled(&self, enabled: bool) -> Result<(), StorageError> {
            let directory = self.directory(true)?;
            let owner = fs::symlink_metadata(&directory)
                .map_err(|_| StorageError)?
                .uid();
            let path = directory.join(MARKER);
            Self::metadata(&path, owner)?;
            let temporary = directory.join(format!(
                ".sakai-opt-in-{}-{}",
                std::process::id(),
                TEMP_ID.fetch_add(1, Ordering::Relaxed)
            ));
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(O_NOFOLLOW)
                .open(&temporary)
                .map_err(|_| StorageError)?;
            let result = (|| {
                file.write_all(if enabled { ENABLED } else { DISABLED })
                    .map_err(|_| StorageError)?;
                file.sync_all().map_err(|_| StorageError)?;
                self.directory(false)?;
                Self::metadata(&path, owner)?;
                fs::rename(&temporary, &path).map_err(|_| StorageError)?;
                File::open(&directory)
                    .and_then(|file| file.sync_all())
                    .map_err(|_| StorageError)
            })();
            if result.is_err() {
                let _ = fs::remove_file(&temporary);
            }
            result
        }
    }

    #[cfg(not(test))]
    pub(super) struct KeychainStore {
        pub marker: Marker,
        pub _ownership: File,
    }

    #[cfg(not(test))]
    fn options() -> security_framework::passwords::PasswordOptions {
        let mut options = security_framework::passwords::PasswordOptions::new_generic_password(
            "de.mci.studymanager.sakai-session",
            "sakai.mci4me.at",
        );
        options.set_access_synchronized(Some(false));
        options
    }

    #[cfg(not(test))]
    impl Store for KeychainStore {
        fn enabled(&self) -> Result<bool, StorageError> {
            self.marker.enabled()
        }
        fn set_enabled(&self, enabled: bool) -> Result<(), StorageError> {
            self.marker.set_enabled(enabled)
        }
        fn read(&self) -> Result<Option<Vec<u8>>, StorageError> {
            match security_framework::passwords::generic_password(options()) {
                Ok(bytes) => Ok(Some(bytes)),
                Err(error) if error.code() == -25300 => Ok(None),
                Err(_) => Err(StorageError),
            }
        }
        fn write(&self, bytes: &[u8]) -> Result<(), StorageError> {
            if bytes.is_empty() || bytes.len() > MAX_STORED_BYTES {
                return Err(StorageError);
            }
            security_framework::passwords::set_generic_password_options(bytes, options())
                .map_err(|_| StorageError)
        }
        fn delete(&self) -> Result<(), StorageError> {
            match security_framework::passwords::delete_generic_password_options(options()) {
                Ok(()) => Ok(()),
                Err(error) if error.code() == -25300 => Ok(()),
                Err(_) => Err(StorageError),
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::os::unix::fs::{symlink, PermissionsExt};

        #[test]
        fn owner_lock_child() {
            let Some(root) = std::env::var_os("MCI_TEST_SAKAI_OWNER_PATH") else {
                return;
            };
            assert!(Marker(root.into()).claim_owner().is_err());
        }

        #[test]
        fn only_one_process_can_own_session_storage() {
            let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
                "sakai-owner-test-{}-{}",
                std::process::id(),
                TEMP_ID.fetch_add(1, Ordering::Relaxed)
            ));
            let marker = Marker(root.join("config"));
            let owner = marker.claim_owner().unwrap();
            assert!(marker.claim_owner().is_err());
            let child = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "sakai_credentials::native::tests::owner_lock_child",
                ])
                .env("MCI_TEST_SAKAI_OWNER_PATH", &marker.0)
                .output()
                .unwrap();
            assert!(child.status.success());
            drop(owner);
            let next = marker.claim_owner().unwrap();
            drop(next);
            fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn marker_is_atomic_private_bounded_and_rejects_links() {
            let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
                "sakai-marker-test-{}-{}",
                std::process::id(),
                TEMP_ID.fetch_add(1, Ordering::Relaxed)
            ));
            let marker = Marker(root.join("config"));
            assert!(!marker.enabled().unwrap());
            marker.set_enabled(true).unwrap();
            assert!(marker.enabled().unwrap());
            marker.set_enabled(false).unwrap();
            assert!(!marker.enabled().unwrap());
            let path = marker.0.join(MARKER);
            assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
            fs::write(&path, b"invalid").unwrap();
            assert!(marker.enabled().is_err());
            fs::write(&path, [0; 65]).unwrap();
            assert!(marker.enabled().is_err());
            fs::remove_file(&path).unwrap();
            symlink(root.join("missing"), &path).unwrap();
            assert!(marker.enabled().is_err());
            assert!(marker.set_enabled(true).is_err());
            fs::remove_file(&path).unwrap();
            marker.set_enabled(false).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
            assert!(marker.enabled().is_err());
            let alias = root.join("alias");
            symlink(&marker.0, &alias).unwrap();
            assert!(Marker(alias).enabled().is_err());
            fs::remove_dir_all(root).unwrap();
        }
    }
}
