# SEO — Cheat Sheet (Payload + Next.js)

Wiederkehrende Onpage-SEO-Baustellen, die in Payload-/Next.js-Projekten aus **fehlenden Code-Fallbacks** entstehen (nicht aus Redaktionsfehlern) — und wie man sie einmal sauber löst. Hintergrund: ein Onpage-Crawl von `neurauter-versichert.at` zeigte 18 Seiten „ohne individuellen Titel", 18 doppelte Titel, 20 Meta-Description-Probleme und 10 „identische HTML-Seiten" — fast alles Symptome der Punkte 1–4 unten. Quick-Checkliste steht am Ende.

## Die Kernursache

Der `@payloadcms/plugin-seo` füllt die SEO-Felder (`meta.title`, `meta.description`, `meta.image`) **nicht automatisch beim Speichern** — die `generate*`-Funktionen hängen an einem „Auto-generieren"-Button im Admin, den Redakteure oft nie klicken. Wer im Frontend dann **nur** `doc.meta.title` liest, rendert für jede unbefüllte Seite denselben generischen Fallback → massenhaft fehlende/doppelte Titel. **Lösung: im Frontend immer auf ein garantiert vorhandenes Feld (`doc.title`) zurückfallen.**

## 1. `seoPlugin` vollständig konfigurieren

`src/plugins/index.ts` — **alle drei** `generate*`-Funktionen setzen, nicht nur Titel/URL:

```ts
import { GenerateTitle, GenerateURL, GenerateDescription } from '@payloadcms/plugin-seo/types'

const generateTitle: GenerateTitle<Post | Page> = ({ doc }) =>
  doc?.title ? `${doc.title} | Marke` : 'Marke'

const generateDescription: GenerateDescription<Post | Page> = ({ doc }) =>
  doc?.meta?.description || doc?.excerpt || '' // aus Content ableiten, wenn vorhanden

const generateURL: GenerateURL<Post | Page> = ({ doc, collectionSlug }) => {
  const url = getServerSideURL()
  const prefix = collectionSlug === 'posts' ? '/posts' : ''
  return doc?.slug ? `${url}${prefix}/${doc.slug}` : url
}

seoPlugin({ generateTitle, generateDescription, generateURL })
```

→ **Gotcha:** Das Standard-`generateURL` in vielen Templates ist `${url}/${doc.slug}` für **alle** Collections — für Posts unter `/posts/...` also falsch. `collectionSlug` nutzen (steht im Callback zur Verfügung), um den Prefix zu setzen. Das ist die Vorlage für den Admin-Default; der eigentliche Frontend-Canonical kommt aus Punkt 3.

## 2. Titel-Fallback im Frontend — behebt fehlende & doppelte Titel

`src/utilities/generateMeta.ts` — nie nur `doc.meta.title` lesen:

```ts
// FALSCH: rendert für alle unbefüllten Seiten denselben Default
const title = doc?.meta?.title ? doc.meta.title + ' | Marke' : 'Marke'

// RICHTIG: Fallback auf den immer vorhandenen Dokumenttitel
const titleBase = doc?.meta?.title || doc?.title
const title = titleBase ? titleBase + ' | Marke' : 'Marke'
```

→ Ein Einzeiler, der typischerweise Dutzende „fehlende/doppelte Titel"-Fehler auf einmal auflöst, weil jedes Dokument ein `title`-Feld hat.

## 3. Canonical-URL auf jeder Seite ausgeben

Viele Templates geben **nirgends** ein `alternates.canonical` aus → Query-Parameter-Varianten (`?utm=`, Filter, Session-Params) und `/` vs `/home` zählen als Duplicate Content. In `generateMeta.ts`:

```ts
export const generateMeta = async (args: {
  doc: Partial<Page> | Partial<Post> | null
  /** Absoluter Pfad, unter dem das Dokument ausgeliefert wird, z. B. /posts/<slug>.
   *  Weglassen = aus Slug ableiten (korrekt für Top-Level-Pages, nicht für Prefix-Collections). */
  path?: string
}): Promise<Metadata> => {
  const { doc } = args

  const slugPath = doc?.slug
    ? `/${Array.isArray(doc.slug) ? doc.slug.join('/') : doc.slug}`
    : '/'
  // Home liegt auf `/`, hat aber Slug `home` → auf `/` normalisieren, damit `/` und `/home`
  // sich EINEN Canonical teilen.
  const path = args.path ?? (slugPath === '/home' ? '/' : slugPath)
  const canonical = `${getServerSideURL()}${path}`

  return {
    alternates: { canonical },
    // ...
  }
}
```

