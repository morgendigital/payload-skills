# Inhalte übersetzen — Übersetzungen per Script in die Locales schreiben

Erfahrungen aus dem ersten Übersetzungs-Durchlauf (DE → EN/IT) bei Gruberwirt, Payload 3.90.2,
MongoDB, `localization` mit `fallback: true`, Pages mit Drafts + Autosave, **ohne**
`localizeStatus`. Übersetzt wurde ohne DeepL/Plugin: Export aller lokalisierten Felder als JSON →
übersetzen → Review-Seite (DE | EN | IT) → Import per Local API, erst als Dry-Run.

Für den Übersetzen-Button im Admin (`@payload-enchants/translator`) siehe
[translator-plugin](../translator-plugin/description.md) — dort steckt auch eine Sicherheitslücke.

Zwei Fallen, beide im Payload-Code nachgeprüft (Pfade unten beziehen sich auf
`node_modules/payload/dist`, Version 3.90.2). Beide fallen im Dry-Run und beim Speichern als Draft
**nicht** auf — erst beim Veröffentlichen.

## 1. Nach `publishSpecificLocale` meldet `draft: true` den Status `draft`

### Problem

Ein Script veröffentlicht EN mit `publishSpecificLocale: 'en'` und will danach IT veröffentlichen
— aber nur für Seiten, die auf Deutsch schon live sind. Die Prüfung
`findByID({ draft: true, locale: 'de' })._status === 'published'` war vor dem EN-Durchlauf
`true`, danach `false`. Folge bei Gruberwirt: 5 von 6 Seiten landeten auf Italienisch als Draft
statt veröffentlicht und mussten mit einem zweiten Durchlauf nachveröffentlicht werden.

### Ursache

Ohne `localizeStatus` legt Payload beim Veröffentlichen einer einzelnen Locale zusätzlich einen
**Snapshot** an — eine Version mit `_status: 'draft'`, die nicht veröffentlichte Arbeit der
anderen Sprachen weiterträgt:

```js
// collections/operations/utilities/update.js (Zeilen 247–269)
} else if (publishSpecificLocale) {
    // previous way of publishing a single locale
    ...
    snapshotData = { ...result, _status: 'draft' };
}
```

`versions/saveSnapshot.js` speichert ihn mit einem neuen Zeitstempel, also **nach** der
veröffentlichten Version. `draft: true` liest die neueste Version — und das ist jetzt der
Snapshot. Die Seite ist trotzdem veröffentlicht, auch auf Deutsch.

### Lösung

Den Veröffentlichungs-Status nie aus einem `draft: true`-Read ableiten, nachdem schon geschrieben
wurde. Entweder vor dem ersten Schreiben festhalten (beim Export mitspeichern) oder die
veröffentlichte Version lesen:

```ts
const live = await payload.findByID({
  collection: 'pages',
  id,
  draft: false, // veröffentlichte Version, nicht der neueste Snapshot
  depth: 0,
  locale: 'de',
})
const isPublished = live._status === 'published'
```

## 2. Veröffentlichen prüft Pflichtfelder pro Sprache — ohne Fallback

### Problem

EN-Veröffentlichung der Restaurant-Seite schlägt fehl, alle Texte sind übersetzt:

```
The following field is invalid: Hero > Buttons 4 > Link > File
  "message": "This field is required.", "path": "hero.buttons.3.link.file"
```

Der Button verlinkt die Speisekarte als PDF. Das Upload-Feld ist lokalisiert (Teil von
`link({ localized: true })`) und Pflicht, wenn der Link-Typ „Datei" ist. Auf Deutsch gesetzt, auf
Englisch leer. Auf der Website fällt das nie auf, weil `fallback: true` dort die deutsche Datei
ausliefert.

### Ursache

Beim Update liest Payload das Originaldokument **ohne Fallback** (`fallbackLocale: null`):

```js
// collections/operations/utilities/update.js (Zeile 60)
fallbackLocale: id ? null : fallbackLocale,
```

und `afterRead` setzt den Fallback nur, wenn `fallbackLocale` truthy ist
(`fields/hooks/afterRead/promise.js`, Zeile 56). Die Validierung sieht also nur den Wert der
Sprache, die gespeichert wird. Drafts überspringen die Validierung
(`collections/operations/updateByID.js`, Zeile 191:
`skipValidation: isSavingDraft && !hasDraftValidationEnabled(collectionConfig)`) — darum klappt
das Speichern als Draft und erst das Veröffentlichen scheitert.

Das gilt für **jedes** lokalisierte Pflichtfeld, nicht nur für Uploads. In der Praxis trifft es
die Felder, die beim Übersetzen niemand anfasst, weil sie keinen Text enthalten: `upload`,
`select`, `relationship`, `checkbox`.

### Lösung

Beim Übersetzen alle lokalisierten Felder ohne Text aus der Quellsprache übernehmen (gleiche
Datei, gleiche Auswahl), nicht nur die Texte schreiben:

```ts
// pro exportiertem lokalisierten Feld
if (['upload', 'relationship', 'select'].includes(entry.type)) return { path, value: entry.de }
```

Muss so ein Wert pro Sprache gar nicht unterschiedlich sein können, das Feld besser gleich nicht
lokalisieren.

## Was sich sonst bewährt hat

- Lesen der Ziel-Locale immer mit `fallbackLocale: false`, sonst kommt ein leeres EN-Feld als
  deutscher Text zurück und gilt als „schon übersetzt".
- Pfade zu Blöcken/Array-Zeilen über die Zeilen-ID adressieren (`layout[id=…].text`), nicht über
  den Index, und die IDs beim Zurückschreiben unverändert lassen.
- Vor dem Import prüfen, ob sich der deutsche Text seit dem Export geändert hat (Feld überspringen
  statt eine veraltete Übersetzung zu schreiben).
- Mit übersetzten Slugs (`/en/surroundings`) brechen alle **händisch eingetragenen** internen
  Links (`/umgebung`) in EN/IT, auch im Header-Global — die URL-Felder pro Sprache mit
  umschreiben.
- Scripts schreiben mit `context: { disableRevalidate: true }`. Danach zeigt der gecachte
  Header noch die alten Links, bis das Global im Admin einmal gespeichert oder neu deployt wird
  (siehe [static-rendering](../static-rendering/description.md)).

## Checkliste

- [ ] Backup vor dem Import ([database-migrations](../database-migrations/description.md)).
- [ ] Dry-Run zuerst: zeigt Pfade, die nicht mehr existieren, und geänderte deutsche Texte.
- [ ] Veröffentlichungs-Status vor dem ersten Schreiben festhalten oder mit `draft: false` lesen.
- [ ] Nicht-Text-Felder (Upload, Select, Relationship) in jede Zielsprache übernehmen.
- [ ] Interne Link-URLs auf die übersetzten Slugs umschreiben, auch in Globals.
- [ ] Danach die veröffentlichte Version pro Locale gegen die Übersetzungsdateien prüfen
      (`draft: false`, `fallbackLocale: false`) und alle Sprach-URLs auf 200 testen.
