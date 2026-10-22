import { parseNote, readStatus, splitQuoteHead, writeStatus } from "./notes";

export interface DraftScope {
  basisPfad: string;
  semester: string;
  terminRel: string;
  uid: string;
}

export interface NoteDraft {
  version: 1;
  revision: string;
  baseRaw: string;
  body: string;
  status: { vorbereitet: boolean; nachbereitet: boolean };
}

export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function draftKey(scope: DraftScope): string {
  return `mci-note-draft-v1:${JSON.stringify([scope.basisPfad, scope.semester, scope.terminRel, scope.uid])}`;
}

export function readDraft(storage: DraftStorage, key: string): { draft: NoteDraft | null; token: string | null } {
  const token = storage.getItem(key);
  if (token === null) return { draft: null, token };
  const value = JSON.parse(token) as Partial<NoteDraft> | null;
  if (!value || value.version !== 1 || typeof value.revision !== "string" ||
      typeof value.baseRaw !== "string" || typeof value.body !== "string" ||
      typeof value.status?.vorbereitet !== "boolean" || typeof value.status?.nachbereitet !== "boolean") {
    throw new Error("Der lokale Entwurf ist beschädigt oder hat ein unbekanntes Format. Er bleibt erhalten.");
  }
  return { draft: value as NoteDraft, token };
}

export function replaceDraft(storage: DraftStorage, key: string, expected: string | null, draft: NoteDraft | null): string | null {
  if (storage.getItem(key) !== expected) {
    throw new Error("Der lokale Entwurf wurde in einer anderen Ansicht geändert. Er wird nicht überschrieben.");
  }
  const token = draft === null ? null : JSON.stringify(draft);
  if (token === null) storage.removeItem(key);
  else storage.setItem(key, token);
  return token;
}

interface EditorState {
  data: Record<string, unknown>;
  body: string;
  head: string;
  prefix: string;
  loaded: boolean;
  dirty: boolean;
  saving: boolean;
  discarding: boolean;
  pending: boolean;
  canCreate: boolean;
  conflict: { raw: string | null } | null;
  readError: string | null;
  draftError: string | null;
  message: string | null;
}

interface EditorPorts {
  storage: () => DraftStorage;
  read: () => Promise<string | null>;
  write: (data: Record<string, unknown>, body: string, expected: string) => Promise<string>;
  isConflictError: (error: unknown) => boolean;
}

