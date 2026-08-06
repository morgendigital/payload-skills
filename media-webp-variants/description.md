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

# alles
APPLY=1 pnpm payload run src/scripts/regenerateMediaVariants.ts
```

Läuft **lokal gegen die Produktion**: DB über SSH-Tunnel, Speicher über die `S3_*`-Variablen der
lokalen `.env`. Die Originaldatei wird über HTTP von `MEDIA_SOURCE` geholt, damit es gleich
funktioniert, ob die Medien auf S3 oder einem lokalen Volume liegen.

```bash
ssh -fN -L 27018:localhost:27017 user@server
APPLY=1 DATABASE_URL="mongodb://127.0.0.1:27018/<db>?directConnection=true" \
  pnpm payload run src/scripts/regenerateMediaVariants.ts
```

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
