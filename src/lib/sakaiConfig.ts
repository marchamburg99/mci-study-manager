import type { SakaiSelection } from "./sakai";

export interface SakaiPreferences {
  autoSync: boolean;
  selections: SakaiSelection[];
  lastSync: string | null;
}

export const EMPTY_SAKAI_PREFERENCES: SakaiPreferences = { autoSync: false, selections: [], lastSync: null };

export function sakaiConfigKey(root: string, semester: string): string {
  return `mci-sakai-v1:${JSON.stringify([root, semester])}`;
}

export function parseSakaiPreferences(raw: string | null): SakaiPreferences | null {
  if (raw === null) return null;
  if (raw.length > 100_000) throw new Error("Sakai-Einstellungen sind zu groß.");
  const value = JSON.parse(raw) as Partial<SakaiPreferences> | null;
  if (!value || typeof value !== "object" || typeof value.autoSync !== "boolean" || !Array.isArray(value.selections)
    || value.selections.length > 100 || (value.lastSync !== null && (typeof value.lastSync !== "string" || !Number.isFinite(Date.parse(value.lastSync))))) {
    throw new Error("Sakai-Einstellungen sind beschädigt.");
  }
  const seen = new Set<string>();
  for (const entry of value.selections) {
    if (!entry || typeof entry !== "object" || typeof entry.siteId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(entry.siteId)
      || (entry.subjectKey !== null && (typeof entry.subjectKey !== "string" || !entry.subjectKey || entry.subjectKey.length > 256)) || seen.has(entry.siteId)) {
      throw new Error("Sakai-Kursauswahl ist ungültig.");
    }
    seen.add(entry.siteId);
  }
  return { autoSync: value.autoSync, selections: value.selections, lastSync: value.lastSync ?? null };
}
