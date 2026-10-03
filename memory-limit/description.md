# Memory-Limit, Heap-Limit und Speicher-Log (Dokploy)

Was tun, wenn Dokploy meldet, dass der Container-Speicher „ohne Deploy wächst“ — und
warum der übliche Rat (`NODE_OPTIONS=--max-old-space-size=…`) in Projekten aus dem
Website-Template **still verpufft**. Auslöser war ein Alarm auf northlight.at:

```
892 MB now, 444 MB is its 7-day median. Growing without a deploy usually means a leak.
```

Kurzfassung: **Start-Skript reparieren**, **Memory-Limit plus Heap-Limit setzen**,
**Speicher-Log einschalten** — und erst dann über Leaks reden. Ohne Heap-Limit ist
Wachstum kein Beweis für einen Leak, und ohne aufgeschlüsselte Werte weiß man nicht,
ob man einen Heap-Snapshot oder sharp/Buffers jagt.

Reihenfolge: **Todo 1** Start-Skript → **Todo 2** Limits in Dokploy → **Todo 3** Speicher-Log
→ **Todo 4** Auswerten → **Todo 5** Lasttest (optional) → weitere Stellschrauben.

---

## Todo 1: `start` darf `NODE_OPTIONS` nicht überschreiben

**Datei:** `package.json`

Das Website-Template liefert:

```json
"start": "cross-env NODE_OPTIONS=--no-deprecation next start"
```

`cross-env NODE_OPTIONS=…` **ersetzt** die Variable. Was in Dokploy als `NODE_OPTIONS`
steht, kommt bei `next start` nie an — Nixpacks startet über genau dieses Skript. Gemessen
(Node, `NODE_OPTIONS=--max-old-space-size=300` von außen gesetzt):

| Skript | `NODE_OPTIONS` im Prozess | Heap-Limit |
| ------ | ------------------------- | ---------- |
| Template | `--no-deprecation` | **4192 MB** (Default, Limit ignoriert) |
| Fix | `--no-deprecation --max-old-space-size=300` | **396 MB** |

Fix — anhängen statt ersetzen. `cross-env` expandiert `$VAR` selbst (auch unter Windows),
unter `sh` erledigt das schon die Shell:

```json
"start": "cross-env NODE_OPTIONS=\"--no-deprecation $NODE_OPTIONS\" next start"
```

Ist `NODE_OPTIONS` leer, bleibt `--no-deprecation ` mit Leerzeichen stehen — harmlos.

> Dieselbe Falle betrifft **jeden** Rat, der über `NODE_OPTIONS` läuft — auch das
> `--max-old-space-size=2048` in [server-actions-encryption](../server-actions-encryption/description.md).
> Für den Build ist das in `scripts/build.mjs` schon gelöst
> ([payload-start](../payload-start/description.md) Todo 3); für `start` fehlte es.

**Prüfen:** Todo 3 loggt `heapLimit` beim Start. Steht dort ~2–4 GB statt des gesetzten
Werts, greift der Fix nicht.

## Todo 2: Memory-Limit und Heap-Limit in Dokploy

**Ort:** Dokploy → Application → Advanced → Resources, plus Environment

1. **Memory Limit** setzen, z. B. 1 GB. Ohne Limit kann ein Leak den ganzen Server (alle
   Projekte darauf) aushungern; mit Limit startet nur dieser Container neu.
2. **`NODE_OPTIONS=--max-old-space-size=768`** (~75 % des Limits). Der Rest ist für
   Nicht-Heap-Speicher: Buffers, sharp/libvips, Code, Young Generation. Das gemessene
   `heapLimit` liegt ~100 MB über dem gesetzten Wert (Young Generation): 512 → 608 MB.

Warum der zweite Punkt nötig ist: Ohne `--max-old-space-size` richtet sich V8 nach dem
verfügbaren Speicher und räumt spät auf — der Heap wächst lange, bevor ein großer GC
läuft. **Ein Anstieg von 444 auf 892 MB ist ohne Heap-Limit kein Leak-Beweis.** Mit Limit
trennt sich das sauber: pendelt der Speicher sich ein → kein Leak; steigt er bis zum
Neustart → Leak.

Node erkennt cgroup-v2-Limits erst ab 20.3 selbst — Node ≥ 22 sicherstellen (siehe
`payload-start`, Nixpacks fällt sonst still auf 18 zurück). Ein explizites Limit ist
trotzdem besser als die Automatik, weil es im Log steht.

## Todo 3: Speicher-Log

**Datei:** `src/instrumentation-node.ts` (aus `instrumentation.ts` per dynamischem Import
geladen, damit Edge-Bundles kein `process`/`node:v8` sehen)

