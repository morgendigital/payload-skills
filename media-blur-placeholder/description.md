# Blur-Platzhalter für Bilder — beim Upload erzeugt, im Dokument gespeichert

Solange ein Foto lädt, zeigt die Seite ein unscharfes Abbild **genau dieses** Fotos statt einer
leeren Fläche. Das Website-Template macht das nicht: dort steht für `placeholder="blur"` eine
**Konstante** (ein graues Base64-Bild) — jedes Foto blendet aus demselben Grau ein, egal ob das Bild
dunkel, hell oder rot ist. Das ist die Zeile, die man beim Aufsetzen ersetzt, nicht später.

Gehört in jedes Projekt mit Fotos — **beim Aufsetzen**, zusammen mit
[media-webp-variants](../media-webp-variants/description.md): Wer es erst nachrüstet, braucht den
Backfill unten für den ganzen Bestand.

## Das Prinzip

1. **Beim Upload** (`beforeChange` auf `media`) macht `sharp` aus der hochgeladenen Datei eine
   Kopie mit **16 px** an der längsten Seite, als **WebP** (`quality: 60`) — **60–200 Byte**, als
   Base64-Data-URL im Feld `blurDataURL` des Media-Dokuments gespeichert.
2. **Beim Rendern** reicht die Komponente das Feld an `next/image` durch. Eine Data-URL ist schon
   im HTML, **kein Request, kein JavaScript** nötig — der Platzhalter steht, bevor irgendetwas
   hydriert.

Dateien in diesem Ordner:

| Datei | Wohin | Was |
| --- | --- | --- |
| [`makeBlurDataURL.ts`](./makeBlurDataURL.ts) | `src/utilities/` | Buffer → Data-URL (oder `null`) |
| [`generateBlurDataURL.ts`](./generateBlurDataURL.ts) | `src/hooks/` | `beforeChange`-Hook für `media` |
| [`backfillBlurDataURLs.ts`](./backfillBlurDataURLs.ts) | `src/scripts/` | füllt den Bestand nach, ohne jedes Bild zu speichern |

## Einbau

**Feld und Hook in `src/collections/Media.ts`:**

```ts
import { generateBlurDataURL } from '../hooks/generateBlurDataURL'

export const Media: CollectionConfig = {
  slug: 'media',
  hooks: {
    beforeChange: [generateBlurDataURL],
  },
  fields: [
    // … alt, caption …
    {
      // Wird beim Upload gesetzt, nie von Hand.
      name: 'blurDataURL',
      type: 'text',
      admin: { hidden: true },
    },
  ],
}
```

`pnpm generate:types` danach. **Bei SQL-Adaptern (Postgres/SQLite) ist das eine neue Spalte** —
Migration erzeugen, siehe [database-migrations](../database-migrations/description.md). Bei MongoDB
nicht.

**Komponente** — im Template-`ImageMedia` die Konstante ersetzen:

```tsx
placeholder={resource.blurDataURL ? 'blur' : 'empty'}
blurDataURL={resource.blurDataURL || undefined}
```

`next/image` baut daraus selbst den SVG-Blur (`feGaussianBlur`) und entfernt ihn, sobald das Foto
geladen ist. Ohne Wert: `'empty'` — das Foto lädt über der Kartenfarbe, kein falsches Grau.

> Wer den Platzhalter weicher einblenden will (Foto fadet über den
> Blur), zeichnet den Blur selbst als Hintergrund des `<picture>` und entfernt ihn nach dem Fade —
> Beispiel in kapferer, `src/components/Media/ImageMedia/index.tsx`. Dabei **nicht** am
> `preload`-Bild (Hero): ein bis zum Fade unsichtbares Bild zählt später als LCP.

## Was der Hook entscheidet

- **Neue oder ersetzte Datei, Zuschnitt im Admin:** Payload legt die Bytes auf `req.file.data`, der
  Hook erzeugt neu.
- **Edit ohne neue Datei** (Alt-Text, Focal Point): `req.file` fehlt, der gespeicherte Wert bleibt.
- **Neuer Dateiname, aber keine Bytes:** Wert auf `null` — besser kein Blur als der des alten Fotos.
- **`null` statt Blur** bei: SVG und allem, was kein Rasterbild ist; **Bildern mit Transparenz**
  (Logos, Freisteller — der Blur würde um die Form herum verschmieren, `stats().isOpaque`); Dateien,
  die sharp nicht lesen kann (Fehler wird verschluckt, der Upload scheitert deshalb nicht).

## Bestehende Medien nachrüsten

Der Hook greift nur bei neuen Dateien. Für den Bestand — ohne jedes Bild einzeln zu öffnen und auf
Speichern zu klicken:

