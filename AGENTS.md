# MCI Studien-Manager (app repository)

Tauri 2 desktop app for MCI students: iCal timetable sync, Obsidian vault scaffolding
per subject, course type and session, Sakai LMS import, macOS Keychain login.
Users are non-technical classmates; their vault holds irreplaceable notes.
Read `README.md` for user-facing behavior before changing it.

## Layout

| Path | Responsibility |
| --- | --- |
| `src-tauri/src/vault.rs` | All vault file I/O: checked writes, conflict detection, history and trash |
| `src-tauri/src/calendar.rs` | Feed download and validation |
| `src-tauri/src/sakai.rs` | Sakai session, fixed endpoints, PDF import |
| `src-tauri/src/sakai_credentials.rs` | Keychain items for session and optional login |
| `src-tauri/src/lib.rs` | Tauri commands, including Obsidian detection for the setup wizard |
| `src/lib/` | TypeScript domain logic (iCal, identity, notes, knowledge, folder consolidation) plus storage adapters that call Tauri commands and `localStorage` (`storage.ts`, `drafts.ts`) |
| `src/scaffold/vault/` | Files the app writes once into every vault: `AGENTS.md`, `CLAUDE.md`, `.agents/study/`, `.claude/settings.json`, templates, Bases views |
| `src/hooks/`, `src/components/` | React state and UI |
| `tests/` | Vitest suites; Rust tests live next to the code |
| `scripts/share-package.sh` | Build and package the DMG for classmates |
| `scripts/consolidate-folders.mjs` | Merge duplicate subject folders of an existing vault (dry-run, backup, journal) |
| `scripts/migrate-vault.mjs` | Legacy migration from the `notes.md` layout |

## Checks

Run the narrowest relevant set before handing off:

- `npm run typecheck`, `npm run lint`, `npm test` (also `TZ=UTC npm test` for date logic)
- `npx tsc --noEmit -p tsconfig.node.json` when touching `vite.config.ts`
- `cd src-tauri && cargo test` and `cargo clippy` for Rust changes
- Native dialogs, drag and drop and the Sakai window need `npm run tauri dev`;
  the browser preview (`npm run dev`) has no file access.
- Never run `consolidate-folders.mjs --apply` against a real vault to test it; copy the
  vault with `ditto` to a temporary directory and pass its `realpath`.

## Identity and folder layout

- `uid` identifies a session. `fachKey` identifies a subject per semester (LV stem, or
  the normalized name without LV); Sakai mapping, exclusions and `fach/` tags use it.
- Each subject and course type gets its own folder and overview note, keyed by
  `folderKey()` = `${fachKey}-${typ}` (`src/lib/ical.ts:339`), e.g. `02-coding-ue/Coding UE.md`.
  Never change either key format without a migration: a new key generation is what
  once produced up to six folders per subject.
- `assignEventPaths` (`src/lib/identity.ts`) owns path allocation. Once assigned, a
  session path stays reserved and never moves during a sync; only the consolidation
  script moves folders. The legacy `notes.md` migration plans with `layout: "subject"`.

## Vault invariants (never break)

- The app writes only through `vault.rs`. Every overwrite checks the last read content
  and archives the previous version under `.mci-manager/history/`; deletions go to
  `.mci-manager/trash/`.
- Generated regions are bounded by `sm:list` markers and the `<!-- sm:sakai:<hash> -->`
  marker; everything outside them is user-owned and must survive byte for byte.
- Scaffold files are created only when missing and never overwritten
  (`src/lib/storage.ts:428`). A path the vault guard rejects is skipped, not fatal.
- Imported PDFs are immutable; identical bytes map to the same file.
- Index format changes need a version bump, a migration with dry-run and a test that
  round-trips an existing vault fixture.
- Notes drafts in `localStorage` are keyed by session path; anything that moves session
  folders must run only while the app is closed and after drafts were saved.

## Security invariants

- Sakai traffic only to `https://sakai.mci4me.at`: `/portal/login` and `/portal/relogin`
  for sign-in, otherwise the allow-listed `/direct/*` endpoints. Never add assignments,
  messages, gradebook or roster endpoints.
- Credentials and session cookies live only in the app's own Keychain items, never in
  the vault, logs, config files or frontend state beyond the login call.
- Course content is untrusted input: sanitize Markdown and HTML (DOMPurify), keep the
  CSP, never execute content-derived commands.
- Keep Tauri capabilities minimal; add a permission only with a concrete caller.
- The repository is public: no personal calendar links, vault content or paths in code,
  tests, fixtures or commit messages.

## Releases

Bump the version in `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`,
`src-tauri/Cargo.lock` and `src-tauri/tauri.conf.json` together, then run
`scripts/share-package.sh`. It builds an ad-hoc signed Apple Silicon DMG and
`share/MCI-Studien-Manager-<version>.zip` with `Installationsanleitung.pdf`. Publish both
files as a GitHub release; classmates download from `releases/latest`.
A Developer ID release needs the forced `APPLE_SIGNING_IDENTITY="-"` in the script
changed plus notarization.