```ts
import { getHeapStatistics } from 'node:v8'

const DEFAULT_MEMORY_LOG_INTERVAL_MS = 10 * 60 * 1000

const toMb = (bytes: number) => Math.round(bytes / 1024 / 1024)

// One line per interval so container memory can be traced back to its source:
// rising heapUsed → JS leak (take a heap snapshot), rising rss/external/
// arrayBuffers with flat heapUsed → native memory (sharp, Buffers, streams).
// heapLimit shows whether --max-old-space-size from NODE_OPTIONS took effect.
const logMemory = () => {
  const { rss, heapUsed, heapTotal, external, arrayBuffers } = process.memoryUsage()
  const heapLimit = getHeapStatistics().heap_size_limit

  console.log(
    `[memory] rss=${toMb(rss)}MB heapUsed=${toMb(heapUsed)}MB heapTotal=${toMb(heapTotal)}MB external=${toMb(external)}MB arrayBuffers=${toMb(arrayBuffers)}MB heapLimit=${toMb(heapLimit)}MB`,
  )
}

// MEMORY_LOG_INTERVAL_MS=0 turns the log off.
const startMemoryLog = () => {
  const interval = Number(process.env.MEMORY_LOG_INTERVAL_MS ?? DEFAULT_MEMORY_LOG_INTERVAL_MS)
  if (!Number.isFinite(interval) || interval <= 0) return

  logMemory()
  setInterval(logMemory, interval).unref()
}

export function registerNodeInstrumentation() {
  startMemoryLog()
  // ... process.on('unhandledRejection' / 'uncaughtException') wie gehabt
}
```

- `.unref()`, damit der Timer den Prozess beim Shutdown nicht festhält.
- Alle 10 Minuten = 144 Zeilen am Tag; genug, um einen Trend über Tage zu sehen.
- Läuft auch in `next dev` — dort ist der Wert wegen HMR wertlos, stört aber nicht.

## Todo 4: Auswerten

Im Dokploy-Log nach `[memory]` filtern und den Verlauf über ein paar Tage ansehen:

| Was steigt | Was es ist | Nächster Schritt |
| ---------- | ---------- | ---------------- |
| `heapUsed` stetig, auch nach Lastspitzen | JS-Leak (Map/Set ohne Limit, Listener, Closures) | Heap-Snapshot: `node --inspect` → Chrome DevTools → Memory, zwei Snapshots vergleichen |
| `external`/`arrayBuffers`, `heapUsed` flach | Buffers/Streams (Downloads, Bodies) | Media-Routen, Streams, `fetch` ohne Body-Konsum |
| nur `rss`, alles andere flach | nativer Speicher: sharp/libvips, glibc-Fragmentierung | [image-optimization](../image-optimization/description.md), `MALLOC_ARENA_MAX=2` |
| alles pendelt sich ein, fällt in Ruhe | kein Leak, nur Cache/GC-Verhalten | Limit passend wählen, fertig |

Ein Heap-Snapshot zeigt **nur** den JS-Heap. Bei den unteren beiden Zeilen findet er nichts.

## Todo 5: Lasttest (optional)

Lokal nachstellen, bevor man im Code sucht. Gegen einen Production-Build
(`pnpm build && NODE_OPTIONS=--max-old-space-size=512 MEMORY_LOG_INTERVAL_MS=5000 PORT=3100 pnpm start`):

- **Seiten crawler-artig:** echte URLs aus `pages-sitemap.xml` plus jeder dritte Request
  ein eindeutiger unbekannter Slug (`/crawler-probe-<n>` → 404) — das füllt
  `unstable_cache`/ISR mit immer neuen Keys.
- **Medien mit Abbrüchen:** `/api/media/file/<filename>` und ~60 % der Downloads nach dem
  ersten Chunk per `AbortController` abbrechen (Crawler, geschlossener Tab). Dabei
  `lsof -a -p <pid> -iTCP:<s3-port>` zählen — hängende S3-Streams zeigen sich als
  wachsende Socket-Zahl.
- Lokale S3-Zugangsdaten bekommen vom Prod-Bucket oft `403` (dann misst der Test nichts,
  alle Media-Requests enden in `UnknownError`). Stattdessen MinIO lokal
  (`docker run -p 9100:9000 minio/minio server /data`) mit **Platzhalterdateien unter den
  echten Dateinamen** aus `/api/media` befüllen und `S3_ENDPOINT` darauf zeigen lassen.

Messwerte northlight.at (Next 16.3.3, Payload 3.88, Heap-Limit 512 MB, lokal macOS):

| Szenario | Requests | RSS unter Last | `heapUsed` | RSS nach 30 s Ruhe | S3-Sockets |
| -------- | -------- | -------------- | ---------- | ------------------ | ---------- |
| Seiten + 10 000 unbekannte Slugs | 30 000 | 270 → **~390 MB**, dann flach | 120–146 MB | 256 MB | — |
| Medien, ~4 300 mitten im Download abgebrochen | 9 600 | **~340–360 MB**, dann flach | 102–121 MB | 169 MB | 2–7, nicht steigend |

