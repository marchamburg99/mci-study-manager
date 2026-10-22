# MCI Studien-Manager

Lokale Desktop-App (Tauri) für Management, Kommunikation & IT am MCI Innsbruck.
Abonniert den Stundenplan per iCal, öffnet je nach Zeit das passende Fachfenster
mit Drag&Drop für Docs und Markdown-Notizen — abgelegt in einer sauberen
Ordnerstruktur unter `~/MCI/Sem01-MCiT26-IM/`.

## Start

### Eigenständige Mac-App

Die installierte App liegt unter `/Applications/study-manager.app` und startet
per Doppelklick oder Spotlight. Sie enthält die Oberfläche und das Rust-Backend;
Node, Rust, ein Terminal und ein Entwicklungsserver werden zum Benutzen nicht
benötigt. Neue Stundenplan- und Sakai-Inhalte benötigen eine Internetverbindung;
bereits gespeicherte Inhalte bleiben offline lesbar.

Zum erneuten Erstellen auf diesem Apple-Silicon-Mac:

```bash
APPLE_SIGNING_IDENTITY="-" npm run tauri build -- --bundles app,dmg
```

Die `.app` liegt danach unter `src-tauri/target/release/bundle/macos/`, die
Installationsdatei unter `src-tauri/target/release/bundle/dmg/`. `npm run build`
allein aktualisiert keine installierte Mac-App. Vor dem Ersetzen die laufende App
beenden und die bisherige `.app` sichern. Vault und App-Daten nicht löschen.
Der lokale Build ist nicht für eine notarisierte Veröffentlichung vorgesehen.
Die App enthält keine persönlichen Zugangsdaten. Beim ersten Start öffnen sich die
Einstellungen; dort trägt jede Person ihren eigenen Kalender-Abo-Link und ihren
Studienordner ein. Die Sakai-Anmeldung bleibt ebenfalls lokal auf dem eigenen Mac.

### Installation für Mitstudierende (MCiT)

1. Die `.dmg` öffnen und `study-manager` in den Programme-Ordner ziehen.
2. Weil die App nicht von Apple notarisiert ist, blockiert macOS den ersten Start.
   Einmalig im Terminal ausführen:
   `xattr -dr com.apple.quarantine /Applications/study-manager.app`
3. App starten, in den Einstellungen den eigenen Kalender-Link des MCI-Stundenplans
   einfügen, Studienordner wählen und speichern.

Der Build läuft nur auf Macs mit Apple Silicon (M1 und neuer).

### Sakai-Wissen in der App

Das Fach bündelt Sakai-Informationen, Materialien, Zusammenfassungen und ergänzende
Notizen aus seinen Einheiten. „Studienwissen“ ist die Gesamtübersicht derselben
Originaldateien. Die App liest `Studium/*.md` sowie Markdown-Dateien direkt in den
bekannten Fach- und Terminordnern des aktuellen Semesters. Fachübersichten und die
Hauptnotizen der Termine erscheinen nicht als zusätzliche Wissensnotizen; die
Terminnotizen bleiben über „Einheiten & Notizen“ im Fach erreichbar. UE und VO
verwenden die gemeinsame Fachzuordnung, auch bei getrennten alten Terminordnern.
Bereits im Terminpfad-Index erfasste Einheitsordner bekannter Fächer werden weiterhin
eingelesen, wenn der Termin nicht mehr im Kalender steht.

Notizen in Fach- oder Terminordnern gehören zum jeweiligen Fach. Für Notizen unter
`Studium/` werden `fach` (Fachname) und `lv` (LV-Nummer) aus dem Frontmatter ausgewertet,
wenn sie ein Fach eindeutig bestimmen. Widersprüchliche oder mehrdeutige Angaben
werden gemeldet und nicht geraten. Ein ausdrücklich angegebenes anderes `semester`
wird nicht dem aktuellen Fach zugeordnet. Es werden keine Dateien verschoben oder
kopiert. Der bisherige Pfad `Fachname - Sakai.md` bleibt unterstützt.