```bash
# Trockenlauf, schreibt nichts
pnpm payload run src/scripts/backfillBlurDataURLs.ts

# echt
APPLY=1 pnpm payload run src/scripts/backfillBlurDataURLs.ts

# ein Dokument / Batch / auch schon befüllte neu
APPLY=1 MEDIA_ID=<id> pnpm payload run src/scripts/backfillBlurDataURLs.ts
APPLY=1 LIMIT=100 pnpm payload run src/scripts/backfillBlurDataURLs.ts
APPLY=1 FORCE=1 pnpm payload run src/scripts/backfillBlurDataURLs.ts
```

Konfiguration über **Umgebungsvariablen**, nicht Flags — `payload run` schluckt alle Argumente
(siehe [media-webp-variants](../media-webp-variants/description.md#payload-run-schluckt-alle-argumente)).
Datenbank und Quelle wie dort: lokal gegen die Produktion über Tunnel/Infisical, die Dateien per
HTTP von `MEDIA_SOURCE` (Default `NEXT_PUBLIC_SERVER_URL`).

Vier Entscheidungen im Skript, die nicht zufällig sind:

**1. `payload.db.updateOne` mit `updatedAt: null`, nicht `payload.update`.** `payload.update` setzt
`updatedAt` neu — und wenn `updatedAt` als Cache-Buster in die imgproxy-URL geht
([image-optimization](../image-optimization/description.md)), kodiert imgproxy danach **jedes**
angefasste Bild neu, und das CDN verfehlt einmal komplett. Außerdem liefen die Media-Hooks samt
Revalidierung der ganzen Seite. `db.updateOne` umgeht Hooks und Revalidierung, setzt `updatedAt`
aber **trotzdem** auf „jetzt“, wenn man es nicht angibt: der Mongo-Adapter (3.92.1) ergänzt es im
Write-Transform (`utilities/transform.js`: `if (typeof data.updatedAt === 'undefined') …`).
Ausdrücklich `updatedAt: null` mitgeben — das heißt „nicht anfassen“.

> **Das stand hier zuerst falsch.** Die erste Fassung behauptete nach dem Lesen des Adapters
> („Timestamps are manually added by the write transform“), `db.updateOne` lasse `updatedAt`
> in Ruhe. Es heißt das Gegenteil: der Adapter setzt es *selbst*. Am echten Dokument gemessen:
> ohne `null` sprang `updatedAt` von `2026-11-12T12:04:01.661Z` auf `2026-11-20T07:53:08.972Z`,
> mit `null` blieb es stehen. Die Probe an **einem** Dokument mit `FORCE=1` vor dem Vollauf ist
> deshalb Pflicht, nicht Kür — `updatedAt` davor und danach vergleichen. Bei SQL-Adaptern nicht
> geprüft.

**2. Die 300-px-`thumbnail`-Variante als Quelle, nicht das Original.** Das Ergebnis ist ein 16-px-Bild;
das Original ist bis zu 4096 px breit. Der Unterschied ist der Download (~8 KB statt mehrere
hundert) — bei hunderten Bildern über HTTP spürbar. Fallback auf die Hauptdatei, wenn keine
`thumbnail` im Dokument steht (Quelle kleiner als 300 px). Die `thumbnail` hat nur `width`, also
kein Zuschnitt und dasselbe Seitenverhältnis. **Nicht** `square` verwenden — die ist zugeschnitten.

**3. Kein `where: { blurDataURL: { exists: false } }`.** Klingt naheliegend, ist eine Falle: Während
der Schleife geschriebene Dokumente fallen aus dem Ergebnis, die folgenden Seiten rutschen nach, und
**Dokumente werden übersprungen**. Fest sortieren (`sort: 'createdAt'`) und im Code filtern.

**4. Gedrosselt wie der Reparaturlauf:** seitenweise, ein Dokument nach dem anderen,
`sharp.concurrency(2)`, 100 ms Pause. Aus demselben Grund wie in
[media-webp-variants](../media-webp-variants/description.md#wie-dieses-skript-einen-server-lahmgelegt-hat-17082026).
Der Backfill ist leichter (ein 16-px-Ergebnis, keine sieben Varianten, keine Schreibzugriffe auf den
Bucket) — die Drosselung kostet wenig und spart die Diskussion.

**Danach:** Vorgerenderte Seiten haben den Wert noch nicht im HTML. Mit ISR (`revalidate = 3600`)
ziehen sie ihn beim nächsten Revalidieren nach, ohne Zutun. Rein statische Seiten ohne
`revalidate`: neu deployen oder `revalidatePath('/', 'layout')` auslösen — das Skript läuft
außerhalb von Next und kann das nicht.

Transparente und nicht lesbare Bilder bleiben `null` und werden bei jedem Lauf erneut geprüft
(ein 300-px-Download, billig). Zählt das Skript am Ende mehr „not applicable" als erwartet, sind es
Logos — das ist so gewollt.

## Gemessen — und warum hier nichts mehr zu optimieren ist

Gemessen an **einem** echten Foto (1600×657 JPEG; im Repo des Projekts lagen keine Medien, die
liegen in S3) mit `sharp` 0.35:

| Einstellung | Größe (Byte, Rohdaten) |
| --- | --- |
| 16 px, `quality: 60` (aktuell) | 78 |
| 16 px, `quality: 40` | 66–70 |
| 12 px, `quality: 60` | 68 |
| 10 px, `quality: 60` | 62–66 |
| 8 px, `quality: 60` | 56–58 |
| `effort: 6` statt 4 | ±0–4 |

Ein WebP-Container kostet allein rund 40 Byte. **Alles zwischen 8 und 16 px, 40 und 60 Qualität
liegt innerhalb von 25 Byte.** Bei echten Fotos mit mehr Detail sind es eher 100–200 Byte, aber auch
dort verschiebt Tuning nur Zehner. Es lohnt nicht, das gegen sichtbare Unschärfeartefakte
einzutauschen — 16 px / 60 bleibt.

Der größere Posten ist der **SVG-Wrapper** an der Anzeigestelle: in der selbstgezeichneten Variante
(Foto fadet über den Blur) rund 600 Zeichen Filter-Markup pro Bild, doppelt so viel wie der Blur
selbst. Wer `next/image`s eigenes `placeholder="blur"` nutzt, hat dieses Markup ebenfalls im
Inline-Style. Bei 10–20 Bildern pro Seite ist das im Rauschen; bei Seiten mit hunderten Bildern fällt es
ins Gewicht (nicht gemessen).

`removeAlpha()` nach der Opak-Prüfung brachte bei einem PNG mit vollständig opakem Alpha-Kanal
**keinen** messbaren Unterschied (44 Byte mit und ohne) — nicht nötig.

### Warum kein BlurHash / ThumbHash

Ein Hash ist kürzer (~25 Byte), muss aber **im Browser zu einem Bild decodiert** werden: JavaScript
plus Canvas. Der Platzhalter erscheint dann erst nach der Hydration, genau dann, wenn man ihn am
wenigsten braucht. Die WebP-Data-URL steht ohne JavaScript im HTML. Für 40 gesparte Byte nicht
getauscht.

## Externe Bilder ohne Media-Dokument (Justimmo, CDN-URLs)

Der Hook oben setzt das Feld beim Upload — das setzt ein Media-Dokument voraus. Kommen Bilder als
**URL aus einer externen API** (Immobilien aus Justimmo, Produktfotos aus einem Shop-System), gibt es
kein Dokument, auf dem `blurDataURL` stehen könnte. `next/image` mit `placeholder="blur"` und
Konstante zeigt dann wieder dasselbe Grau für alle Fotos — oder, ohne `blurDataURL`, gar nichts.

**Lösung:** dieselbe `makeBlurDataURL` läuft auf dem **Server beim Rendern**, das Ergebnis liegt im
Next.js-Datencache. Der Cache-Key ist die Bild-URL; ändert sich das Bild, ändert sich meist die URL
(bei Justimmo steckt ein Hash im Pfad), also ist ein langer Cache sicher und die Arbeit fällt **einmal
pro Bild** an, nicht einmal pro Seitenaufruf.

```ts
// src/lib/<quelle>/blur.ts
import { unstable_cache } from 'next/cache'

import { makeBlurDataURL } from '@/utilities/makeBlurDataURL'

const CACHE_SECONDS = 60 * 60 * 24 * 7

/** Dieselben Hosts wie `images.remotePatterns` in next.config.ts — sonst nichts laden. */
export const isAllowedImageUrl = (value: string): boolean => {
  try {
    const { hostname, protocol } = new URL(value)
    return protocol === 'https:' && (hostname.endsWith('.justimmo.at') || hostname.endsWith('.justimmo.net'))
  } catch {
    return false
  }
}

const readBlur = unstable_cache(
  async (url: string): Promise<null | string> => {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) })
    // Werfen statt null zurückgeben: ein fehlgeschlagener Download kommt so nicht in den Cache.
    if (!response.ok) throw new Error(`fetch ${response.status}`)

    return makeBlurDataURL(
      Buffer.from(await response.arrayBuffer()),
      response.headers.get('content-type')?.split(';')[0],
    )
  },
  ['<quelle>-blur'],
  { revalidate: CACHE_SECONDS },
)

export async function blurFor(url: string): Promise<string | undefined> {
  if (!isAllowedImageUrl(url)) return undefined
  try {
    return (await readBlur(url)) ?? undefined
  } catch {
    return undefined // kein Blur ist besser als eine kaputte Seite
  }
}
```

Das Ergebnis hängt man beim **Mappen der API-Daten** an jedes Bild (`Promise.all` über alle Bilder
einer Seite) und reicht es der Komponente durch:

```tsx
<NextImage
  blurDataURL={image.blurDataURL}
  placeholder={image.blurDataURL ? 'blur' : 'empty'}
  …
/>
```

Drei Entscheidungen, die nicht zufällig sind:

**1. Host-Allowlist vor dem Fetch.** Die URL stammt aus einer fremden API-Antwort, der Server ruft
sie auf. Ohne Prüfung ist das ein SSRF-Einfallstor (interne Adressen, Metadaten-Endpunkte). Die Liste
ist dieselbe wie `images.remotePatterns` — was `next/image` nicht ausliefern darf, lädt auch der Blur
nicht. Mit Tests absichern: `https://justimmo.at.evil.com`, `http://…` und `169.254.169.254` müssen
`false` liefern.

**2. Kleinere Bildgröße als Quelle, nicht die Anzeigegröße.** Das Ergebnis ist ein 16-px-Bild. Bieten
API oder CDN mehrere Größen an, die mittlere lesen (Justimmo: `medium`, 630 px, statt `fullhd`,
1920 px) — das Seitenverhältnis muss stimmen, also **keine zugeschnittene** Größe (`small` ist bei
Justimmo ein 100×300-Crop). Fehlt sie, fällt es auf die Anzeige-URL zurück.

**3. Fehler werfen, nicht cachen.** `unstable_cache` speichert, was die Funktion zurückgibt. Ein
`null` bei einem Timeout stünde danach eine Woche im Cache. Geworfene Fehler werden nicht gespeichert
und beim nächsten Rendern erneut versucht. `null` aus `makeBlurDataURL` selbst (transparent,
unlesbar) ist dagegen ein echtes Ergebnis und darf gecacht werden.

**Gemessen** (Next 16, Dev-Server, Seite mit 15 Bildern, davon Hero, neun Galeriebilder, Grundriss
und drei Karten): erster Aufruf mit leerem Cache 5,9 s (Seitenrender inklusive der API-Abrufe),
zweiter Aufruf 54 ms; alle 15 `<img>` tragen den Blur im HTML. Ein Produktions-Build wurde nicht
gemessen — die Zahl zeigt nur, dass der Cache greift und die Arbeit nicht pro Aufruf wiederkehrt.

Nicht getestet: wie sich der Datencache bei **mehreren Instanzen** verhält (jede Instanz hat ihren
eigenen Cache, Dokploy/Docker ohne gemeinsamen `cacheHandler`) — dann fällt die Arbeit einmal pro
Instanz an, sonst ändert sich nichts.

## Gegenprüfen

```js
// mongosh — wie viele Raster-Medien haben noch keinen Blur?
db.media.countDocuments({
  mimeType: /^image\//, $and: [{ mimeType: { $ne: 'image/svg+xml' } }],
  $or: [{ blurDataURL: null }, { blurDataURL: { $exists: false } }],
})
```

Eine Restmenge aus Logos/Freistellern ist normal. Im Browser: Netzwerk auf „Slow 3G“, Seite
neu laden — jedes Foto muss in **seinen eigenen** Farben erscheinen, nicht in einheitlichem Grau.

## Kurzüberblick

| Ziel | Wo | Wie |
| --- | --- | --- |
| Blur erzeugen | `hooks/generateBlurDataURL.ts` | `beforeChange` auf `media`, `req.file.data` → sharp 16 px WebP |
| Blur speichern | `Media.ts` | Feld `blurDataURL`, `type: 'text'`, `hidden` |
| Blur anzeigen | `ImageMedia` | `placeholder="blur"` + `blurDataURL={resource.blurDataURL}` |
| Bestand nachrüsten | `src/scripts/backfillBlurDataURLs.ts` | `APPLY=1`, `payload.db.updateOne` + `updatedAt: null`, Thumbnail als Quelle |
| Externe Bild-URLs (API) | `lib/<quelle>/blur.ts` | `makeBlurDataURL` auf dem Server, `unstable_cache` pro URL, Host-Allowlist, Fehler werfen statt cachen |
| Nicht tun | — | `payload.update` im Backfill; `db.updateOne` **ohne** `updatedAt: null` (bumpt `updatedAt` → imgproxy-Cache); `where`-Filter beim Paging |
