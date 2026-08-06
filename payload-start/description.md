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

## Todo 3: Production-Build — voller `next build` mit DB-Zugriff

**Datei:** `package.json` → Skript `build`

Nach Media-Defaults (Todo 1) und S3-Plugin (Todo 2) ist das der **Build-Schritt**. Es bleibt bei **einem** `next build` — der zweistufige `experimental-build-mode` rutscht in die Fallback-Zeile:

```json
"build": "node scripts/build.mjs",
"build:no-db": "cross-env NODE_OPTIONS=--no-deprecation next build --experimental-build-mode generate-env && cross-env NODE_OPTIONS=--no-deprecation next build --experimental-build-mode compile"
```

### Warum nicht mehr zweistufig

`generate-env` → `compile` ist ein **Build-ohne-Datenbank**-Modus. Er überspringt nicht nur das Prerendering, er schaltet den Route-Cache komplett ab: Alle Routen landen als `ƒ (Dynamic)` im Build-Output, `prerender-manifest.json` bleibt leer, und jede Anfrage rendert live aus Mongo — auch wenn im Code `export const revalidate = …` steht. An northlight.at gemessen (`/agency`, `next start`):

| Build | erste Anfrage | Folgeanfragen |
| ----- | ------------- | ------------- |
| `generate-env` → `compile` | ~330 ms, kein Cache-Header | ~330 ms, **kein Cache** |
| voller `next build` | **11 ms**, `x-nextjs-cache: HIT` | **5 ms**, HIT |

Der Fallback bleibt trotzdem im `package.json` stehen: Wenn die DB beim Bauen partout nicht erreichbar ist, kommt man damit durch ein Deployment — mit dem Wissen, dass die Seite dann ungecacht läuft.

### Was der volle Build voraussetzt

- **DB-Zugriff auf der Build-Maschine.** Läuft der Build woanders als die Datenbank, braucht er eine eigene Adresse — dafür der `DATABASE_URI_BUILD`-Wrapper in `scripts/build.mjs` (Dokploy gibt Nixpacks denselben Variablensatz für Build und Laufzeit).
- **Vollständige Build-Env**, insbesondere `NEXT_PUBLIC_SERVER_URL` mit der **Produktions-URL** — sie wird in `canonical` und `og:url` jeder prerenderten Seite eingebacken.
- **Korrekte `generateStaticParams`** über alle dynamischen Segmente. Fehlt ein Elternsegment wie `[locale]`, prerendert Next **stillschweigend nichts** und der Build sieht trotzdem grün aus.
- **Revalidierung auf internen Pfaden**, sonst bleiben die statischen Seiten nach einem Publish stehen.

Schlägt der Build fehl, behält Dokploy den laufenden Container — das Risiko ist ein fehlgeschlagenes Deployment, keine kaputte Seite.

`NODE_OPTIONS=--no-deprecation` unterdrückt weiterhin nur Lärm von veralteten Node-APIs; der Wrapper reicht ein von außen gesetztes `NODE_OPTIONS` (z. B. ein größeres Heap-Limit) durch, statt es zu überschreiben.

**Die Details zu Params, Middleware-Rewrites, Revalidierung und der Build/Laufzeit-Trennung stehen in [static-rendering](../static-rendering/description.md).**

## Todo 4: Stabiler Server-Actions-Encryption-Key (Dokploy)

**Datei:** Dokploy-Environment (Production) — **nicht** ins Repo committen

Nach jedem Deployment kann es passieren, dass Browser-Tabs, die noch die alte App-Version geladen haben, plötzlich Fehler werfen oder die App komplett abschmiert. Ursache sind die **Server-Action-IDs**: Next.js vergibt beim Build pro Server Action einen Hash. Wenn sich diese IDs zwischen Builds ändern, schicken alte Clients Requests mit IDs, die der neue Server nicht mehr kennt.

### Warum trifft uns das besonders hart

Der **zweistufige Build** (die Fallback-Zeile aus Todo 3, `generate-env` → `compile`) kann zwischen den Phasen unterschiedliche Action-IDs erzeugen. Zusätzlich generiert Next.js **ohne** stabilen Encryption Key bei **jedem Build** einen neuen Key — damit ändern sich auch die verschlüsselten Action-Referenzen, und alte Clients laufen ins Leere.

### Lösung — fixer Encryption Key

Eine feste Env-Variable setzen, damit Action-IDs und Verschlüsselung über Builds **und** Server-Instanzen hinweg stabil bleiben:

```env
NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=<32-byte-base64-key>
```

Key generieren (einmalig):

```bash
openssl rand -base64 32
```

**Wichtig:**

- Den **gleichen Wert** auf **allen** Server-Instanzen und über **alle** Deployments hinweg verwenden.
- In Dokploy als Environment-Variable hinterlegen (Production), **nicht** in `.env` im Repo.
- Nur ändern, wenn der Key bewusst rotiert werden soll — eine Rotation invalidiert alle in-flight Action-Referenzen alter Clients.

### Crash statt 500er

Eigentlich sollte ein unbekannter Action-Hash nur einen **500er pro Request** werfen, nicht den ganzen Prozess killen. Wenn die App nach einem Deploy komplett abschmiert, liegt das meist an einem **unhandled rejection** in einer Server Action oder am Memory-Limit. Beim Setup in `next.config.js` auf realistische Werte achten (z. B. `NODE_OPTIONS=--max-old-space-size=2048`, `experimental.cpus`) und Server Actions konsequent in `try/catch` kapseln.
