// @vitest-environment happy-dom
import { act, createElement, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig, StudyEvent } from "../src/lib/types";

const ports = vi.hoisted(() => ({
  apiSetVaultRoot: vi.fn(), loadConfig: vi.fn(), saveConfig: vi.fn(), defaultBasis: vi.fn(), syncCalendar: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("../src/lib/storage", () => ports);
vi.mock("../src/lib/calendar", () => ({ syncCalendar: ports.syncCalendar }));
import { useStudyCalendar } from "../src/hooks/useStudyCalendar";

const cfg: AppConfig = {
  basisPfad: "/synthetic/vault", semester: "Semester-1", icalUrl: "https://example.test/calendar",
  refreshHours: 12, lastRefresh: null,
};
const event: StudyEvent = {
  uid: "synthetic", summary: "Databases", fach: "Databases", typ: "ILV", dozent: "Example", lvNummer: "DB1",
  fachKey: "databases", fachDir: "01-databases", terminRel: "01-databases/2026-10-05",
  start: "2026-10-05T07:00:00.000Z", end: "2026-10-05T08:00:00.000Z",
};
let root: Root | null;
let container: HTMLDivElement;
let latest: ReturnType<typeof useStudyCalendar>;
let allowSync: boolean;
const canSync = () => allowSync;

function Probe() {
  const api = useStudyCalendar(canSync);
  useEffect(() => { latest = api; }, [api]);
  return null;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function mount(strict = false) {
  await act(async () => {
    root!.render(strict ? createElement(StrictMode, null, createElement(Probe)) : createElement(Probe));
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  allowSync = true;
  ports.loadConfig.mockResolvedValue(cfg);
  ports.apiSetVaultRoot.mockResolvedValue(undefined);
  ports.defaultBasis.mockResolvedValue("/synthetic/default");
  ports.syncCalendar.mockImplementation(async (config: AppConfig) => ({
    events: [event], config: { ...config, lastRefresh: new Date().toISOString() }, state: "synced", warning: null,
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("calendar hook lifecycle", () => {
  it("serializes initialization and settings changes", async () => {
    const activation = deferred();
    ports.apiSetVaultRoot.mockReturnValueOnce(activation.promise);
    await mount();
    expect(latest.syncing).toBe(true);
    await expect(latest.applyConfig({ ...cfg, semester: "Semester-2" })).rejects.toThrow("laufende Synchronisation");
    expect(ports.apiSetVaultRoot).toHaveBeenCalledTimes(1);
    await act(async () => activation.resolve());
    expect(latest.ready).toBe(true);
    expect(latest.cfg?.semester).toBe("Semester-1");
    await act(async () => latest.applyConfig({ ...cfg, semester: "Semester-2" }));
    expect(latest.cfg?.semester).toBe("Semester-2");
  });

  it("does not sync after an initial activation completes following unmount", async () => {
    const activation = deferred();
    ports.apiSetVaultRoot.mockReturnValueOnce(activation.promise);
    await mount();
    await act(async () => { root!.unmount(); root = null; });
    await act(async () => activation.resolve());
    expect(ports.syncCalendar).not.toHaveBeenCalled();
    expect(ports.saveConfig).not.toHaveBeenCalled();
  });

  it("does not persist or sync a config change after unmount", async () => {
    await mount();
    ports.syncCalendar.mockClear();
    ports.saveConfig.mockClear();
    const activation = deferred();
    ports.apiSetVaultRoot.mockReturnValueOnce(activation.promise);
    let operation: Promise<void>;
    await act(async () => { operation = latest.applyConfig({ ...cfg, semester: "Semester-2" }); });
    await act(async () => { root!.unmount(); root = null; });
    await act(async () => { activation.resolve(); await operation!; });
    expect(ports.saveConfig).not.toHaveBeenCalled();
    expect(ports.syncCalendar).not.toHaveBeenCalled();
  });

  it("initializes once in StrictMode despite the replayed mount", async () => {
    await mount(true);
    expect(latest.ready).toBe(true);
    expect(ports.apiSetVaultRoot).toHaveBeenCalledTimes(1);
    expect(ports.syncCalendar).toHaveBeenCalledTimes(1);
  });

  it("shows a loaded calendar even if the sync timestamp cannot be persisted", async () => {
    ports.saveConfig.mockImplementation(() => { throw new Error("Storage full"); });
    await mount();
    expect(latest.events).toEqual([event]);
    expect(latest.error).toContain("Sync-Zeitpunkt");
    expect(latest.ready).toBe(true);
  });

  it("stops automatic initialization on damaged configuration", async () => {
    ports.loadConfig.mockRejectedValue(new Error("Invalid settings"));
    await mount();
    expect(latest.cfg?.basisPfad).toBe("/synthetic/default");
    expect(latest.ready).toBe(false);
    expect(latest.error).toContain("Invalid settings");
    expect(ports.apiSetVaultRoot).not.toHaveBeenCalled();
    expect(ports.syncCalendar).not.toHaveBeenCalled();
  });

  it("refreshes periodically and releases all intervals on unmount", async () => {
    vi.useFakeTimers();
    await mount();
    expect(ports.syncCalendar).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(12 * 3_600_000); });
    expect(ports.syncCalendar).toHaveBeenCalledTimes(2);
    await act(async () => { root!.unmount(); root = null; });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not replace events while an unsafe draft exists", async () => {
    await mount();
    allowSync = false;
    ports.syncCalendar.mockClear();
    await act(async () => latest.refreshNow());
    expect(ports.syncCalendar).not.toHaveBeenCalled();
    expect(latest.events).toEqual([event]);
    expect(latest.error).toContain("ungesicherten");
  });
});
