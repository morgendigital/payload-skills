# Bild-Optimierung mit imgproxy (off-server AVIF/WebP)

Wie Bilder in einem Payload-/Next.js-Projekt ausgeliefert werden, **ohne** dass der
`next/image`-Optimizer (Sharp) auf dem App-Server läuft. Auf self-hosted Setups
(Dokploy/Hetzner) ist genau dieser Optimizer der Hauptgrund für **OOM-Kills und
Crash-Loops** unter Last: pro Bild-Request wird das Original aus S3 geholt und mit
Sharp neu encodiert — bei Crawler-/Traffic-Concurrency sprengt das das Memory-Limit.

Lösung: eine zentrale **imgproxy**-Instanz (Go + libvips, schnell & speicher-schonend)
liest das Original direkt aus S3 und encodiert on-the-fly, mit **AVIF/WebP** je nach
`Accept`-Header. Sharp läuft nur noch **einmal beim Upload** (Payload), nie pro Request.

> Voraussetzung: Media-Grundsetup (Upload-Limits, WebP, Sharp-Resize, `@payloadcms/storage-s3`)
> steht bereits — siehe [payload-start/description.md](../payload-start/description.md).
> Diese Skill baut darauf auf und ersetzt den on-server Optimizer.

Reihenfolge: **Todo 1** imgproxy in Dokploy → **Todo 2** Cloudflare → **Todo 3** Next.js-Integration → **Todo 4** Fallstricke → **Todo 5** Verifizieren.

## Architektur

```
Browser
  │  <img src="https://imgproxy.<domain>/insecure/rs:fit:1200/q:80/plain/s3://bucket/bild.jpg">
  ▼
Cloudflare (Edge-Cache + Rate-Limit)     ← cacht optimierte Derivate
  ▼
nginx (Disk-Cache, Accept-aware)         ← im selben Compose
  ▼
imgproxy (libvips, AVIF/WebP, resize)    ← liest Original per S3-Credentials
  ▼
S3-Bucket (Originale bleiben privat)
```

---

## Todo 1: imgproxy + nginx-Cache in Dokploy

Ein **Compose-Service** (wie die bestehenden `minio`-Services). **Eine** Instanz kann
alle Projekte bedienen, die aus demselben S3 lesen.

> **Default/Shared-Instanz (morgendigital):** Es läuft bereits eine gemeinsame
> Instanz unter **`https://imgproxy.northlight.website`**, die den zentralen
> S3 (`storage.morgendigital.website`) liest. Für ein **neues Projekt am selben
> S3** ist Todo 1 damit i. d. R. **erledigt** — direkt zu **Todo 3** springen und
> nur `NEXT_PUBLIC_IMGPROXY_URL=https://imgproxy.northlight.website` +
> `NEXT_PUBLIC_IMGPROXY_BUCKET=s3://<bucket>` setzen. Eine **eigene** Instanz nur
> aufsetzen, wenn ein Projekt aus einem **anderen** S3/Bucket-Endpoint liest.

**Wichtig:**
- **S3 nativ** einbinden (`IMGPROXY_USE_S3`), nicht per HTTP — Payload-Media sind i. d. R.
  `acl: private`, ein HTTP-Fetch der Originale schlägt fehl. Mit S3-Credentials liest
  imgproxy privat, liefert aber öffentlich optimierte Derivate aus.
- **AVIF/WebP-Detection anschalten.** Format wird über den `Accept`-Header ausgehandelt —
  **kein `f:auto`** in der URL (das ist **kein** gültiger imgproxy-Wert und führt zu 404).
- Domain in Dokploy auf den **nginx**-Service (Port 80) legen, **nicht** auf imgproxy —
  sonst umgehst du den Cache. imgproxy bleibt intern (`expose`).

