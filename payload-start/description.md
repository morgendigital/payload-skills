# Neues Payload-Website-Setup — Checkliste

Reihenfolge: **Todo 1** Media-Defaults → **Todo 2** S3 mit `@payloadcms/storage-s3` → **Todo 3** zweistufiger Production-Build.

**Deployment:** Standard ist **Dokploy auf einem Hetzner-Server** (Docker, eigene VM) — **nicht** Vercel. Upload-Grenzen kommen hier vor allem von **Payload** (`upload.limits`) und vom **Reverse Proxy** (z. B. Nginx Proxy Manager: `client_max_body_size`), nicht von einem Serverless-Body-Limit.

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

## Todo 2: S3 Storage — `@payloadcms/storage-s3`

Für neue Sites setzen wir Uploads **nicht** dauerhaft auf dem App-Server-Dateisystem ab, sondern nutzen das **offizielle Plugin** [`@payloadcms/storage-s3`](https://www.npmjs.com/package/@payloadcms/storage-s3) (S3-kompatibel: AWS S3, Cloudflare R2, MinIO, …). Ältere Projekte migrieren vom Paket `@payloadcms/plugin-cloud-storage` + `s3Adapter` auf dieses Standalone-Paket — siehe [Payload: Migration / Cloud Storage](https://payloadcms.com/docs/migration-guide/overview).

### 2.1 Paket installieren

```bash
pnpm add @payloadcms/storage-s3
# bzw. npm install / yarn add — @aws-sdk/client-s3 wird typischerweise mitgezogen
```

### 2.2 Umgebungsvariablen (Produktion & Preview)

| Variable | Zweck |
|----------|--------|
| `S3_BUCKET` | Bucket-Name |
| `S3_ACCESS_KEY_ID` | IAM / API-Zugang (nicht committen) |
| `S3_SECRET_ACCESS_KEY` | Geheimnis (nicht committen) |
| `S3_REGION` | z. B. `eu-central-1` |

Lokal kann derselbe Bucket genutzt werden oder ein separater Dev-Bucket — wichtig ist, dass **`NEXT_PUBLIC_*` nicht** für Secret-Keys verwendet wird.

### 2.3 `payload.config.ts` — Plugin einbinden

**Datei:** `src/payload.config.ts` (Pfad je nach Projekt)

- Pro **Upload-Collection** (Slug z. B. `media`) in `s3Storage({ collections: { … } })` eintragen — der Slug muss exakt zur Collection passen.
- **`bucket`** und **`config`** (AWS `S3ClientConfig`: `credentials`, `region`, optional `endpoint` für R2/MinIO) aus Env befüllen.

```ts
import { s3Storage } from '@payloadcms/storage-s3'
// import { Media } from './collections/Media'

export default buildConfig({
  // collections: [Media, …],
  plugins: [
    s3Storage({
      collections: {
        media: true,
        // optional: Prefix pro Collection
        // documents: { prefix: 'private-docs' },
      },
      bucket: process.env.S3_BUCKET!,
      config: {
        credentials: {
          accessKeyId: process.env.S3_ACCESS_KEY_ID!,
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
        },
        region: process.env.S3_REGION!,
        // R2 / MinIO: endpoint + forcePathStyle — siehe Payload-Doku „Storage adapters“
      },
    }),
  ],
})
```

Wenn das Plugin für eine Collection aktiv ist, setzt Payload **`disableLocalStorage: true`** für diese Collection — Dateien landen im Bucket, nicht unter `staticDir` auf dem Server.

### 2.4 Bucket & Sicherheit (Kurz)

- Bucket **nicht** öffentlich „List/Get für Everyone“ — Zugriff über die App; mit Standard-Plugin bleiben URLs typischerweise über Payloads Dateipfad, sodass **`access.read`** der Collection greift (siehe Security-Checkliste, Abschnitt private Uploads).
- **`disablePayloadAccessControl: true`** und **`generateFileURL`** nur, wenn bewusst **öffentliche** CDN-URLs gewünscht sind — dann entfällt Payloads Zugriffskontrolle auf der Datei-URL; siehe [Payload: Storage adapters](https://payloadcms.com/docs/upload/storage-adapters).

### 2.5 Große Dateien (Dokploy / Hetzner)

Auf **eigener Infrastruktur** entfällt das typische **Vercel-Limit** (~4,5 MB) für Server-Uploads. Praktisch limitieren:

- **`upload.limits.fileSize`** in `payload.config.ts` (siehe Todo 1),
- der **Reverse Proxy** vor dem Container (Body-Size erhöhen, falls 413 bei großen Dateien),
- ggf. **Timeout** / Ressourcen des Containers bei sehr großen Dateien.

**`clientUploads: true`** im S3-Plugin ist bei uns **optional**: sinnvoll, wenn ihr Uploads direkt zum Bucket vom Browser schicken wollt (weniger Last auf dem App-Container) oder wenn ihr bewusst große Dateien ohne langen Request durch den Proxy fahren wollt. Dann am Bucket **CORS** für `PUT` von der Produktions-**Origin** freigeben — siehe [README `@payloadcms/storage-s3`](https://github.com/payloadcms/payload/blob/main/packages/storage-s3/README.md). In der Payload-Doku wird `clientUploads` oft im Vercel-Kontext genannt; für **Dokploy + Hetzner** ist es meist keine Pflicht.

### Kurzüberblick (Todo 2)

| Ziel | Wo | Wie |
| ---- | -- | --- |
| S3-kompatibler Speicher | `payload.config.ts` | `s3Storage({ collections, bucket, config })` |
| Secrets | `.env` / Hosting | `S3_*` niemals im Repo |
| Private Medien | Collection + Bucket-Policy | `access.read` streng; kein öffentlicher Bucket-Zugriff |
| Sehr große Uploads / Entlastung App | Plugin optional | `clientUploads` + Bucket-CORS; Proxy-Body-Limit prüfen |

## Todo 3: Production-Build — zweistufiger Next.js-Build (`experimental-build-mode`)

**Datei:** `package.json` → Skript `build`

Ersetze ein einfaches `next build` durch eine **zweistufige** Pipeline (hier mit `cross-env` und unterdrückten Deprecation-Warnungen über `NODE_OPTIONS`):

```json
"build": "cross-env NODE_OPTIONS=--no-deprecation next build --experimental-build-mode generate-env && cross-env NODE_OPTIONS=--no-deprecation next build --experimental-build-mode compile"
```

### Warum zwei Schritte?

Next.js kann den Build in Modi aufteilen, die **Kompilierung** und **Einbetten von Umgebungsvariablen** voneinander trennen (experimentell):

- **`generate-env`** — Phase, in der **`NEXT_PUBLIC_*`** (und zugehörige Build-Zeit-Env) in die Bundles **eingebettet** werden, damit der Client die erwarteten öffentlichen Werte sieht.
- **`compile`** — experimenteller **Compile**-Lauf; Next kann dabei **ohne** vorheriges Einbrennen von Env-Werten in Zwischenartefakte arbeiten, sodass reine Compile-Outputs **unabhängiger von konkreten Env-Werten** cachbar sind (sinnvoll für CI-Cache oder Docker-Layer).

Statt eines einzigen `next build` nutzt ihr **zwei** `next build`-Aufrufe mit unterschiedlichen Modi — nach Media-Defaults (Todo 1) und S3-Plugin (Todo 2) ist das der **Build-Schritt** (Todo 3). `NODE_OPTIONS=--no-deprecation` unterdrückt nur Lärm von veralteten Node-APIs während des Builds.

**Reihenfolge:** In der Next.js-Doku und in vielen CI-/Docker-Beispielen ist **`compile` zuerst**, danach **`generate-env`** üblich. Die obige Zeile entspricht der gewünschten Projektvorgabe (`generate-env` → `compile`); wenn der Build fehlschlägt oder Env-Werte fehlen, mit der Reihenfolge **`compile` → `generate-env`** gegenprüfen. Modi sind an die **Next.js-Version** gebunden und können sich ändern.
