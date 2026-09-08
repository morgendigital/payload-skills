# Migrations & Datenbestand — Schema-Änderungen auf einer laufenden Kundenseite

Die Lücke, die alle anderen Skills offen lassen: Sie beschreiben, wie man etwas **aufsetzt**.
Dieser hier beschreibt, wie man es ändert, **nachdem** der Kunde drei Monate Inhalte gepflegt hat.

Backups laufen bei uns über **Dokploy** (geplanter Dump in einen S3-Bucket, Restore per Klick) —
dieser Skill behandelt deshalb nicht, *wie* man ein Backup baut, sondern was Dokploy **nicht**
abdeckt und wann man es von Hand auslösen muss.

## 1. Der Ausgangszustand: `push` ist eine Dev-Bequemlichkeit

Der Postgres-Adapter läuft in der Entwicklung mit `push: true`. Payload gleicht das Schema dann
bei jedem Start automatisch an die Config an — kein `migrate:create`, kein Nachdenken. Genau das
ist der Grund, warum die erste Schema-Änderung in Produktion überrascht.

```ts
// src/payload.config.ts
db: postgresAdapter({
  pool: { connectionString: process.env.DATABASE_URI },
  push: process.env.NODE_ENV === 'development',  // ← in Produktion IMMER false
  migrationDir: './src/migrations',
}),
```

→ **`push: true` in Produktion kann Daten verlieren.** Payload bzw. Drizzle löst Änderungen dann
selbst auf — und ein umbenanntes Feld sieht für ein automatisches Diff aus wie „Spalte weg, neue
Spalte da". In der Entwicklung ist das egal, in Produktion ist es der Inhalt des Kunden.

→ **Migrations gehören ins Repo.** `src/migrations/*.ts` plus die generierte `index.ts` werden
committet. Sie sind Teil des Codes, nicht Teil der Datenbank.

## 2. Der Ablauf pro Schema-Änderung

```bash
# 1. Lokal gegen eine Kopie des Prod-Schemas arbeiten (nicht gegen eine leere DB!)
pnpm payload migrate:create aussagekraeftiger-name

# 2. Die generierte Datei LESEN — nicht nur committen
$EDITOR src/migrations/2026...aussagekraeftiger-name.ts

# 3. Lokal anwenden und prüfen, ob die Inhalte noch da sind
pnpm payload migrate
pnpm payload migrate:status
```

→ **Schritt 2 ist der eigentliche Punkt.** Eine Feld-Umbenennung erzeugt praktisch immer
`DROP COLUMN` + `ADD COLUMN` — syntaktisch korrekt, inhaltlich ein Datenverlust. Wer den Inhalt
behalten will, schreibt das `ALTER TABLE … RENAME COLUMN` bzw. ein `UPDATE`-Statement von Hand in
die Migration. Payload kann nicht wissen, dass „alte Spalte" und „neue Spalte" dasselbe meinen.

→ **Gegen eine Kopie des Prod-Schemas generieren.** Wer gegen eine frisch aufgesetzte lokale DB
generiert, bekommt eine Migration, die nur auf seinem Rechner passt — und die auf Prod entweder
fehlschlägt oder Schritte enthält, die dort längst erledigt sind.

→ **Besonders vorsichtig bei:** lokalisierten Feldern (eigene `_locales`-Tabellen), Arrays und
Blocks (eigene Tabellen pro Block, Umbenennen des `blockType` = Datenverlust), `hasMany`-Relations
(Join-Tabellen), und dem Wechsel eines Feldtyps (`text` → `richText` migriert **nicht** von
allein).

## 3. Wo die Migration laufen muss: beim Containerstart, nicht im Build

Das ist der stack-spezifische Teil. Der Docker-Build auf Dokploy hat **nicht** verlässlich Zugriff
auf die Produktionsdatenbank — genau deshalb existiert der zweistufige Build-Fallback in
[payload-start](../payload-start/description.md). Eine Migration im Build-Schritt ist damit
entweder unmöglich oder unzuverlässig.

Zwei saubere Wege:

```ts
// Variante A — Payload führt Migrations beim Server-Init aus (nur Produktion)
import { migrations } from './migrations'

db: postgresAdapter({
  pool: { connectionString: process.env.DATABASE_URI },
  push: process.env.NODE_ENV === 'development',
  prodMigrations: migrations,
}),
```

```jsonc
// Variante B — explizit im Start-Command (Dokploy: Start Command der Application)
"start": "payload migrate && next start"
```

→ **Variante B ist die ehrlichere.** Der Migrationslauf steht im Deploy-Log an einer Stelle, an
der man ihn sucht, und ein Fehlschlag verhindert den Start, statt die App mit halbem Schema
hochkommen zu lassen. Variante A versteckt den Schritt im Server-Init.

→ **Mehrere Instanzen = Rennen um dieselbe Migration.** Solange ihr eine Replica fahrt, ist das
egal. Beim Hochskalieren muss der Migrationslauf aus dem App-Start heraus und in einen
**einmaligen Schritt** (Dokploy Schedule Job / manuell vor dem Deploy), sonst starten zwei
Container dieselbe Migration gleichzeitig.

→ **Rollback ist keine Strategie.** `payload migrate:down` nimmt die letzte Batch zurück — aber
nur das Schema, nicht die Daten, die die Migration gelöscht hat. Der echte Rückweg ist das Backup
aus Abschnitt 4.

## 4. Backup: was Dokploy macht — und was nicht

**Dokploy deckt ab:** geplanter Dump von Postgres in einen S3-Bucket nach Cron-Zeitplan, Restore
über die Oberfläche.

**Dokploy deckt nicht ab:**

