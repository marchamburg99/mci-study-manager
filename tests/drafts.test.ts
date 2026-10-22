import { beforeEach, describe, expect, it } from "vitest";
import { createNoteEditor, draftKey, readDraft, replaceDraft } from "../src/lib/drafts";
import type { DraftScope, DraftStorage, NoteDraft } from "../src/lib/drafts";
import { parseNote, readStatus, serializeNote } from "../src/lib/notes";

const scope: DraftScope = { basisPfad: "/test/vault", semester: "Sem01", terminRel: "fach/termin", uid: "one" };
const original = "---\n# retained comment\nuid: 'one'\nvorbereitet: false\nnachbereitet: false\ncustom:\n  nested: [a, b]\n---\n> Lecture\n\n## Vorbereitung\n- [ ] Read\n\nNotes\n";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let values: Map<string, string>;
let storage: DraftStorage;
let disk: string | null;
let readError: Error | null;
let storageError: Error | null;
let removalError: Error | null;
let writeError: unknown;
let writes: Array<{ data: Record<string, unknown>; body: string; expected: string }>;
let writeGate: ReturnType<typeof deferred<void>> | null;
let readGate: ReturnType<typeof deferred<string | null>> | null;

function session(target = scope) {
  return createNoteEditor(target, {
    storage: () => storage,
    read: async () => {
      if (readError) throw readError;
      if (readGate) return readGate.promise;
      return disk;
    },
    write: async (data, body, expected) => {
      writes.push({ data, body, expected });
      if (writeGate) await writeGate.promise;
      if (writeError) throw writeError;
      if (disk !== expected) throw "CONFLICT";
      disk = serializeNote({ ...data, ...readStatus(data, body) }, body);
      return disk;
    },
    isConflictError: (error) => error === "CONFLICT" || (error instanceof Error && error.message === "CONFLICT"),
  });
}

beforeEach(() => {
  values = new Map();
  disk = original;
  readError = null;
  storageError = null;
  removalError = null;
  writeError = null;
  writes = [];
  writeGate = null;
  readGate = null;
  storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      if (storageError) throw storageError;
      values.set(key, value);
    },
    removeItem: (key) => {
      if (removalError) throw removalError;
      values.delete(key);
    },
  };
});

