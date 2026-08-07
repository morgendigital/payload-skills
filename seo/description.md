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

## 6. Sitemap — **jede** öffentlich geroutete Collection braucht ihren eigenen Eintrag

Das ist der Punkt, der in unseren Projekten am zuverlässigsten durchrutscht: Die Sitemap wird
einmal beim Aufsetzen aus dem Payload-Template übernommen (`pages` + `posts`) und danach
kommen Collections dazu — Projekte, Jobs, Apartments, News, Kampagnen, Leistungen —, die
**nie** in einer Sitemap landen.

**Warum das nicht von allein passiert:** Im Template steht in `next-sitemap.config.cjs`
`exclude: ['/*', …]`. `next-sitemap` generiert also praktisch nichts selbst — es kann
dynamische Routen, deren Slugs erst aus der Datenbank kommen, gar nicht kennen. Jede
Collection wird über eine **eigene Route** ausgeliefert und muss in `additionalSitemaps`
referenziert werden. Fehlt der Schritt, existiert die Collection für Google nur über interne
Verlinkung.

**Stand in unseren Projekten** (Stichprobe, Stand 08/2026):

| Projekt | Öffentliche Route | In einer Sitemap? |
| ------- | ----------------- | ----------------- |
| northlight | `/posts/[slug]` | ❌ nur der Index `/posts`, hart in `pages-sitemap` |
| noas | `/apartments/[slug]` | ❌ nur `pages` + `posts` |
| bacher | `/news/[slug]` | ❌ nur `pages` |
| markenhaus | `/kampagnen/[slug]` | ❌ nur `pages` + `posts` |

Bei northlight ruft `revalidatePost.ts` dreimal `revalidateTag('posts-sitemap')` auf — die
Route `posts-sitemap.xml` existiert nicht. Ein verwaister Tag ist das typische Anzeichen: Da
hat jemand die Collection aus dem Template kopiert und den Sitemap-Teil vergessen.

### Vier Handgriffe pro Collection

1. **Route anlegen:** `src/app/(frontend)/(sitemaps)/<slug>-sitemap.xml/route.ts`
2. **Cache-Tag** in `unstable_cache` vergeben (`<slug>-sitemap`)
3. **Im `afterChange`/`afterDelete`-Hook** der Collection genau diesen Tag revalidieren
4. **In `next-sitemap.config.cjs`** unter `additionalSitemaps` **und** `exclude` eintragen

```ts
// src/app/(frontend)/(sitemaps)/projects-sitemap.xml/route.ts
import config from '@payload-config'
import { unstable_cache } from 'next/cache'
import { getServerSideSitemap } from 'next-sitemap'
import { getPayload } from 'payload'

const getProjectsSitemap = unstable_cache(
  async () => {
    const payload = await getPayload({ config })
    const SITE_URL = process.env.NEXT_PUBLIC_SERVER_URL || 'https://example.com'

    const results = await payload.find({
      collection: 'projects',
      overrideAccess: false, // nur, was auch öffentlich lesbar ist
      draft: false,
      depth: 0,
      limit: 1000,          // bei großen Collections gegenzählen, siehe unten
      pagination: false,
      where: { _status: { equals: 'published' } },
      select: { slug: true, updatedAt: true },
    })

    return results.docs
      .filter((doc) => Boolean(doc?.slug))
      .map((doc) => ({
        loc: `${SITE_URL}/projects/${doc.slug}`,
        lastmod: doc.updatedAt || new Date().toISOString(),
      }))
  },
  ['projects-sitemap'],
  { tags: ['projects-sitemap'] }, // muss zum revalidateTag im Hook passen
)

export async function GET() {
  return getServerSideSitemap(await getProjectsSitemap())
}
```

```js
// next-sitemap.config.cjs
exclude: ['/pages-sitemap.xml', '/projects-sitemap.xml', '/*'],
robotsTxtOptions: {
  policies: [{ userAgent: '*', disallow: '/admin/*' }],
  additionalSitemaps: [
    `${SITE_URL}/pages-sitemap.xml`,
    `${SITE_URL}/projects-sitemap.xml`, // ← ohne diese Zeile findet niemand die Datei
  ],
}
```

### Mehrsprachigkeit: die zweite Sprache fehlt fast immer

Bei `localization.locales: ['de', 'en']` mit Default-Locale ohne Prefix (Middleware schreibt
`/kontakt` intern auf `/de/kontakt` um, `/de/...` wird auf die saubere URL redirected) liefert
die Template-Sitemap nur `${SITE_URL}/${slug}` — **sämtliche `/en/…`-URLs fehlen**.

Wichtig ist die Unterscheidung: `revalidatePath` arbeitet auf den **internen** Pfaden
(`/de/…`, `/en/…`, dafür gibt es in den Projekten `localePaths()`), die Sitemap braucht die
**öffentlichen** URLs — also `/slug` für die Default-Locale und `/en/slug` für die zweite.
Dazu gehören `hreflang`-Alternates, damit die Sprachversionen nicht als Duplicate Content
gewertet werden:

```ts
results.docs.flatMap((doc) => [
  { loc: `${SITE_URL}/${doc.slug}`,     lastmod: doc.updatedAt },
  { loc: `${SITE_URL}/en/${doc.slug}`,  lastmod: doc.updatedAt },
])
```

### Was nicht in die Sitemap gehört

- **Entwürfe und ungelistete Inhalte** — `_status: published` und `overrideAccess: false`
  filtern das; Collections wie `dev-pages` gar nicht erst in `additionalSitemaps` aufnehmen
  (die Route bleibt sonst zwar erreichbar, aber unbeworben — besser zusätzlich `noindex`).
- **Einsendungen und geschützte Uploads** (`form-submissions`, `secure-documents`, siehe
  [form-submissions-email](../form-submissions-email/description.md)) — die haben ohnehin
  keine öffentliche Route.
- **Query-Parameter-URLs** — nur Canonicals.
- `/admin` und `/api` per `robots.txt` disallowen; `siteUrl` = Prod-Domain.

### Gegenprüfen (nach jedem Deploy mit neuer Collection)

```bash
# Welche Sitemaps kennt robots.txt?
curl -s https://example.com/robots.txt | grep -i sitemap

# Wie viele URLs liefert eine Sitemap?
curl -s https://example.com/projects-sitemap.xml | grep -c "<loc>"
```

Die Zahl gegen die veröffentlichten Dokumente der Collection im Admin halten. Weicht sie ab:
`limit`/`pagination`, `_status`-Filter oder fehlende Locale prüfen. Und für jede Collection
mit `[slug]`-Route im Frontend muss eine Zeile in `robots.txt` stehen — das ist der schnellste
Vollständigkeitstest.

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
6. **Sitemap pro Collection:** für **jede** Collection mit öffentlicher Route eine eigene
   `<slug>-sitemap.xml`-Route + Cache-Tag + `revalidateTag` im Hook + Eintrag in
   `additionalSitemaps`; alle Locales enthalten; `siteUrl` = Prod-Domain, `/admin` + `/api`
   ausschließen, nur Canonicals. Gegenprüfen: `curl robots.txt | grep -i sitemap` und
   `<loc>`-Anzahl gegen die veröffentlichten Dokumente halten.
7. `metadataBase`, `<html lang>`, ein `<h1>` pro Seite, optional JSON-LD
