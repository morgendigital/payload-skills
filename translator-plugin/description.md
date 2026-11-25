# Übersetzen-Button im Admin — `@payload-enchants/translator` absichern und reparieren

Befunde aus northlight (2026-11-25, `@payload-enchants/translator` 1.3.0, Payload 3.94.2, MongoDB,
Locales DE/EN). Alle mit lokaler Datenbank reproduziert. Das Paket wurde zuletzt im November 2024
veröffentlicht — auf einen Fix von außen nicht warten.

**Zuerst prüfen**, ob ein Projekt betroffen ist:

```bash
grep -n '"@payload-enchants/translator"' package.json
```

## 1. Der Endpoint hat keine Login-Prüfung (zuerst beheben)

### Problem

`POST /api/translator/translate` antwortet ohne Session. Mit `resolver: "copy"` und `data: {}`
liefert er Felder eines beliebigen Dokuments zurück — auch aus Collections, die die REST-API mit
403 sperrt:

```bash
curl -H 'Content-Type: application/json' \
  -d '{"collectionSlug":"contact-submissions","id":"<id>","locale":"en","localeFrom":"de","resolver":"copy","data":{}}' \
  https://<seite>/api/translator/translate
# → 200 mit email, Zustimmung, Datum, Status
```

Kopiert werden `email`, `select`, `checkbox`, `date`, `number`, `relationship`, `upload` u. a.,
lokalisierte Texte kommen über den Resolver mit. Man braucht die Dokument-ID. Mit
`resolver: "openai"` kann außerdem jeder das OpenAI-Budget verbrauchen.

### Ursache

Payload schützt Custom Endpoints nicht von selbst, der Handler prüft `req.user` nicht, und der
erste Read in `translateOperation` läuft ohne `overrideAccess` (also mit `true`).

### Lösung

[requireTranslatorAuth.ts](requireTranslatorAuth.ts) in `src/plugins/translator/` ablegen und
**direkt hinter** `translator()` in die Plugin-Liste setzen. Das Plugin wirft beim Start, wenn es
den Endpoint nicht findet, statt ihn still offen zu lassen. Der Patch unten reicht zusätzlich die
Zugriffsrechte an den Quell-Read durch.

Gegenprobe nach dem Deploy: `curl -X POST https://<seite>/api/translator/translate` → **401**.

## 2. `openAIResolver` funktioniert nicht mehr

- Default-Modell `gpt-3.5-turbo` → OpenAI antwortet `404 model_not_found`.
- Kein erzwungenes Antwortformat, `JSON.parse` auf Freitext.
- Antwortet das Modell mit zu wenigen Texten, meldet die Operation trotzdem Erfolg.

[openAIResolver.ts](openAIResolver.ts) ersetzt ihn (gleicher `key: 'openai'`, die Button-Texte
bleiben): Structured Output mit einem Pflicht-Schlüssel pro Text, Leerzeichen am Rand bleiben
erhalten, Modell über `OPENAI_TRANSLATE_MODEL` (Default `gpt-5.6-luna`). Die Leerzeichen sind
wichtig, weil das Plugin Rich Text **pro Textknoten** übersetzt — „Wir bauen **starke** Marken.“
kommt als drei Fragmente an. Gemessen: `["We build ","strong"," brands."]`, 2 s.

Im Prompt in `openAIResolver.ts` die Firma ruhig konkret beschreiben, das hilft beim Ton.
Ohne `OPENAI_KEY` in der Produktions-Umgebung meldet der Button nur einen Fehler.

Modellnamen veralten. Verfügbare prüfen mit `GET https://api.openai.com/v1/models`.

## 3. Plugin-Fehler — per `pnpm patch`

| Fehler | Folge |
| --- | --- |
| Quell-Read ohne `draft: true` | übersetzt den veröffentlichten Stand statt des Entwurfs |
| Nicht-Text-Felder werden immer aus der Quelle kopiert | auch bei „nur leere Felder“ werden Datum, Checkbox, Upload, Select der Zielsprache bzw. ungespeicherte Eingaben überschrieben |
| Fehlende Group / benannter Tab im Ziel wird nicht zurückgehängt | Übersetzungen darin gehen verloren (z. B. `meta`) |

[Patch-Datei](@payload-enchants__translator@1.3.0.patch) nach `patches/` kopieren:

```json
"pnpm": {
  "patchedDependencies": {
    "@payload-enchants/translator@1.3.0": "patches/@payload-enchants__translator@1.3.0.patch"
  }
}
```

⚠️ Baut das Projekt per Dockerfile, braucht die `deps`-Stage vor `pnpm i`:

```dockerfile
COPY patches ./patches
```

Mit Nixpacks auf Dokploy lief der Patch ohne weitere Anpassung durch (northlight, 2026-11-25).

Leere Nicht-Text-Felder werden weiterhin aus der Quelle gefüllt — das braucht man, weil
Veröffentlichen lokalisierte Pflichtfelder ohne Fallback prüft (siehe
[content-translation](../content-translation/description.md), Punkt 2).

## Checkliste

- [ ] `requireTranslatorAuth` eingebaut, deployt, anonymer POST liefert 401.
- [ ] Eigener Resolver statt `openAIResolver`, `OPENAI_KEY` gesetzt.
- [ ] Patch eingetragen, `pnpm install --frozen-lockfile` läuft (auch im Build).
- [ ] [translator.int.spec.ts](translator.int.spec.ts) nach `tests/int/` — fällt auf, wenn der
      Patch bei einem Update verloren geht. Dafür in `vitest.config.mts`:
      `test.server.deps.inline: ['@payload-enchants/translator']`.
- [ ] Im Admin einmal DE → EN übersetzen, Ergebnis gegenlesen, speichern.