Die Leseansicht bietet Volltextsuche, Bereichsfilter, Quellenstand und Jahrgang.
Fachnotizen zeigen ihre Zuordnung und bieten „Zum Fach“. Wikilinks öffnen geladene
Wissensnotizen oder die passende Terminnotiz in der App. Dokumente in bekannten
Termin-`docs/`-Ordnern, etwa Präsentationen, und Original-PDFs unter `Studium/Quellen/`
öffnen sich im Standardprogramm. „Originalnotiz öffnen“ verwendet das für Markdown
konfigurierte Programm, üblicherweise Obsidian. Beim Lesen schreibt die App keine
Wissensnotizen und verändert keine Lernstatus-Kästchen.
Änderungen aus Obsidian werden beim Fensterfokus, alle 30 Sekunden oder mit
„Vault neu einlesen“ sichtbar. Fehlerhafte Dateien werden einzeln gemeldet.

### Direkter Sakai-Sync

Unter „Studienwissen“ → „Bei Sakai anmelden“ öffnet sich ein separates, privates
Sakai-Fenster. Dort selbst anmelden; die App prüft die Anmeldung automatisch und
schließt das Fenster nach erfolgreicher Übernahme. Apple AutoFill ist über das
Kontextmenü der Eingabefelder erreichbar. Scheitert die automatische Prüfung,
erscheint „Anmeldung erneut prüfen“. Anschließend die vorgeschlagene Kursauswahl und
Fachzuordnung prüfen und „Jetzt abrufen“ wählen. Bekannte Quellen aus den bisherigen
Wissensnotizen werden vorgeschlagen; weitere Sites lassen sich auswählen und einem
Fach oder „Studium“ zuordnen. UE und VO mit gleicher Fachzuordnung erhalten eine
gemeinsame Live-Notiz. Auswahl und Automatik gelten je Vault und Semester.

Die aktivierbare Automatik ruft nach dem App-Start und erfolgreicher Anmeldung sofort
ab und aktualisiert danach alle fünf Minuten. Beim Zurückwechseln zur App, nach
Wiederherstellung der Verbindung und beim Öffnen eines Fachs wird nachgeholt, sobald
der letzte Abruf mindestens eine Minute zurückliegt. Das geöffnete Fach und Fächer
mit heutigen Terminen werden zuerst verarbeitet. Die App muss geöffnet und bei
Sakai angemeldet sein. Das Passwort wird ausschließlich auf der Sakai-Seite eingegeben;
die App übernimmt keine Chrome-Cookies. Ohne die optionale Einstellung „Auf diesem
Mac angemeldet bleiben“ bleibt die Sitzung nur im Arbeitsspeicher. Mit der Option
speichert die App ihre Sakai-Sitzung im lokalen macOS-Schlüsselbund, nicht das Passwort.
Diese Einstellung gilt für die App auf diesem Mac, nicht pro Vault. Beim Neustart
wird eine gespeicherte Sitzung erst bei Sakai geprüft. Die Wiederherstellung ist
auf höchstens 30 Tage nach Anmeldung begrenzt; Sakai kann die Sitzung früher beenden. Bei Netzwerk-
oder Schlüsselbund-Problemen wird keine erfolgreiche Anmeldung vorgetäuscht.

Das Abschalten von „Angemeldet bleiben“ entfernt die gespeicherte Sitzung; die
laufende Verbindung bleibt bis zum Beenden oder Ablaufen nutzbar. „Verbindung trennen“
entfernt zusätzlich die laufende Sitzung und stoppt weitere Import-Schritte. Beide
Aktionen sperren die Wiederherstellung, bevor der Schlüsselbund-Eintrag gelöscht wird.
Ein fehlgeschlagener Löschzugriff wird sichtbar gemeldet und kann wiederholt werden.
Nur eine laufende App-Instanz darf die gespeicherte Sitzung verwalten. Wird eine
zweite Instanz gestartet, bleibt dort diese Funktion mit einem Speicherhinweis gesperrt.
Die bereits gespeicherten Inhalte im Vault und Anmeldungen anderer Browser bleiben
unberührt. Die App liest keine Einträge aus Apple „Passwörter“ aus; sie verwendet
einen eigenen Schlüsselbund-Eintrag ausschließlich für ihre Sakai-Sitzung.

Importiert werden Kursübersichten, verfügbare Lessons, Ankündigungen der letzten
365 Tage und Ressourcenlisten der ausgewählten Sites. Die separate Seiten- und
Werkzeugliste bestimmt, ob ein Kurs Lessons anbietet; ohne dieses Werkzeug entfällt
der Lessons-Abruf. Der Import liest ausschließlich
festgelegte Sakai-Schnittstellen; keine Nachrichten, Teilnehmendenlisten, Noten,
Aufgabenabgaben oder externen myMCI-/Study-&-Learn-Inhalte. Insbesondere der
Assignments-Endpunkt bleibt aus, weil er auch Abgabe- und Bewertungsdaten liefert.
Es werden weder Abgaben noch Nachrichten versendet. Es findet keine automatische
Zusammenfassung, PDF-Texterkennung oder Prüfung auf persönliche Geltung statt.

