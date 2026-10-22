// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SakaiPanel } from "../src/components/SakaiPanel";
import type { useSakai } from "../src/hooks/useSakai";

let root: Root;
let container: HTMLDivElement;
let sync: ReturnType<typeof useSakai>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  sync = {
    context: "synthetic", connected: true, loginOpen: false, loginEpoch: 0, loginCheckFailed: false, rememberSession: false, persistenceError: false, busy: false, sites: [],
    preferences: { autoSync: false, selections: [], lastSync: null }, hasPreferences: true,
    initializationBlocked: false, setupRequested: false, error: null, progress: "",
    report: { updated: 12, unchanged: 0, downloaded: 188, warnings: [], completedAt: "2026-09-22T10:00:00Z" },
    beginLogin: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), run: vi.fn(), refreshSubject: vi.fn(), setSelections: vi.fn(), setAutoSync: vi.fn(), setRememberSession: vi.fn(),
  };
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("SakaiPanel download summary", () => {
  it("shows the completed totals without an obsolete download-limit message", async () => {
    await act(async () => root.render(createElement(SakaiPanel, { sync, events: [] })));

    expect(container.querySelector("[role=status]")?.textContent).toBe("12 Live-Notizen aktualisiert · 0 unverändert · 188 PDFs gespeichert");
    expect(container.textContent).not.toContain("Download-Limit");
    expect(container.textContent).not.toContain("noch aus");
    expect(container.querySelector("details")).toBeNull();
  });

  it("updates progress while keeping cancellation available during the full sync", async () => {
    sync = { ...sync, busy: true, report: null, progress: "Sakai-Gruppe 1 von 2: 25 PDFs gespeichert. Nächste PDF wird geladen …" };
    await act(async () => root.render(createElement(SakaiPanel, { sync, events: [] })));
    sync = { ...sync, progress: "Sakai-Gruppe 1 von 2: 26 PDFs gespeichert. Nächste PDF wird geladen …" };
    await act(async () => root.render(createElement(SakaiPanel, { sync, events: [] })));

    expect(container.querySelector("[role=status]")?.textContent).toBe(sync.progress);
    expect(container.textContent).toContain("Abruf abbrechen");
    expect(container.textContent).not.toContain("Download-Limit");
  });

  it("keeps genuine download issues accessible and collapsed beside the totals", async () => {
    sync.report!.warnings = ["7 PDFs: Download fehlgeschlagen; Quellenlinks bleiben verfügbar."];
    sync.report!.downloaded = 181;
    await act(async () => root.render(createElement(SakaiPanel, { sync, events: [] })));

    expect(container.textContent).toContain("181 PDFs gespeichert");
    expect(container.textContent).not.toContain("Download-Limit");
    expect(container.querySelector("summary")?.textContent).toBe("1 Hinweis zum Abruf");
    expect(container.querySelector("details")?.open).toBe(false);
    expect([...container.querySelectorAll("details li")].map((item) => item.textContent)).toEqual(sync.report!.warnings);
  });

  it("offers remember-session opt-in before login without an extra takeover button", async () => {
    sync.connected = false;
    sync.loginOpen = true;
    await act(async () => root.render(createElement(SakaiPanel, { sync, events: [] })));

    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(true);
    expect(container.textContent).toContain("Die App erkennt die Anmeldung automatisch");
    expect(container.textContent).not.toContain("Anmeldung übernehmen");
    expect(container.textContent).not.toContain("Anmeldung erneut prüfen");
  });

  it("shows manual recovery only after an automatic login check failed", async () => {
    sync.connected = false;
    sync.loginOpen = true;
    sync.loginCheckFailed = true;
    await act(async () => root.render(createElement(SakaiPanel, { sync, events: [] })));

    expect(container.textContent).toContain("Anmeldung erneut prüfen");
  });

  it("leaves session removal accessible even when disconnected after a Keychain error", async () => {
    sync.connected = false;
    sync.persistenceError = true;
    await act(async () => root.render(createElement(SakaiPanel, { sync, events: [] })));

    expect(container.textContent).toContain("Verbindung trennen");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Schlüsselbund");
  });
});