Prefix-Collections (Posts) übergeben ihren echten Pfad aus der Route:

```ts
// src/app/(frontend)/posts/[slug]/page.tsx → generateMetadata
return generateMeta({ doc: post, path: '/posts/' + decodedSlug })
```

→ **Zwei Fallen, die man hier gleich mit erschlägt:**
- **Posts:** ohne `path`-Param bekämen sie `/slug` statt `/posts/slug`.
- **Home:** `/` und `/home` rendern dasselbe Dokument (Root-`page.tsx` re-exportiert `generateMetadata` mit Slug-Default `home`) → ohne Normalisierung zwei URLs mit widersprüchlichem Canonical.

## 4. OpenGraph-`url` = echter Pfad

Häufiger Template-Bug: `url: Array.isArray(doc?.slug) ? doc.slug.join('/') : '/'` liefert für **jede** Nicht-Array-Slug-Seite `/`. Denselben `path` aus Punkt 3 verwenden:

```ts
openGraph: mergeOpenGraph({ title, description: doc?.meta?.description || '', url: path, images })
```

## 5. `alt` auf der Media-Collection required machen

`src/collections/Media.ts` — im Payload-Template ist `required` bei `alt` oft auskommentiert:

```ts
{ name: 'alt', type: 'text', required: true }
```

→ Forcing Function: neue Bilder können nicht mehr **ohne** Alt-Text gespeichert werden. **Achtung:** (a) bestehende Media-Docs ohne Alt verlangen beim nächsten Speichern einen Wert (bestehende Seiten brauchen weiter Redaktions-Nacharbeit); (b) prüfen, dass **Seed-Daten und programmatische `payload.create({ collection: 'media' })`-Aufrufe** ein `alt` mitgeben, sonst bricht der Seed.

Und in der Bild-Komponente (`ImageMedia`) den Alt **immer** durchreichen (`alt={resource.alt || ''}`), damit das Attribut überhaupt gerendert wird.

## 6. Sitemap & robots

- `next-sitemap` (bzw. `next-sitemap.config.cjs`) generiert `sitemap.xml` + `robots.txt` beim Build. Prüfen, dass `siteUrl` auf die Prod-Domain zeigt und Admin-/API-Pfade (`/admin`, `/api`) ausgeschlossen sind.
- Query-Parameter-URLs gehören **nicht** in die Sitemap — nur Canonicals.
- `robots.txt`: `/admin` und `/api` disallowen, Sitemap-URL referenzieren.

## 7. Weiteres (kurz)

- **`metadataBase`** in der Root-`layout.tsx` setzen (`new URL(getServerSideURL())`), sonst warnt Next.js und OG-Bilder bekommen relative URLs.
- **`<html lang="de">`** korrekt setzen (Crawler prüfen die Sprachangabe).
- **Ein `<h1>` pro Seite**; H1-Keywords sollten auch im Fließtext vorkommen (häufiger Content-Report-Punkt).
- **Structured Data** (JSON-LD, z. B. `Organization`, `BreadcrumbList`) via `<script type="application/ld+json">` im Layout/Template, wo sinnvoll.

## Quick-Checkliste für ein neues Projekt

1. `seoPlugin` mit **allen drei** `generate*`-Funktionen; `generateURL` mit `collectionSlug`-Prefix für Posts
2. `generateMeta.ts`: Titel-Fallback `doc.meta.title || doc.title`
3. `generateMeta.ts`: `alternates.canonical` ausgeben; `path`-Param für Prefix-Collections; `/home` → `/` normalisieren
4. OpenGraph-`url` auf den echten `path` setzen (nicht den `/`-Bug übernehmen)
5. `Media.alt` → `required: true`; Seed/`payload.create`-Aufrufe geben `alt` mit; `ImageMedia` reicht `alt` durch
6. `next-sitemap`: `siteUrl` = Prod-Domain, `/admin` + `/api` ausschließen, nur Canonicals
7. `metadataBase`, `<html lang>`, ein `<h1>` pro Seite, optional JSON-LD