```yaml
version: "3.8"
services:
  imgproxy:
    image: darthsim/imgproxy:v3.30.1
    restart: unless-stopped
    expose:
      - 8080
    environment:
      # --- S3-Quelle (privat, per Credentials) ---
      IMGPROXY_USE_S3: "true"
      IMGPROXY_S3_ENDPOINT: "https://<dein-s3-endpoint>"
      IMGPROXY_S3_REGION: ${S3_REGION:-eu-north-1}
      AWS_ACCESS_KEY_ID: ${S3_ACCESS_KEY_ID}
      AWS_SECRET_ACCESS_KEY: ${S3_SECRET_ACCESS_KEY}
      IMGPROXY_ALLOWED_SOURCES: "s3://"          # nur dein S3, keine fremden URLs
      # --- Format: automatische AVIF/WebP-Aushandlung via Accept ---
      IMGPROXY_ENABLE_WEBP_DETECTION: "true"
      IMGPROXY_ENABLE_AVIF_DETECTION: "true"
      # --- Sicherheit / Limits ---
      IMGPROXY_MAX_SRC_FILE_SIZE: ${IMGPROXY_MAX_SRC_FILE_SIZE:-31457280}   # 30 MB
      IMGPROXY_MAX_SRC_RESOLUTION: ${IMGPROXY_MAX_SRC_RESOLUTION:-50}       # Megapixel
      IMGPROXY_DOWNLOAD_TIMEOUT: ${IMGPROXY_DOWNLOAD_TIMEOUT:-10}
      IMGPROXY_MAX_CLIENTS: ${IMGPROXY_MAX_CLIENTS:-10}                     # Concurrency-Deckel = Speicherschutz
      IMGPROXY_QUALITY: ${IMGPROXY_QUALITY:-80}
      IMGPROXY_USE_ETAG: "true"
      IMGPROXY_TTL: ${IMGPROXY_TTL:-2592000}
      IMGPROXY_ALLOW_ORIGIN: ${IMGPROXY_ALLOW_ORIGIN:-*}
      IMGPROXY_LOG_LEVEL: ${IMGPROXY_LOG_LEVEL:-error}

  nginx:
    image: nginx:1.28.2-alpine
    restart: unless-stopped
    expose:
      - 80
    depends_on:
      - imgproxy
    volumes:
      - nginx-cache:/tmp/cache
    command:
      - /bin/sh
      - -c
      - |
        cat <<EOF > /etc/nginx/conf.d/default.conf
        proxy_cache_path /tmp/cache levels=1:2 keys_zone=my_cache:32m max_size=500m inactive=30d use_temp_path=off;
        server {
          listen 80 default_server;
          location / {
            expires 30d;
            access_log off;
            # AVIF zuerst prüfen (Vorrang), dann WebP — der Cache-Key MUSS beide
            # Dimensionen enthalten, sonst bekommt ein AVIF-Browser evtl. das
            # gecachte WebP (oder umgekehrt).
            set \$handle_avif 0;
            if (\$http_accept ~* "image/avif") { set \$handle_avif 1; }
            set \$handle_webp 0;
            if (\$http_accept ~* "image/webp") { set \$handle_webp 1; }
            proxy_cache my_cache;
            proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
            proxy_cache_background_update on;
            proxy_cache_lock on;
            proxy_cache_key "\$scheme\$host\$uri\$handle_avif\$handle_webp";
            server_tokens off;
            proxy_pass http://imgproxy:8080;
          }
        }
        EOF
        exec nginx -g 'daemon off;'

volumes:
  nginx-cache:
```

**Env in Dokploy** — Pflicht sind nur die S3-Credentials (dieselben wie in der App):

```env
S3_ACCESS_KEY_ID=<...>
S3_SECRET_ACCESS_KEY=<...>
```

Danach in Dokploy eine Domain (z. B. `imgproxy.<domain>`) auf den **nginx**-Service, Port 80, LetsEncrypt.

### Signing?

Der Next-Loader läuft **im Browser** und kann kein Signing-Secret halten → **unsigniert**
(`/insecure/`). Missbrauch fängst du über `IMGPROXY_ALLOWED_SOURCES=s3://` (nur dein Bucket
als Quelle) + Cloudflare-Rate-Limit ab. Signierte URLs bräuchten serverseitiges Rendern
der Bild-URLs und sind für den Client-Loader nicht praktikabel.

---

## Todo 2: Cloudflare-Einstellungen

**DNS:** `imgproxy.<domain>` als **Proxied** (orange Wolke).

### 2.1 Der `Vary: Accept`-Fallstrick (wichtig!)

imgproxy sendet `Vary: Accept` (dieselbe URL liefert AVIF **oder** WebP je nach Browser).
Cloudflare berücksichtigt `Vary` per Default **nur** für `Accept-Encoding` — es würde also
**die erste Variante pro URL** cachen und sie allen Browsern ausliefern → alte Browser
bekommen ein AVIF, das sie nicht darstellen können.

Zwei saubere Optionen:
- **A (empfohlen):** Cloudflare-Feature **„Vary for images"** aktivieren (Caching → Cache Variants /
  API `cache/variants`), damit `Vary: Accept` für `image/*` respektiert wird. Dann darf Cloudflare
  edge-cachen.
- **B:** imgproxy-Host in Cloudflare auf **Cache Bypass** (oder DNS-only / graue Wolke) — dann
  übernimmt der **nginx-Layer** aus dem Compose die Accept-korrekte Cache-Trennung (avif/webp
  im Cache-Key). Etwas weniger Edge-Nähe, aber keine Format-Verwechslung.

