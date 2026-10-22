import { beforeEach, describe, expect, it, vi } from "vitest";

const apiReadText = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/storage", () => ({ apiReadText }));
vi.mock("@tauri-apps/api/path", () => ({ join: (...parts: string[]) => Promise.resolve(parts.join("/")) }));
import { loadSubjectExclusions } from "../src/lib/subjectExclusions";

const cfg = { basisPfad: "/study/vault", semester: "Semester-1" };
const valid = { version: 1, subjectKeys: ["lv-0123456789abcdef0123456789abcdef"], sakaiSiteIds: ["example-course"] };

beforeEach(() => {
  vi.resetAllMocks();
  apiReadText.mockResolvedValue(null);
});

describe("loadSubjectExclusions", () => {
  it("returns no exclusions when the optional semester file is missing", async () => {
    const result = await loadSubjectExclusions(cfg);

    expect(result).toEqual({ subjectKeys: new Set(), sakaiSiteIds: new Set() });
    expect(apiReadText).toHaveBeenCalledWith("/study/vault/Semester-1/.mci-manager/excluded-subjects.json");
  });

  it("reads validated stable subject and Sakai keys", async () => {
    apiReadText.mockResolvedValue(JSON.stringify(valid));

    const result = await loadSubjectExclusions(cfg);

    expect(result).toEqual({ subjectKeys: new Set(valid.subjectKeys), sakaiSiteIds: new Set(valid.sakaiSiteIds) });
  });

  it.each([
    "{broken", "null", "[]",
    JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({ ...valid, extra: true }),
    JSON.stringify({ version: 1, subjectKeys: [] }),
    JSON.stringify({ ...valid, subjectKeys: "coding" }),
    JSON.stringify({ ...valid, subjectKeys: ["../coding"] }),
    JSON.stringify({ ...valid, subjectKeys: [".hidden"] }),
    JSON.stringify({ ...valid, subjectKeys: [" "] }),
    JSON.stringify({ ...valid, subjectKeys: ["x".repeat(257)] }),
    JSON.stringify({ ...valid, subjectKeys: ["coding", "coding"] }),
    JSON.stringify({ ...valid, subjectKeys: Array.from({ length: 101 }, (_, index) => `subject-${index}`) }),
    JSON.stringify({ ...valid, sakaiSiteIds: ["https://example.test/course"] }),
    JSON.stringify({ ...valid, sakaiSiteIds: ["x".repeat(129)] }),
    JSON.stringify({ ...valid, sakaiSiteIds: ["example-course", "example-course"] }),
    JSON.stringify({ ...valid, sakaiSiteIds: Array.from({ length: 101 }, (_, index) => `site-${index}`) }),
    `${" ".repeat(100_000)}${JSON.stringify(valid)}`,
  ])("rejects malformed or unbounded exclusion files", async (raw) => {
    apiReadText.mockResolvedValue(raw);

    await expect(loadSubjectExclusions(cfg)).rejects.toThrow("Fach-Ausschlussdatei");
  });

  it("keeps filesystem errors visible instead of treating them as a missing file", async () => {
    apiReadText.mockRejectedValue(new Error("Permission denied"));

    await expect(loadSubjectExclusions(cfg)).rejects.toThrow("Permission denied");
  });

  it("rejects a semester path outside the selected semester directory before reading", async () => {
    await expect(loadSubjectExclusions({ ...cfg, semester: "../Semester-2" })).rejects.toThrow("Vault-Pfad");

    expect(apiReadText).not.toHaveBeenCalled();
  });
});
