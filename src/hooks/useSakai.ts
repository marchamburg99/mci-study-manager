import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppConfig, StudyEvent } from "../lib/types";
import type { KnowledgeNote } from "../lib/knowledge";
import { apiSakaiDisableAutoLogin, apiSakaiEnableAutoLogin, apiSakaiSites, apiSakaiStatus, defaultSelections, type SakaiSelection, type SakaiSite, type SakaiSyncReport } from "../lib/sakai";
import { syncSakai } from "../lib/sakaiStorage";
import { EMPTY_SAKAI_PREFERENCES, parseSakaiPreferences, sakaiConfigKey, type SakaiPreferences } from "../lib/sakaiConfig";

const AUTO_REFRESH_INTERVAL = 5 * 60 * 1000;
const ACTIVE_REFRESH_INTERVAL = 60 * 1000;
interface State {
  context: string;
  connected: boolean;
  loginOpen: boolean;
  loginEpoch: number;
  loginCheckFailed: boolean;
  rememberSession: boolean;
  persistenceError: boolean;
  autoLogin: boolean;
  autoLoginRejected: boolean;
  busy: boolean;
  sites: SakaiSite[];
  preferences: SakaiPreferences;
  hasPreferences: boolean;
  initializationBlocked: boolean;
  setupRequested: boolean;
  error: string | null;
  progress: string;
  report: SakaiSyncReport | null;
}
const EMPTY: State = { context: "", connected: false, loginOpen: false, loginEpoch: 0, loginCheckFailed: false, rememberSession: false, persistenceError: false, autoLogin: false, autoLoginRejected: false, busy: false, sites: [], preferences: EMPTY_SAKAI_PREFERENCES,
  hasPreferences: false, initializationBlocked: false, setupRequested: false, error: null, progress: "", report: null };

function message(error: unknown): string {
  if (String(error).includes("SAKAI_AUTH_REQUIRED")) return "Die Sakai-Sitzung ist abgelaufen. Bitte erneut anmelden. Dein lokaler Wissensstand bleibt erhalten.";
  if (String(error).includes("SAKAI_CANCELLED")) return "Sakai-Abruf abgebrochen. Bereits gespeicherte Inhalte bleiben erhalten.";
  return "Sakai konnte nicht vollständig abgerufen werden. Bitte Verbindung und Anmeldung prüfen. Bestehende Notizen bleiben erhalten.";
}

