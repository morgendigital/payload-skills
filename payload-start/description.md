# Neues Payload-Website-Setup — Checkliste

Reihenfolge: **Todo 0** Template lauffähig machen → **Todo 1** Media-Defaults → **Todo 2** S3 mit `@payloadcms/storage-s3` → **Todo 3** Production-Build → **Todo 4** stabiler Server-Actions-Key → **Todo 5** Template-Reste aus dem Admin entfernen.

> **Todo 0 steht am Ende dieser Datei, gehört aber an den Anfang der Arbeit.** Ab Payload 3.90 / Next 16 ist das offizielle Website-Template nicht lauffähig, wie es ausgeliefert wird: `pnpm build` ruft einen Befehl auf, den es nicht gibt, `pnpm lint` stürzt ab, und `tsc` bricht ab, bevor es eine Datei ansieht. Wer das nicht zuerst behebt, sucht die Ursache später im eigenen Code.

**Deployment:** Standard ist **Dokploy auf einem Hetzner-Server** (Docker, eigene VM) — **nicht** Vercel. Upload-Grenzen kommen hier vor allem von **Payload** (`upload.limits`) und vom **Reverse Proxy** (z. B. Nginx Proxy Manager: `client_max_body_size`), nicht von einem Serverless-Body-Limit.

## Todo 1: Bild-Upload — Größe, WebP und Resize

Beim Aufsetzen einer neuen Payload-Website zuerst die Media-/Upload-Einstellungen setzen (Dateigröße global, Format WebP, maximale Pixelmaße).

### 1.1 Maximale Upload-Dateigröße (global)

**Datei:** `src/payload.config.ts`

- **`upload.limits.fileSize: 5000000`** – maximal **5 000 000 Byte** (~5 MB dezimal) pro Datei im Multipart-Upload (gilt für Payload-Uploads, u. a. Media).
- **`upload.abortOnLimit: true`** – wenn die Datei größer ist, bricht der Upload ab mit **HTTP 413** statt die Datei still zu kürzen.

Damit wird die Grenze beim Parsen der Anfrage durchgesetzt (Busboy/Payload-`upload`-Optionen), nicht nur in der Media-Collection.

### 1.2 WebP-Konvertierung

> ⚠️ **`formatOptions` auf Collection-Ebene reicht nicht.** Es wandelt **nur die Hauptdatei** um.
> Jede Größe in `imageSizes` braucht ihre **eigene** `formatOptions` — sonst behalten die Varianten
> das Quellformat des Uploads. Und genau die Varianten liefert `next/image` aus, nicht das Original.
> Hintergrund, Messwerte und Reparaturskript: [media-webp-variants](../media-webp-variants/description.md).

**Datei:** `src/collections/Media.ts`

```ts
const WEBP = { format: 'webp' as const, options: { quality: 76 } }

upload: {
  formatOptions: WEBP,                                      // Hauptdatei
  imageSizes: [
    { name: 'thumbnail', width: 300, formatOptions: WEBP }, // ← jede Größe einzeln
    { name: 'small',     width: 600, formatOptions: WEBP },
    // …
  ],
}
```

- **Hauptdatei:** `upload.formatOptions` – hochgeladene Bilder werden mit **Sharp** in **WebP** ausgegeben.
- **Varianten:** `formatOptions` **je Eintrag** in `imageSizes`. Ohne diese Angabe erbt die Variante
  nichts vom Collection-Level. Ein PNG-Upload erzeugt dann ein WebP-Original mit PNG-Ablegern.

### 1.3 Begrenzung der Bildabmessungen (keine „Riesen“-Originale)

**Datei:** `src/collections/Media.ts`

- **`resizeOptions`** (Sharp `resize`):
  - **`width: 2560`**, **`height: 2560`**
  - **`fit: 'inside'`** – Bild bleibt im Seitenverhältnis und passt in diese Box (längere Kante max. 2560 px).
  - **`withoutEnlargement: true`** – kleinere Bilder werden **nicht** hochskaliert.

Die **Original-Datei** in der Media-Collection wird damit beim Upload verkleinert. Zusätzlich erzeugt **`imageSizes`** weiterhin die definierten Varianten (thumbnail, small, medium, large, xlarge, og, …).

