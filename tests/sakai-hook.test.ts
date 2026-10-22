// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { AppConfig, StudyEvent } from "../src/lib/types";
import { sakaiConfigKey } from "../src/lib/sakaiConfig";

const ports = vi.hoisted(() => ({ syncSakai: vi.fn(), updated: vi.fn() }));
vi.mock("../src/lib/sakaiStorage", () => ({ syncSakai: ports.syncSakai }));
import { useSakai } from "../src/hooks/useSakai";

const cfg: AppConfig = { basisPfad: "/test/vault", semester: "Sem01", icalUrl: "https://example.test/calendar", refreshHours: 12, lastRefresh: null };
let events: StudyEvent[];
const event: StudyEvent = {
  uid: "coding", summary: "Coding", fach: "Coding", typ: "ILV", dozent: "Teacher", lvNummer: "COD1",
  fachKey: "coding", fachDir: "01-coding", terminRel: "01-coding/one",
  start: "2026-09-22T11:00:00.000Z", end: "2026-09-22T12:00:00.000Z",
};
const notes: [] = [];
const preferences = { autoSync: true, selections: [{ siteId: "study", subjectKey: null }], lastSync: null };
const report = { updated: 1, unchanged: 0, downloaded: 0, warnings: [], completedAt: "2026-09-22T10:00:00Z" };
let root: Root;
let container: HTMLDivElement;
let latest: ReturnType<typeof useSakai>;
let calls: string[];
let connected: boolean;
let loginOpen: boolean;
let rememberSession: boolean;
let persistenceError: boolean;
let autoLogin: boolean;
let failure: string | null;

