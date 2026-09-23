# Umgebungsvariablen vollständig in Infisical — ohne Nachfassen

Quelle der Wahrheit für Werte ist **Infisical** (EU-Region, ein Projekt je Repo).
Environments nach Bedarf — mindestens `dev` und `prod`; ein `staging` nur, wenn es
wirklich benutzt wird, sonst pflegt man einen dritten Satz Variablen für nichts. Die `.env.example` im Repo dokumentiert
nur, *welche* Variablen es gibt und wofür — nie Werte.

## Das Problem

Beim Aufsetzen legt man die Variablen an, die einem gerade einfallen. Der Rest
kommt tröpfchenweise nach: erst fehlt die Build-Adresse, dann imgproxy, dann die
Produktions-URL. Jede Runde kostet eine Rückfrage beim Kunden und eine
Deployment-Schleife.

Gemessen an frechinger (23.09.2026): **vier Runden Nachfassen** nach dem
vermeintlich vollständigen ersten Satz.

Zwei Gründe, warum eine reine Checkliste das nicht löst:

1. **`grep process.env` findet nicht alles.** `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`
   liest Next.js selbst — die Variable steht in keiner Projektdatei und fehlt
   deshalb systematisch. Dasselbe gilt für Variablen, deren Feature noch nicht
   verdrahtet ist, die aber in Dokploy längst gesetzt sein müssten.
2. **Eine Liste veraltet.** Sobald ein Plugin dazukommt, stimmt sie nicht mehr.

Deshalb: **Katalog plus Prüfskript.** Der Katalog sagt, was erwartet wird; das
Skript gleicht ihn gegen Code *und* Infisical ab und bricht ab, wenn etwas fehlt
oder ein Platzhalter stehen geblieben ist.

## Das Skript

[`check-env.mjs`](./check-env.mjs) nach `scripts/check-env.mjs` kopieren:

```jsonc
"check:env": "node scripts/check-env.mjs"
```

```bash
pnpm check:env                 # alle Environments
pnpm check:env -- --env=prod   # eines
```

Die Environment-Liste steht oben im Skript (`ALLE_ENVS`, Default `dev,prod`) und
lässt sich per `INFISICAL_ENVS` überschreiben — die CLI kann Environments nicht
auflisten, deshalb explizit.

Es meldet je Environment:

| Befund | Bedeutung |
| --- | --- |
| **FEHLT** | Code oder Katalog erwartet sie, in Infisical nicht vorhanden |
| **PLATZHALTER** | gesetzt, aber `test`, leer, `changeme`, `YOUR_SECRET_HERE`, … |
| **OHNE DATENBANKNAMEN** | eine Mongo-Adresse endet am Host — Payload landet dann in der Default-DB `test` |
| optional, nicht gesetzt | z. B. `DATABASE_URL_BUILD` — nur wo gebraucht |
| verwaist | in Infisical, wird nirgends gelesen |
| WARNUNG | ein Secret ist in zwei Environments identisch, oder Bucket und Datenbank passen nicht zusammen |

Exit 1 bei FEHLT oder PLATZHALTER. Damit taugt es als **Gate vor dem Go-live**
und gehört in [go-live-check](../go-live-check/description.md).

> **Werte werden gelesen, aber nie ausgegeben.** Berichtet wird ausschließlich
> der Name der Variablen — das Skript darf deshalb in CI-Logs laufen.

Die WARNUNG-Zeile prüft zwei Kopplungen, die man von Hand übersieht:

1. **Secrets müssen sich je Environment unterscheiden.** Wer die Environments per
   Copy-Paste anlegt, hat in Produktion dasselbe `PAYLOAD_SECRET` wie in Dev —
   ein kompromittiertes Dev-Environment ist dann ein kompromittiertes
   Produktivsystem.
2. **Der Bucket gehört zur Datenbank, nicht zum Environment.** Gleiche DB →
   gleicher Bucket ist Pflicht; getrennte DB → getrennter Bucket. Beide
   Abweichungen werden gemeldet.

→ Für Punkt 2 reicht ein String-Vergleich von `DATABASE_URL` **nicht**. Zwei
Environments können über verschiedene Wege auf dieselbe Datenbank zeigen — intern
über den Docker-Host, von außen über Tailscale. Das Skript vergleicht deshalb die
Mengen aus `DATABASE_URL` **und** `DATABASE_URL_BUILD` und wertet eine
Überschneidung als „dieselbe Datenbank".

## Der Katalog

Steht als Datenstruktur oben in `check-env.mjs` und wird dort gepflegt. Inhaltlich:

### Immer