„Sakai Live“-Notizen liegen separat unter `Studium/` mit Semester und stabiler Kennung
im Dateinamen. Die App ordnet sie über `sakai_subject_key` den vorhandenen Fächern zu
und blendet Live-Notizen anderer Semester aus. Bisherige Zusammenfassungen,
Terminnotizen, Fachübersichten und der Terminpfad-Index werden nicht geändert.
Im Fach und in der Fachübersicht stehen die aktuellen Sakai-Unterlagen vor eigenen
Zusammenfassungen. Dateien und Präsentationen sind direkt erreichbar; Einleitung,
Lerninhalte und Ankündigungen lassen sich dort aufklappen. „Sakai aktualisieren“
ruft den aktuellen Stand ab und verarbeitet dieses Fach zuerst. Hinweise und Fehler
zum Abruf bleiben sichtbar, gespeicherte Inhalte auch ohne Sakai-Verbindung lesbar.
Schlägt der Abruf eines Fachs fehl, erscheint dort ein direkter Hinweis auf den alten
gespeicherten Stand; die Fehlerdetails nennen Kursquelle und betroffenen Abrufbereich.
Eigene Ergänzungen gehören unter „Persönliche Notizen“ am Ende der Live-Notiz.
Der automatisch erzeugte Bereich davor ist durch eine Prüfsumme geschützt: Nach
manuellen Änderungen wird die Datei als Konflikt übersprungen, nicht überschrieben.
Für die Wiederaufnahme zuerst eigene Änderungen separat sichern und den automatisch
erzeugten Bereich aus einer vorherigen Version wiederherstellen. Den `sm:sakai`-Marker
nicht unabhängig vom zugehörigen Text bearbeiten. Frühere geschriebene Versionen
liegen im bestehenden Vault-Verlauf unter `.mci-manager/history/`.

PDFs bis 15 MiB werden unter `Studium/Quellen/Sakai-<SHA256>.pdf` unveränderlich
gespeichert und in der Live-Notiz verlinkt. Gleiche Bytes erzeugen dasselbe Original,
geänderte PDFs eine neue Datei. Andere Formate und zu große PDFs bleiben Weblinks.
Ein Abruf arbeitet alle geeigneten PDFs automatisch in aufeinanderfolgenden Paketen
mit höchstens 25 Download-Versuchen und 100 MiB ab. Der Fortschritt zeigt die bereits
gespeicherten PDFs. Jedes Paket reserviert vor einer Datei deren erlaubte 15 MiB;
erfolgreiche Downloads zählen anschließend mit ihrer tatsächlich empfangenen Bytezahl,
fehlgeschlagene Downloads bleiben mit dem reservierten Maximum angerechnet. Zwischen
Paketen wird der Cache gesichert. Pro Abruf wird dieselbe PDF nicht wiederholt versucht;
fehlgeschlagene Downloads werden erst beim nächsten Abruf erneut berücksichtigt. Wiederholte
PDF-Hinweise werden nach Ursache zusammengefasst. Der Cache `.mci-manager/sakai-<Semesterhash>.json` enthält
Quellenadressen und PDF-Metadaten, keine Anmeldedaten. Bei Fehlern oder unvollständigen
Quellantworten bleibt der bisherige Wissensstand erhalten und die App meldet Hinweise.
Abgewählte Sites und bereits heruntergeladene PDFs werden nicht automatisch aus dem Vault gelöscht.

Der Stundenplan-Sync bleibt unabhängig. „Sakai öffnen“ öffnet weiterhin den normalen
Browser. `abgerufen: "2026-09-22"` bezeichnet den Quellenabruf, nicht das lokale Einlesen.
Optional zeigen `quellenstand`, `geltung` und `jahrgang` die Herkunft genauer an.
Ein Prozess-PDF für einen älteren Jahrgang wird durch einen neuen Abruf nicht zu einer
bestätigten Vorgabe für den eigenen Jahrgang.

### Bestätigte Hinweise auf „Heute“