### Kurzüberblick (Todo 1)

| Ziel                 | Wo                  | Wie                                                  |
| -------------------- | ------------------- | ---------------------------------------------------- |
| Dateigröße cap       | `payload.config.ts` | `limits.fileSize` + `abortOnLimit`                   |
| WebP (Hauptdatei)    | `Media.ts`          | `upload.formatOptions`                               |
| WebP (**Varianten**) | `Media.ts`          | `formatOptions` **je Eintrag** in `imageSizes` ⚠️     |
| Max. Pixelmaße       | `Media.ts`          | `resizeOptions` (Sharp, `fit: 'inside'`)             |

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

Ohne festen Key erzeugt Next.js bei **jedem Build** einen neuen und verschlüsselt die
Server-Action-Referenzen damit. Clients, die noch die alte Version offen haben, laufen
danach in `Failed to find Server Action`. Einmalig `openssl rand -base64 32` erzeugen, als
`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` in Dokploy hinterlegen (vor dem nächsten Build) und
über alle Deployments und Instanzen identisch halten.

**Ursache, Dev-vs-Prod-Verhalten, `deploymentId` gegen Version-Skew und Checkliste:
[server-actions-encryption](../server-actions-encryption/description.md).**

## Todo 5: Template-Reste aus dem Admin entfernen

**Dateien:** `src/payload.config.ts`, `src/components/BeforeDashboard/`, `src/components/BeforeLogin/`,
`src/endpoints/seed/`

Das offizielle Website-Template liefert einen Willkommens-Block auf dem Dashboard, den der Kunde
am ersten Tag sieht:

> Seed your database with a few pages, posts, and projects to jump-start your new site …
> Modify your collections and add more fields as needed …
> **Commit and push your changes to the repository to trigger a redeployment of your project.**

Das ist Entwickler-Onboarding im CMS des Kunden — inklusive einer Anleitung, wie er sein Repo
deployt. Es gehört in **jedem** Projekt raus, und zwar aus vier Gründen, von denen nur der erste
kosmetisch ist:

1. **Es ist nicht das Produkt.** Der Kunde bezahlt ein CMS, kein Template mit Restbeschriftung.
   Der Platz gehört den eigenen Widgets (SEO-Status, wartende Jobs, Redaktionshandbuch).
2. **Der Seed-Knopf ist ein Datenverlust-Risiko.** Der Link ruft den Seed-Endpoint des Templates
   auf, der Demo-Inhalte anlegt und dafür Collections leert bzw. überschreibt. In einem
   Kundenprojekt ist das ein Knopf, der die Redaktionsarbeit von Wochen wegräumt — **einmal
   nachlesen, was der Seed in eurer Template-Version genau tut**, und dann Route *und* Endpoint
   entfernen. Ausblenden reicht nicht: Die Route bleibt sonst aufrufbar.
3. **Es verweist auf Dinge, die es nicht gibt.** „Commit and push" trifft auf einen Redakteur zu,
   der kein Repo hat, und die Links zeigen in die Payload-Doku statt in eure.