| Variable | Wer liefert | je Environment verschieden |
| --- | --- | --- |
| `DATABASE_URL` | Kunde/Infra | ja |
| `PAYLOAD_SECRET` | selbst erzeugen | **ja** |
| `NEXT_PUBLIC_SERVER_URL` | Kunde (Domain) | **ja** |
| `CRON_SECRET` | selbst erzeugen | **ja** |
| `PREVIEW_SECRET` | selbst erzeugen | **ja** |
| `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` | selbst erzeugen | **ja** |

„Selbst erzeugen" heißt `openssl rand -base64 32`. Diese vier haben keinen
externen Bezug — sie auf `test` stehen zu lassen und auf den Kunden zu warten,
ist reine Verzögerung.

→ `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` muss **innerhalb** eines Environments über
alle Deployments stabil bleiben, sonst „Failed to find Server Action"
([server-actions-encryption](../server-actions-encryption/description.md)).

→ **Die Mongo-Adresse muss auf einen Datenbanknamen enden.** Endet sie am Host
(`mongodb://user:pw@host:27017`), verbindet sich Payload wortlos mit Mongos
Default-Datenbank **`test`**. Es funktioniert alles, nichts warnt — bis jemand auf
dem Host ein zweites Projekt anlegt, das seine Adresse genauso schreibt. Dann
teilen sich zwei Kundenprojekte eine Datenbank.

Der Fehler ist doppelt unauffällig, weil `test` auch der Name des üblichen
Platzhalterwerts ist: In Infisical steht dann `DATABASE_URL` korrekt befüllt da,
und trotzdem heißt die Datenbank `test`.

```
mongodb://user:pw@host:27017                  → landet in `test`
mongodb://user:pw@host:27017/frechinger       → richtig
mongodb://user:pw@host:27017/frechinger?tls=true
```

→ Beim Nachtragen prüfen, ob in `test` schon Daten liegen. Ist die alte
Datenbank nicht leer, ist das Umhängen eine Migration, kein Edit
([database-migrations](../database-migrations/description.md)).

### Nur wo Build- und Laufzeit-Adresse auseinanderfallen

| Variable | Anmerkung |
| --- | --- |
| `DATABASE_URL_BUILD` | Dokploy gibt Nixpacks denselben Variablensatz für Build und Laufzeit; erreicht der Builder die DB anders als der Container, führt nur diese Variable daran vorbei ([static-rendering](../static-rendering/description.md)) |

### S3 — wenn `@payloadcms/storage-s3` installiert ist

`S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`

→ **Bucket je Environment trennen — aber nur, wenn auch die Datenbank getrennt
ist.** Bei getrennter DB ist ein gemeinsamer Bucket riskant: Das Setup fährt
`overwriteExistingFiles`, ein Dev-Upload mit gleichem Dateinamen überschreibt
eine Produktionsdatei, und die alte URL gibt 404
([media-webp-variants](../media-webp-variants/description.md)).

→ **Teilt sich ein Environment die Datenbank mit Produktion, muss es sich auch
den Bucket teilen.** Das ist der Fall, sobald `dev` über die Tailscale-Adresse
auf dieselbe DB zeigt, die in `prod` als `DATABASE_URL_BUILD` steht — ein
üblicher Aufbau, damit lokal mit echten Inhalten gearbeitet wird. Getrennte
Buckets bei gemeinsamer DB sind dann der schlechteste Fall von beiden: In `dev`
entstehende Media-Dokumente landen in der **Produktionsdatenbank** und zeigen auf
Dateien in einem Bucket, den die Live-Seite nicht sieht — die Seite liefert 404
für Bilder, die im Admin einwandfrei aussehen. Umgekehrt fehlen lokal alle
bestehenden Bilder.

→ Und: Wer so arbeitet, arbeitet an echten Inhalten. Skripte, Löschungen und
Migrationen entsprechend behandeln
([database-migrations](../database-migrations/description.md)).

### imgproxy — sobald Uploads auf S3 liegen

`NEXT_PUBLIC_IMGPROXY_URL`, `NEXT_PUBLIC_IMGPROXY_BUCKET`

→ Gehören **auch dann schon gesetzt**, wenn der Loader noch nicht verdrahtet ist.
Sie sind die Variablen, die am häufigsten nachträglich auffallen — nämlich dann,
wenn unter Last der On-Server-Optimizer den Container killt.

### Mailversand, Formulare, Tracking, Keycloak

Je nach installiertem Paket, siehe Katalog im Skript. Die Zuordnung geht über
`package.json`, nicht über Raten.

## Zwei Sorten Platzhalter

