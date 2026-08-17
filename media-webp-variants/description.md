# WebP-Varianten in Payload — `formatOptions` gehört auch an jede `imageSize`

> **Korrigiert Todo 1.2 aus [payload-start](../payload-start/description.md).** Dort stand nur
> `formatOptions: { format: 'webp' }` auf Collection-Ebene. Das wandelt **ausschließlich die
> Hauptdatei** um.

Alle Zahlen unten sind an rtbrick.com gemessen (Payload 3.86, Next.js 16.2, MongoDB, S3/Spaces).

## Das Problem in einem Satz

`upload.formatOptions` wandelt die Hauptdatei um. Jede Größe in `imageSizes` behält ohne **eigene**
`formatOptions` das Format des Uploads — und **die Varianten liefert `next/image` aus**, nicht das
Original.

Ein PNG-Upload erzeugt also ein WebP-Original und sieben PNG-Ableger. Der Fehler ist unsichtbar,
solange niemand die Dateigrößen anschaut: Im Admin sieht man das Original, im CMS gibt es die
Varianten gar nicht als eigene Einträge, und die Seite funktioniert einwandfrei — sie lädt nur ein
Vielfaches an Bytes.

## Wie groß das wird

Ein Bild aus der Startseite, Original **1920 px WebP, 108 KB**:

| Variante  | Maße      | als PNG (vorher) | als WebP (nachher) |
| --------- | --------- | ---------------- | ------------------ |
| thumbnail | 300×169   | 48 KB            | ~8 KB              |
| small     | 600×338   | 160 KB           | ~22 KB             |
| medium    | 900×506   | 330 KB           | ~36 KB             |
| large     | 1400×788  | 758 KB           | ~58 KB             |
| **xlarge**| 1920×1080 | **893 KB**       | **~91 KB**         |

Die `xlarge`-Variante hat **dieselben Maße wie das Original** und wiegt als PNG das Achtfache.
Genau sie wurde ausgeliefert.

Über den ganzen Bestand:

| | |
| --- | --- |
| Medien gesamt | 349 |
| davon mit Nicht-WebP-Varianten | **315** |
| Bytes in diesen Varianten | **101 MB** |
| Bytes der zugehörigen Originale | 10,4 MB |

Typische Einsparung pro Dokument im Reparaturlauf: **50–93 %**.

## Die Konfiguration

```ts
// src/collections/Media.ts
const WEBP = { format: 'webp' as const, options: { quality: 76 } }

export const Media: CollectionConfig = {
  slug: 'media',
  upload: {
    formatOptions: WEBP,                    // Hauptdatei
    resizeOptions: { fit: 'inside', width: 2560, height: 2560, withoutEnlargement: true },
    imageSizes: [
      { name: 'thumbnail', width: 300,                          formatOptions: WEBP },
      { name: 'square',    width: 500, height: 500,             formatOptions: WEBP },
      { name: 'small',     width: 600,                          formatOptions: WEBP },
      { name: 'medium',    width: 900,                          formatOptions: WEBP },
      { name: 'large',     width: 1400,                         formatOptions: WEBP },
      { name: 'xlarge',    width: 1920,                         formatOptions: WEBP },
      { name: 'og',        width: 1200, height: 630, crop: 'center', formatOptions: WEBP },
    ],
  },
}
```

`quality: 76` ist eine bewusste Setzung, kein Muss — ohne Angabe nimmt Sharp seinen Standard (80).
Der Unterschied ist klein; **entscheidend ist `format`**, nicht die Qualität.

## Bestehende Medien reparieren

Die Konfiguration wirkt nur auf **neue** Uploads. Vorhandene Dokumente behalten ihre Ableger, bis
jede Datei einmal mit angehängtem File durch `payload.update()` läuft — dann erzeugt Payload den
kompletten Variantensatz neu.

Skript: [`regenerateMediaVariants.ts`](./regenerateMediaVariants.ts) — nach `src/scripts/` kopieren.

```bash
# Trockenlauf, schreibt nichts
pnpm payload run src/scripts/regenerateMediaVariants.ts

# ein einzelnes Dokument, echt
APPLY=1 MEDIA_ID=<id> pnpm payload run src/scripts/regenerateMediaVariants.ts

# in Batches, gedrosselt — so gehört es gegen Produktion gefahren
nice -n 19 ionice -c 3 env APPLY=1 LIMIT=100 \
  pnpm payload run src/scripts/regenerateMediaVariants.ts
```