### 2.2 Cache-Rule

Für die `imgproxy.*`-Domain eine **Cache Rule**:
- **Cache Everything** + **Edge Cache TTL** z. B. 1 Monat (Bilder sind unveränderlich pro Key).
- **4xx/5xx NICHT cachen.** Sonst bleibt ein einmaliger Fehler (z. B. verwaistes Bild → imgproxy 404)
  ~stundenlang kleben. In der Cache Rule „Cache TTL by status" → 4xx/5xx auf **No cache** / Bypass.

### 2.3 Rate-Limit

Eine Rate-Limiting-Rule auf den imgproxy-Host schützt vor „jemand hämmert `?w=1..9999`". Zusammen
mit `IMGPROXY_ALLOWED_SOURCES=s3://` ist die Angriffsfläche gering.

---

## Todo 3: Next.js-Integration

### 3.1 Package (empfohlen)

`@morgendigital/next-imgproxy` (GitHub Packages) kapselt Loader + Helper.

**`.npmrc`** im Projekt:
```
@morgendigital:registry=https://npm.pkg.github.com
```
```bash
pnpm add @morgendigital/next-imgproxy
```
**Env** (pro Projekt eigener Bucket) — für Projekte am zentralen morgendigital-S3
ist `NEXT_PUBLIC_IMGPROXY_URL` die geteilte Default-Instanz aus Todo 1:
```env
NEXT_PUBLIC_IMGPROXY_URL=https://imgproxy.northlight.website
NEXT_PUBLIC_IMGPROXY_BUCKET=s3://<bucket>
```

> **Achtung Build-Zeit:** `NEXT_PUBLIC_*` wird beim `next build` ins Client-Bundle
> eingebacken. In Dokploy als **Build-Env** setzen, sonst bleibt der Loader
> deaktiviert (`imgproxyEnabled=false`) und es läuft weiter der On-Server-Optimizer.
**Eine konfigurierte Instanz** anlegen und überall importieren:
```ts
// src/utilities/imgproxy.ts
import { createImgproxy } from '@morgendigital/next-imgproxy'
const imgproxy = createImgproxy() // liest NEXT_PUBLIC_IMGPROXY_URL / _BUCKET
export const imgproxyLoader = imgproxy.loader
export const imgproxyUrlFromMediaUrl = imgproxy.urlFromMediaUrl
export { mediaKeyFromUrl } from '@morgendigital/next-imgproxy'
```

Kein Package im Projekt? Dann denselben Code inline (siehe **Anhang: Loader-Code**).

### 3.2 Die vier Render-Fälle

Der `src` für den Loader ist der **S3-Key** (Payload `filename`), **nicht** `/api/media/file/...`.

**1) `next/image` in einer Client Component** → Loader + Key (volles responsives srcSet):
```tsx
'use client'
<Image
  loader={imgproxyLoader}
  src={resource.filename ?? mediaKeyFromUrl(resource.url)}
  width={resource.width} height={resource.height}
  alt={resource.alt ?? ''}
/>
```

**2) `next/image` in einer Server Component** → URL bauen + `unoptimized`.
Eine Loader-**Funktion** kann **nicht** über die Server→Client-Grenze übergeben werden:
```tsx
<Image
  src={imgproxyUrlFromMediaUrl(resource.url, { width: 2000 })}
  unoptimized
  width={2000} height={1000} alt=""
/>
```

**3) Rohe `<img>` / WebGL / `motion.img`** → fertige URL:
```tsx
<img src={imgproxyUrlFromMediaUrl(resource.url, { width: 1600 })} />
```

**4) SVG** → **nicht** durch imgproxy rastern. Der Helper erledigt das automatisch
(SVG → same-origin relativer Pfad). Bei rohem `next/image` mit fertiger URL zusätzlich `unoptimized`.

### 3.3 Vorgehen im Projekt

1. Zentrale Media-Komponente (`ImageMedia`) auf den Loader umstellen — deckt die meisten Bilder ab.
2. **Alle** übrigen Stellen finden, die roh rendern:
   ```bash
   grep -rn "getMediaUrl(" src --include="*.tsx" | grep -v "relative"
   grep -rln "from 'next/image'" src --include="*.tsx"
   ```
   Typische Kandidaten: Hero, Slider, Team-/Member-Cards, Award-/Logo-Listen, Footer-Logos,
   WebGL-Effekte (Distortion/Bubble). Jede nach den 4 Fällen umstellen.

---

## Todo 4: Fallstricke (aus der Praxis)