Der Unterschied entscheidet, ob ein Platzhalter harmlos oder gefährlich ist.

**Platzhalter, die laut scheitern** — gut. `DATABASE_URL=test` bricht den Build
ab, das merkt man sofort.

**Platzhalter, die still vergiften** — gefährlich:

- **`NEXT_PUBLIC_SERVER_URL`** wird beim Build in `canonical` und `og:url`
  **jeder** prerenderten Seite eingebacken. Mit einem unbrauchbaren Wert läuft
  der Build sauber durch und produziert Müll, den man erst live sieht.
- **`DATABASE_URL_BUILD`** biegt `DATABASE_URL` um. Im Deploy-Log steht dann ein
  Mongoose-Fehler, dem man nicht ansieht, dass die Adresse aus einer *anderen*
  Variablen kam.

Deshalb gehört beides in den Build-Wrapper aus
[payload-start](../payload-start/description.md), Todo 3:

```js
// scripts/build.mjs — nach dem dotenv-Aufsatz, vor `next build`
if (env.DATABASE_URL_BUILD) env.DATABASE_URL = env.DATABASE_URL_BUILD

if (!/^mongodb(\+srv)?:\/\//.test(env.DATABASE_URL)) {
  const quelle = env.DATABASE_URL_BUILD ? 'DATABASE_URL_BUILD' : 'DATABASE_URL'
  console.error(`[build] ${quelle} ist keine Mongo-Adresse: "${env.DATABASE_URL}"`)
  process.exit(1)
}

let parsed
try {
  parsed = new URL(env.NEXT_PUBLIC_SERVER_URL)
} catch {
  console.error(`[build] NEXT_PUBLIC_SERVER_URL ist keine absolute URL: "${env.NEXT_PUBLIC_SERVER_URL}"`)
  process.exit(1)
}
if (!['http:', 'https:'].includes(parsed.protocol) || env.NEXT_PUBLIC_SERVER_URL.endsWith('/')) {
  console.error('[build] NEXT_PUBLIC_SERVER_URL braucht http(s) und keinen Slash am Ende.')
  process.exit(1)
}
```

→ **Der Wrapper braucht `node_modules/.bin` im PATH.** `next` findet sonst nur
pnpm. Wird der Wrapper direkt aufgerufen — `infisical run -- node
scripts/build.mjs`, oder ein Start-Command in Dokploy, der nicht über pnpm geht —
stirbt der Build mit `next: command not found` und exit 127:

```js
env.PATH = [join(process.cwd(), 'node_modules', '.bin'), env.PATH].filter(Boolean).join(delimiter)
```

→ **Der Wrapper muss `env.*` lesen, nicht `process.env.*`.** Der dotenv-Aufsatz
schreibt in die Kopie; wer am Original vorbeiliest, ignoriert stillschweigend
jeden Wert, der nur in einer `.env` steht.

## `NEXT_PUBLIC_*` gehört in Dokploy als Build-Env

Alles mit diesem Präfix wird beim `next build` ins Client-Bundle eingebacken. Nur
als Laufzeit-Env gesetzt, ist es zur Build-Zeit nicht da — und das Feature bleibt
**still** aus:

- imgproxy-Loader deaktiviert, On-Server-Optimizer läuft weiter
  ([image-optimization](../image-optimization/description.md))
- GTM und Meta Pixel laden nie ([tracking](../tracking/description.md))

Kein Fehler, kein Log. In Dokploy deshalb bei beiden Feldern eintragen.

## Ablauf im Projekt

1. Infisical-Projekt anlegen, `infisical init` im Repo — die entstehende
   `.infisical.json` enthält nur die Workspace-ID und **gehört ins Repo**.
2. `check-env.mjs` nach `scripts/` kopieren, `check:env` in die `package.json`.
3. `pnpm check:env` laufen lassen. Die Ausgabe ist die Liste, die man beim Kunden
   anfragt — vollständig, in einer Runde.
4. Alles mit „selbst erzeugen" sofort setzen, nicht auf den Kunden warten.
5. `.env.example` mit denselben Namen füllen, ohne Werte.
6. Vor dem Go-live nochmal, zusammen mit
   [go-live-check](../go-live-check/description.md). Exit 1 ist ein Blocker.

## Lokal arbeiten

```bash
infisical run --env=dev -- pnpm dev
infisical run --env=dev -- pnpm build
```

Eine lokale `.env` ist möglich (`infisical export --env=dev > .env`), veraltet
aber still. Wo beides existiert, gewinnen die Werte aus `infisical run` — weder
Next noch der Build-Wrapper überschreiben vorhandene Prozess-Variablen.