„Heute“ zeigt unter „Prüfungen & Abgaben“ die nächsten bestätigten Prüfungen und
Abgaben des aktuellen Semesters, auch mehr als 14 Tage im Voraus. Zunächst sind
fünf Einträge sichtbar; die übrigen lassen sich direkt aufklappen. Ein Klick auf
einen Eintrag öffnet die vollständige Quellnotiz. Allgemeine Sakai-Hinweise zeigen
weiterhin die nächsten 14 Tage. Termine werden weder aus Fließtext erraten noch
in den Kalender kopiert.
Ein Hinweis benötigt eine stabile `id`, `titel`, `art` (`termin`, `frist` oder
`hinweis`), einen `zeitpunkt` mit Zeitzone, `bestaetigt: true` und eine `quelle`,
die in `source_urls` oder `source_url` derselben Notiz steht. Beispiel-Frontmatter:

```yaml
abgerufen: "2026-09-22"
jahrgang: 2026
source_urls:
  - "https://example.test/ankuendigung"
hinweise:
  - id: "einfuehrung"
    titel: "Einführung"
    art: "termin"
    zeitpunkt: "2026-09-28T08:45:00+02:00"
    bestaetigt: true
    quelle: "https://example.test/ankuendigung"
```

Prüfungen und Abgaben erhalten zusätzlich `bereich: pruefung` sowie `art: termin`
oder `art: frist`. Ihre Notiz benötigt `pruefungssemester` mit dem konfigurierten
Semester-Ordnernamen; `gruppe` und `jahrgang` werden zur Einordnung angezeigt.
Ist die Uhrzeit unbekannt, wird statt `zeitpunkt` ein `datum: "2027-01-12"`
verwendet. Ein Prüfungsfenster kann dazu `bis: "2027-01-13"` enthalten. Diese
Einträge bleiben bis zum Ende des betreffenden Tages bzw. Fensters sichtbar,
ohne eine Uhrzeit vorzutäuschen. `detail` kann auf eine noch offene persönliche
Einteilung hinweisen. Unbestätigte oder widersprüchliche Daten bleiben ausgeschlossen.

Hinweise zeigen den Jahrgang der Notiz an; sie werden nicht automatisch als
persönliche Anmeldung gewertet. Vergangene Hinweise verschwinden aus „Heute“,
bleiben aber in der Originalnotiz erhalten. Eine leere Liste bedeutet nicht,
dass in Sakai keine neuen Meldungen existieren. Maximal 200 Notizen mit je
512 KiB werden geladen; unlesbare oder ungültige Hinweise werden nicht als
bestätigte Termine angezeigt.

### Entwicklungsmodus

```bash
cd study-manager
npm install
npm run tauri dev
```

Voraussetzungen: Node 20.19+ oder 22.12+, Rust stable (`rustup`). Beim ersten Start
lädt die Desktop-App den Stundenplan automatisch. Unter Einstellungen lassen sich
HTTPS-/Webcal-Adresse, Semester und Sync-Intervall ändern. Andere Vault-Ordner
müssen einmal über die native Ordnerauswahl freigegeben werden.

Während die App geöffnet ist, prüft sie jede Minute, beim Fensterfokus und nach
Wiederherstellung der Verbindung, ob ein Sync fällig ist. Bei Downloadfehlern
bleibt der zuletzt gespeicherte Plan verfügbar. Ein anderer Feed oder ein anderes
Semester verwendet einen eigenen Cache. Beschädigte Einstellungen stoppen den
automatischen Start, bis sie korrigiert wurden.
Der frühere gemeinsame `calendar.ics`-Cache wird nicht automatisch übernommen,
weil seine Quelle nicht sicher zugeordnet werden kann. Beim ersten Start nach
diesem Update ist deshalb eine Verbindung zum Kalender nötig.

## Ablage (`~/MCI/` ist direkt ein Obsidian-Vault)

```
~/MCI/
  README.md                <- Dashboard (Dataview: vorbereiten/nachbereiten)
  00-system/templates/     <- Notiz-Vorlagen (nur angelegt, nie überschrieben)
  .obsidian/app.json       <- Minimal-Config (nur angelegt, .mci-manager excludet)
  Sem01-MCiT26-IM/
    .mci-manager/event-paths.json <- Dauerhafte UID-Zuordnung, Dateinamen und reservierte Pfade
    _Semester.md           <- MOC: alle Fächer + offene Termine
    09-databases-ilv/
      Databases.md         <- MOC: alle Termine, offene Fragen, Prüfungsthemen
      2026-10-05_databases-ilv/
        2026-10-05 0900 Databases.md <- Notiz (Frontmatter: vorbereitet/nachbereitet)
        docs/              <- Drag&Drop landet hier (+ ![[docs/…]]-Verweis)
  .mci-manager/
    calendar-<hash>.ics     <- Cache je Feed und Semester (keine URL im Dateinamen)
    history/<revision>/    <- Vorherige Dateistände mit ursprünglichem Pfad
    trash/<revision>/      <- Entfernte Dateien mit ursprünglichem Pfad
```