| Lücke | Was zu tun ist |
| --- | --- |
| **Medien im S3-/R2-Bucket** | Die Uploads liegen nicht in der Datenbank ([payload-start](../payload-start/description.md), `@payloadcms/storage-s3`). Ein DB-Restore ohne passenden Bucket-Stand ergibt eine Seite voller toter Bilder. **Object Versioning bzw. eine Lifecycle-Regel am Bucket aktivieren** — das ist das Medien-Backup. |
| **Der Zeitpunkt vor einer Migration** | Der Cron läuft nachts, die Migration mittags. **Vor jedem Deploy mit Migration von Hand ein Backup auslösen** und im Deploy-Protokoll vermerken. |
| **Env-Variablen und Dokploy-Konfiguration** | Stecken in Dokploy, nicht im Repo (`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`, SMTP-Zugänge, S3-Keys). Bei Serververlust ist die DB da und die App nicht startfähig. Eine dokumentierte Liste der benötigten Variablen pro Projekt gehört ins Repo — **die Werte natürlich nicht**. |
| **Der Beweis, dass das Backup funktioniert** | Siehe unten. |

→ **Restore einmal proben, bevor man ihn braucht.** Einmal pro Projekt (spätestens beim Go-Live)
einen Dump in eine leere Staging-Datenbank zurückspielen, die App dagegen starten und schauen, ob
Inhalte und Medien zusammenpassen. Ein nie getestetes Backup ist eine Vermutung. Gehört als Zeile
in [go-live-check](../go-live-check/description.md).

→ **Aufbewahrungsdauer gegen die Datenschutzerklärung halten.** Wenn dort „Löschung nach 6
Monaten" steht, die Backups aber 24 Monate vorhalten, stimmt die Zusage nicht. Das ist dieselbe
Prüfung wie bei den Löschjobs in [jobs-queue](../jobs-queue/description.md).

## 5. Inhalte zwischen Staging und Produktion

Der Wunsch kommt in jedem Projekt: „Können wir die Seiten, die wir auf Staging gebaut haben, nach
Prod übernehmen?" Die Antwort ist fast nie „Datenbank kopieren".

- **Prod → Staging: unkritisch.** Dump einspielen, um mit echten Daten zu testen. Danach daran
  denken, dass auf Staging jetzt echte personenbezogene Daten liegen (Formular-Einsendungen!) —
  entweder löschen oder Staging genauso schützen wie Prod.
- **Staging → Prod: niemals als Voll-Restore.** Damit überschreibt man alles, was der Kunde
  inzwischen in Prod gepflegt hat. Stattdessen gezielt: `@payloadcms/plugin-import-export` für
  einzelne Collections, oder ein Seed-Skript, das über die Payload Local API schreibt statt über
  SQL — dann greifen Hooks, Revalidation und Access Control.
- **Medien-IDs wandern nicht mit.** Ein Dokument, das auf Media-ID 42 zeigt, zeigt auf der anderen
  Instanz auf ein anderes Bild. Beim Übernehmen entweder Medien zuerst und über den Dateinamen
  neu verknüpfen — oder von vornherein akzeptieren, dass Inhalte einmal, in einer Umgebung,
  gepflegt werden.

→ **Die einfachste Lösung ist meistens die richtige:** Redaktionsinhalte werden in Produktion
gepflegt, Staging ist für Code. Wer beides pflegt, baut sich einen Abgleich-Job, den niemand warten
will.

## 6. Was regelmäßig schiefgeht

- **Migration vergessen zu committen.** Lokal läuft alles, auf Prod fehlt die Spalte. `git status`
  nach `migrate:create` ist der billigste Test.
- **`migrate:status` nie angeschaut.** Zeigt, welche Migrationen die Ziel-DB kennt. Der schnellste
  Weg zu „warum ist das Schema anders als gedacht".
- **Migration schlägt in der Mitte fehl.** Payload/Drizzle fährt die einzelne Migration in einer
  Transaktion — mehrere Migrationen in einem Lauf aber nacheinander. Nach einem Fehlschlag also
  prüfen, welche Batch durchging, statt blind erneut zu starten.
- **`payload generate:types` und `generate:importmap` vergessen.** Gehören nach jeder
  Schema-/Komponentenänderung dazu und in die CI vor den Build — der Import-Map-Teil ist die
  Ursache für stillschweigend leere Admin-Views
  ([seo-meta-check §5.7](../seo-meta-check/description.md#57-verdrahtung)).
- **Große Tabellen ohne Nachdenken ändern.** `ALTER TABLE` auf einer Versions-Tabelle mit
  Hunderttausenden Zeilen sperrt. Versionen vorher aufräumen (`maxPerDoc`) — das ist ohnehin
  überfällig, wenn Autosave aktiv ist.

## Quick-Checkliste

1. `push` nur in `development`, in Produktion `false`; `migrationDir` gesetzt
2. `migrate:create` gegen eine **Kopie des Prod-Schemas**, generierte Datei lesen, Umbenennungen
   von Hand als `RENAME`/`UPDATE` nachziehen
3. Migrations committen — inklusive `index.ts`
4. Migrationslauf beim **Containerstart** (`payload migrate && next start`), nicht im Docker-Build;
   bei mehr als einer Replica in einen einmaligen Schritt auslagern
5. **Vor jedem Deploy mit Migration** von Hand ein Dokploy-Backup auslösen
6. Bucket-Versionierung für Medien aktiv (Dokploy sichert die Datenbank, nicht S3/R2)
7. Liste der benötigten Env-Variablen pro Projekt im Repo dokumentiert (ohne Werte)
8. Restore **einmal geprobt** — Dump in leere Staging-DB, App dagegen gestartet, Medien geprüft
9. Staging → Prod nie als Voll-Restore; gezielt über Import/Export oder Local-API-Seed
10. Nach der Änderung: `migrate:status`, `generate:types`, `generate:importmap`