export function createNoteEditor(scope: DraftScope, ports: EditorPorts) {
  const key = draftKey(scope);
  const listeners = new Set<() => void>();
  let state: EditorState = {
    data: {}, body: "", head: "", prefix: "", loaded: false, dirty: false, saving: false, discarding: false,
    pending: false, canCreate: false, conflict: null, readError: null, draftError: null, message: null,
  };
  let baseRaw: string | null = null;
  let draft: NoteDraft | null = null;
  let token: string | null = null;
  let storageKnown = false;
  let active = false;
  let epoch = 0;
  let readSequence = 0;
  let seenNote = false;

  function update(patch: Partial<EditorState>) {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  }

  function parseOwned(raw: string) {
    const note = parseNote(raw);
    if (note.data.uid !== scope.uid) {
      throw new Error("Die Notiz gehört nicht zu diesem Termin (UID). Bearbeiten und Speichern sind gesperrt.");
    }
    return note;
  }

  function persist(next: NoteDraft | null) {
    try {
      if (!storageKnown) {
        const stored = readDraft(ports.storage(), key);
        if (stored.draft !== null) throw new Error("Ein vorhandener Entwurf konnte nicht geladen werden. Er bleibt erhalten.");
        token = stored.token;
        storageKnown = true;
      }
      token = replaceDraft(ports.storage(), key, token, next);
      update({ draftError: null, pending: false });
    } catch (error) {
      update({ draftError: `Lokaler Entwurf nicht gesichert: ${String(error)}`, pending: state.dirty });
    }
  }

  function makeDraft(): NoteDraft {
    if (baseRaw === null) throw new Error("Keine geladene Basisversion.");
    return { version: 1, revision: crypto.randomUUID(), baseRaw, body: state.body, status: readStatus(state.data, state.body) };
  }

  function applyDisk(raw: string) {
    const note = parseOwned(raw);
    const { head, rest } = splitQuoteHead(note.body);
    baseRaw = raw;
    seenNote = true;
    update({ ...note, head, prefix: note.body.slice(0, note.body.length - rest.length), loaded: true, dirty: false, pending: false, readError: null, conflict: null, canCreate: false });
  }

  function acceptRead(raw: string | null) {
    if (raw === null) {
      const canCreate = storageKnown && !seenNote && !draft;
      update({
        readError: canCreate ? "Für diesen Termin wurde noch keine Notiz angelegt."
          : "notes.md fehlt. Eine bestehende Notiz wird nicht automatisch neu angelegt.",
        conflict: state.dirty || state.conflict ? { raw: null } : null,
        canCreate,
      });
      return;
    }
    parseOwned(raw);
    seenNote = true;
    if (state.dirty || state.conflict) {
      update({ loaded: true, readError: null, canCreate: false,
        conflict: raw !== baseRaw || state.conflict ? { raw } : null });
    } else {
      applyDisk(raw);
    }
  }

  async function refresh(afterConflict = false) {
    if (!active || (state.saving && !afterConflict) || state.discarding) return;
    const version = epoch;
    const sequence = ++readSequence;
    try {
      const raw = await ports.read();
      if (!active || version !== epoch || sequence !== readSequence) return;
      acceptRead(raw);
    } catch (error) {
      if (active && version === epoch && sequence === readSequence) update({ readError: `Lesen fehlgeschlagen: ${String(error)}`, canCreate: false });
    }
  }

  async function start() {
    active = true;
    epoch++;
    try {
      const stored = readDraft(ports.storage(), key);
      if (stored.draft) {
        const note = parseOwned(stored.draft.baseRaw);
        const { head, rest } = splitQuoteHead(note.body);
        const prefix = note.body.slice(0, note.body.length - rest.length);
        draft = stored.draft;
        baseRaw = draft.baseRaw;
        seenNote = true;
        note.data.vorbereitet = draft.status.vorbereitet;
        note.data.nachbereitet = draft.status.nachbereitet;
        update({ data: note.data, body: draft.body, head: draft.body.startsWith(prefix) ? head : "",
          prefix: draft.body.startsWith(prefix) ? prefix : "", dirty: true, message: "Lokaler Entwurf wiederhergestellt." });
      }
      token = stored.token;
      storageKnown = true;
    } catch (error) {
      update({ draftError: `Lokaler Entwurf konnte nicht geladen werden: ${String(error)}` });
    }
    await refresh();
  }

  function editable() {
    return active && state.loaded && !state.readError && !state.discarding;
  }

  function edit(body: string) {
    if (!editable()) return;
    update({ body, dirty: true, message: null });
    draft = makeDraft();
    persist(draft);
  }

  async function save(keepMine = false, statusKey?: "vorbereitet" | "nachbereitet") {
    if (!editable() || state.saving || baseRaw === null) return;
    if (state.conflict && !keepMine) return;
    if (keepMine && !state.conflict) return;
    const expected = keepMine ? state.conflict?.raw : baseRaw;
    if (expected == null) return;
    if (statusKey) {
      const next = writeStatus(state.data, state.body, statusKey, !readStatus(state.data, state.body)[statusKey]);
      update({ ...next, dirty: true });
      draft = makeDraft();
      persist(draft);
    }
    if (!state.dirty || !draft) return;
    const snapshot = draft;
    const savedData = state.data;
    const savedBody = state.body;
    epoch++;
    update({ saving: true, message: null });
    try {
      parseOwned(expected);
      const raw = await ports.write(savedData, savedBody, expected);
      const normalized = parseOwned(raw);
      baseRaw = raw;
      if (draft === snapshot) {
        draft = null;
        applyDisk(raw);
        persist(null);
      } else {
        update({ data: normalized.data, conflict: null, readError: null });
        draft = makeDraft();
        persist(draft);
      }
      update({ message: state.dirty ? "Stand gespeichert; neuere Eingaben bleiben als Entwurf erhalten." : "Notizen gespeichert." });
    } catch (error) {
      if (ports.isConflictError(error)) {
        update({ conflict: state.conflict ?? { raw: expected }, message: "Die Datei wurde zwischenzeitlich geändert. Bitte den Konflikt prüfen." });
        await refresh(true);
      } else {
        update({ message: `Speichern fehlgeschlagen: ${String(error)}` });
      }
    } finally {
      update({ saving: false });
    }
  }

  async function loadTheirs() {
    if (!active || state.saving || state.discarding || !state.conflict) return;
    const version = ++epoch;
    update({ discarding: true });
    try {
      const raw = await ports.read();
      if (!active || version !== epoch) return;
      if (raw === null) throw new Error("notes.md fehlt. Der Entwurf bleibt erhalten.");
      parseOwned(raw);
      // Do not discard the only in-memory copy until removing its durable copy succeeds.
      if (!storageKnown) throw new Error("Der lokale Entwurf ist nicht zugänglich. Verwerfen abgebrochen.");
      token = replaceDraft(ports.storage(), key, token, null);
      draft = null;
      applyDisk(raw);
      update({ draftError: null, message: "Stand von der Festplatte übernommen; eigener Entwurf verworfen." });
    } catch (error) {
      update({ message: `Übernehmen fehlgeschlagen: ${String(error)}` });
    } finally {
      update({ discarding: false });
    }
  }

  async function create(createNote: () => Promise<string>) {
    if (!active || !state.canCreate || state.saving || state.discarding || state.dirty) return;
    const version = ++epoch;
    update({ saving: true });
    try {
      const raw = await createNote();
      if (active && version === epoch) applyDisk(raw);
    } catch (error) {
      if (active && version === epoch) update({ readError: `Anlegen fehlgeschlagen: ${String(error)}` });
    } finally {
      update({ saving: false });
    }
  }

  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start,
    stop: () => { active = false; epoch++; },
    refresh: () => refresh(),
    edit,
    save: () => save(),
    toggle: (key: "vorbereitet" | "nachbereitet") => save(false, key),
    keepMine: () => save(true),
    loadTheirs,
    create,
    retryDraft: () => persist(draft),
  };
}
