// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeCatalog } from "../src/lib/knowledge";
import type { AppConfig, StudyEvent } from "../src/lib/types";

const ports = vi.hoisted(() => ({ loadKnowledge: vi.fn() }));
vi.mock("../src/lib/knowledgeStorage", () => ports);
import { useKnowledge } from "../src/hooks/useKnowledge";

const cfg: AppConfig = {
  basisPfad: "/synthetic/vault", semester: "Sem01", icalUrl: "https://example.test/calendar",
  refreshHours: 12, lastRefresh: null,
};
const events: StudyEvent[] = [];
const catalog: KnowledgeCatalog = { notes: [{
  path: "Studium/General.md", title: "General", body: "# General\n", subjectKey: null, subject: null,
  retrievedAt: "2026-09-22", sourceStatus: null, applicability: null, cohort: null,
  sourceUrls: ["https://example.test/sakai/general"], notices: [],
}], warnings: [] };
const replacement: KnowledgeCatalog = {
  notes: [{ ...catalog.notes[0], path: "Studium/Updated.md", title: "Updated" }], warnings: ["Example warning"],
};
let root: Root | null;
let container: HTMLDivElement;
let latest: ReturnType<typeof useKnowledge>;

function Probe({ config, enabled }: { config: AppConfig | null; enabled: boolean }) {
  const api = useKnowledge(config, events, enabled);
  useEffect(() => { latest = api; }, [api]);
  return null;
}

function deferred() {
  let resolve!: (value: KnowledgeCatalog) => void;
  const promise = new Promise<KnowledgeCatalog>((done) => { resolve = done; });
  return { promise, resolve };
}

async function render(config: AppConfig | null = cfg, enabled = true) {
  await act(async () => { root!.render(createElement(Probe, { config, enabled })); });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  ports.loadKnowledge.mockResolvedValue(catalog);
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

describe("useKnowledge", () => {
  it("loads the configured local catalog and reports when the read finishes", async () => {
    const pending = deferred();
    ports.loadKnowledge.mockReturnValueOnce(pending.promise);

    await render();

    expect(latest).toMatchObject({ notes: [], warnings: [], loading: true });
    expect(ports.loadKnowledge).toHaveBeenCalledWith({ basisPfad: cfg.basisPfad, semester: cfg.semester }, events);
    await act(async () => pending.resolve(catalog));
    expect(latest).toMatchObject({ ...catalog, loading: false });
  });

  it.each([cfg, null])("makes no storage or IPC calls while disabled, including focus, reload, and timer refresh: %j", async (config) => {
    vi.useFakeTimers();

    await render(config, false);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      latest.reload();
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(ports.loadKnowledge).not.toHaveBeenCalled();
    expect(latest).toMatchObject({ notes: [], warnings: [], loading: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { ...cfg, basisPfad: "/synthetic/other-vault" },
    { ...cfg, semester: "Sem02" },
  ])("rejects a late read from an old vault or semester: %j", async (nextConfig) => {
    const oldRead = deferred();
    const newRead = deferred();
    ports.loadKnowledge.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);

    await render();
    await render(nextConfig);
    await act(async () => newRead.resolve(replacement));
    await act(async () => oldRead.resolve(catalog));

    expect(latest).toMatchObject({ ...replacement, loading: false });
    expect(ports.loadKnowledge).toHaveBeenCalledTimes(2);
    expect(ports.loadKnowledge).toHaveBeenLastCalledWith({ basisPfad: nextConfig.basisPfad, semester: nextConfig.semester }, events);
  });

  it("hides the previous catalog while a new context is loading", async () => {
    await render();
    const pending = deferred();
    ports.loadKnowledge.mockReturnValueOnce(pending.promise);

    await render({ ...cfg, semester: "Sem02" });

    expect(latest).toMatchObject({ notes: [], warnings: [], loading: true });
    await act(async () => pending.resolve(replacement));
    expect(latest).toMatchObject({ ...replacement, loading: false });
  });

  it("rejects an old read even after returning to its original context", async () => {
    const oldRead = deferred();
    ports.loadKnowledge.mockReturnValueOnce(oldRead.promise).mockResolvedValueOnce(catalog).mockResolvedValueOnce(replacement);

    await render();
    await render({ ...cfg, semester: "Sem02" });
    await render();
    await act(async () => oldRead.resolve(catalog));

    expect(latest).toMatchObject({ ...replacement, loading: false });
    expect(ports.loadKnowledge).toHaveBeenCalledTimes(3);
  });

  it("ignores an in-flight read after disabling and loads again when re-enabled", async () => {
    const pending = deferred();
    ports.loadKnowledge.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(replacement);

    await render();
    await render(cfg, false);
    await act(async () => pending.resolve(catalog));
    expect(latest).toMatchObject({ notes: [], warnings: [], loading: false });
    await render();

    expect(latest).toMatchObject({ ...replacement, loading: false });
    expect(ports.loadKnowledge).toHaveBeenCalledTimes(2);
  });

  it("refreshes on focus while retaining the current catalog and suppressing overlapping reads", async () => {
    await render();
    const pending = deferred();
    ports.loadKnowledge.mockReturnValueOnce(pending.promise);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
    });

    expect(latest).toMatchObject({ ...catalog, loading: true });
    expect(ports.loadKnowledge).toHaveBeenCalledTimes(2);
    await act(async () => pending.resolve(replacement));
    expect(latest).toMatchObject({ ...replacement, loading: false });
  });

  it("reloads on request without reloading for an equivalent configuration object", async () => {
    await render();
    await render({ ...cfg });
    expect(ports.loadKnowledge).toHaveBeenCalledTimes(1);
    ports.loadKnowledge.mockResolvedValueOnce(replacement);

    await act(async () => latest.reload());

    expect(ports.loadKnowledge).toHaveBeenCalledTimes(2);
    expect(latest).toMatchObject({ ...replacement, loading: false });
  });

  it("refreshes every thirty seconds and releases timers and focus listeners on unmount", async () => {
    vi.useFakeTimers();
    await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(ports.loadKnowledge).toHaveBeenCalledTimes(2);

    await act(async () => { root!.unmount(); root = null; });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(ports.loadKnowledge).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("exposes a readable warning on failure and recovers on the next focus", async () => {
    ports.loadKnowledge.mockRejectedValueOnce(new Error("Example read failure"));

    await render();

    expect(latest).toMatchObject({ notes: [], loading: false });
    expect(latest.warnings).toHaveLength(1);
    expect(latest.warnings[0]).toContain("Studienwissen konnte nicht geladen werden");
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(latest).toMatchObject({ ...catalog, loading: false });
  });
});
