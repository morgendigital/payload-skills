# Neues Payload-Website-Setup — Checkliste

## Todo 1: Bild-Upload — Größe, WebP und Resize

Beim Aufsetzen einer neuen Payload-Website zuerst die Media-/Upload-Einstellungen setzen (Dateigröße global, Format WebP, maximale Pixelmaße).

### 1.1 Maximale Upload-Dateigröße (global)

**Datei:** `src/payload.config.ts`

- **`upload.limits.fileSize: 5000000`** – maximal **5 000 000 Byte** (~5 MB dezimal) pro Datei im Multipart-Upload (gilt für Payload-Uploads, u. a. Media).
- **`upload.abortOnLimit: true`** – wenn die Datei größer ist, bricht der Upload ab mit **HTTP 413** statt die Datei still zu kürzen.

Damit wird die Grenze beim Parsen der Anfrage durchgesetzt (Busboy/Payload-`upload`-Optionen), nicht nur in der Media-Collection.

### 1.2 WebP-Konvertierung

**Datei:** `src/collections/Media.ts`

- **`formatOptions: { format: 'webp' }`** – hochgeladene Bilder werden mit **Sharp** in **WebP** ausgegeben (zentrale Stelle für das Format der gespeicherten Bilder in dieser Collection).

### 1.3 Begrenzung der Bildabmessungen (keine „Riesen“-Originale)

**Datei:** `src/collections/Media.ts`

- **`resizeOptions`** (Sharp `resize`):
  - **`width: 2560`**, **`height: 2560`**
  - **`fit: 'inside'`** – Bild bleibt im Seitenverhältnis und passt in diese Box (längere Kante max. 2560 px).
  - **`withoutEnlargement: true`** – kleinere Bilder werden **nicht** hochskaliert.

Die **Original-Datei** in der Media-Collection wird damit beim Upload verkleinert. Zusätzlich erzeugt **`imageSizes`** weiterhin die definierten Varianten (thumbnail, small, medium, large, xlarge, og, …).

### Kurzüberblick (Todo 1)

| Ziel           | Wo                  | Wie                                      |
| -------------- | ------------------- | ---------------------------------------- |
| Dateigröße cap | `payload.config.ts` | `limits.fileSize` + `abortOnLimit`       |
| WebP           | `Media.ts`          | `formatOptions.format: 'webp'`           |
| Max. Pixelmaße | `Media.ts`          | `resizeOptions` (Sharp, `fit: 'inside'`) |

## Todo 2: Production-Build — zweistufiger Next.js-Build (`experimental-build-mode`)

**Datei:** `package.json` → Skript `build`

Ersetze ein einfaches `next build` durch eine **zweistufige** Pipeline (hier mit `cross-env` und unterdrückten Deprecation-Warnungen über `NODE_OPTIONS`):

```json
"build": "cross-env NODE_OPTIONS=--no-deprecation next build --experimental-build-mode generate-env && cross-env NODE_OPTIONS=--no-deprecation next build --experimental-build-mode compile"
```

### Warum zwei Schritte?

Next.js kann den Build in Modi aufteilen, die **Kompilierung** und **Einbetten von Umgebungsvariablen** voneinander trennen (experimentell):

- **`generate-env`** — Phase, in der **`NEXT_PUBLIC_*`** (und zugehörige Build-Zeit-Env) in die Bundles **eingebettet** werden, damit der Client die erwarteten öffentlichen Werte sieht.
- **`compile`** — experimenteller **Compile**-Lauf; Next kann dabei **ohne** vorheriges Einbrennen von Env-Werten in Zwischenartefakte arbeiten, sodass reine Compile-Outputs **unabhängiger von konkreten Env-Werten** cachbar sind (sinnvoll für CI-Cache oder Docker-Layer).

Statt eines einzigen `next build` nutzt ihr **zwei** `next build`-Aufrufe mit unterschiedlichen Modi — das ist der **zweite konfigurative Schritt** in dieser Checkliste (nach den Media-Defaults). `NODE_OPTIONS=--no-deprecation` unterdrückt nur Lärm von veralteten Node-APIs während des Builds.

**Reihenfolge:** In der Next.js-Doku und in vielen CI-/Docker-Beispielen ist **`compile` zuerst**, danach **`generate-env`** üblich. Die obige Zeile entspricht der gewünschten Projektvorgabe (`generate-env` → `compile`); wenn der Build fehlschlägt oder Env-Werte fehlen, mit der Reihenfolge **`compile` → `generate-env`** gegenprüfen. Modi sind an die **Next.js-Version** gebunden und können sich ändern.