Ergebnis dort: **kein Leak im App-Code reproduzierbar** — weder durch die Next-Caches noch
durch abgebrochene S3-Streams (die `AbortError`-Behandlung in `instrumentation-node.ts`
lässt keine Sockets hängen). Der Anstieg in Produktion passt damit eher zu
„kein Heap-Limit + späte GC“ oder nativem Speicher (glibc, sharp) — genau das, was
Todo 3 im Prod-Log auseinanderhält. Der lokale Test läuft auf macOS/libmalloc; glibc-
Fragmentierung (Nixpacks = Ubuntu) bildet er nicht ab.

**Testserver nie per `pkill -f next-server` stoppen**, sondern per PID. Laufen auf dem Rechner
mehrere Sessions mit Next-Servern, trifft das alle — und umgekehrt: Ein Testserver, der unter
Last mit `ELIFECYCLE … exit code 143` stirbt, ohne Fehler im Log, wurde meist von außen per
SIGTERM beendet, nicht von der App. Ein `--require`-Hook, der `SIGTERM` mit Zeitstempel
loggt, und ein `ps -ax | grep next-server` zeigen, wer es war.

## Weitere Stellschrauben

Erst Todo 3 auswerten, dann gezielt. In northlight umgesetzt sind `maxPoolSize`, der
Proxy-Matcher, Node ≥ 22 und Next 16.3.8. Gegengeprüft wurde nur das Gesamtpaket, nicht
jede Maßnahme einzeln: Typecheck, Build mit 83 prerenderten Routen, Routing per `curl` und
30 000 Requests im warmen Zustand bei RSS 317–395 MB / `heapUsed` 123–148 MB. Das ist
dasselbe Niveau wie vorher, die Maßnahmen haben also nichts verschlechtert. Gezielt
nachgemessen ist keine davon.

Proxy-Matcher (Next 16: `src/proxy.ts`, Funktion `proxy`), der die Ausnahmen der Funktion
spiegelt, statt sie nur per Early-Return abzufangen:

```ts
export const config = {
  matcher: ['/((?!api|_next|favicon|admin|public-relations|.*\\.).*)'],
}
```

Der Rest ist recherchiert, aber nicht gemessen:

- **`MALLOC_ARENA_MAX=2`** als Env: begrenzt glibc-Arenen, die RSS sonst ohne
  Heap-Wachstum aufblähen. Empfehlung aus der sharp-Doku; betrifft glibc
  (Nixpacks/Ubuntu), nicht Alpine/musl.
  https://sharp.pixelplumbing.com/install#linux-memory-allocator
- **`/_next/image` loswerden** — der größte Hebel, siehe
  [image-optimization](../image-optimization/description.md). Wo der Fallback noch läuft:
  `images.maximumResponseBody` (ab Next 16.1.2, Default 50 MB) für kleine Server senken.
- **`cacheMaxMemorySize`**: Default 50 MB, also begrenzt — kein Leak-Kandidat. `0` spart bis
  zu 50 MB, kostet Disk-Lesezugriffe (`.next/cache` bleibt).
- **MongoDB-Pool:** Default `maxPoolSize: 100`. Für eine einzelne Instanz
  `connectOptions: { maxPoolSize: 10 }` im `mongooseAdapter`. Better Auth mit eigenem
  `MongoClient` hat einen zweiten Pool.
- **`experimental.preloadEntriesOnStart: false`** senkt nur den Start-RSS (Payload-Admin-
  Module werden sonst vorgeladen); nach dem ersten Aufruf aller Routen ist es gleich.
- **Proxy-/Middleware-Matcher** um `admin` und Dateien mit Endung ergänzen, damit sie nicht
  pro Asset läuft.
- **Next-Patch-Stand prüfen:** 16.3.x hat einen bekannten Leak (~2 MiB/Request), aber nur mit
  `cacheComponents`/`'use cache'` (https://github.com/vercel/next.js/issues/97938) —
  Projekte ohne beides sind nicht betroffen.
- **Build-only, kein Laufzeit-RAM:** `experimental.cpus`, `workerThreads`,
  `memoryBasedWorkersCount`, `webpackMemoryOptimizations`, Source-Map-Schalter.

## Checkliste

- [ ] `start`-Skript hängt an `NODE_OPTIONS` an, statt es zu ersetzen.
- [ ] Dokploy: Memory Limit gesetzt, `NODE_OPTIONS=--max-old-space-size` ≈ 75 % davon.
- [ ] Speicher-Log aktiv; `heapLimit` in der ersten Zeile entspricht dem gesetzten Wert.
- [ ] Nach ein paar Tagen: Verlauf nach der Tabelle in Todo 4 eingeordnet.
- [ ] Erst danach: Heap-Snapshot (JS) oder `MALLOC_ARENA_MAX`/imgproxy (nativ).
