---
name: unterricht-startet
description: "Unterricht startet: evaluate the student's saved quizzes from earlier lessons of the same subject and prepare the upcoming lesson around remaining learning gaps. Trigger when the student says Unterricht startet or asks for the next lesson's preparation from their quiz results."
---

# Unterricht startet

Locate the actual study vault; the chat's working folder may be its parent.
Use the vault root as `--vault` and read its study and learning rules.
Resolve the upcoming lesson's exact UID, subject key, semester, start timestamp
and reserved session path from the current context and the read-only app index.
Ask which lesson only if the context is ambiguous. Preserve the existing course
and session folders, app-owned state and student notes.
If the index reserves the selected session but its directory is not materialized,
create only that exact directory for the preparation artifacts. The app alone
creates the main session note; never modify the path index.

## Evaluate the earlier attempts

Use the [lesson bridge](../unterricht-vorbei/scripts/notebooklm_bridge.py) without
a network call or Google login:

```text
python3 .agents/skills/unterricht-vorbei/scripts/notebooklm_bridge.py review
  --vault /absolute/study-vault
  --session Semester/subject/upcoming-session
  --uid EXACT_SESSION_UID --subject-key EXACT_SUBJECT_KEY
  --before 2026-10-30T09:00:00+01:00
```

Substitute the actual start time including its UTC offset. The bridge selects
earlier quiz attempts in the same semester and subject, including other course
types. It recomputes correct/incorrect answers from each quiz and the latest
completed attempt before this lesson. Scores stored by another agent are not
evidence. A pending quiz has no result: name it as untested, never as failed.
If no attempts exist, use a short diagnostic question; invent no learning gaps.
If a result is invalid or mismatched, stop that evaluation and report the file
that needs inspection without editing or discarding student answers.

## Prepare the next lesson

1. Read the missed questions, their explanations and the original source pages.
   Cluster the observed mistakes into concrete concepts or skills. Distinguish
   a likely misconception from a confirmed one; a single answer does not establish
   mastery of a whole topic. Use recent successes to adjust priorities without
   erasing the earlier evidence.
2. Write or update `Lernrueckblick.md` in the upcoming session folder. Link the
   previous lessons and their actual attempt dates. Record observed scores,
   remaining gaps, untested units and one next exercise per priority topic.
   Preserve student additions and use actual wikilinks from the main session
   note, outside generated regions. Never modify the quiz answer records.
3. Write or update `Vorbereitung.md` in the same folder: a short recap, two or
   three targeted retrieval/application questions with changed examples, source
   links and what to listen for in the upcoming lesson. Keep solutions separate
   so the student can attempt the questions first. Prefer the weakest prerequisite
   for the upcoming material; avoid repeating the entire course summary.
4. During an interactive session let the student attempt the first targeted
   question before explaining it. Record needed help and the observed next step
   in the optional learning-review note. Leave `vorbereitet` and `nachbereitet`
   to actual student reports or explicit status requests.

## Done

The upcoming lesson contains a linked, source-grounded recap and a concrete next
exercise based on actual saved attempts, or explicitly says no attempt exists.
Tell the student the highest-priority gap and the first question. At lesson end,
[Unterricht vorbei](../unterricht-vorbei/SKILL.md) carries the observed gaps into
the next summary and NotebookLM quiz, closing the cycle.