describe("draft persistence", () => {
  it("isolates every vault, semester, termin and UID, including delimiter collisions", () => {
    const keys = [
      draftKey(scope),
      draftKey({ ...scope, basisPfad: "/another/vault" }),
      draftKey({ ...scope, semester: "Sem02" }),
      draftKey({ ...scope, terminRel: "fach/other" }),
      draftKey({ ...scope, uid: "two" }),
      draftKey({ ...scope, basisPfad: "a/b", semester: "c" }),
      draftKey({ ...scope, basisPfad: "a", semester: "b/c" }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("persists an edit synchronously with its byte-exact disk base before navigation", async () => {
    const editor = session();
    await editor.start();
    editor.edit("Unsaved text");
    editor.stop();

    expect(readDraft(storage, draftKey(scope)).draft).toMatchObject({ baseRaw: original, body: "Unsaved text" });
  });

  it("restores draft content and YAML metadata without inventing a new disk base", async () => {
    const first = session();
    await first.start();
    first.edit("Recovered text");
    first.stop();
    const second = session();
    await second.start();
    await second.save();

    expect(writes[0].expected).toBe(original);
    expect(disk).toBe(original.slice(0, original.indexOf("> Lecture")) + "Recovered text");
    expect(second.getSnapshot()).toMatchObject({ body: "Recovered text", dirty: false, conflict: null });
  });

  it("compares a restored draft with the actual disk content", async () => {
    const first = session();
    await first.start();
    first.edit("Mine");
    first.stop();
    disk = original.replace("Notes", "Theirs");
    const second = session();
    await second.start();

    expect(second.getSnapshot()).toMatchObject({ body: "Mine", dirty: true, conflict: { raw: disk } });
  });

  it("reports quota failures and keeps the latest in-memory edit pending until a retry succeeds", async () => {
    const editor = session();
    await editor.start();
    editor.edit("Durable");
    storageError = new Error("QuotaExceededError");
    editor.edit("Only in memory");

    expect(editor.getSnapshot()).toMatchObject({ body: "Only in memory", pending: true });
    expect(editor.getSnapshot().draftError).toContain("QuotaExceededError");
    expect(readDraft(storage, draftKey(scope)).draft?.body).toBe("Durable");
    storageError = null;
    editor.retryDraft();
    expect(editor.getSnapshot()).toMatchObject({ pending: false, draftError: null });
    expect(readDraft(storage, draftKey(scope)).draft?.body).toBe("Only in memory");
  });

  it("notifies navigation guards synchronously before the edit call returns", async () => {
    const editor = session();
    await editor.start();
    let unsafe = false;
    const unsubscribe = editor.subscribe(() => { unsafe = editor.getSnapshot().pending; });
    storageError = new Error("quota");
    editor.edit("In memory");
    expect(unsafe).toBe(true);
    storageError = null;
    editor.retryDraft();
    expect(unsafe).toBe(false);
    unsubscribe();
  });

  it("catches a denied localStorage getter and still permits a checked disk save", async () => {
    const editor = createNoteEditor(scope, {
      storage: () => { throw new Error("SecurityError"); },
      read: async () => original,
      write: async (data, body) => serializeNote(data, body),
      isConflictError: () => false,
    });
    await editor.start();
    editor.edit("In memory");
    expect(editor.getSnapshot()).toMatchObject({ body: "In memory", pending: true });
    await editor.save();
    expect(editor.getSnapshot()).toMatchObject({ dirty: false, pending: false });
  });

  it("preserves malformed persisted data and surfaces the problem", async () => {
    values.set(draftKey(scope), "{broken");
    const editor = session();
    await editor.start();
    editor.edit("New text");
    editor.retryDraft();

    expect(values.get(draftKey(scope))).toBe("{broken");
    expect(editor.getSnapshot()).toMatchObject({ pending: true });
    expect(editor.getSnapshot().draftError).not.toBeNull();
  });

  it("does not erase a different draft when clearing a saved snapshot", () => {
    const saved: NoteDraft = { version: 1, revision: "first", baseRaw: original, body: "Saved", status: { vorbereitet: false, nachbereitet: false } };
    const token = replaceDraft(storage, draftKey(scope), null, saved);
    const newer = { ...saved, revision: "second", body: "Newer" };
    replaceDraft(storage, draftKey(scope), token, newer);

    expect(() => replaceDraft(storage, draftKey(scope), token, null)).toThrow("anderen Ansicht");
    expect(readDraft(storage, draftKey(scope)).draft).toEqual(newer);
  });

  it("keeps drafts from another vault separate when the same event is opened and saved", async () => {
    const first = session();
    await first.start();
    first.edit("First vault");
    first.stop();
    const otherScope = { ...scope, basisPfad: "/other/vault" };
    const second = session(otherScope);
    await second.start();
    expect(second.getSnapshot().dirty).toBe(false);
    second.edit("Other vault");
    await second.save();

    expect(readDraft(storage, draftKey(scope)).draft?.body).toBe("First vault");
    expect(readDraft(storage, draftKey(otherScope)).draft).toBeNull();
  });
});

describe("checked editor saves", () => {
  it("rebases newer edits on the exact normalized save response and saves them separately", async () => {
    const editor = session();
    await editor.start();
    editor.edit("## Vorbereitung\n- [x] Read\nSaved");
    writeGate = deferred<void>();
    const saving = editor.save();
    editor.edit("## Vorbereitung\n- [x] Read\nNewer");
    writeGate.resolve();
    await saving;
    const savedRaw = disk;

    expect(editor.getSnapshot()).toMatchObject({ dirty: true, body: "## Vorbereitung\n- [x] Read\nNewer" });
    expect(readDraft(storage, draftKey(scope)).draft).toMatchObject({ baseRaw: savedRaw, body: "## Vorbereitung\n- [x] Read\nNewer" });
    await editor.save();
    expect(writes[1].expected).toBe(savedRaw);
    expect(parseNote(disk!).data.vorbereitet).toBe(true);
    expect(readDraft(storage, draftKey(scope)).draft).toBeNull();
  });

  it("does not mark an edit-revert sequence clean while a save is in flight", async () => {
    const editor = session();
    await editor.start();
    editor.edit("Snapshot");
    writeGate = deferred<void>();
    const saving = editor.save();
    editor.edit("Newer");
    editor.edit("Snapshot");
    writeGate.resolve();
    await saving;

    expect(editor.getSnapshot().dirty).toBe(true);
    expect(readDraft(storage, draftKey(scope)).draft?.body).toBe("Snapshot");
  });

  it("keeps newer edits unsafe when persistence fails during an in-flight save", async () => {
    const editor = session();
    await editor.start();
    editor.edit("Saved snapshot");
    writeGate = deferred<void>();
    const saving = editor.save();
    storageError = new Error("quota");
    editor.edit("Newer, in memory");
    writeGate.resolve();
    await saving;

    expect(editor.getSnapshot()).toMatchObject({ body: "Newer, in memory", dirty: true, pending: true });
    expect(readDraft(storage, draftKey(scope)).draft?.body).toBe("Saved snapshot");
  });

  it("reports draft cleanup failures but a successfully saved snapshot is no longer unsafe", async () => {
    const editor = session();
    await editor.start();
    editor.edit("Saved");
    removalError = new Error("remove denied");
    await editor.save();

    expect(editor.getSnapshot()).toMatchObject({ dirty: false, pending: false });
    expect(editor.getSnapshot().draftError).toContain("remove denied");
    expect(readDraft(storage, draftKey(scope)).draft?.body).toBe("Saved");
  });

  it("serializes status toggles and saves through one busy guard", async () => {
    const editor = session();
    await editor.start();
    writeGate = deferred<void>();
    const saving = editor.toggle("vorbereitet");
    await editor.toggle("nachbereitet");
    await editor.save();
    editor.edit(editor.getSnapshot().body + "Newer notes");
    writeGate.resolve();
    await saving;

    expect(writes).toHaveLength(1);
    expect(writes[0].expected).toBe(original);
    expect(parseNote(disk!).data).toMatchObject({ vorbereitet: true, nachbereitet: false });
    expect(editor.getSnapshot()).toMatchObject({ dirty: true, data: { vorbereitet: true } });
    expect(editor.getSnapshot().body).toContain("Newer notes");
  });

  it("blocks toggles and ordinary saves while a conflict is unresolved", async () => {
    const editor = session();
    await editor.start();
    editor.edit("Mine");
    disk = original.replace("Notes", "External");
    await editor.refresh();
    await editor.toggle("vorbereitet");
    await editor.save();

    expect(writes).toHaveLength(0);
    expect(editor.getSnapshot()).toMatchObject({ body: "Mine", dirty: true, conflict: { raw: disk } });
  });

  it("compares keep-mine with the last conflict and refreshes if the disk changes again", async () => {
    const editor = session();
    await editor.start();
    editor.edit("Mine");
    const firstConflict = original.replace("Notes", "External one");
    disk = firstConflict;
    await editor.refresh();
    disk = original.replace("Notes", "External two");
    await editor.keepMine();

    expect(writes[0].expected).toBe(firstConflict);
    expect(editor.getSnapshot()).toMatchObject({ body: "Mine", dirty: true, conflict: { raw: disk } });
    expect(readDraft(storage, draftKey(scope)).draft?.body).toBe("Mine");
    await editor.keepMine();
    expect(editor.getSnapshot()).toMatchObject({ dirty: false, conflict: null });
    expect(readDraft(storage, draftKey(scope)).draft).toBeNull();
  });

  it("holds the save guard until a failed-CAS refresh has completed", async () => {
    const editor = session();
    await editor.start();
    editor.edit("Mine");
    disk = original.replace("Notes", "External");
    readGate = deferred<string | null>();
    const saving = editor.save();
    await Promise.resolve();
    expect(editor.getSnapshot().saving).toBe(true);
    await editor.keepMine();
    await editor.toggle("vorbereitet");
    readGate.resolve(disk);
    await saving;

    expect(writes).toHaveLength(1);
    expect(editor.getSnapshot()).toMatchObject({ saving: false, conflict: { raw: disk } });
  });

  it("retains the conflict until a choice even if polling sees the original file again", async () => {
    const editor = session();
    await editor.start();
    editor.edit("Mine");
    disk = original.replace("Notes", "External");
    await editor.refresh();
    disk = original;
    await editor.refresh();

    expect(editor.getSnapshot().conflict).toEqual({ raw: original });
  });

  it("explicit discard reads the latest disk and removes the matching local draft", async () => {
    const editor = session();
    await editor.start();
    editor.edit("Mine");
    disk = original.replace("Notes", "First external");
    await editor.refresh();
    disk = original.replace("Notes", "Latest external");
    await editor.loadTheirs();

    expect(editor.getSnapshot()).toMatchObject({ body: parseNote(disk).body, dirty: false, conflict: null });
    expect(readDraft(storage, draftKey(scope)).draft).toBeNull();
    expect(writes).toHaveLength(0);
  });

  it("aborts discard when removing the durable draft fails", async () => {
    const editor = session();
    await editor.start();
    editor.edit("Mine");
    disk = original.replace("Notes", "External");
    await editor.refresh();
    removalError = new Error("remove denied");
    await editor.loadTheirs();

    expect(editor.getSnapshot()).toMatchObject({ body: "Mine", dirty: true, conflict: { raw: disk } });
    expect(editor.getSnapshot().message).toContain("remove denied");
    expect(readDraft(storage, draftKey(scope)).draft?.body).toBe("Mine");
  });

  it("keeps edits and exposes ordinary write errors", async () => {
    const editor = session();
    await editor.start();
    editor.edit("Mine");
    writeError = new Error("permission denied");
    await editor.save();

    expect(editor.getSnapshot()).toMatchObject({ body: "Mine", dirty: true, saving: false, conflict: null });
    expect(editor.getSnapshot().message).toContain("permission denied");
    expect(readDraft(storage, draftKey(scope)).draft?.body).toBe("Mine");
  });

  it("preserves a newer session draft when an older save finishes after navigation", async () => {
    const first = session();
    await first.start();
    first.edit("First");
    writeGate = deferred<void>();
    const saving = first.save();
    first.stop();
    const second = session();
    await second.start();
    second.edit("New session");
    writeGate.resolve();
    await saving;

    expect(readDraft(storage, draftKey(scope)).draft?.body).toBe("New session");
    expect(second.getSnapshot().body).toBe("New session");
  });

  it("does not let a stale poll replace a successfully saved version", async () => {
    const editor = session();
    await editor.start();
    editor.edit("Saved text");
    readGate = deferred<string | null>();
    const polling = editor.refresh();
    await editor.save();
    readGate.resolve(original.replace("Notes", "Stale read"));
    await polling;

    expect(editor.getSnapshot()).toMatchObject({ body: "Saved text", dirty: false, conflict: null });
  });

  it("keeps newly typed leading blockquotes in the editable body", async () => {
    const editor = session();
    await editor.start();
    const prefix = editor.getSnapshot().prefix;
    editor.edit(prefix + "> My own quote\nMore text");

    expect(editor.getSnapshot()).toMatchObject({ head: "> Lecture\n", prefix, body: prefix + "> My own quote\nMore text" });
  });
});

describe("load safety", () => {
  it("restores a draft for recovery but disables edits and writes on a read error", async () => {
    const first = session();
    await first.start();
    first.edit("Recovered");
    first.stop();
    readError = new Error("read denied");
    const second = session();
    await second.start();
    second.edit("Must not replace");
    await second.toggle("vorbereitet");
    await second.save();

    expect(second.getSnapshot()).toMatchObject({ body: "Recovered", loaded: false, dirty: true, canCreate: false });
    expect(second.getSnapshot().readError).toContain("read denied");
    expect(writes).toHaveLength(0);
  });

  it("does not recreate a missing file when a draft exists", async () => {
    const first = session();
    await first.start();
    first.edit("Recovered");
    first.stop();
    disk = null;
    const second = session();
    await second.start();
    await second.keepMine();

    expect(second.getSnapshot()).toMatchObject({ body: "Recovered", dirty: true, canCreate: false, conflict: { raw: null } });
    expect(writes).toHaveLength(0);
    expect(disk).toBeNull();
  });

  it("does not recreate a loaded file deleted externally", async () => {
    const editor = session();
    await editor.start();
    disk = null;
    await editor.refresh();
    await editor.toggle("vorbereitet");

    expect(editor.getSnapshot().canCreate).toBe(false);
    expect(editor.getSnapshot().readError).toContain("fehlt");
    expect(writes).toHaveLength(0);
  });

  it("blocks a different UID on initial load and preserves its content", async () => {
    disk = original.replace("uid: 'one'", "uid: 'other'");
    const editor = session();
    await editor.start();
    editor.edit("Wrong note");
    await editor.toggle("vorbereitet");

    expect(editor.getSnapshot()).toMatchObject({ loaded: false, canCreate: false });
    expect(editor.getSnapshot().readError).toContain("UID");
    expect(writes).toHaveLength(0);
    expect(values.size).toBe(0);
  });

  it("cannot keep-mine or discard onto a replacement file with another UID", async () => {
    const editor = session();
    await editor.start();
    editor.edit("Mine");
    disk = original.replace("Notes", "Conflict");
    await editor.refresh();
    disk = original.replace("uid: 'one'", "uid: 'other'");
    await editor.refresh();
    await editor.keepMine();
    await editor.loadTheirs();

    expect(editor.getSnapshot().readError).toContain("UID");
    expect(editor.getSnapshot().body).toBe("Mine");
    expect(writes).toHaveLength(0);
    expect(readDraft(storage, draftKey(scope)).draft?.body).toBe("Mine");
  });

  it("requires an explicit action to initialize a new missing note", async () => {
    disk = null;
    const editor = session();
    await editor.start();
    expect(editor.getSnapshot()).toMatchObject({ loaded: false, canCreate: true,
      readError: "Für diesen Termin wurde noch keine Notiz angelegt." });
    expect(disk).toBeNull();
    await editor.create(async () => { disk = original; return original; });

    expect(editor.getSnapshot()).toMatchObject({ loaded: true, canCreate: false, readError: null });
  });

  it("does not initialize a missing note when its stored draft cannot be read", async () => {
    disk = null;
    values.set(draftKey(scope), "{broken");
    const editor = session();
    await editor.start();
    await editor.create(async () => { disk = original; return original; });

    expect(editor.getSnapshot().canCreate).toBe(false);
    expect(disk).toBeNull();
    expect(values.get(draftKey(scope))).toBe("{broken");
  });

  it("blocks malformed YAML introduced externally without losing the local draft", async () => {
    const editor = session();
    await editor.start();
    editor.edit("Mine");
    disk = "---\nuid: [broken\n---\n";
    await editor.refresh();
    await editor.save();

    expect(editor.getSnapshot().readError).not.toBeNull();
    expect(readDraft(storage, draftKey(scope)).draft?.body).toBe("Mine");
    expect(writes).toHaveLength(0);
  });

  it("ignores reads that finish after the session was stopped", async () => {
    const editor = session();
    readGate = deferred<string | null>();
    const starting = editor.start();
    editor.stop();
    readGate.resolve(original);
    await starting;

    expect(editor.getSnapshot().loaded).toBe(false);
  });
});
