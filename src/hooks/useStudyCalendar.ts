import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import type { AppConfig, StudyEvent } from "../lib/types";
import { apiSetVaultRoot, defaultBasis, loadConfig, saveConfig } from "../lib/storage";
import { DEFAULT_CONFIG } from "../lib/types";
import { configContextKey, configForUpdate, errorMessage, validateConfig } from "../lib/config";
import { syncCalendar } from "../lib/calendar";

export function useStudyCalendar(canSync: () => boolean) {
  const desktop = isTauri();
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [events, setEvents] = useState<StudyEvent[]>([]);
  const [syncing, setSyncing] = useState(desktop);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<"empty" | "synced" | "cached" | "offline">("empty");
  const current = useRef<AppConfig | null>(null);
  const busy = useRef(false);
  const lastAttempt = useRef(0);
  const generation = useRef(0);

  const refresh = useCallback(async (config: AppConfig, force = false) => {
    if (busy.current || !desktop) return;
    if (!canSync()) {
      setError("Synchronisation pausiert: Bitte zuerst die ungesicherten Notizänderungen speichern.");
      return;
    }
    busy.current = true;
    const version = generation.current;
    lastAttempt.current = Date.now();
    setSyncing(true);
    try {
      const result = await syncCalendar(config, force);
      if (version !== generation.current) return;
      if (!canSync()) throw new Error("Der neue Plan wird erst nach dem Sichern deiner Notiz übernommen. Danach bitte erneut synchronisieren.");
      if (!current.current || configContextKey(current.current) !== configContextKey(config)) return;
      let persistenceWarning: string | null = null;
      try { saveConfig(result.config); }
      catch { persistenceWarning = "Der Plan ist verfügbar, aber der Sync-Zeitpunkt konnte nicht in den App-Einstellungen gespeichert werden."; }
      current.current = result.config;
      setCfg(result.config);
      setEvents(result.events);
      setState(result.state);
      setError([result.warning, persistenceWarning].filter(Boolean).join(" ") || null);
    } catch (cause) {
      if (version === generation.current) setError(`Stundenplan konnte nicht geladen werden: ${errorMessage(cause)}`);
    } finally {
      if (version === generation.current) {
        busy.current = false;
        setSyncing(false);
      }
    }
  }, [canSync, desktop]);

  useEffect(() => {
    let alive = true;
    const version = ++generation.current;
    busy.current = true;
    void (async () => {
      try {
        const saved = await loadConfig();
        if (!alive) return;
        setSyncing(desktop);
        current.current = saved;
        setCfg(saved);
        if (!desktop) return;
        const config = validateConfig(saved);
        await apiSetVaultRoot(config.basisPfad);
        if (!alive) return;
        current.current = config;
        setCfg(config);
        setReady(true);
        busy.current = false;
        await refresh(config);
      } catch (cause) {
        const fallback = current.current ?? { ...DEFAULT_CONFIG, basisPfad: await defaultBasis() };
        if (alive) {
          setCfg(fallback);
          setReady(false);
          setError(`Einstellungen prüfen: ${errorMessage(cause)}`);
        }
      } finally {
        if (version === generation.current) {
          busy.current = false;
          setSyncing(false);
        }
      }
    })();
    return () => { alive = false; generation.current = version + 1; };
  }, [desktop, refresh]);

  useEffect(() => {
    if (!ready || !desktop) return;
    const check = () => {
      const config = current.current;
      if (!config || busy.current || Date.now() - lastAttempt.current < 60_000) return;
      const age = config.lastRefresh ? Date.now() - Date.parse(config.lastRefresh) : Infinity;
      if (age >= config.refreshHours * 3_600_000) void refresh(config);
    };
    const timer = window.setInterval(check, 60_000);
    window.addEventListener("focus", check);
    window.addEventListener("online", check);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
      window.removeEventListener("online", check);
    };
  }, [desktop, ready, refresh]);

  const applyConfig = useCallback(async (draft: AppConfig) => {
    if (!desktop) throw new Error("Einstellungen können nur in der Desktop-App gespeichert werden.");
    if (!canSync()) throw new Error("Bitte zuerst die ungesicherten Notizänderungen speichern.");
    if (busy.current) throw new Error("Die laufende Synchronisation bitte zuerst abschließen lassen.");
    const version = generation.current;
    const previous = current.current;
    const next = configForUpdate(previous, draft);
    const changed = !previous || configContextKey(previous) !== configContextKey(next);
    busy.current = true;
    setSyncing(true);
    try {
      await apiSetVaultRoot(next.basisPfad);
      if (version !== generation.current) return;
      try {
        saveConfig(next);
      } catch (cause) {
        if (previous) await apiSetVaultRoot(previous.basisPfad);
        throw cause;
      }
      current.current = next;
      setCfg(next);
      setReady(true);
      setError(null);
      if (changed) {
        setEvents([]);
        setState("empty");
      }
    } finally {
      if (version === generation.current) {
        busy.current = false;
        setSyncing(false);
      }
    }
    if (version === generation.current) await refresh(next, true);
  }, [canSync, desktop, refresh]);

  const refreshNow = useCallback(() => {
    if (current.current && ready) return refresh(current.current, true);
    return Promise.resolve();
  }, [ready, refresh]);

  return { cfg, events, syncing, ready, desktop, error, state, refreshNow, applyConfig };
}
