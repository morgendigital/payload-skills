---
name: payload-seitenanalyse
description: Analysiert ein komplettes Website-Design in Figma und leitet daraus einen Umsetzungsplan mit Payload-Collections, Blocks und einzelnen Linear-Tickets ab. Nur für Payload-Projekte. Auslöser sind Aufträge wie "analysiere das Design", "plane die Umsetzung", "leite Tickets ab" oder "welche Blocks brauchen wir".
---

# Seitenanalyse für Payload-Projekte

Gilt nur, wenn das Projekt Payload einsetzt (payload.config.ts vorhanden oder
im Ticket genannt). Sonst nicht anwenden.

## Ablauf

### 1. Vollständig erfassen
Alle Screens der maßgeblichen Figma-Page holen, nicht eine Auswahl. Erst den
Index über `?depth=2`, dann jeden Frame einzeln mit dem Fetch-Skript.
Welche Page maßgeblich ist, steht im Ticket — steht nichts da, die zuletzt
angelegte annehmen und diese Annahme im Kommentar festhalten.

### 2. Wiederholungen finden
Über alle Screens hinweg vergleichen, welche Abschnitte mehrfach vorkommen.
Das sind die Blocks. Ein Abschnitt, der nur einmal auftritt, ist erst dann ein
eigener Block, wenn er inhaltlich pflegbar sein muss.

Für jeden Block festhalten: Name, auf welchen Screens er vorkommt, welche
Felder er braucht, welche Varianten es gibt.

### 3. Collections ableiten
Was ist wiederkehrender Inhalt mit eigener Struktur (Team-Mitglieder,
Leistungen, Standorte, Beiträge)? Das wird eine Collection, kein Block-Feld.
Was ist einmalig pro Seite? Das gehört in die Page-Blocks.
Was ist global (Kontaktdaten, Öffnungszeiten, Navigation)? Das wird ein Global.

### 4. Plan schreiben
Als `docs/UMSETZUNGSPLAN.md` im Repo:
- Übersicht aller Screens mit Node-IDs
- Collections und Globals mit Feldern
- Blocks mit Feldern, Varianten und Vorkommen
- Welche Plugins nötig sind (Formulare, SEO, Redirects, Suche)
- Reihenfolge der Umsetzung mit Abhängigkeiten
- Offene Punkte

### 5. Tickets anlegen
Über den Linear-MCP, im selben Team wie das auslösende Ticket, Status Backlog.
Reihenfolge: erst Collections und Globals, dann Blocks, dann Seiten.
Ein Ticket pro Block, ein Ticket pro Seite. Nicht bündeln.

Jedes Ticket im Projektformat:

    repo: <owner/name>
    figma: <link mit node-id>
    route: <pfad oder ->

    auftrag:
    <konkret, ein Block oder eine Seite>

    kriterien:
    - <prüfbare Punkte>

Abhängigkeiten über Linear-Relations abbilden, nicht im Text beschreiben.

## Rückfragen
Nie auf Antwort warten. Offene Punkte als Kommentar ins auslösende Ticket
schreiben, eine Liste, jede Frage mit der Annahme, die du vorläufig getroffen
hast. Die Umsetzung geht auf Basis dieser Annahmen weiter.

## Grenzen
- Keine Screens umsetzen, nur planen
- Figma-Exporte nicht committen
- Keine Tickets in anderen Teams anlegen