Regeln: Die Terminnotiz ist die einzige Wahrheit für Status.
`vorbereitet` ⟺ alle Kästchen unter `## Vorbereitung` abgehakt (ebenso
Nachbereitung). Ohne Kästchen gilt das Frontmatter-Feld. Beim Speichern in der App
werden die Felder mit den Kästchen abgeglichen. Bei Änderungen direkt in Obsidian
liest die App den Status aus den Kästchen; eine reine Dataview-Frontmatter-Abfrage
sieht den angeglichenen Wert erst nach dem nächsten Speichern durch die App.
Fremde YAML-Felder und Kommentare bleiben erhalten; fehlerhaftes Frontmatter
wird nicht überschrieben. Fachübersichten und
`_Semester.md` aktualisiert die App nur zwischen den `sm:list`-Markern;
eigene Abschnitte bleiben unangetastet. Externe Änderungen erkennt die
Fachansicht per Datei-Check (Intervall + Fenster-Fokus) und fragt bei
Konflikten, statt still zu überschreiben. Auch Speichern und Statuswechsel prüfen
den zuletzt gelesenen Dateistand. Neue Notizen werden mit „Notiz anlegen“ erstellt;
eine fehlende bestehende Datei wird nicht still neu angelegt.

Eine vollständig leere Datei am exakt indizierten Terminpfad gilt als Platzhalter:
Sie blockiert die Stundenplansynchronisation nicht und kann über „Notiz anlegen“
mit dem zugehörigen Termin initialisiert werden. Die Datei muss beim Schreiben
weiterhin leer sein. Dateien mit Inhalt ohne passende UID bleiben gesperrt.

Neue Semesterübersichten verlinken die Vault-Startseite, neue Fachübersichten
das Semester und neue Terminnotizen die kanonische Fachübersicht. Zusammenfassungen,
Lernpräsentationen und Aufgaben einer Einheit gehören in deren Terminordner und
werden von der Terminnotiz aus mit echten Wikilinks verknüpft. Metadaten wie `fach`
oder `termin` ersetzen diese Links im Obsidian-Graphen nicht. Sakai-Live-Notizen
verlinken beim Abruf vorhandene Fach- und Semesterübersichten; allgemeine Sites
zusätzlich das vorhandene Studienwissen. Diese Navigation gehört zum geschützten
generierten Bereich, persönliche Ergänzungen bleiben erhalten.

Einmal zugeordnete Terminpfade bleiben bei Verschiebungen und Feed-Löschungen
reserviert. Neue Fächer nummerieren vorhandene Ordner nicht um. Bestehende Notizen
werden über ihre UID übernommen, nicht verschoben. Dateinamen bleiben auch bei
späteren Titel- oder Terminänderungen stabil. Fächer werden pro Semester über
LV-Nummer und Lehrform zusammengefasst, nicht nach Dozent. Ohne LV-Nummer gelten
normalisierter Fachname und Lehrform. Selbststudium gehört zum jeweiligen Fach;
der ursprüngliche Termintitel bleibt erhalten. Bei widersprüchlichen UIDs
oder manuell verschobenen bereits indizierten Notizen stoppt die Zuordnung mit
einer Fehlermeldung. Den Index deshalb zusammen mit dem Vault sichern.

Anerkannte oder anderweitig ausgeschlossene Fächer lassen sich je Semester in
`<Semester>/.mci-manager/excluded-subjects.json` aus dem aktiven Stundenplan und
den Fachübersichten ausblenden:

```json
{"version":1,"subjectKeys":["lv-0123456789abcdef0123456789abcdef"],"sakaiSiteIds":["example-course"]}
```