- **Kein `f:auto`** in der URL — ungültig, führt zu 404. Format kommt aus der Detection (Todo 1).
- **Loader-Funktion nur in Client Components.** Server Component → URL bauen + `unoptimized`.
- **`getMediaUrl(url)` ohne `{ relative: true }`** baut eine **absolute** `NEXT_PUBLIC_SERVER_URL`.
  Das (a) bricht lokal, wenn der Dev-Port ≠ `NEXT_PUBLIC_SERVER_URL` ist, und (b) hält das Bild am
  on-server Optimizer. Über imgproxy (Key/Helper) routen.
- **`unoptimized` setzen**, wenn du eine **fertige** imgproxy-URL an `next/image` gibst — sonst wickelt
  es sie erneut in `/_next/image` (Doppel-Optimierung, Host-Fehler wenn imgproxy nicht in
  `next.config` `remotePatterns` steht). Loader-Variante braucht das nicht.
- **Cloudflare cacht 404** (verwaiste Bilder) — siehe Todo 2.2.
- **SVG** nie durch den Optimizer/imgproxy rastern — direkt ausliefern.

---

## Todo 5: Verifizieren

**Live-DOM** (im Browser-Console/JS): kein Raster darf mehr über `/_next/image` laufen.
```js
const imgs = [...document.querySelectorAll('img')]
const val = i => i.getAttribute('srcset') || i.getAttribute('src') || ''
const raster = i => !/\.svg/i.test(val(i))
console.log({
  imgproxy: imgs.filter(i => val(i).includes('imgproxy')).length,
  optimizer_raster_leaks: imgs.filter(i => val(i).includes('/_next/image') && raster(i)).length, // → 0
  absolute_server_url: imgs.filter(i => /https?:\/\/[^/]+\/api\/media\/file/.test(val(i))).length, // → 0
})
```

**imgproxy direkt** (AVIF-Aushandlung + Ersparnis):
```bash
curl -s -o /dev/null -H "Accept: image/avif,*/*" \
  -w "%{http_code} %{content_type} %{size_download}\n" \
  "https://imgproxy.<domain>/insecure/rs:fit:800/q:80/plain/s3://<bucket>/<key>?cb=$RANDOM"
# erwartet: 200 image/avif <deutlich kleiner als Original>
```
Erwartung: alle Raster über imgproxy, `image/avif`/`image/webp` je Browser, `optimizer_raster_leaks = 0`,
keine `/_next/image`-Raster und keine absoluten `/api/media/file`-URLs mehr.

---

## Anhang: Loader-Code (inline, falls kein Package)

```ts
import type { ImageLoader } from 'next/image'

export interface ImgproxyConfig { endpoint?: string; bucket?: string; quality?: number }

const strip = (s: string) => s.replace(/\/+$/, '')
const resolve = (c?: ImgproxyConfig) => {
  const endpoint = strip((c?.endpoint ?? process.env.NEXT_PUBLIC_IMGPROXY_URL ?? '').trim())
  const bucket = strip((c?.bucket ?? process.env.NEXT_PUBLIC_IMGPROXY_BUCKET ?? '').trim())
  if (!endpoint || !bucket) throw new Error('[imgproxy] set NEXT_PUBLIC_IMGPROXY_URL / _BUCKET')
  return { endpoint, bucket, quality: c?.quality ?? 80 }
}
const sameOrigin = (u: string) => { try { if (/^https?:\/\//i.test(u)) { const x = new URL(u); return `${x.pathname}${x.search}` } } catch {} return u }

export const mediaKeyFromUrl = (url?: string | null): string => {
  if (!url) return ''
  let path = url
  try { if (/^https?:\/\//i.test(url)) path = new URL(url).pathname } catch {}
  path = path.split('?')[0] ?? ''
  const m = '/api/media/file/'; const i = path.indexOf(m)
  const seg = i >= 0 ? path.slice(i + m.length) : (path.split('/').pop() ?? '')
  try { return decodeURIComponent(seg) } catch { return seg }
}

export const createImgproxy = (config?: ImgproxyConfig) => {
  const { endpoint, bucket, quality: dq } = resolve(config)
  const url = (key: string, o: { width: number; quality?: number }) =>
    `${endpoint}/insecure/rs:fit:${o.width}/q:${o.quality ?? dq}/plain/${bucket}/${encodeURIComponent(key.replace(/^\/+/, ''))}`
  const loader: ImageLoader = ({ src, width, quality }) => url(src, { width, quality: quality ?? undefined })
  const urlFromMediaUrl = (u: string | null | undefined, o: { width: number; quality?: number }) => {
    if (!u) return ''
    const key = mediaKeyFromUrl(u)
    if (!key) return ''
    if (key.toLowerCase().endsWith('.svg')) return sameOrigin(u)
    return url(key, o)
  }
  return { loader, url, urlFromMediaUrl }
}
```