export function useSakai(cfg: AppConfig | null, events: StudyEvent[], notes: KnowledgeNote[], enabled: boolean, onUpdated: () => void, catalogReady = true) {
  const context = cfg ? sakaiConfigKey(cfg.basisPfad, cfg.semester) : "";
  const [state, setState] = useState<State>(EMPTY);
  const current = useRef(EMPTY);
  const inputs = useRef({ cfg, events, onUpdated, catalogReady });
  const generation = useRef(0);
  const busy = useRef(false);
  const lastAttempt = useRef(0);
  const lastFinished = useRef(0);
  const startupPending = useRef(true);
  const invalidate = useCallback(() => { busy.current = false; return ++generation.current; }, []);
  useEffect(() => { inputs.current = { cfg, events, onUpdated, catalogReady }; }, [cfg, events, onUpdated, catalogReady]);
  const update = useCallback((patch: Partial<State>) => {
    current.current = { ...current.current, ...patch };
    setState(current.current);
  }, []);

  useEffect(() => {
    const epoch = invalidate();
    busy.current = false;
    lastAttempt.current = 0;
    lastFinished.current = 0;
    startupPending.current = true;
    current.current = { ...EMPTY, context };
    setState(current.current);
    if (!enabled || !context) return;
    let preferences: SakaiPreferences | null = null;
    try { preferences = parseSakaiPreferences(localStorage.getItem(context)); }
    catch { update({ initializationBlocked: true, error: "Sakai-Einstellungen konnten nicht gelesen werden. Automatik ist aus. Bitte Kurse neu auswählen." }); }
    if (preferences) update({ preferences, hasPreferences: true });
    void apiSakaiStatus().then(async (status) => {
      if (generation.current !== epoch) return;
      update(status);
      if (!status.connected) return;
      update({ connected: true });
      const sites = await apiSakaiSites();
      if (generation.current === epoch) update({ connected: true, sites });
    }).catch((error) => {
      if (generation.current === epoch) update({ error: message(error), connected: String(error).includes("SAKAI_AUTH_REQUIRED") ? false : current.current.connected });
    });
    return () => { invalidate(); };
  }, [context, enabled, invalidate, update]);

  useEffect(() => {
    if (!enabled || !state.loginOpen || state.loginCheckFailed || state.context !== context) return;
    const epoch = generation.current;
    let stopped = false;
    let checking = false;
    const isCurrent = () => generation.current === epoch && current.current.context === context;
    const check = async () => {
      if (stopped || checking || busy.current) return;
      checking = true;
      try {
        const status = await apiSakaiStatus("sakai_poll_login");
        if (!isCurrent()) return;
        update(status);
        if (!status.connected) return;
        startupPending.current = true;
        busy.current = true;
        update({ busy: true, setupRequested: true, initializationBlocked: false, error: null });
        try {
          const sites = await apiSakaiSites();
          if (isCurrent()) update({ sites });
        } catch (error) {
          if (isCurrent()) update({ error: message(error), connected: String(error).includes("SAKAI_AUTH_REQUIRED") ? false : current.current.connected });
        } finally {
          if (isCurrent()) { busy.current = false; update({ busy: false }); }
        }
      } catch {
        if (isCurrent()) {
          stopped = true;
          update({ loginCheckFailed: true, error: "Die automatische Anmeldeprüfung konnte nicht abgeschlossen werden. Bitte nach der Anmeldung erneut prüfen." });
        }
      } finally { checking = false; }
    };
    const timer = window.setInterval(() => { void check(); }, 2_000);
    const onFocus = () => { void check(); };
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onFocus);
    return () => { stopped = true; window.clearInterval(timer); window.removeEventListener("focus", onFocus); window.removeEventListener("online", onFocus); };
  }, [context, enabled, state.context, state.loginCheckFailed, state.loginEpoch, state.loginOpen, update]);

  // Silent re-login: Sakai ends idle sessions after an hour and the Mac sleeps overnight.
  useEffect(() => {
    if (!enabled || state.context !== context || state.connected || state.loginOpen || !state.autoLogin || state.autoLoginRejected) return;
    const epoch = generation.current;
    let checking = false;
    const isCurrent = () => generation.current === epoch && current.current.context === context;
    const check = async () => {
      if (checking || busy.current || !navigator.onLine) return;
      checking = true;
      try {
        const status = await apiSakaiStatus();
        if (!isCurrent()) return;
        update(status);
        if (!status.connected) return;
        startupPending.current = true;
        update({ error: null });
        if (!current.current.sites.length) {
          const sites = await apiSakaiSites();
          if (isCurrent()) update({ sites });
        }
      } catch {
        // The next focus, network change or interval retries; the backend enforces a cooldown.
      } finally { checking = false; }
    };
    void check();
    const timer = window.setInterval(() => { void check(); }, 60_000);
    const onActive = () => { void check(); };
    window.addEventListener("focus", onActive);
    window.addEventListener("online", onActive);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", onActive); window.removeEventListener("online", onActive); };
  }, [context, enabled, state.autoLogin, state.autoLoginRejected, state.connected, state.context, state.loginOpen, update]);

  const save = useCallback((preferences: SakaiPreferences): boolean => {
    if (!enabled || current.current.context !== context) return false;
    try {
      parseSakaiPreferences(JSON.stringify(preferences));
      localStorage.setItem(context, JSON.stringify(preferences));
      update({ preferences, hasPreferences: true, error: null });
      return true;
    } catch {
      update({ preferences: { ...preferences, autoSync: false }, hasPreferences: true, error: "Sakai-Einstellungen konnten nicht gespeichert werden. Automatik ist aus; bitte lokalen App-Speicher prüfen." });
      return false;
    }
  }, [context, enabled, update]);

  useEffect(() => {
    if (enabled && catalogReady && state.context === context && state.connected && state.setupRequested && state.sites.length
      && !state.hasPreferences && !state.initializationBlocked) {
      save({ autoSync: true, selections: defaultSelections(state.sites, notes, events), lastSync: null });
    }
  }, [catalogReady, context, enabled, events, notes, save, state.connected, state.context, state.hasPreferences, state.initializationBlocked, state.setupRequested, state.sites]);

  const run = useCallback(async (prioritySubjectKey?: string) => {
    const input = inputs.current;
    if (!enabled || !input.cfg || busy.current || !current.current.connected || !current.current.sites.length || current.current.context !== context || !current.current.preferences.selections.length) return;
    const epoch = generation.current;
    const isCurrent = () => generation.current === epoch && current.current.context === context;
    busy.current = true;
    lastAttempt.current = Date.now();
    startupPending.current = false;
    update({ busy: true, error: null, report: null, progress: "Sakai wird abgefragt …" });
    try {
      const report = await syncSakai(input.cfg, input.events, current.current.preferences.selections, {
        isCurrent,
        prioritySubjectKey,
        onProgress: (progress) => { if (isCurrent()) update({ progress }); },
      });
      if (!isCurrent()) return;
      update({ report });
      save({ ...current.current.preferences, lastSync: report.completedAt });
      inputs.current.onUpdated();
      const status = await apiSakaiStatus();
      if (isCurrent()) update(status);
    } catch (error) {
      if (!isCurrent()) return;
      update({ error: message(error), connected: String(error).includes("SAKAI_AUTH_REQUIRED") ? false : current.current.connected });
      inputs.current.onUpdated();
    } finally {
      if (isCurrent()) { lastFinished.current = Date.now(); busy.current = false; update({ busy: false, progress: "" }); }
    }
  }, [context, enabled, save, update]);

  const canAutoRefresh = useCallback(() => inputs.current.catalogReady && (inputs.current.events.length > 0
    || current.current.preferences.selections.every((selection) => selection.subjectKey === null)), []);

  useEffect(() => {
    if (enabled && canAutoRefresh() && state.context === context && state.connected && !state.busy && state.sites.length
      && state.hasPreferences && !state.initializationBlocked && state.preferences.autoSync
      && state.preferences.selections.length && startupPending.current) void run();
  }, [canAutoRefresh, catalogReady, context, enabled, events.length, run, state.busy, state.connected, state.context, state.hasPreferences, state.initializationBlocked,
    state.preferences.autoSync, state.preferences.selections, state.sites.length]);

  const refreshSubject = useCallback((subjectKey: string) => {
    const value = current.current;
    if (!enabled || !canAutoRefresh() || value.context !== context || !value.hasPreferences || value.initializationBlocked || !value.preferences.autoSync) return;
    const attempted = Math.max(lastAttempt.current, lastFinished.current, value.preferences.lastSync ? Date.parse(value.preferences.lastSync) : 0);
    if (!lastAttempt.current || Date.now() - attempted >= ACTIVE_REFRESH_INTERVAL) void run(subjectKey);
  }, [canAutoRefresh, context, enabled, run]);

  useEffect(() => {
    if (!enabled) return;
    const check = (interval: number) => {
      const value = current.current;
      const attempted = Math.max(lastAttempt.current, lastFinished.current, value.preferences.lastSync ? Date.parse(value.preferences.lastSync) : 0);
      if (canAutoRefresh() && value.context === context && value.hasPreferences && !value.initializationBlocked && value.preferences.autoSync
        && value.connected && !busy.current && Date.now() - attempted >= interval) void run();
    };
    const timer = window.setInterval(() => check(AUTO_REFRESH_INTERVAL), 60_000);
    const onActive = () => check(ACTIVE_REFRESH_INTERVAL);
    window.addEventListener("focus", onActive);
    window.addEventListener("online", onActive);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", onActive); window.removeEventListener("online", onActive); };
  }, [canAutoRefresh, context, enabled, run]);

  const beginLogin = async () => {
    if (!enabled || busy.current) return;
    const epoch = ++generation.current;
    busy.current = true;
    update({ busy: true, error: null, loginEpoch: epoch });
    try {
      await invoke("sakai_begin_login");
      if (generation.current === epoch) { startupPending.current = true; update({ connected: false, loginOpen: true, loginCheckFailed: false }); }
    } catch { if (generation.current === epoch) update({ error: "Sakai-Anmeldefenster konnte nicht geöffnet werden." }); }
    finally { if (generation.current === epoch) { busy.current = false; update({ busy: false }); } }
  };

  const connect = async () => {
    if (!enabled || busy.current) return;
    const reconnecting = !current.current.connected;
    const epoch = ++generation.current;
    busy.current = true;
    update({ busy: true, error: null });
    try {
      const status = await apiSakaiStatus("sakai_connect");
      if (generation.current !== epoch) return;
      update(status);
      if (!status.connected) throw new Error("SAKAI_AUTH_REQUIRED");
      if (reconnecting) startupPending.current = true;
      update({ connected: true, loginOpen: false, loginCheckFailed: false, setupRequested: true, initializationBlocked: false });
      const sites = await apiSakaiSites();
      if (generation.current !== epoch) return;
      update({ connected: true, loginOpen: false, sites });
    } catch (error) { if (generation.current === epoch) update({ error: message(error), connected: String(error).includes("SAKAI_AUTH_REQUIRED") ? false : current.current.connected }); }
    finally { if (generation.current === epoch) { busy.current = false; update({ busy: false }); } }
  };

  const disconnect = async () => {
    if (!enabled) return;
    const epoch = ++generation.current;
    busy.current = true;
    update({ connected: false, loginOpen: false, loginCheckFailed: false, busy: true, progress: "", report: null });
    try {
      await invoke("sakai_disconnect");
      if (generation.current === epoch) update({ rememberSession: false, persistenceError: false, autoLogin: false, autoLoginRejected: false, error: null });
    }
    catch { if (generation.current === epoch) update({ persistenceError: true, error: "Die gespeicherte Sakai-Sitzung konnte nicht vollständig gelöscht werden. Bitte „Verbindung trennen“ erneut versuchen." }); }
    finally { if (generation.current === epoch) { busy.current = false; update({ busy: false }); inputs.current.onUpdated(); } }
  };

  const setRememberSession = async (remember: boolean) => {
    if (!enabled || busy.current || current.current.loginOpen) return;
    const epoch = ++generation.current;
    busy.current = true;
    update({ busy: true, error: null });
    try {
      const status = await apiSakaiStatus("sakai_set_remember_session", remember);
      if (generation.current !== epoch) return;
      update(status);
      if (status.connected && !current.current.sites.length) {
        try {
          const sites = await apiSakaiSites();
          if (generation.current === epoch) update({ sites });
        } catch (error) {
          if (generation.current === epoch) update({ error: message(error), connected: String(error).includes("SAKAI_AUTH_REQUIRED") ? false : current.current.connected });
        }
      }
    } catch {
      if (generation.current === epoch) update({ persistenceError: true, error: "„Angemeldet bleiben“ konnte nicht geändert werden. Bitte den Schlüsselbund-Zugriff prüfen und erneut versuchen." });
    } finally { if (generation.current === epoch) { busy.current = false; update({ busy: false }); } }
  };

  const enableAutoLogin = async (eid: string, pw: string): Promise<boolean> => {
    if (!enabled || busy.current || current.current.loginOpen) return false;
    const epoch = ++generation.current;
    busy.current = true;
    update({ busy: true, error: null });
    try {
      const status = await apiSakaiEnableAutoLogin(eid, pw);
      if (generation.current !== epoch) return false;
      update(status);
      if (status.connected) {
        startupPending.current = true;
        update({ setupRequested: true, initializationBlocked: false });
        if (!current.current.sites.length) {
          const sites = await apiSakaiSites();
          if (generation.current === epoch) update({ sites });
        }
      }
      return true;
    } catch (error) {
      if (generation.current === epoch) {
        const text = String(error);
        update({ error: text.includes("SAKAI_LOGIN_REJECTED") ? "Sakai hat die Anmeldung abgelehnt. Bitte E-Mail-Adresse (z. B. ab1234@mci4me.at) und Passwort prüfen."
          : text.includes("SAKAI_LOGIN_INVALID") ? "Bitte E-Mail-Adresse und Passwort vollständig eingeben."
          : "Automatische Anmeldung konnte nicht eingerichtet werden. Bitte Verbindung und Schlüsselbund-Zugriff prüfen." });
      }
      return false;
    } finally { if (generation.current === epoch) { busy.current = false; update({ busy: false }); } }
  };

  const disableAutoLogin = async () => {
    if (!enabled || busy.current) return;
    const epoch = ++generation.current;
    busy.current = true;
    update({ busy: true, error: null });
    try {
      const status = await apiSakaiDisableAutoLogin();
      if (generation.current === epoch) update(status);
    } catch {
      if (generation.current === epoch) update({ error: "Die gespeicherten Zugangsdaten konnten nicht gelöscht werden. Bitte erneut versuchen." });
    } finally { if (generation.current === epoch) { busy.current = false; update({ busy: false }); } }
  };

  return {
    ...(enabled && state.context === context ? state : EMPTY),
    beginLogin, connect, disconnect, run, refreshSubject, setRememberSession, enableAutoLogin, disableAutoLogin,
    setSelections: (selections: SakaiSelection[]) => { if (!busy.current) save({ ...current.current.preferences, selections }); },
    setAutoSync: (autoSync: boolean) => { if (!busy.current) save({ ...current.current.preferences, autoSync }); },
  };
}
