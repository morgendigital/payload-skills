# Videos ausliefern — Safari spielt hinter Cloudflare nichts ab

> Betrifft Projekte mit **Next.js ab 16.4.5 bzw. 15.5.29**, Videos aus der Payload-Media-Collection
> (`/api/media/file/….mp4`) und **Cloudflare** davor. Gefunden in dankl am 25.11.2026
> (Next.js 16.4.6, Payload 3.92, S3-Adapter).

## Problem

In Safari bleiben Videos leer. Chrome ist unauffällig, im Build und im Log steht nichts.
Das `<video>`-Element meldet `error.code === 4` (`MEDIA_ERR_SRC_NOT_SUPPORTED`).

Safari holt Videos per **Byte-Range** (`Range: bytes=0-1` zuerst) und braucht `206 Partial Content`.
Über Cloudflare kam stattdessen `200` mit der **ganzen Datei**:

| Anfrage `Range: bytes=0-1` (dankl, 20 MB Video) | Antwort |
| --- | --- |
| direkt am Origin | `206`, 2 Bytes |
| über Cloudflare, `/api/media/file/Headervideo_01.mp4` | `200`, 20.122.551 Bytes, `cf-cache-status: HIT` |
| über Cloudflare, `/video/Headervideo_01/mp4` (Lösung unten) | `206`, 2 Bytes, `DYNAMIC` |

## Ursache

1. Seit dem Security-Release **Next.js 16.4.5 / 15.5.29** entfernt `sendResponse` die Header
   `content-length`, `content-encoding` und `transfer-encoding` von **jeder** Antwort eines Route
   Handlers (`next/dist/server/send-response.js`, `FORBIDDEN_HEADERS`). Die Payload-Dateiroute ist
   ein Route Handler: `200` und `206` gehen ohne `Content-Length` und chunked raus. Dateien aus
   `public/` sind nicht betroffen.
2. Cloudflare cached `.mp4`/`.webm` anhand der Dateiendung. Eine so gecachte Datei wurde auf
   Range-Anfragen komplett ausgeliefert.

