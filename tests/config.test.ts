import { describe, expect, it } from "vitest";
import { configContextKey, configForUpdate, normalizeCalendarUrl, validateConfig } from "../src/lib/config";
import type { AppConfig } from "../src/lib/types";

const config: AppConfig = {
  icalUrl: "https://calendar.example.test/feed",
  basisPfad: "/study/vault",
  semester: "Semester-1",
  refreshHours: 12,
  lastRefresh: null,
};

describe("configuration validation", () => {
  it("normalizes Webcal without losing feed query parameters", () => {
    expect(normalizeCalendarUrl(" webcal://calendar.example.test/feed?key=synthetic#fragment "))
      .toBe("https://calendar.example.test/feed?key=synthetic");
  });

  it.each(["http://calendar.example.test/feed", "file:///etc/passwd", "https://user:pass@example.test/feed", "not a URL"])("rejects unsupported calendar URLs: %s", (url) => {
    expect(() => normalizeCalendarUrl(url)).toThrow();
  });

  it.each(["../Semester-1", "one/two", "one\\two", ".hidden", "", "name\u0000"])("rejects unsafe semester folders", (semester) => {
    expect(() => validateConfig({ ...config, semester })).toThrow();
  });

  it.each([0, 169, 1.5, NaN, Infinity])("rejects invalid refresh intervals", (refreshHours) => {
    expect(() => validateConfig({ ...config, refreshHours })).toThrow();
  });

  it("normalizes configuration and invalid refresh timestamps", () => {
    expect(validateConfig({ ...config, semester: " Semester-1 ", basisPfad: "/study/vault/", lastRefresh: "invalid" })).toEqual(config);
  });

  it("separates roots, semesters and feeds but not refresh timestamps", () => {
    expect(configContextKey(config)).not.toBe(configContextKey({ ...config, semester: "Semester-2" }));
    expect(configContextKey(config)).not.toBe(configContextKey({ ...config, basisPfad: "/other/vault" }));
    expect(configContextKey(config)).not.toBe(configContextKey({ ...config, icalUrl: "https://other.example.test/feed" }));
    expect(configContextKey(config)).toBe(configContextKey({ ...config, lastRefresh: new Date().toISOString() }));
  });

  it("keeps the current sync timestamp when an older settings dialog is saved", () => {
    const current = { ...config, lastRefresh: "2026-10-05T12:00:00.000Z" };
    expect(configForUpdate(current, config).lastRefresh).toBe(current.lastRefresh);
    expect(configForUpdate(current, { ...config, semester: "Other" }).lastRefresh).toBeNull();
  });
});
