import { useCallback, useEffect, useRef, useState } from "react";
import type { AppConfig, StudyEvent } from "../lib/types";
import { loadLearningQuiz, saveLearningAttempt, type LearningSnapshot } from "../lib/learningStorage";
import { isConflictError } from "../lib/storage";

const empty: LearningSnapshot = { quiz: null, record: null, quizRaw: null, recordRaw: null };

export function useLearningQuiz(cfg: AppConfig, event: StudyEvent) {
  const key = JSON.stringify([cfg.basisPfad, cfg.semester, event.uid, event.fachKey, event.terminRel]);
  const [state, setState] = useState({ key, snapshot: empty, loading: true, saving: false, error: null as string | null });
  const current = useRef<{ key: string; request: number; saving: boolean; snapshot: LearningSnapshot } | null>(null);
  const refresh = useCallback(async () => {
    const scope = current.current;
    if (!scope || scope.key !== key || scope.saving) return;
    const request = ++scope.request;
    try {
      const snapshot = await loadLearningQuiz(cfg, event);
      if (current.current !== scope || request !== scope.request) return;
      scope.snapshot = snapshot;
      setState({ key, snapshot, loading: false, saving: false, error: null });
    } catch (error) {
      if (current.current !== scope || request !== scope.request) return;
      setState((old) => ({ ...old, key, snapshot: old.key === key ? old.snapshot : empty, loading: false, error: isConflictError(error)
        ? "Die Ergebnisse wurden extern geändert. Bitte neu laden."
        : error instanceof Error ? error.message : "Das Lernquiz konnte nicht gelesen werden. Bitte erneut laden." }));
    }
  }, [cfg, event, key]);

  useEffect(() => {
    const scope = { key, request: 0, saving: false, snapshot: empty };
    current.current = scope;
    queueMicrotask(() => { void refresh(); });
    const onFocus = () => { void refresh(); };
    const timer = window.setInterval(onFocus, 30_000);
    window.addEventListener("focus", onFocus);
    return () => {
      if (current.current === scope) current.current = null;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [key, refresh]);

  const submit = useCallback(async (answers: Record<string, number>): Promise<boolean> => {
    const scope = current.current;
    if (!scope || scope.key !== key || scope.saving) return false;
    scope.saving = true;
    ++scope.request;
    setState((old) => ({ ...old, saving: true, error: null }));
    try {
      const snapshot = await saveLearningAttempt(cfg, event, scope.snapshot, answers);
      if (current.current !== scope) return false;
      scope.snapshot = snapshot;
      setState({ key, snapshot, loading: false, saving: false, error: null });
      return true;
    } catch (error) {
      if (current.current !== scope) return false;
      setState((old) => ({ ...old, saving: false, error: isConflictError(error)
        ? "Die Ergebnisse wurden extern geändert. Bitte neu laden und erneut abschließen. Deine Antworten bleiben erhalten."
        : error instanceof Error ? error.message : "Deine Antworten konnten nicht gespeichert werden. Bitte erneut versuchen." }));
      return false;
    } finally {
      scope.saving = false;
    }
  }, [cfg, event, key]);

  const visible = state.key === key ? state : { key, snapshot: empty, loading: true, saving: false, error: null };
  return { quiz: visible.snapshot.quiz, record: visible.snapshot.record, loading: visible.loading,
    saving: visible.saving, error: visible.error, refresh, submit };
}
