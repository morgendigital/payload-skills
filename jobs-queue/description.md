# Jobs Queue & Cron — wiederkehrende Aufgaben auf Dokploy

Payload 3 bringt eine echte Job-Queue mit Cron-Schedules mit. Der Haken ist nicht die
Konfiguration, sondern der **Runner**: Ohne ihn nimmt Payload Jobs entgegen, führt sie nie aus,
und alles bleibt still auf `pending` — ohne Fehler, ohne Log, ohne Hinweis im Admin. Genau das
passiert beim ersten Einsatz zuverlässig.

Betroffen sind mehr Features, als man denkt:

| Was | Braucht die Queue | Skill |
| --- | --- | --- |
| Löschfrist für Formular-Einsendungen | ja | [form-submissions-email](../form-submissions-email/description.md) |
| Geplantes Veröffentlichen („Montag 8:00 live") | ja | — |
| CSV-Export über `@payloadcms/plugin-import-export` | ja (Export **und** Import laufen als Job) | — |
| Wiederkehrende Alarm-/Health-Mails | ja | [email-test](../email-test/description.md) |
| Sitemap-/Cache-Warmup nach Deploy | optional | [static-rendering](../static-rendering/description.md) |

## 1. Die Runner-Frage — und warum `autoRun` bei uns nicht die erste Wahl ist

Payload kennt drei Wege, Jobs abzuarbeiten:

| Weg | Was es ist | Für Dokploy/Hetzner |
| --- | --- | --- |
| `jobs.autoRun` in der Config | Ein Cron **innerhalb** des Node-Prozesses der Next.js-App | Erlaubt (kein Serverless), aber mit zwei Fallen — siehe unten |
| `pnpm payload jobs:run` | Einmaliger CLI-Lauf, arbeitet die Queue ab und beendet sich | **Empfehlung**, getriggert über einen Dokploy Schedule Job |
| `GET /api/payload-jobs/run` | HTTP-Endpoint, gedacht für externe Cron-Dienste (Vercel Cron o. ä.) | Nur mit sauberem Zugriffsschutz, siehe Abschnitt 3 |

`pnpm payload jobs:run --cron "*/5 * * * *"` gibt es auch — der Prozess bleibt dann dauerhaft
laufen. Das ist ein **eigener Service**, kein Kommando, das man in einen Deploy-Hook schreibt.

→ **Warum nicht `autoRun`?** Zwei Gründe, die beide erst im Betrieb auffallen:

1. **Skalierung.** `autoRun` läuft in *jedem* App-Prozess. Sobald ihr auf zwei Replicas geht oder
   Dokploy während eines Deploys kurz alt und neu parallel hält, arbeiten zwei Runner dieselbe
   Queue ab. Payload sperrt Jobs zwar, aber Nebenwirkungen (versendete Mails!) sind dann eine
   Frage des Timings, nicht des Designs.
2. **Kaltstart.** Der Cron startet erst, wenn Payload im Prozess initialisiert ist — in einer
   Next.js-App passiert das beim ersten Request, nicht beim Containerstart. Auf einer Seite mit
   wenig Traffic kann der nächtliche Job damit schlicht ausfallen, weil nachts niemand die Seite
   aufruft. **Vor dem Verlassen auf `autoRun` genau das einmal testen:** Container neu starten,
   nichts aufrufen, warten, ob der Job läuft.

Ein externer Trigger hat keins der beiden Probleme — und ihr habt ihn schon: **Dokploy Schedule
Jobs** sind derselbe Mechanismus, über den bei euch die Datenbank-Backups laufen.

## 2. Empfohlenes Setup: Dokploy Schedule Job

**In Dokploy** (Projekt → Application → *Schedules*) einen Job anlegen:

| Feld | Wert |
| --- | --- |
| Typ | Application (Command im laufenden Container) |
| Command | `pnpm payload jobs:run --limit 20 --allQueues` |
| Schedule | `*/5 * * * *` (oder seltener, je nach Aufgabe) |

→ **Der Zielcontainer muss laufen.** Dokploy führt das Kommando *in* dem Container aus — ist die
App gestoppt oder crasht sie im Restart-Loop, fällt der Job stillschweigend aus. Deshalb gehört
die Queue in die Überwachung (Abschnitt 5), nicht nur die Website.

→ **`--limit` setzen.** Ohne Begrenzung zieht ein Lauf alles, was da ist. Nach einem längeren
Ausfall ist die Queue voll, und der erste Lauf danach kippt euch auf den kleinen Hetzner-Instanzen
den Speicher — dieselbe Drosselungs-Logik wie bei den Media-Skripten
([media-webp-variants](../media-webp-variants/description.md)).

→ **`--allQueues` nur, wenn ihr wirklich alle wollt.** Sobald es eine schwere Queue gibt (Exporte,
Bildverarbeitung) und eine leichte (Mails), trennen: zwei Schedule Jobs mit unterschiedlicher
Frequenz und unterschiedlichem `--queue`. Sonst blockiert ein 4-Minuten-Export den Mailversand.

```ts
// src/payload.config.ts
export default buildConfig({
  jobs: {
    tasks: [/* … */],
    // autoRun bewusst NICHT gesetzt — der Trigger kommt von außen (Dokploy Schedule Job)
  },
})
```

## 3. Wenn es doch der HTTP-Endpoint sein muss

`GET /api/payload-jobs/run` ist praktisch (kein Shell-Zugriff nötig), aber der Zugriffsschutz ist
**standardmäßig „jeder eingeloggte Benutzer"**. Ein Cron-Dienst hat keine Session, also braucht er
einen eigenen Weg hinein — und den muss man explizit bauen, sonst endet es bei „Access Control
lockern, damit der Cron durchkommt". Das ist genau das Muster, vor dem
[security-check](../security-check/description.md) warnt.

```ts
// src/payload.config.ts
jobs: {
  access: {
    run: ({ req }) => {
      // 1. Eingeloggte Admins dürfen manuell auslösen
      if (req.user?.roles?.includes('admin')) return true
      // 2. Externer Cron mit eigenem Secret — zeitkonstanter Vergleich
      const header = req.headers.get('authorization')
      const expected = `Bearer ${process.env.JOBS_RUN_SECRET}`
      return Boolean(header && expected.length > 7 && timingSafeEqualStr(header, expected))
    },
    queue: ({ req }) => Boolean(req.user),
    cancel: ({ req }) => Boolean(req.user?.roles?.includes('admin')),
  },
}
```

→ **`JOBS_RUN_SECRET` gehört in die Dokploy-Env**, nicht ins Repo, und ist genauso zu behandeln
wie `PAYLOAD_SECRET` (siehe [security-check §4](../security-check/description.md#4-environment-variables-absichern)).

→ **Der Endpoint darf nicht in die `robots.txt`-Erlaubnis und nicht in die Sitemap.** `/api` ist
in unserer robots.txt ohnehin ausgeschlossen ([seo](../seo/description.md)) — beim Umbau auf eine
eigene `app/robots.ts` (siehe [geo §1](../geo/description.md)) nicht vergessen.

## 4. Tasks schreiben — die Regeln, die im Betrieb zählen

```ts
// src/jobs/pruneFormSubmissions.ts
import type { TaskConfig } from 'payload'

export const pruneFormSubmissions: TaskConfig<'pruneFormSubmissions'> = {
  slug: 'pruneFormSubmissions',
  retries: 2,
  handler: async ({ req }) => {
    const cutoff = new Date(Date.now() - 1000 * 60 * 60 * 24 * 180) // 180 Tage
    const { docs } = await req.payload.find({
      collection: 'contact-submissions',
      where: { createdAt: { less_than: cutoff.toISOString() } },
      limit: 100,            // ← begrenzt, nicht "alles"
      depth: 0,
      overrideAccess: true,
    })

    for (const doc of docs) {
      await req.payload.delete({ collection: 'contact-submissions', id: doc.id, overrideAccess: true })
    }

    return { output: { deleted: docs.length, hasMore: docs.length === 100 } }
  },
}
```

→ **Jeder Task muss idempotent sein.** Er kann doppelt laufen (Retry, zwei Runner, manueller
Anstoß). „Mail versenden" ist nur dann sicher, wenn im Dokument ein `mailStatus` steht, das der
Task vorher prüft — das Feld gibt es in
[form-submissions-email](../form-submissions-email/description.md) bereits genau dafür.

→ **Kein Task ohne Obergrenze.** `limit` in der Query, und lieber „100 pro Lauf, alle 5 Minuten"
als „alles auf einmal". Das ist die Lehre aus dem Vorfall vom 17.08.2026, bei dem ein
ungedrosselter Bulk-Lauf den Produktionsserver lahmgelegt hat — dieselbe Regel gilt hier.

→ **`retries` bewusst setzen.** Default ist unbegrenztes Wiederholen; ein Task, der an
fehlerhaften Daten scheitert, läuft dann für immer im Kreis und füllt das Log. 2–3 Versuche,
danach `hasError` im Job-Dokument und ein Alarm.

→ **Löschfristen sind eine DSGVO-Zusage, kein Aufräumen.** Wenn in der Datenschutzerklärung
„6 Monate" steht, muss der Job auch tatsächlich laufen — das ist der eigentliche Grund, warum die
Runner-Frage in diesem Skill an erster Stelle steht. Gehört in
[go-live-check](../go-live-check/description.md) Todo 4 mit hinein.

## 5. Überwachen — sonst merkt es niemand

Der Ausfallmodus einer Queue ist **Stille**. Nichts crasht, nichts loggt, es passiert nur nichts
mehr. Drei Gegenmaßnahmen, in dieser Reihenfolge:

1. **Die `payload-jobs`-Collection im Admin sichtbar machen** und einmal wöchentlich anschauen:
   Häufen sich Dokumente mit `hasError` oder alte, nie abgeholte Einträge, läuft der Runner nicht.
2. **Ein Zähler-Check im Dashboard-Widget** — dieselbe Mechanik wie beim SEO-Check
   ([seo-meta-check §5](../seo-meta-check/description.md#5-dashboard-meta-check-über-alle-seiten)):
   „12 Jobs warten seit über einer Stunde" gehört als roter Banner aufs Dashboard.
3. **Ein Alarm über den Agentur-Resend-Account**, gedrosselt auf eine Mail pro Ursache und 6 h —
   exakt das Muster aus [email-test](../email-test/description.md). Ein toter Runner ist genauso
   unsichtbar wie ein toter SMTP.

```bash
# Schnellcheck auf dem Server: hängen Jobs?
psql "$DATABASE_URI" -c "select count(*) filter (where has_error), count(*) \
  from payload_jobs where completed_at is null;"
```

→ **Nach jedem Deploy einmal prüfen.** Ein umbenannter Task-Slug lässt alte, noch wartende Jobs
ins Leere laufen: Der Job liegt in der Queue, der Handler existiert nicht mehr. Beim Umbenennen
eines Tasks entweder die Queue vorher leeren oder den alten Slug als No-op stehen lassen.

## Quick-Checkliste

1. **Runner festlegen, bevor der erste Job gebaut wird** — sonst bleibt alles auf `pending`, ohne
   Fehlermeldung
2. Dokploy Schedule Job mit `pnpm payload jobs:run --limit 20`, Zielcontainer muss laufen;
   schwere und leichte Queues über `--queue` trennen
3. `autoRun` nur nach bewusstem Test (Container-Neustart ohne Traffic) und nie bei mehr als einer
   Instanz
4. Falls HTTP-Trigger: `jobs.access.run` mit eigenem Secret aus der Dokploy-Env, **nicht** die
   Access Control aufweichen
5. Jeder Task: idempotent, `limit` in jeder Query, `retries` gesetzt
6. `payload-jobs` im Admin sichtbar, Warteschlangen-Alarm per Resend an die Agentur, gedrosselt
7. Nach jedem Deploy: hängen Jobs? Task-Slugs unverändert?
8. Löschfristen aus der Datenschutzerklärung gegen die tatsächlich laufenden Jobs halten
