import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseIcs } from "../src/lib/ical";
import type { AppConfig, StudyEvent } from "../src/lib/types";

const storage = vi.hoisted(() => ({
  apiFetchIcal: vi.fn(), apiReadText: vi.fn(), apiSaveText: vi.fn(),
  calendarCachePath: vi.fn(), ensureVault: vi.fn(), resolveEventPaths: vi.fn(),
}));
vi.mock("../src/lib/storage", () => storage);
vi.mock("@tauri-apps/api/path", () => ({ join: (...parts: string[]) => Promise.resolve(parts.join("/")) }));
import { syncCalendar } from "../src/lib/calendar";

const config: AppConfig = {
  basisPfad: "/study/vault", semester: "Semester-1", icalUrl: "https://calendar.example.test/feed",
  refreshHours: 12, lastRefresh: null,
};
const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:synthetic-event
SUMMARY:Databases (ILV) - MCiT 26 (Anna Example)
DTSTART:20261005T090000
DTEND:20261005T103000
END:VEVENT
END:VCALENDAR`;
const cachePath = "/study/vault/.mci-manager/calendar-key.ics";
const exclusionPath = "/study/vault/Semester-1/.mci-manager/excluded-subjects.json";
const fullIcs = ics.replace("END:VCALENDAR", `BEGIN:VEVENT
UID:synthetic-coding
SUMMARY:Coding (UE) - MCiT 26 (Anna Example)
DTSTART:20261006T090000
DTEND:20261006T103000
END:VEVENT
END:VCALENDAR`);
const excludedKey = parseIcs(ics)[0].fachKey;
const exclusion = JSON.stringify({ version: 1, subjectKeys: [excludedKey], sakaiSiteIds: [] });
let files: Map<string, string>;

beforeEach(() => {
  vi.resetAllMocks();
  files = new Map();
  storage.calendarCachePath.mockResolvedValue(cachePath);
  storage.apiReadText.mockImplementation(async (path: string) => files.get(path) ?? null);
  storage.apiFetchIcal.mockResolvedValue(ics);
  storage.resolveEventPaths.mockImplementation(async (_cfg: AppConfig, events: StudyEvent[]) => events.map((event) => ({ ...event, terminRel: "stable/course" })));
});

describe("calendar synchronization", () => {
  it("resolves stable paths and persists a validated calendar with an expected revision", async () => {
    const result = await syncCalendar(config, true);
    expect(result.state).toBe("synced");
    expect(result.events[0].terminRel).toBe("stable/course");
    expect(result.config.lastRefresh).not.toBeNull();
    expect(storage.apiSaveText).toHaveBeenCalledWith(expect.any(String), ics, null);
    expect(storage.ensureVault).toHaveBeenCalledWith(config, result.events);
  });

  it("uses a recent cache without a network request", async () => {
    files.set(cachePath, ics);
    const result = await syncCalendar({ ...config, lastRefresh: new Date().toISOString() });
    expect(result.state).toBe("cached");
    expect(storage.apiFetchIcal).not.toHaveBeenCalled();
    expect(storage.apiSaveText).not.toHaveBeenCalled();
  });

  it.each(["<html>Sign in</html>", "BEGIN:VCALENDAR\nBEGIN:VEVENT\nEND:VEVENT\nEND:VCALENDAR"])("does not overwrite a cache with an unreadable feed", async (response) => {
    files.set(cachePath, ics);
    storage.apiFetchIcal.mockResolvedValue(response);
    const result = await syncCalendar(config, true);
    expect(result.state).toBe("offline");
    expect(result.events).toHaveLength(1);
    expect(result.config.lastRefresh).toBeNull();
    expect(storage.apiSaveText).not.toHaveBeenCalled();
  });

  it("does not reinterpret cache permission errors as a missing file", async () => {
    storage.apiReadText.mockImplementation(async (path: string) => {
      if (path === cachePath) throw new Error("Permission denied");
      return null;
    });
    await expect(syncCalendar(config)).rejects.toThrow("Permission denied");
    expect(storage.apiFetchIcal).not.toHaveBeenCalled();
    expect(storage.apiSaveText).not.toHaveBeenCalled();
  });

  it("recovers a damaged recent cache through a fresh download", async () => {
    files.set(cachePath, "broken cache");
    const result = await syncCalendar({ ...config, lastRefresh: new Date().toISOString() });
    expect(result.state).toBe("synced");
    expect(storage.apiSaveText).toHaveBeenCalledWith(expect.any(String), ics, "broken cache");
  });

  it("rejects partially truncated calendars even when one event is readable", async () => {
    files.set(cachePath, ics);
    storage.apiFetchIcal.mockResolvedValue(ics.replace("END:VCALENDAR", "BEGIN:VEVENT\nUID:truncated\nEND:VCALENDAR"));
    const result = await syncCalendar(config, true);
    expect(result.state).toBe("offline");
    expect(storage.apiSaveText).not.toHaveBeenCalled();
  });

  it("updates vault overviews when falling back to the selected source's cache", async () => {
    files.set(cachePath, ics);
    storage.apiFetchIcal.mockRejectedValue(new Error("Offline"));
    const result = await syncCalendar(config, true);
    expect(result.state).toBe("offline");
    expect(storage.ensureVault).toHaveBeenCalledWith(config, result.events);
  });

  it("surfaces a failed first sync rather than reporting an empty success", async () => {
    storage.apiFetchIcal.mockRejectedValue(new Error("Offline"));
    await expect(syncCalendar(config)).rejects.toThrow("Offline");
  });

  it("does not advance the sync timestamp when a concurrent cache write conflicts", async () => {
    files.set(cachePath, ics);
    storage.apiSaveText.mockRejectedValue(new Error("CONFLICT"));
    const result = await syncCalendar(config, true);
    expect(result.state).toBe("offline");
    expect(result.config.lastRefresh).toBeNull();
    expect(result.warning).toContain("CONFLICT");
  });
});

describe("semester course exclusions", () => {
  it.each([
    { state: "synced", lastRefresh: null, fetch: async () => fullIcs },
    { state: "cached", lastRefresh: new Date().toISOString(), fetch: async () => fullIcs },
    { state: "offline", lastRefresh: null, fetch: async () => { throw new Error("Offline"); } },
  ])("excludes courses before assigning paths and writing overviews in the $state branch", async ({ state, lastRefresh, fetch }) => {
    files.set(exclusionPath, exclusion);
    files.set(cachePath, fullIcs);
    storage.apiFetchIcal.mockImplementation(fetch);
    const cfg = { ...config, lastRefresh };

    const result = await syncCalendar(cfg);

    expect(result.state).toBe(state);
    expect(result.events.map((event) => event.uid)).toEqual(["synthetic-coding"]);
    expect(storage.resolveEventPaths).toHaveBeenCalledWith(cfg, [expect.objectContaining({ uid: "synthetic-coding" })]);
    expect(storage.ensureVault).toHaveBeenCalledWith(cfg, result.events);
  });

  it.each([
    { state: "synced", lastRefresh: null, fetch: async (): Promise<string> => ics },
    { state: "cached", lastRefresh: new Date().toISOString(), fetch: async (): Promise<string> => ics },
    { state: "offline", lastRefresh: null, fetch: async () => { throw new Error("Offline"); } },
  ])("keeps a valid empty active semester when every course is excluded in the $state branch", async ({ state, lastRefresh, fetch }) => {
    files.set(exclusionPath, exclusion);
    files.set(cachePath, ics);
    storage.apiFetchIcal.mockImplementation(fetch);
    const cfg = { ...config, lastRefresh };

    const result = await syncCalendar(cfg);

    expect(result).toMatchObject({ state, events: [] });
    expect(storage.resolveEventPaths).toHaveBeenCalledWith(cfg, []);
    expect(storage.ensureVault).toHaveBeenCalledWith(cfg, []);
  });

  it("keeps the entire validated source calendar in the cache", async () => {
    files.set(exclusionPath, exclusion);
    storage.apiFetchIcal.mockResolvedValue(fullIcs);

    await syncCalendar(config, true);

    expect(storage.apiSaveText).toHaveBeenCalledWith(cachePath, fullIcs, null);
  });

  it("validates the complete calendar before applying exclusions", async () => {
    files.set(exclusionPath, exclusion);
    storage.apiFetchIcal.mockResolvedValue(ics.replace("END:VCALENDAR", "BEGIN:VEVENT\nUID:truncated\nEND:VCALENDAR"));

    await expect(syncCalendar(config, true)).rejects.toThrow("vollständigen Kalender");

    expect(storage.resolveEventPaths).not.toHaveBeenCalled();
    expect(storage.ensureVault).not.toHaveBeenCalled();
    expect(storage.apiSaveText).not.toHaveBeenCalled();
  });

  it("stops on malformed exclusions without falling back to a cached calendar or writing files", async () => {
    files.set(exclusionPath, "{broken");
    files.set(cachePath, fullIcs);

    await expect(syncCalendar(config, true)).rejects.toThrow("Fach-Ausschlussdatei");

    expect(storage.apiFetchIcal).not.toHaveBeenCalled();
    expect(storage.resolveEventPaths).not.toHaveBeenCalled();
    expect(storage.ensureVault).not.toHaveBeenCalled();
    expect(storage.apiSaveText).not.toHaveBeenCalled();
  });

  it("surfaces exclusion permission errors before a calendar fetch or write", async () => {
    storage.apiReadText.mockRejectedValue(new Error("Permission denied"));

    await expect(syncCalendar(config, true)).rejects.toThrow("Permission denied");

    expect(storage.apiFetchIcal).not.toHaveBeenCalled();
    expect(storage.resolveEventPaths).not.toHaveBeenCalled();
    expect(storage.ensureVault).not.toHaveBeenCalled();
    expect(storage.apiSaveText).not.toHaveBeenCalled();
  });

  it("uses exclusions only from the selected semester", async () => {
    files.set(exclusionPath, exclusion);

    const result = await syncCalendar({ ...config, semester: "Semester-2" }, true);

    expect(result.events.map((event) => event.uid)).toEqual(["synthetic-event"]);
    expect(storage.apiReadText).toHaveBeenCalledWith("/study/vault/Semester-2/.mci-manager/excluded-subjects.json");
  });
});