4. **Es signalisiert, dass niemand aufgeräumt hat.** Genau wie das nie ersetzte
   `/website-template-OG.webp`, das in
   [seo-meta-check §1](../seo-meta-check/description.md#1-der-bug-das-website-template-überschreibt-die-defaults-nicht)
   dokumentiert ist — dasselbe Muster, andere Stelle.

### Die Liste

| Rest | Wo | Was zu tun ist |
| --- | --- | --- |
| Willkommens-Block auf dem Dashboard | `admin.components.beforeDashboard` | Eintrag entfernen, Ordner `BeforeDashboard/` löschen |
| Seed-Endpoint samt Route | `src/endpoints/seed/`, Registrierung in der Config | **Löschen**, nicht auskommentieren |
| Login-Hinweistext des Templates | `admin.components.beforeLogin` | **Slot behalten, Inhalt ersetzen** — siehe unten |
| Payload-Branding im Tab | `admin.meta` (`titleSuffix`, `icons`, `openGraph`) | Auf die Marke setzen: eigenes Favicon, `titleSuffix: ' — Marke'` |
| Demo-Inhalte und Demo-Medien | `pages`, `posts`, `projects`, `media` | Vor Übergabe löschen, inklusive der Bilddateien im Bucket |
| Demo-Benutzer (`demo@payloadcms.com` o. ä.) | `users` | Löschen; echte Redaktions-Accounts anlegen |

```ts
// src/payload.config.ts — vorher
admin: {
  components: {
    beforeLogin: ['@/components/BeforeLogin'],
    beforeDashboard: ['@/components/BeforeDashboard'],
  },
}

// nachher — derselbe Platz, aber mit eigenem Inhalt
admin: {
  meta: { titleSuffix: ' — Marke', icons: [{ url: '/favicon.svg', type: 'image/svg+xml' }] },
  components: {
    beforeLogin: ['@/components/BeforeLogin'],        // bleibt — nur der Inhalt ist neu
    beforeDashboard: [
      '@/components/SeoCheck/Widget#SeoCheckWidget',   // seo-meta-check §5.4
      '@/components/Handbuch/Widget#HandbuchWidget',   // optional: Kontakt + Kurzanleitung
    ],
  },
}
```

### `beforeLogin` behalten — nur den Inhalt austauschen

Der Slot ist kein Template-Rest, sondern die einzige Stelle, an der die Login-Seite etwas sagen
kann. Raus muss der Text des Templates (Verweise auf „create your first user" und in die
Payload-Doku); rein gehört, was der Redakteur an genau dieser Stelle braucht:

```tsx
// src/components/BeforeLogin/index.tsx
export const BeforeLogin: React.FC = () => (
  <div className="before-login">
    <p>
      <strong>Redaktionsbereich — Marke</strong>
      <br />
      Hier pflegen Sie die Inhalte Ihrer Website.
    </p>
    <p>
      Zugang vergessen oder Probleme beim Anmelden?{' '}
      <a href="mailto:support@northlight.at">support@northlight.at</a>
    </p>
  </div>
)
```

- **Wer hilft, wenn es klemmt.** Der häufigste Support-Fall ist „ich komme nicht rein" — und
  genau dann ist die Adresse der Agentur nicht zur Hand. Ein Satz hier spart pro Projekt mehrere
  Rückfragen über Umwege.
- **Welche Seite das überhaupt ist.** Wer drei Kundenprojekte betreut, sieht dreimal dasselbe
  Payload-Login. Marke plus Projektname beantworten das in einer Zeile.
- **Bei Keycloak-Projekten steht hier der eigentliche Weg hinein** — der Link auf das
  Keycloak-Login bzw. die Account-Konsole, weil das lokale Passwortformular dort bewusst nicht
  mehr benutzt wird ([keycloak](../keycloak/description.md)).

→ **Die Login-Seite ist öffentlich.** Also eine allgemeine Support-Adresse statt einer
persönlichen (sie wird abgegriffen), keine Beispiel-Benutzernamen, keine Hinweise auf
Rollennamen oder interne Systeme. Was hier steht, liest jeder, der die URL kennt.

→ **`beforeDashboard` ist dasselbe Array**, in das der SEO-Status aus
[seo-meta-check §5.7](../seo-meta-check/description.md#57-verdrahtung) kommt. Wer das Widget
ergänzt, ohne den Template-Block zu entfernen, hat beides untereinander stehen — der häufigste
Zustand in unseren Projekten.

→ **Nach dem Entfernen `pnpm payload generate:importmap` laufen lassen.** Die gelöschten
Komponenten stehen sonst weiter in der Import-Map und zeigen auf Dateien, die es nicht mehr gibt.

### Gegenprüfen

```bash
# Keine Template-Komponenten mehr registriert oder vorhanden?
grep -rn "BeforeDashboard\|endpoints/seed" src/ || echo "sauber"
# BeforeLogin bleibt — hier nur prüfen, dass der Template-Text ersetzt wurde:
grep -rn "create your first user\|payloadcms.com/docs" src/components/BeforeLogin/ || echo "eigener Text"

# Seed-Route wirklich weg (nicht nur der Link)?
curl -s -o /dev/null -w '%{http_code}\n' https://domain.at/next/seed   # erwartet: 404
```

→ Der zweite Befehl ist der wichtige. Der Link im Dashboard ist schnell entfernt; die Route
dahinter bleibt, bis der Endpoint gelöscht ist.

## Todo 0: Das Template ist nicht lauffähig, wie es ausgeliefert wird

**Betrifft:** Payload 3.90.x mit Next.js 16.3, TypeScript 6, ESLint 9 — also jedes Projekt,
das ab jetzt neu aufgesetzt wird. Gemessen an frechinger (Template-Tag `v3.90.1`, Node 24,
pnpm 10).

Vier Fehler, die alle vor der ersten Zeile eigenem Code auftreten. Drei davon lassen die
Standard-Skripte hart fehlschlagen; der vierte ist still und deshalb der teuerste.

### 0.1 Vom Release-Tag klonen, nicht von `main`

`templates/website` auf `main` ist der Canary-Stand und benutzt APIs, die im letzten
Release noch nicht existieren. Konkret importiert `src/collections/Media.ts` dort
`createFolderField` aus `payload` — mit der veröffentlichten 3.90.1 bricht schon das
Laden der Config ab:

```
SyntaxError: The requested module 'payload' does not provide an export named 'createFolderField'
```

Also den Tag nehmen, der zur installierten Payload-Version passt:

```bash
TAG=$(gh api repos/payloadcms/payload/releases/latest --jq '.tag_name')
git clone --depth 1 --branch "$TAG" --filter=blob:none --sparse \
  https://github.com/payloadcms/payload.git /tmp/payload-src
cd /tmp/payload-src && git sparse-checkout set templates/website
```

Und in der `package.json` alle `workspace:*` durch genau diese Version ersetzen — im
Monorepo lösen sie sich auf, im Kundenprojekt nicht.

### 0.2 `pnpm build` ruft einen Befehl auf, den es nicht gibt

Das Template setzt:

```json
"build": "cross-env NODE_OPTIONS=--no-deprecation payload build"
```

`payload build` ist in 3.90.1 **kein Befehl**. Der CLI antwortet mit
`Unknown command: "build"` und listet die verfügbaren Befehle — `generate:types`,
`generate:importmap`, `migrate*`, `run`, `jobs:*`, `info`. Kein `build`.

Fällt in der Praxis erst beim ersten Deployment auf, weil lokal alle `pnpm dev` benutzen.

→ Todo 3 ersetzt dieses Skript ohnehin durch `node scripts/build.mjs`. Der Punkt hier ist
nur: **nicht suchen, warum der Build auf Dokploy nichts tut** — er ist nie gelaufen.

→ Im Wrapper daran denken, dass die Vorabprüfungen **vor** `next build` laufen und die
`.env`-Dateien deshalb noch nicht geladen sind. Ohne eigenes `dotenv.config()` meldet der
Wrapper eine fehlende `DATABASE_URL`, die in der `.env` längst steht.

### 0.3 `pnpm lint` stürzt ab

```
TypeError: Converting circular structure to JSON
    at ConfigValidator.formatErrors (@eslint/eslintrc/lib/shared/config-validator.js:299)
```

Die `eslint.config.mjs` des Templates schleust `eslint-config-next` über `FlatCompat`
ein. `eslint-config-next` 16 liefert aber **native Flat-Configs** — der Kompatibilitäts-
Umweg läuft in einen Zirkelbezug.

```js
// vorher — FlatCompat
import { FlatCompat } from '@eslint/eslintrc'
const compat = new FlatCompat({ baseDirectory: __dirname })
const eslintConfig = [...compat.extends('next/core-web-vitals', 'next/typescript'), /* … */]

// nachher — direkt importieren
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'
import nextTypescript from 'eslint-config-next/typescript'
const eslintConfig = [...nextCoreWebVitals, ...nextTypescript, /* … */]
```

Danach läuft der Lint — und meldet auf unverändertem Template-Code fünf Fehler aus den
neuen React-Compiler-Regeln (`setState` im Effect-Body in `Header/Component.client.tsx`
und beiden Theme-Providern, Ref-Zugriff während des Renders in `components/Card`). Die
gehören in einen eigenen Durchgang, nicht ins Setup-Ticket — aber man sollte wissen, dass
sie da sind, bevor man Lint in die CI hängt.

### 0.4 `tsc` läuft gar nicht erst durch — und das ist der stille Fehler

TypeScript 6 meldet zuerst:

```
tsconfig.json(4,5): error TS5101: Option 'baseUrl' is deprecated and will stop functioning in TypeScript 7.0.
```

Das ist ein **harter Abbruch, kein Hinweis**: Der Typecheck bricht ab, bevor er eine
einzige Datei ansieht. Wer nur auf den Exit-Code schaut, hält das für „ein Fehler, schnell
behoben" — tatsächlich verdeckt es alles dahinter.

`"ignoreDeprecations": "6.0"` setzen — und `baseUrl` dabei **behalten**. Nimmt man es
stattdessen heraus, tauschen sich die Fehler nur aus: Das Template importiert an fünf
Stellen bare Pfade (`from 'src/payload-types'`, `from 'src/utilities/formatDateTime'`),
die genau über `baseUrl` aufgelöst wurden. TypeScript 6 löst sie ohnehin nicht mehr auf.

Betroffen: `blocks/Banner/Component.tsx`, `heros/PostHero/index.tsx`,
`utilities/getGlobals.ts`, `utilities/getDocument.ts`,
`collections/Posts/hooks/populateAuthors.ts`.

```bash
grep -rl "from 'src/" src --include='*.ts' --include='*.tsx' | xargs sed -i '' "s|from 'src/|from '@/|g"
```

→ **Warum das mehr ist als fünf Imports:** `getGlobals.ts` und `getDocument.ts` leiten ihre
Typen aus dem fehlgeschlagenen Import ab. Solange er nicht auflöst, ist `Config` still `any`,
`keyof Config['globals']` wird zu `string | number | symbol`, und die Generics der beiden
Cache-Helfer sind damit komplett wirkungslos — ohne dass irgendetwas rot wäre. Erst nach
dem Fix steht dort wieder `'header' | 'footer'`. Ein Typecheck, der nicht läuft, meldet
eben auch keine Typfehler.

### 0.5 Videos sind 404 — still

`components/Media/VideoMedia/index.tsx` baut die Quelle selbst:

```tsx
<source src={getMediaUrl(`/media/${filename}`)} />
```

Die Route `/media/…` gibt es nicht; Payload liefert Uploads unter `/api/media/file/…`
aus (mit S3-Adapter genauso). Die Media-Collection des Templates hat keine
`mimeTypes`-Einschränkung, ein Video laesst sich also hochladen, steht im Admin korrekt
da — und das `<video>` auf der Seite bleibt leer. Kein Fehler im Build, keiner im Log.

```tsx
const { mimeType, updatedAt, url } = resource
<source src={getMediaUrl(url, updatedAt)} type={mimeType ?? undefined} />
```

Gefunden in frechinger beim Umstellen der Bilder auf imgproxy, nicht durch ein Video.

### 0.6 Node 24 aus dem Template bricht den Dokploy-Build

Das Template setzt `"engines": { "node": ">=24.15.0" }`. Dokploy baut mit **Nixpacks 1.35**,
und das stellt kein Node 24 bereit — es findet keine passende Version und nimmt **ohne
Warnung** den Default Node 18. Im Log steht es nur im Setup-Kasten (`nodejs_18`), der Build
scheitert danach an `You are using Node.js 18.20.5. For Next.js, Node.js version ">=20.9.0"
is required.` Eine `.nvmrc` mit `24` aendert daran nichts.

Weder Payload 3.90 (`^18.20.2 || >=20.9.0`) noch Next 16 (`>=20.9.0`) brauchen 24:

```json
"engines": { "node": ">=22.0.0" }
```

plus `.nvmrc` auf `22`. Gefunden in frechinger beim ersten Deploy.

### Gegenprüfen

```bash
npx tsc --noEmit && echo "typecheck ok"
pnpm lint
pnpm build            # muss echtes SSG erzeugen, nicht nur durchlaufen:
node -e "const m=require('./.next/prerender-manifest.json'); console.log(Object.keys(m.routes).length)"
```

Der letzte Befehl ist der entscheidende — ein grüner Build ohne prerenderte Routen ist
genau der Zustand, den [static-rendering](../static-rendering/description.md) beschreibt.