## Todo 3: S3-Storage-Plugin und Secrets in der Umgebung

Für Produktion (oder geteilte Dev-Umgebungen) sollen Uploads der Media-Collection typischerweise in **Amazon S3** liegen — dafür das **offizielle S3-Storage-Paket** von Payload einbinden, nicht die alte manuelle `plugin-cloud-storage`-Variante aus Payload 2.x für reinen AWS-S3-Einsatz.

### 3.1 Paket installieren

```bash
pnpm add @payloadcms/storage-s3
```

(Entsprechend `npm` / `yarn`, je nach Projekt.)

### 3.2 Plugin in der Payload-Config registrieren

**Datei:** `src/payload.config.ts`

- **`s3Storage`** aus `@payloadcms/storage-s3` importieren und unter **`plugins`** eintragen.
- Unter **`collections`** den **Slug** der Upload-Collection setzen (meist **`media: true`**), passend zu eurer `Media`-Collection.
- **`bucket`** und **`config`** (AWS SDK `S3ClientConfig`) aus **Umgebungsvariablen** lesen — **keine** Access Keys ins Repository schreiben.

Orientierung und weitere Optionen (`clientUploads`, `signedDownloads`, `enabled` usw.): [Storage Adapters – Payload-Dokumentation](https://payloadcms.com/docs/upload/storage-adapters).

### 3.3 Umgebungsvariablen (.env / Hosting)

Die **Zugangsdaten und der Bucket** gehören in die **Env** des Servers bzw. der CI-/Container-Umgebung (lokal z. B. `.env`, in der Cloud die geheime Konfiguration des Providers).

Typische Variablen für **AWS S3** (Namen können im Projekt angepasst werden, müssen dann konsistent in `payload.config.ts` referenziert werden):

| Variable | Zweck |
| -------- | ----- |
| `S3_BUCKET` | Bucket-Name |
| `S3_REGION` | Region (z. B. `eu-central-1`) |
| `S3_ACCESS_KEY_ID` | Access Key ID |
| `S3_SECRET_ACCESS_KEY` | Secret Access Key |

Optional je nach Setup weitere Werte aus der AWS-/S3-Doku in `config`.

### Kurzüberblick (Todo 3)

| Ziel | Wo | Wie |
| ---- | -- | --- |
| S3-Anbindung | `payload.config.ts` | `s3Storage({ … })` in `plugins`, `collections` + `bucket` + `config` aus `process.env` |
| Secrets | `.env` / Hosting-Env | Bucket, Region, Access Key ID, Secret Access Key — **nicht** committen |

## Todo 4: Meta-Daten (SEO) — Payload überschreibt die Defaults

**Ziel:** Alle für die öffentliche Seite relevanten **Meta-Daten** (Titel, Beschreibung, Open Graph, Canonical, ggf. Twitter Cards, strukturierte Daten) sollen **aus Payload** kommen und **statische Next.js-Defaults bewusst überschreiben**, sobald im CMS Werte gesetzt sind.

### 4.1 Defaults nur als Fallback

- In **`layout.tsx`** / Root-**`metadata`** nur noch **minimale Fallbacks** halten (Site-Name, Basis-Locale, ein generisches `description`, falls nichts aus Payload geladen werden kann).
- Pro Route **`generateMetadata`** (oder gleichwertige Datenquelle) nutzen und **Payload-Daten** (z. B. Globals wie „SEO“, Seiten-/Post-Dokumente) laden.
- Wenn Payload Felder liefert, diese **explizit zurückgeben**, sodass sie die Root-Defaults **ersetzen** (nicht nur ergänzen, wenn ihr vollständige Kontrolle aus dem CMS wollt). Leere CMS-Felder können weiterhin auf die Fallbacks aus dem Layout zurückfallen — das Verhalten im Projekt einheitlich festlegen.

### 4.2 OG-Bilder und Media

- **`openGraph.images`** / **`twitter.images`** aus Payload beziehen (z. B. Relation zur **Media**-Collection, absolute URLs für Produktion), damit Social-Previews nicht auf statischen Platzhaltern aus dem Repo hängen bleiben.

### Kurzüberblick (Todo 4)

| Ziel | Wo | Wie |
| ---- | -- | --- |
| CMS > Default | Route-`generateMetadata` + ggf. Globals | Payload-Werte setzen `title`, `description`, `openGraph`, … und überschreiben Root-Defaults |
| Konsistenz | Layout | Nur schmale Fallbacks, keine „harten“ Marketing-Texte, die das CMS später nicht ersetzt |
