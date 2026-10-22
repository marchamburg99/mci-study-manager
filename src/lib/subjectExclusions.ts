import { join } from "@tauri-apps/api/path";
import { validateRelativePath } from "./identity";
import { sakaiSiteId } from "./sakai";
import { apiReadText } from "./storage";
import type { AppConfig } from "./types";

type Checked = <T>(operation: () => Promise<T>) => Promise<T>;

function subjectKey(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(value);
}

function entries(value: unknown, valid: (entry: unknown) => entry is string): value is string[] {
  return Array.isArray(value) && value.length <= 100 && value.every(valid) && new Set(value).size === value.length;
}

export async function loadSubjectExclusions(
  cfg: Pick<AppConfig, "basisPfad" | "semester">,
  checked: Checked = (operation) => operation(),
): Promise<{ subjectKeys: Set<string>; sakaiSiteIds: Set<string> }> {
  validateRelativePath(cfg.semester, 1);
  const path = await checked(() => join(cfg.basisPfad, cfg.semester, ".mci-manager", "excluded-subjects.json"));
  const raw = await checked(() => apiReadText(path));
  if (raw === null) return { subjectKeys: new Set(), sakaiSiteIds: new Set() };
  if (new TextEncoder().encode(raw).length > 100_000) throw new Error("Die Fach-Ausschlussdatei ist zu groß.");
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("Die Fach-Ausschlussdatei enthält ungültiges JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Die Fach-Ausschlussdatei hat ein unbekanntes oder beschädigtes Format.");
  }
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).length !== 3 || fields.version !== 1
    || !entries(fields.subjectKeys, subjectKey) || !entries(fields.sakaiSiteIds, sakaiSiteId)) {
    throw new Error("Die Fach-Ausschlussdatei hat ein unbekanntes oder beschädigtes Format.");
  }
  return { subjectKeys: new Set(fields.subjectKeys), sakaiSiteIds: new Set(fields.sakaiSiteIds) };
}
