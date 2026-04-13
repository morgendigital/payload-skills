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