function Probe({ config, enabled, catalogReady = true }: { config: AppConfig | null; enabled: boolean; catalogReady?: boolean }) {
  const value = useSakai(config, events, notes, enabled, ports.updated, catalogReady);
  useEffect(() => { latest = value; }, [value]);
  return null;
}
async function render(config: AppConfig | null = cfg, enabled = true) {
  await act(async () => { root.render(createElement(Probe, { config, enabled })); });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-22T10:00:00Z"));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  localStorage.setItem(sakaiConfigKey(cfg.basisPfad, cfg.semester), JSON.stringify(preferences));
  events = [];
  connected = true;
  loginOpen = false;
  rememberSession = false;
  persistenceError = false;
  autoLogin = false;
  failure = null;
  calls = [];
  ports.syncSakai.mockResolvedValue(report);
  mockIPC((command, payload) => {
    calls.push(command);
    if (failure === command) throw new Error("private internal response");
    if (command === "sakai_set_remember_session") rememberSession = (payload as { remember: boolean }).remember;
    if (command === "sakai_connect" || command === "sakai_poll_login") loginOpen = !connected && loginOpen;
    if (["sakai_status", "sakai_connect", "sakai_poll_login", "sakai_set_remember_session"].includes(command)) return { connected, loginOpen, rememberSession, persistenceError, autoLogin, autoLoginRejected: false };
    if (command === "sakai_sites") return [{ id: "study", title: "Study", description: "" }];
    if (command === "sakai_begin_login") { loginOpen = true; return null; }
    if (command === "sakai_disconnect") { connected = false; loginOpen = false; rememberSession = false; persistenceError = false; return null; }
    throw new Error("Unexpected command");
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  clearMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

describe("useSakai", () => {
  it("silently reconnects with stored credentials after the session expired", async () => {
    connected = false;
    autoLogin = true;
    await render();
    expect(latest).toMatchObject({ connected: false, autoLogin: true });

    connected = true;
    await act(async () => vi.advanceTimersByTimeAsync(60_000));

    expect(latest).toMatchObject({ connected: true, autoLogin: true, error: null });
    expect(ports.syncSakai).toHaveBeenCalledTimes(1);
  });
  it("does not poll for silent sign-in without stored credentials", async () => {
    connected = false;
    await render();
    calls = [];
    await act(async () => vi.advanceTimersByTimeAsync(5 * 60_000));
    expect(calls).toEqual([]);
  });
  it("makes no native calls or network jobs while disabled", async () => {
    await render(cfg, false);
    await act(async () => { await latest.beginLogin(); await latest.connect(); await latest.run(); latest.refreshSubject("coding"); await latest.disconnect(); await latest.setRememberSession(true); await vi.advanceTimersByTimeAsync(120_000); });
    expect(calls).toEqual([]);
    expect(ports.syncSakai).not.toHaveBeenCalled();
  });
  it("refreshes immediately once after restoring a session even when the saved import is recent", async () => {
    localStorage.setItem(sakaiConfigKey(cfg.basisPfad, cfg.semester), JSON.stringify({ ...preferences, lastSync: report.completedAt }));
    await render();
    await render();
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(latest).toMatchObject({ connected: true, busy: false, preferences: { ...preferences, lastSync: report.completedAt } });
    expect(ports.syncSakai).toHaveBeenCalledTimes(1);
  });
  it("waits for delayed course discovery before starting the initial import", async () => {
    const pending = deferred<{ id: string; title: string; description: string }[]>();
    mockIPC((command) => {
      if (command === "sakai_status") return { connected: true, loginOpen: false, rememberSession: true, persistenceError: false, autoLogin: false, autoLoginRejected: false };
      if (command === "sakai_sites") return pending.promise;
      throw new Error("Unexpected command");
    });
    await render();
    await act(async () => vi.advanceTimersByTimeAsync(5 * 60_000));
    expect(ports.syncSakai).not.toHaveBeenCalled();

    await act(async () => pending.resolve([{ id: "study", title: "Study", description: "" }]));

    expect(ports.syncSakai).toHaveBeenCalledTimes(1);
  });
  it("waits for mapped subjects' calendar before importing any general or course sites", async () => {
    const selections = [...preferences.selections, { siteId: "course", subjectKey: "coding" }];
    localStorage.setItem(sakaiConfigKey(cfg.basisPfad, cfg.semester), JSON.stringify({ ...preferences, selections }));
    await render();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
      latest.refreshSubject("coding");
    });
    expect(ports.syncSakai).not.toHaveBeenCalled();

    events = [event];
    await render();
    await render();

    expect(ports.syncSakai).toHaveBeenCalledTimes(1);
    expect(ports.syncSakai.mock.calls[0].slice(0, 3)).toEqual([cfg, [event], selections]);
  });
  it("waits for the knowledge catalog even when mapped subjects' calendar is already available", async () => {
    events = [event];
    localStorage.setItem(sakaiConfigKey(cfg.basisPfad, cfg.semester), JSON.stringify({
      ...preferences, selections: [{ siteId: "study", subjectKey: "coding" }],
    }));
    await act(async () => root.render(createElement(Probe, { config: cfg, enabled: true, catalogReady: false })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
      latest.refreshSubject("coding");
    });
    expect(ports.syncSakai).not.toHaveBeenCalled();

    await render();

    expect(ports.syncSakai).toHaveBeenCalledTimes(1);
  });
  it("starts general-only selections without a calendar after removing the course mapping", async () => {
    localStorage.setItem(sakaiConfigKey(cfg.basisPfad, cfg.semester), JSON.stringify({
      ...preferences, selections: [{ siteId: "study", subjectKey: "coding" }],
    }));
    await render();
    expect(ports.syncSakai).not.toHaveBeenCalled();

    await act(async () => latest.setSelections(preferences.selections));

    expect(ports.syncSakai).toHaveBeenCalledTimes(1);
  });
  it("keeps an explicit manual import available while the catalog and calendar are loading", async () => {
    localStorage.setItem(sakaiConfigKey(cfg.basisPfad, cfg.semester), JSON.stringify({
      ...preferences, selections: [{ siteId: "study", subjectKey: "coding" }],
    }));
    await act(async () => root.render(createElement(Probe, { config: cfg, enabled: true, catalogReady: false })));

    await act(async () => latest.run());

    expect(ports.syncSakai).toHaveBeenCalledTimes(1);
  });
  it("keeps manual imports available when startup, focus and subject refresh are opted out", async () => {
    localStorage.setItem(sakaiConfigKey(cfg.basisPfad, cfg.semester), JSON.stringify({ ...preferences, autoSync: false }));
    await render();
    await act(async () => {
      latest.refreshSubject("coding");
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(ports.syncSakai).not.toHaveBeenCalled();

    await act(async () => latest.run());

    expect(ports.syncSakai).toHaveBeenCalledTimes(1);
  });
  it("does not persist an empty initial selection before knowledge has loaded", async () => {
    const key = sakaiConfigKey(cfg.basisPfad, cfg.semester);
    localStorage.removeItem(key);
    await act(async () => root.render(createElement(Probe, { config: cfg, enabled: true, catalogReady: false })));
    expect(latest.connected).toBe(true);
    await act(async () => latest.connect());
    expect(localStorage.getItem(key)).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(ports.syncSakai).not.toHaveBeenCalled();
    await render();
    expect(latest.hasPreferences).toBe(true);
    expect(localStorage.getItem(key)).not.toBeNull();
    await act(async () => latest.setSelections(preferences.selections));
    expect(ports.syncSakai).toHaveBeenCalledTimes(1);
  });
  it("requires login after app restart when no remembered session is restored", async () => {
    connected = false;
    await render();
    await act(async () => { await latest.run(); await vi.advanceTimersByTimeAsync(120_000); });
    expect(latest.connected).toBe(false);
    expect(calls).toEqual(["sakai_status"]);
    expect(ports.syncSakai).not.toHaveBeenCalled();
  });
  it("keeps successful authentication recoverable when course discovery fails", async () => {
    connected = false;
    await render();
    await act(async () => latest.beginLogin());
    connected = true;
    failure = "sakai_sites";
    await act(async () => latest.connect());
    expect(latest).toMatchObject({ connected: true, loginOpen: false, sites: [], busy: false });
    expect(latest.error).not.toContain("private internal");
    await act(async () => latest.run());
    expect(ports.syncSakai).not.toHaveBeenCalled();
    failure = null;
    await act(async () => latest.connect());
    expect(latest.sites).toHaveLength(1);
    expect(latest.error).toBeNull();
  });
  it("updates local knowledge and persists the completed attempt", async () => {
    await render();
    expect(latest).toMatchObject({ busy: false, report, preferences: { lastSync: report.completedAt } });
    expect(ports.updated).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(sakaiConfigKey(cfg.basisPfad, cfg.semester))!)).toEqual({ ...preferences, lastSync: report.completedAt });
  });
  it("serializes overlapping manual and automatic attempts", async () => {
    const pending = deferred<typeof report>();
    ports.syncSakai.mockReturnValue(pending.promise);
    await render();
    await act(async () => { void latest.run(); void latest.run(); window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(120_000); });
    expect(ports.syncSakai).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(report));
    expect(latest.busy).toBe(false);
  });
  it("refreshes every five minutes and respects disabled automatic refresh", async () => {
    await render();
    await act(async () => vi.advanceTimersByTimeAsync(5 * 60_000 - 1));
    expect(ports.syncSakai).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(ports.syncSakai).toHaveBeenCalledTimes(2);
    await act(async () => latest.setAutoSync(false));
    await act(async () => vi.advanceTimersByTimeAsync(2 * 60 * 60_000));
    expect(ports.syncSakai).toHaveBeenCalledTimes(2);
  });
  it.each(["focus", "online"])("refreshes on %s after one minute and recovers after sleep", async (event) => {
    await render();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_999);
      window.dispatchEvent(new Event(event));
    });
    expect(ports.syncSakai).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      window.dispatchEvent(new Event(event));
    });
    await act(async () => window.dispatchEvent(new Event(event)));
    expect(ports.syncSakai).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date("2026-09-22T11:00:00Z"));
    await act(async () => window.dispatchEvent(new Event(event)));

    expect(ports.syncSakai).toHaveBeenCalledTimes(3);
  });
  it("waits five minutes after a slow failed import finishes before retrying", async () => {
    const pending = deferred<void>();
    ports.syncSakai.mockImplementationOnce(async () => { await pending.promise; throw new Error("SYNTHETIC_FAILURE"); });
    await render();
    await act(async () => vi.advanceTimersByTimeAsync(10 * 60_000));
    expect(ports.syncSakai).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(5 * 60_000 - 1));
    expect(ports.syncSakai).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(1));

    expect(ports.syncSakai).toHaveBeenCalledTimes(2);
  });
  it("prioritizes an opened subject in the full sync after one minute without changing its callback", async () => {
    await render();
    const refreshSubject = latest.refreshSubject;
    await act(async () => latest.refreshSubject("coding"));
    expect(ports.syncSakai).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));

    await act(async () => { latest.refreshSubject("coding"); latest.refreshSubject("networks"); });

    expect(ports.syncSakai).toHaveBeenCalledTimes(2);
    expect(ports.syncSakai.mock.calls[1]).toEqual([cfg, events, preferences.selections, {
      isCurrent: expect.any(Function), onProgress: expect.any(Function), prioritySubjectKey: "coding",
    }]);
    expect(latest.refreshSubject).toBe(refreshSubject);
  });
  it("lets the first subject refresh satisfy startup even with a recent persisted import", async () => {
    localStorage.setItem(sakaiConfigKey(cfg.basisPfad, cfg.semester), JSON.stringify({ ...preferences, autoSync: false, lastSync: report.completedAt }));
    await render();

    await act(async () => { latest.setAutoSync(true); latest.refreshSubject("coding"); });

    expect(ports.syncSakai).toHaveBeenCalledTimes(1);
    expect(ports.syncSakai.mock.calls[0][3].prioritySubjectKey).toBe("coding");
  });
  it("stops automatic retries after session expiry and retains local knowledge", async () => {
    ports.syncSakai.mockRejectedValue(new Error("SAKAI_AUTH_REQUIRED"));
    await render();
    await act(async () => latest.run());
    expect(latest).toMatchObject({ connected: false, busy: false });
    expect(latest.error).toContain("abgelaufen");
    await act(async () => vi.advanceTimersByTimeAsync(2 * 60 * 60_000));
    expect(ports.syncSakai).toHaveBeenCalledTimes(1);
    expect(ports.updated).toHaveBeenCalledTimes(1);
  });
  it("invalidates in-flight work when disconnecting and ignores its later result", async () => {
    const pending = deferred<typeof report>();
    ports.syncSakai.mockReturnValue(pending.promise);
    await render();
    await act(async () => { void latest.run(); });
    const guard = ports.syncSakai.mock.calls[0][3].isCurrent as () => boolean;
    expect(guard()).toBe(true);
    await act(async () => latest.disconnect());
    expect(guard()).toBe(false);
    await act(async () => pending.resolve(report));
    expect(latest).toMatchObject({ connected: false, report: null, busy: false });
    expect(calls).toContain("sakai_disconnect");
  });
  it("does not expose old-vault results or continue its automatic settings", async () => {
    const pending = deferred<typeof report>();
    ports.syncSakai.mockReturnValue(pending.promise);
    await render();
    await act(async () => { void latest.run(); });
    const guard = ports.syncSakai.mock.calls[0][3].isCurrent as () => boolean;
    await render({ ...cfg, basisPfad: "/test/other" });
    expect(guard()).toBe(false);
    await act(async () => pending.resolve(report));
    expect(latest).toMatchObject({ report: null, preferences: { autoSync: false, selections: [], lastSync: null } });
    expect(ports.updated).not.toHaveBeenCalled();
  });
  it("fails closed for corrupt preferences and displays a recovery hint", async () => {
    localStorage.setItem(sakaiConfigKey(cfg.basisPfad, cfg.semester), "{");
    await render();
    await act(async () => { latest.refreshSubject("coding"); window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(10 * 60_000); });
    expect(latest.preferences.autoSync).toBe(false);
    expect(latest.error).toContain("neu auswählen");
    expect(ports.syncSakai).not.toHaveBeenCalled();
  });
  it("opens the isolated login flow without sending credentials", async () => {
    connected = false;
    await render();
    await act(async () => latest.beginLogin());
    expect(latest).toMatchObject({ loginOpen: true, connected: false, busy: false });
    connected = true;
    await act(async () => latest.connect());
    expect(latest).toMatchObject({ loginOpen: false, connected: true, busy: false });
    expect(calls).toEqual(["sakai_status", "sakai_begin_login", "sakai_connect", "sakai_sites", "sakai_status"]);
    expect(ports.syncSakai).toHaveBeenCalledTimes(1);
  });

  it("uses a natively restored session without opening a login window", async () => {
    rememberSession = true;
    await render();

    expect(latest).toMatchObject({ connected: true, rememberSession: true, loginOpen: false });
    expect(calls).toEqual(["sakai_status", "sakai_sites", "sakai_status"]);
    expect(ports.syncSakai).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(Object.values(localStorage))).not.toContain("rememberSession");
  });

  it("keeps remember-session opt-in separate from vault preferences", async () => {
    connected = false;
    await render();
    expect(latest.rememberSession).toBe(false);
    const before = localStorage.getItem(sakaiConfigKey(cfg.basisPfad, cfg.semester));
    await act(async () => latest.setRememberSession(true));

    expect(latest).toMatchObject({ rememberSession: true, connected: false, busy: false });
    expect(calls).toEqual(["sakai_status", "sakai_set_remember_session"]);
    expect(localStorage.getItem(sakaiConfigKey(cfg.basisPfad, cfg.semester))).toBe(before);
  });

  it("disables persistence without disconnecting a valid in-memory session", async () => {
    rememberSession = true;
    await render();
    await act(async () => latest.setRememberSession(false));

    expect(latest).toMatchObject({ connected: true, rememberSession: false, busy: false });
    expect(calls).not.toContain("sakai_disconnect");
    expect(ports.syncSakai).toHaveBeenCalledTimes(1);
  });

  it("imports immediately after signing in again despite a recent completed import", async () => {
    await render();
    await act(async () => latest.disconnect());
    await act(async () => latest.beginLogin());
    connected = true;

    await act(async () => vi.advanceTimersByTimeAsync(2_000));

    expect(ports.syncSakai).toHaveBeenCalledTimes(2);
    expect(latest).toMatchObject({ connected: true, busy: false, report });
  });

  it("does not claim persistence succeeded when Keychain access fails", async () => {
    await render();
    failure = "sakai_set_remember_session";
    await act(async () => latest.setRememberSession(true));

    expect(latest).toMatchObject({ connected: true, rememberSession: false, persistenceError: true, busy: false });
    expect(latest.error).not.toContain("private internal response");
  });

  it("preserves a storage warning returned with an otherwise valid session", async () => {
    persistenceError = true;
    await render();

    expect(latest).toMatchObject({ connected: true, persistenceError: true });
    expect(latest.sites).toHaveLength(1);
  });

  it("waits for the login without errors and takes over automatically after authentication", async () => {
    connected = false;
    await render();
    await act(async () => latest.beginLogin());
    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    expect(latest).toMatchObject({ loginOpen: true, connected: false, error: null });
    connected = true;
    await act(async () => vi.advanceTimersByTimeAsync(2_000));

    expect(latest).toMatchObject({ connected: true, loginOpen: false, busy: false, setupRequested: true, error: null });
    expect(latest.sites).toHaveLength(1);
    expect(calls).not.toContain("sakai_connect");
    const checks = calls.filter(command => command === "sakai_poll_login").length;
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(calls.filter(command => command === "sakai_poll_login")).toHaveLength(checks);
  });

  it("keeps automatic login recoverable if fetching the course list fails", async () => {
    connected = false;
    await render();
    await act(async () => latest.beginLogin());
    connected = true;
    failure = "sakai_sites";
    await act(async () => vi.advanceTimersByTimeAsync(2_000));

    expect(latest).toMatchObject({ connected: true, loginOpen: false, sites: [], busy: false });
    failure = null;
    await act(async () => latest.connect());
    expect(latest.sites).toHaveLength(1);
    expect(latest.error).toBeNull();
  });

  it("stops automatic checks after the user closes the login window", async () => {
    connected = false;
    await render();
    await act(async () => latest.beginLogin());
    loginOpen = false;
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    await act(async () => vi.advanceTimersByTimeAsync(20_000));

    expect(latest).toMatchObject({ connected: false, loginOpen: false, error: null });
    expect(calls.filter(command => command === "sakai_poll_login")).toHaveLength(1);
  });

  it("offers manual recovery after a polling failure without endless automatic retries", async () => {
    connected = false;
    await render();
    await act(async () => latest.beginLogin());
    failure = "sakai_poll_login";
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    await act(async () => vi.advanceTimersByTimeAsync(20_000));

    expect(latest).toMatchObject({ connected: false, loginOpen: true, loginCheckFailed: true, busy: false });
    expect(calls.filter(command => command === "sakai_poll_login")).toHaveLength(1);
    expect(latest.error).not.toContain("private internal response");
    failure = null;
    connected = true;
    await act(async () => latest.connect());
    expect(latest).toMatchObject({ connected: true, loginOpen: false, loginCheckFailed: false, error: null });
  });

  it("serializes slow login checks and ignores their result after disconnect", async () => {
    connected = false;
    await render();
    await act(async () => latest.beginLogin());
    const pending = deferred<{ connected: boolean; loginOpen: boolean; rememberSession: boolean; persistenceError: boolean; autoLogin: boolean; autoLoginRejected: boolean }>();
    mockIPC((command) => {
      calls.push(command);
      if (command === "sakai_poll_login") return pending.promise;
      if (command === "sakai_disconnect") return null;
      throw new Error("Unexpected command");
    });
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    await act(async () => { window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(8_000); });
    expect(calls.filter(command => command === "sakai_poll_login")).toHaveLength(1);
    await act(async () => latest.disconnect());
    await act(async () => pending.resolve({ connected: true, loginOpen: false, rememberSession: true, persistenceError: false, autoLogin: false, autoLoginRejected: false }));

    expect(latest).toMatchObject({ connected: false, loginOpen: false, rememberSession: false, busy: false });
    expect(calls).not.toContain("sakai_sites");
  });

  it("keeps failed session deletion visible and allows retry", async () => {
    rememberSession = true;
    await render();
    failure = "sakai_disconnect";
    await act(async () => latest.disconnect());

    expect(latest).toMatchObject({ connected: false, persistenceError: true, busy: false });
    expect(latest.error).toContain("gelöscht");
    failure = null;
    await act(async () => latest.disconnect());
    expect(latest).toMatchObject({ rememberSession: false, persistenceError: false, error: null });
  });

  it("does not let a late restored status replace a newly opened login", async () => {
    const pending = deferred<{ connected: boolean; loginOpen: boolean; rememberSession: boolean; persistenceError: boolean; autoLogin: boolean; autoLoginRejected: boolean }>();
    mockIPC((command) => {
      calls.push(command);
      if (command === "sakai_status") return pending.promise;
      if (command === "sakai_begin_login") return null;
      throw new Error("Unexpected command");
    });
    await render();
    await act(async () => latest.beginLogin());
    await act(async () => pending.resolve({ connected: true, loginOpen: false, rememberSession: true, persistenceError: false, autoLogin: false, autoLoginRejected: false }));

    expect(latest).toMatchObject({ connected: false, loginOpen: true, rememberSession: false });
    expect(calls).not.toContain("sakai_sites");
  });

  it("surfaces session-persistence failures observed after a successful import", async () => {
    ports.syncSakai.mockImplementation(async () => { persistenceError = true; return report; });
    await render();

    expect(latest).toMatchObject({ connected: true, report, persistenceError: true, busy: false });
    expect(calls.filter(command => command === "sakai_status")).toHaveLength(2);
  });

  it("does not change persistence while a login or import is pending", async () => {
    connected = false;
    await render();
    await act(async () => latest.beginLogin());
    await act(async () => latest.setRememberSession(true));

    expect(calls).not.toContain("sakai_set_remember_session");
    expect(latest).toMatchObject({ loginOpen: true, rememberSession: false });
  });

  it("keeps automatic takeover working after showing the existing login window again", async () => {
    connected = false;
    await render();
    await act(async () => latest.beginLogin());
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    await act(async () => latest.beginLogin());
    connected = true;
    await act(async () => vi.advanceTimersByTimeAsync(2_000));

    expect(latest).toMatchObject({ connected: true, loginOpen: false, busy: false, error: null });
    expect(latest.sites).toHaveLength(1);
  });

  it("replaces a pending initial course fetch when remember-session is toggled", async () => {
    const pending = deferred<{ id: string; title: string; description: string }[]>();
    let siteRequests = 0;
    mockIPC((command, payload) => {
      if (command === "sakai_set_remember_session") rememberSession = (payload as { remember: boolean }).remember;
      if (command === "sakai_status" || command === "sakai_set_remember_session") return { connected: true, loginOpen: false, rememberSession, persistenceError: false, autoLogin: false, autoLoginRejected: false };
      if (command === "sakai_sites") {
        siteRequests++;
        return siteRequests === 1 ? pending.promise : [{ id: "fresh", title: "Fresh", description: "" }];
      }
      throw new Error("Unexpected command");
    });
    await render();
    expect(latest).toMatchObject({ connected: true, sites: [] });
    await act(async () => latest.setRememberSession(true));
    await act(async () => pending.resolve([{ id: "stale", title: "Stale", description: "" }]));

    expect(latest).toMatchObject({ rememberSession: true, busy: false, error: null, persistenceError: false });
    expect(latest.sites.map(site => site.id)).toEqual(["fresh"]);
  });
});
