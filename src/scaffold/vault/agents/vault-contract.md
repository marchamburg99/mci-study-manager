# Vault contract and planning

## Ownership and identity

| Information | Owner and agent action |
| --- | --- |
| Official timetable, exam details, assignment deadline | Current MCI, myMCI or Sakai source; verify before consequential planning |
| Imported sessions, IDs, generated navigation, Sakai Live notes above the `sm:sakai` marker | Studien-Manager app; read, never edit |
| Explanations, questions, summaries | Existing course or session note, or a file in the session folder |
| Learning status `vorbereitet` / `nachbereitet` and their checkboxes | User report or observed activity |
| Bibliographic metadata | Existing reference manager; otherwise one source register note |
| Assignment working files and exports | The session or course folder, linked from the assignment note |

`.mci-manager/` holds the path index, calendar and Sakai caches, history and trash.
It is app state. A newer modification time does not prove a successful sync.
Do not write there, do not edit `.obsidian/`, and do not repair the app as a side
effect of another task.

Preserve `<!-- sm:list:start -->` through `<!-- sm:list:end -->` byte for byte.
Keep `uid`, `lv`, `termin`, `typ`, `dozent`, `fach` and existing tags unchanged
unless the user asks for a specific correction. Match a session by `uid` and a course
by `lv` plus semester; course names and numeric folder prefixes can disagree.
Before creating a note, search for an existing one with the same `uid`, `lv` or
title. Never create session notes yourself; the app creates them from the timetable.

Imported PDFs under `Studium/Quellen/` are immutable originals named by content hash.
Find the right PDF through the Sakai Live note that links it. Write excerpts and
summaries as separate notes that link the PDF.

## Dates and requirements

Record a consequential date with source, retrieval date, document version, cohort
or group and certainty: `confirmed`, `user_reported`, `unverified` or `conflicting`.
A newer generic document does not override a specific personal decision; preserve
both values while a conflict remains. A date-only deadline has unknown time, not
23:59. Use `Europe/Vienna` for local plans. General resit windows are not personal
exam appointments. Do not correct implausible years or transfer another cohort's
deadlines silently.

## A useful plan

Reuse existing tasks before creating new ones. Each task needs a course or
assignment link, a concrete output, a next action, an effort estimate and its
dependencies. Distinguish hard deadlines from self-chosen work dates. Prioritize
deadline risk, assessment weight, prerequisite gaps and observed difficulty.
Leave visible buffer and expose overload instead of filling every free minute.
Save a plan only when requested or needed for ongoing work, using the
[study-plan template](../../00-system/templates/agent/study-plan.md).

Done: each task traces to a real need, fits the stated capacity and has a next
action. A file edit proves no calendar, reminder or Sakai change.
