import type { AppConfig } from "./types";

export function normalizeCalendarUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim().replace(/^webcals?:/i, "https:"));
  } catch {
    throw new Error("Bitte eine gültige Kalender-URL eingeben.");
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
    throw new Error("Der Kalender muss eine HTTPS- oder Webcal-Adresse ohne Benutzername und Passwort verwenden.");
  }
  url.hash = "";
  return url.href;
}

export function validateConfig(cfg: AppConfig): AppConfig {
  const basisPfad = cfg.basisPfad.trim().replace(/[\\/]+$/, "");
  if (!basisPfad || (!basisPfad.startsWith("/") && !/^[a-z]:[\\/]/i.test(basisPfad))) {
    throw new Error("Bitte einen absoluten Vault-Pfad auswählen.");
  }
  if (basisPfad.split(/[\\/]/).some((part) => part === ".." || part === ".")) {
    throw new Error("Der Vault-Pfad darf keine relativen Pfadteile enthalten.");
  }
  const semester = cfg.semester.trim();
  if (!semester || semester.startsWith(".") || semester.endsWith(".") || /[\\/:*?"<>|]/.test(semester) || [...semester].some((char) => char.charCodeAt(0) < 32) || semester.length > 128) {
    throw new Error("Bitte einen einzelnen Semester-Ordnernamen ohne Schrägstriche eingeben.");
  }
  if (!Number.isInteger(cfg.refreshHours) || cfg.refreshHours < 1 || cfg.refreshHours > 168) {
    throw new Error("Das Sync-Intervall muss zwischen 1 und 168 ganzen Stunden liegen.");
  }
  return {
    ...cfg,
    basisPfad,
    semester,
    icalUrl: normalizeCalendarUrl(cfg.icalUrl),
    lastRefresh: cfg.lastRefresh && Number.isFinite(Date.parse(cfg.lastRefresh)) ? cfg.lastRefresh : null,
  };
}

export function configContextKey(cfg: AppConfig): string {
  return JSON.stringify([cfg.basisPfad, cfg.semester, cfg.icalUrl]);
}

export function configForUpdate(previous: AppConfig | null, draft: AppConfig): AppConfig {
  const next = validateConfig(draft);
  next.lastRefresh = previous && configContextKey(previous) === configContextKey(next) ? previous.lastRefresh : null;
  return next;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