`subjectKeys` enthält die stabilen Fachschlüssel aus `subjects` im Terminpfad-Index,
`sakaiSiteIds` die Sakai-Site-Kennungen aus der Kursadresse. Beide Listen dürfen
leer sein. Der Sakai-Sync überspringt Auswahlen mit einem ausgeschlossenen
Fachschlüssel oder einer ausgeschlossenen Site, auch ohne Fachzuordnung.
Notizen, Dokumente, reservierte Terminpfade und der vollständige Kalendercache
bleiben erhalten. Eine fehlende Datei bedeutet keine Ausschlüsse; eine beschädigte
oder unlesbare Datei stoppt den Abruf mit einem Fehler. Zum Wiederaufnehmen die
Einträge entfernen und den Stundenplan erneut synchronisieren.

Ungespeicherte Eingaben werden sofort als lokale App-Entwürfe gesichert und beim
erneuten Öffnen desselben Termins wiederhergestellt. „Sichern“ oder Cmd/Ctrl+S
schreibt sie in die Terminnotiz. Entwürfe sind an Vault, Semester und Termin gebunden,
liegen noch nicht in Obsidian und sind kein Ersatz für ein Backup. App-Daten nicht
löschen, bevor alle Entwürfe gespeichert sind. Bei vollem oder gesperrtem
Entwurfsspeicher warnt die App und schützt den Ansichtswechsel.

Dateien lassen sich per nativem Drag & Drop oder „Dateien auswählen“ importieren.
Bestehende Dateien werden nicht überschrieben. Entfernen verschiebt sie in den
Vault-Papierkorb, nicht in den Systempapierkorb. Zum Wiederherstellen die Datei
aus `trash/<revision>/` an den dort abgebildeten ursprünglichen Pfad kopieren.
Analog lassen sich frühere Notizstände aus `history/<revision>/` zurückholen.
History und Papierkorb werden nicht automatisch bereinigt und ersetzen kein
externes Backup. Gleichzeitige Schreibzugriffe anderer Programme sind trotz
Konfliktprüfung nicht vollständig atomar gegeneinander abgesichert.

Gespeicherte Notizen und Dateien sind unabhängig von der App lesbar. Für eine
Neuinstallation zuerst alle Entwürfe sichern und den gesamten Vault inklusive
versteckter `.mci-manager`-Ordner sichern.

Bestehende `notes.md` bleiben bis zu einer ausdrücklichen Migration lesbar.
Der Pfadindex verwendet ab Version 0.2.1 Format 2; ältere App-Versionen können
diesen nicht lesen. Vor einem Downgrade den vollständigen vorherigen Vault-Stand
wiederherstellen, nicht nur den Index. Fach- und Notizdateien nicht unabhängig
vom Index manuell umbenennen.

### Bestehenden Vault migrieren (lokale Wartung)

`scripts/migrate-vault.mjs` benötigt Node mit nativer TypeScript-Unterstützung;
die installierte Desktop-App benötigt weiterhin kein Node. Der Standardlauf ist
rein lesend:

```bash
node scripts/migrate-vault.mjs --vault /absoluter/Vault --semester Sem01 --calendar /absoluter/Kalender.ics --dry-run
```

Zum Anwenden beide Apps schließen und `--dry-run` durch
`--apply --backup /absolutes/neues/Backup` ersetzen. Das Backup muss außerhalb
des Vaults liegen. Der Lauf sichert den kompletten Vault unter `original/`,
archiviert ersetzte Dateien und prüft die geschriebenen Bytes. Bei Abbruch nicht
blind erneut starten: `plan.json` und `journal.jsonl` im Backup prüfen. Zur
Wiederherstellung den betroffenen Vault zuerst separat sichern und den gesamten
Stand aus `original/` verwenden, einschließlich des damaligen Pfadindexes.

## Befehle

- `npm run dev` — nur Frontend im Browser (ohne Datei-Zugriff)
- `npm run tauri dev` — volle Desktop-App
- `npm run build` — Frontend-Build (`tsc` + `vite build`)
- `npm run typecheck` und `npm run lint` prüfen TypeScript und React-Regeln
- `npm test` führt die Regressionstests aus (`TZ=UTC npm test` prüft Zeitzonenunabhängigkeit)
- `cd src-tauri && cargo test` prüft Dateischutz, Konflikte und Kalender-Validierung mit temporären Testdaten
- `npm run tauri build` — Release-Bundle (`.dmg`)

Im Browser zeigt `npm run dev` nur die Vorschau. Native Dateidialoge, Drag & Drop
und der Finder-/Dokumentaufruf müssen zusätzlich in der Desktop-App getestet werden.