> **Nie ungedrosselt über den Gesamtbestand gegen Produktion.** Genau das hat am 17.08.2026 einen
> Server lahmgelegt — warum, und was am Skript dagegen gesetzt ist, steht unter
> [Wie dieses Skript einen Server lahmgelegt hat](#wie-dieses-skript-einen-server-lahmgelegt-hat-17082026).

Läuft **lokal gegen die Produktion**: DB über SSH-Tunnel, Speicher über die `S3_*`-Variablen der
lokalen `.env`. Die Originaldatei wird über HTTP von `MEDIA_SOURCE` geholt, damit es gleich
funktioniert, ob die Medien auf S3 oder einem lokalen Volume liegen.

```bash
ssh -fN -L 27018:localhost:27017 user@server
APPLY=1 DATABASE_URL="mongodb://127.0.0.1:27018/<db>?directConnection=true" \
  pnpm payload run src/scripts/regenerateMediaVariants.ts
```

## Wie dieses Skript einen Server lahmgelegt hat (17.08.2026)

Der Reparaturlauf über den Gesamtbestand hat einen Produktionsserver unerreichbar gemacht: Disk-Reads
am Anschlag, RAM voll, CPU auf allen Kernen — und im Monitoring **kaum Netzwerk-Traffic**, weshalb
zunächst niemand den Bildtransfer verdächtigt hat. Drei Verstärker im Skript, die sich multipliziert
haben:

**1. `limit: 0, pagination: false` lädt die ganze Collection in den Speicher.** Bei ein paar tausend
Dokumenten ist das ein großer Allokationsblock, und Mongo liest dafür die Collection komplett von
Platte — genau die Read-IOPS, die ohne Netzwerklast auftraten. Statt dessen seitenweise laden:

```ts
const { docs, hasNextPage } = await payload.find({
  collection: 'media',
  limit: 100,
  page,
  depth: 0,
  sort: 'createdAt',            // stabile Reihenfolge, während der Loop schreibt
  select: { filename: true, mimeType: true, sizes: true },
  overrideAccess: true,
})
```

`sort` und `select` sind kein Beiwerk: ohne feste Sortierung kann ein Dokument beim Schreiben
zwischen Seiten wandern, ohne `select` liefert Mongo jedes Dokument vollständig aus.

**2. Der Kandidaten-Loop lädt alle Kandidaten, nicht den ersten passenden.** Betrifft die Variante,
die das Original direkt aus S3 holt (`fetchFromS3`, `candidateKeys`): bricht die Schleife nur ab,
wenn der Key **exakt** `doc.filename` entspricht, wird sie bei jedem Bild mit Derivaten bis zum Ende
durchlaufen. Bei ~5 Größen × 4 Endungen sind das bis zu **20 GetObject-Calls pro Bild**, deren Buffer
alle gleichzeitig im RAM liegen, bevor sortiert wird. Das war der eigentliche Speicherfresser. Beim
ersten Treffer zurückgeben:

```ts
for (const key of keys) {
  try {
    const res = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    return { buffer: Buffer.from(await res.Body.transformToByteArray()), key }
  } catch {
    continue
  }
}
```

Und die Keys vorher nach Wahrscheinlichkeit sortieren — Original zuerst, dann `.webp`. Dann trifft
der erste Versuch fast immer. Die HTTP-Variante in
[`regenerateMediaVariants.ts`](./regenerateMediaVariants.ts) hat das Problem nicht, weil sie genau
eine URL abruft.

**3. `payload.update` mit `file` fährt pro Dokument die komplette Sharp-Pipeline hoch** — sieben
Größen, und Sharp nimmt per Default einen Thread pro Kern (auf der Maschine: 12). Ganz oben im
Skript drosseln:

```ts
import sharp from 'sharp'
sharp.concurrency(2)
```

### So wird es aufgerufen

```bash
nice -n 19 ionice -c 3 env APPLY=1 LIMIT=100 \
  pnpm payload run src/scripts/regenerateMediaVariants.ts
```

`nice`/`ionice` stellen den Lauf hinter alles andere auf der Maschine, `LIMIT` gab es schon: in
Batches von 100 laufen lassen statt über alles. Das Skript legt zusätzlich eine kurze Pause zwischen
den Dokumenten ein (`PAUSE_MS`, Default 200 ms) und begrenzt die Seitengröße (`PAGE_SIZE`,
Default 100).

Es dauert damit deutlich länger — der Server bleibt dafür erreichbar. Wer den Vollauf ohne
Drosselung braucht, macht das auf einer Maschine, auf der gerade niemand arbeitet.

> Nachtrag zur Fehlersuche: Dass im Monitoring kein Netzwerk zu sehen war, heißt nicht, dass keine
> Objekte geladen wurden. Zeigt `S3_ENDPOINT` auf ein MinIO hinter dem eigenen Reverse Proxy oder
> einem lokalen Cache, geht ein Teil nie über `eth0` — und `sar` mit 12-Minuten-Intervallen mittelt
> Spitzen ohnehin weg. Die Disk-Reads passten dagegen exakt zum Collection-Scan plus den
> Sharp-Zwischenbuffern.

## Zwei Fallen, die beide Blut gekostet haben

### `overwriteExistingFiles: true` ist Pflicht

Ohne diese Option behandelt Payload die vorhandene Datei als Namenskonflikt und hängt einen Zähler
an: aus `Angacom 2026.webp` wird `Angacom 2026-1.webp`, **die alte URL gibt 404**.

Verweise über eine Medien-Beziehung überleben das (die Komponente liest `resource.url` neu).
Verweise **per URL** nicht — und die gibt es öfter als gedacht, etwa wenn eine Downloadseite den
Link als Text hinterlegt hat. Immer zuerst an einem einzelnen Dokument prüfen.

### `payload run` schluckt alle Argumente

`process.argv` enthält im Skript nur Payloads eigenen Bin-Pfad, egal was danach steht.
CLI-Flags funktionieren nicht — **Umgebungsvariablen** benutzen.

## Verhältnis zu [image-optimization](../image-optimization/description.md)

Die beiden Skills schließen sich nicht aus, sie betreffen verschiedene Stufen:

- **imgproxy** löst das *Ausliefern* — es ersetzt den `next/image`-Optimizer, damit der App-Server
  nicht bei jeder Anfrage neu kodiert.
- **Dieser Skill** löst das *Erzeugen* — was Payload beim Upload überhaupt ablegt.

Wer imgproxy einsetzt und ausschließlich darüber ausliefert, spürt kaputte Varianten kaum, weil
imgproxy ohnehin neu kodiert. Wer wie rtbrick die **vorgenerierten Payload-Ableger** direkt
ausliefert (eigener `next/image`-Loader, kein Proxy), liefert genau diese Dateien aus — dann zählt
es voll.

## Verwandt: `sizes` an `next/image`

Ein korrekter Variantensatz nützt wenig, wenn das `sizes`-Attribut lügt. Steht dort der übliche
Standard `100vw`, fordert der Browser eine bildschirmbreite Datei an, auch für eine Karte von
377 px. Am Bild die tatsächliche Breite angeben:

```tsx
<Media resource={media} size="(max-width: 640px) 85vw, 377px" />
```

Nebenwirkung, die man kennen sollte: Enthält `sizes` einen `vw`-Anteil, baut `next/image` das
`srcset` aus `deviceSizes` (640…3840), nicht aus der feineren `imageSizes`-Liste. Bei kleinen
Originalen laufen dann alle Stufen auf dieselbe Datei hinaus — der Gewinn entsteht erst bei großen
Bildern, und erst zusammen mit WebP-Varianten.

### Im Website-Template sieht der Default responsiv aus — und ist wirkungslos

Wer aus dem offiziellen `templates/website` startet, glaubt leicht, das Thema sei erledigt. In
`src/components/Media/ImageMedia/index.tsx` steht dort:

```ts
const sizes = sizeFromProps
  ? sizeFromProps
  : Object.entries(breakpoints)
      .map(([, value]) => `(max-width: ${value}px) ${value * 2}w`)
      .join(', ')
```

Das erzeugt `(max-width: 1920px) 3840w, (max-width: 1536px) 3072w, …` — und ist als `sizes`
ungültig. Erlaubt sind dort ausschließlich **CSS-Längen** (`100vw`, `33vw`, `377px`); `w` ist ein
srcSet-Deskriptor und hat in `sizes` nichts verloren. Der Browser verwirft die unparsbaren Einträge
und rechnet mit dem Spec-Fallback: **`100vw`**.

Der Default ist damit kein eigener Fehlerfall, sondern **exakt der Fall aus dem Abschnitt oben** —
nur getarnt. Es sieht nach breakpoint-abhängigem Sizing aus, verhält sich aber, als stünde da
nichts. Das ist der eigentliche Ärger: Man sucht den `100vw`-Fall nicht, weil man ihn für gelöst
hält.

Nachgemessen in Chrome (Viewport 1440, DPR 2), gleiches srcSet `640…3840`, nur `sizes` variiert:

| `sizes` | gewählter Kandidat |
| --- | --- |
| Template-Default (ungültig) | **3840w** |
| `100vw` | **3840w** |
| `33vw` | 1080w |

Erste und zweite Zeile sind identisch — der Beleg, dass der Default nichts tut. Die dritte Zeile
ist der Gewinn, um den es geht.

> Zur Fehlersuche: `naturalWidth` allein taugt **nicht** als Beleg. Wird in einem Tab mit
> zusammengeklapptem oder nicht gelayouteten Viewport gemessen, löst `100vw` auf 0 auf und der
> Browser nimmt den kleinsten Kandidaten — das sieht aus wie ein Under-Fetch-Bug, ist aber ein
> Messfehler. Immer gegen einen echten Viewport prüfen, oder direkt `currentSrc` vergleichen.

**Prüfen** — in der Konsole der Live-Seite:

```js
[...document.images].filter(i => /\d\s*w\s*(,|$)/.test(i.getAttribute('sizes') || ''))
```

Jeder Treffer hat ein kaputtes `sizes` und lädt faktisch bildschirmbreit.

**Beheben** — der Default gehört auf eine gültige Länge, und zwar auf die konservative:

```ts
// ehrliche Rückfallebene; Komponenten, die schmaler rendern, geben `size` an
const sizes = sizeFromProps || '100vw'
```

Das ändert am Verhalten zunächst **nichts** — es macht nur sichtbar, was ohnehin passiert. Die
Ersparnis entsteht erst dadurch, **jedem Aufruf seine Darstellungsbreite mitzugeben**. Im Template
haben das von Haus aus die wenigsten. Bei bautenschutz.tirol (Payload 3.72, Next 15.4) waren es
3 von 14:

| Verwendung | `size` |
| --- | --- |
| Vollbild-Hero, vollbreiter Sektionshintergrund | `100vw` |
| Content-Block in `container` (86rem, 2rem Padding) | `(max-width: 1376px) 100vw, 1312px` |
| Zweispaltiges Layout | `(max-width: 1024px) 100vw, 50vw` |
| Karte im 3-Spalten-Grid | `(max-width: 768px) 100vw, (max-width: 1024px) 50vw, 33vw` |
| Logo in fester Box (`h-32`) | `128px` |

Bei spaltenabhängigen Grids den Wert **neben** die Spaltendefinition legen und das im Kommentar
festhalten — sonst wandert die eine Hälfte beim nächsten Umbau mit und die andere nicht:

```tsx
const gridCols  = { '3': 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3' }
const gridSizes = { '3': '(max-width: 768px) 100vw, (max-width: 1024px) 50vw, 33vw' }
```

## Prüfen, ob eine Site betroffen ist

```js
// mongosh
const all = db.media.find({}, {filename:1, sizes:1}).toArray()
const bad = all.filter(m => Object.values(m.sizes||{})
  .some(s => s && s.mimeType && s.mimeType !== 'image/webp'))
print(`${bad.length} von ${all.length} Medien mit Nicht-WebP-Varianten`)
```

Oder ohne DB-Zugang: eine Bild-URL auf der Live-Seite aufrufen und auf die Endung im `srcset`
schauen. Steht dort `-1920x1080.png`, während die Hauptdatei `.webp` heißt, ist es dieser Fall.