Nachgeprüft: 15.5.28, 16.3.x, 16.4.2 und 16.4.3 behalten den Header, 15.5.29 und 16.4.6 entfernen ihn,
`16.5.0-canary.65` ebenfalls. Upstream: [vercel/next.js#101112](https://github.com/vercel/next.js/issues/101112)
(automatisch geschlossen, kein Fix), [PR #101201](https://github.com/vercel/next.js/pull/101201)
(geschlossen, nicht gemergt). Der Zusammenhang zwischen fehlender Länge und Cloudflare-Verhalten ist
die naheliegende Erklärung, wurde aber nicht mit einem zurückgedrehten Next gegengetestet.

**Ob es auffällt, hängt vom Cache-Zustand ab.** An northlight.at und dawi.at (beide 16.4.6) spielte
Safari die getesteten Videos ab, eine frisch gecachte Kopie (`?probe=123`) antwortete auf Range aber
auch dort mit der ganzen Datei. „Bei mir geht's" ist deshalb kein Nachweis.

**Nicht** auf eine ältere Next-Version zurückgehen — damit fällt der Security-Fix weg.

## Prüfen

```bash
U="https://example.com/api/media/file/datei.mp4?probe=$RANDOM"
curl -s -o /dev/null "$U"                                             # Cache füllen
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' -r 0-1 "$U" # gut: 206 2 — kaputt: 200 <ganze Datei>
```

## Lösung — Videos unter einem Pfad ohne Dateiendung

Cloudflare cached den Pfad dann nicht (`DYNAMIC`), reicht die Range-Anfrage an die App durch, und die
antwortet mit `206` und `Content-Range`.

`next.config.ts`:

```ts
async rewrites() {
  return [
    // Videos ohne Dateiendung: Cloudflare cached `*.mp4` und beantwortet Safaris
    // Range-Anfragen dann mit der ganzen Datei (Next sendet keine Content-Length).
    { source: '/video/:name/:ext(mp4|webm)', destination: '/api/media/file/:name.:ext' },
  ]
},
```

`components/Media/VideoMedia/index.tsx`:

```tsx
// `/api/media/file/clip.mp4` → `/video/clip/mp4` (Rewrite in next.config.ts)
const path = url.replace(/^\/api\/media\/file\/([^/?]+)\.(mp4|webm)$/i, '/video/$1/$2')
const src = getMediaUrl(path, resource.updatedAt)
```

- Greift nur bei **relativen** URLs. Baut die Komponente die Adresse mit `getClientSideURL()` oder
  absolut zusammen, den Ausdruck anpassen. Eigene `<video>`-Elemente (Hero, Blöcke) mit umstellen —
  `grep -rn "<video" src`.
- Ersetzt **nicht** den Fix aus [payload-start 0.5](../payload-start/description.md) (`/media/…` gibt
  es nicht).
- CSP: gleiche Origin, `media-src 'self'` reicht.

**Preis:** Videos kommen nicht mehr aus dem CDN-Cache, jeder Abruf läuft über die App aus S3. Bei
wenigen dekorativen Loops vertretbar; bei viel Videomaterial oder Traffic gehört das Video zu einem
Videodienst (HLS) oder auf eine Auslieferung, die nicht durch den Route Handler geht.

**Gemessen:** alle sechs Videos `206` über Cloudflare, Wiedergabe in Playwright-WebKit (macOS) auf der
Live-Seite. Nicht auf einem echten iPhone nachgemessen.

Die Vorschau im Admin nutzt weiter `/api/media/file/…`.

### Nicht getestet / nicht ausreichend

- Eine Cloudflare Cache Rule „Bypass cache" für `/api/media/file/*.mp4` wäre die Variante ohne
  Codeänderung — nicht getestet.
- Ein Request, den Cloudflare nur wegen eines `Authorization`-Headers nicht cached (`BYPASS`), bekam
  trotzdem die ganze Datei.

## Videos klein halten

Unabhängig vom Bug — ein 4K-Hero-Loop ist das größte Element der Seite und startet auf schwachen
Geräten oder Verbindungen spät oder gar nicht.

```bash
ffmpeg -i in.mp4 -vf "scale=1920:-2" -c:v libx264 -preset slow -crf 26 \
  -pix_fmt yuv420p -an -movflags +faststart out.mp4
```

Gemessen an dankls Hero-Loop (17 s, Original 3840×2160, **20,1 MB**, `-crf 26`):

| Ausgabe | Größe | VMAF auf 4K (`vmaf_4k_v0.6.1`) | VMAF auf 1080p |
| --- | --- | --- | --- |
| 2560×1440 (`scale=2560:-2`) | 7,7 MB | 91 | — |
| 1920×1080 | 4,9 MB | 85 | 93 |

Für vollflächige Hero-Videos, die auf großen Bildschirmen scharf bleiben sollen, wurde bei dankl 1440p
genommen, sonst 1080p. Bei Material, das schon in 1080p vorliegt, hängt der CRF vom Inhalt ab
(`28`–`32` für VMAF ≈ 92); ein bewegtes Video wurde mit `26` sogar **größer** als das Original — Größe
nach dem Encoden immer vergleichen.

`-an` entfernt die Tonspur (stumme Loops), `+faststart` legt den Index an den Anfang. Bildqualität vor
dem Hochladen ansehen. Zielgröße für Hero-Loops: so klein wie möglich, siehe
[lighthouse-check](../lighthouse-check/description.md).

### Bestehende Videos ersetzen, ohne Verknüpfungen zu brechen

Per Local API in denselben Media-Eintrag schreiben. Mit `overwriteExistingFiles` bleiben Dateiname und
URL gleich (an dankl für sechs Videos geprüft), danach neu deployen, damit der Cache-Parameter in den
prerenderten Seiten nachzieht. Originale vorher sichern — die alte Datei wird überschrieben.

```ts
await payload.update({
  collection: 'media',
  id,
  data: {},
  file: { data, mimetype: 'video/mp4', name: filename, size: data.length },
  overwriteExistingFiles: true,
  context: { disableRevalidate: true },
})
```

iOS startet im Stromsparmodus keine Videos automatisch — ein Standbild (`poster` oder erstes Bild per
`#t=0.001`) sorgt dafür, dass dann nichts Leeres stehen bleibt.

## Wenn Next den Header wieder mitschickt

Mit jedem Next-Update prüfen:

```bash
grep -A5 "FORBIDDEN_HEADERS = " node_modules/next/dist/server/send-response.js
```

Fehlt `content-length` in der Liste, den Test unter [Prüfen](#prüfen) laufen lassen und erst bei
`206 2` den Umweg wieder ausbauen.

## Checkliste

- [ ] Range-Test mit frischem Query-Parameter gegen die Produktions-URL: `206 2`.
- [ ] Alle `<video>`-Quellen laufen über `/video/…`.
- [ ] Wiedergabe in Safari (Mac **und** iPhone) angesehen.
- [ ] Videos höchstens 1080p, H.264/`yuv420p`, `faststart`, ohne unnötige Tonspur.
