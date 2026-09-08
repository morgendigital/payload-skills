# GEO — AI-Search-Optimierung (Payload + Next.js)

Sichtbarkeit in ChatGPT, Perplexity, Claude, Gemini und Google AI Overviews. Abgrenzung:
[`seo/`](../seo/description.md) macht die Onpage-Grundlagen (Titel, Canonical, Sitemap),
[`seo-meta-check/`](../seo-meta-check/description.md) die Meta-Defaults und das Redaktions-Dashboard.
Dieser Skill setzt darauf auf: **was zusätzlich nötig ist, damit generative Suchsysteme die Seite
überhaupt lesen, verstehen und zitieren können.**

## 0. Ehrliche Einordnung — bevor jemand ein llms.txt verkauft

Das Thema ist voller Agentur-Marketing. Was messbar wirkt, in dieser Reihenfolge:

| Maßnahme | Wirkung | Aufwand | Abschnitt |
| --- | --- | --- | --- |
| **Crawler-Zugang** (robots.txt **+ Cloudflare**) | Voraussetzung für alles andere. Wird am häufigsten übersehen — und ist gleichzeitig der einzige Punkt, an dem eine Seite *komplett* unsichtbar ist. | 1 h | [1](#1-crawler-zugang--der-punkt-der-wirklich-blockiert) |
| **Content Signals** in robots.txt | Kein Ranking-Effekt, aber eine bewusste Kundenentscheidung (Training ja/nein) statt Zufall. | 30 min | [2](#2-content-signals-policy--die-entscheidung-die-der-kunde-treffen-muss) |
| **Strukturierte Daten** (`@graph`) | Attribution und Zitierbarkeit: Wer ist Autor, wer ist die Organisation, wo steht die Antwort. | 2–4 h | [5](#5-strukturierte-daten-als-graph) |
| **Content-Struktur** (Frage-Überschriften, Antwort zuerst, Zahlen, Quellen) | Die Princeton-GEO-Studie misst **+30–40 % Sichtbarkeit** für „Quellen zitieren, Statistiken ergänzen, Zitate einbauen". Keyword-Stuffing: **kein** Effekt. | laufend | [6](#6-redaktionelle-regeln--was-tatsächlich-zitiert-wird) |
| **Markdown-Auslieferung** | ~80 % weniger Tokens pro Seite für Retrieval-Bots. Technisch elegant, Wirkung noch schwach belegt. | 1 Tag | [3](#3-markdown-auslieferung-aus-payload) |
| **`llms.txt`** | **Wird von den großen Crawlern praktisch nicht abgerufen.** | 2–4 h | [4](#4-llmstxt-aus-payload-generieren) |

**Zu `llms.txt` im Klartext:** Eine Auswertung über 500 Mio. AI-Bot-Requests fand 408 Abrufe der
Datei. Google (Gary Illyes, John Mueller) hat öffentlich abgelehnt und vergleicht sie mit dem
Keywords-Meta-Tag; Stand Q1 2026 hat sich **kein** großer Anbieter (OpenAI, Google, Anthropic,
Meta, Mistral) verpflichtet, sie zu lesen. Die Adoption liegt bei ~10 % und konzentriert sich auf
SaaS-Doku und Dev-Tooling.

→ **Trotzdem bauen, aber richtig verkaufen:** Der reale Nutzen ist **agentischer Abruf** — wenn
jemand Claude Code, Cursor oder ChatGPT auf die Domain ansetzt, ist `llms.txt` ein kuratiertes
Inhaltsverzeichnis, das dem Agenten das Crawlen der ganzen Seite erspart. Für Doku-Portale und
B2B-Seiten mit Produktdetails lohnt es sich, für eine 12-Seiten-Firmenwebsite ist es Kosmetik.
Wer es als Ranking-Faktor verkauft, hat in sechs Monaten ein Erklärungsproblem.

## 1. Crawler-Zugang — der Punkt, der wirklich blockiert

Es gibt **zwei Bot-Klassen**, und sie müssen getrennt entschieden werden. Die pauschale
„AI-Bots blocken"-Regel, die viele Seiten aus Reflex gesetzt haben, schaltet die Seite aus der
AI-Suche **und** aus den Zitaten aus, ohne das Training nennenswert zu verhindern.

| Zweck | Betreiber | User-Agent-Tokens |
| --- | --- | --- |
| **Retrieval / Suche** — holt die Seite, *weil ein Mensch gerade fragt*. Ohne diese Bots keine Zitate, keine Links in der Antwort. | OpenAI | `OAI-SearchBot`, `ChatGPT-User` |
| | Anthropic | `Claude-SearchBot`, `Claude-User` |
| | Perplexity | `PerplexityBot`, `Perplexity-User` |
| | Google/Bing | `Googlebot`, `Bingbot` (AI Overviews laufen über den normalen Index) |
| **Training** — sammelt Text für Modelltraining. | OpenAI | `GPTBot` |
| | Anthropic | `ClaudeBot` |
| | Google | `Google-Extended` (steuert nur die *Verwendung* der Googlebot-Daten) |
| | Apple | `Applebot-Extended` (dito zu `Applebot`) |
| | Meta / Common Crawl / ByteDance | `Meta-ExternalAgent`, `CCBot`, `Bytespider` |

```ts
// src/app/robots.ts — Retrieval erlauben, Training nach Kundenentscheidung
import type { MetadataRoute } from 'next'
import { getServerSideURL } from '@/utilities/getURL'

const RETRIEVAL = ['OAI-SearchBot', 'ChatGPT-User', 'Claude-SearchBot', 'Claude-User',
                   'PerplexityBot', 'Perplexity-User']
const TRAINING  = ['GPTBot', 'ClaudeBot', 'Google-Extended', 'Applebot-Extended',
                   'Meta-ExternalAgent', 'CCBot', 'Bytespider']

export default function robots(): MetadataRoute.Robots {
  const url = getServerSideURL()
  return {
    rules: [
      { userAgent: '*', allow: '/', disallow: ['/admin/', '/api/'] },
      { userAgent: RETRIEVAL, allow: '/' },
      { userAgent: TRAINING, disallow: '/' }, // ← bewusste Entscheidung, siehe Abschnitt 2
    ],
    sitemap: [`${url}/pages-sitemap.xml`, `${url}/posts-sitemap.xml`],
  }
}
```

→ **Nur eine robots.txt-Quelle.** In unseren Projekten schreibt `next-sitemap` beim Build eine
`public/robots.txt`. Eine zusätzliche `app/robots.ts` ist ein stiller Konflikt — welche Datei
gewinnt, ist versions- und setup-abhängig, und man merkt es nicht. Entweder alle Regeln in
`next-sitemap.config.cjs` (`robotsTxtOptions.policies`) **oder** `generateRobotsTxt: false` und
alles in `app/robots.ts`. Danach **immer** gegen die deployte Domain prüfen, nicht lokal:

```bash
curl -s https://example.com/robots.txt
```

→ **Die eigentliche Falle liegt vor der robots.txt: Cloudflare.** Unsere Projekte laufen hinter
Cloudflare (siehe [`image-optimization/`](../image-optimization/description.md)). „Bot Fight Mode"
und die verwaltete Regel gegen AI-Scraper blocken die AI-Bots **am Edge**, bevor sie die
robots.txt je sehen. Ergebnis: eine perfekt konfigurierte robots.txt und trotzdem null Zugriffe.
Genauso wirkt die Bot-Challenge, die in [`lighthouse-check/`](../lighthouse-check/description.md)
den Score verfälscht hat — dasselbe Feature, anderes Symptom.

**Gegenprüfen (der einzige Test, der zählt):**

```bash
# 200 = Bot kommt durch, 403/503 = Cloudflare blockt (robots.txt ist dann irrelevant)
for ua in "OAI-SearchBot" "Claude-SearchBot" "PerplexityBot" "ChatGPT-User"; do
  printf '%-18s %s\n' "$ua" "$(curl -s -o /dev/null -w '%{http_code}' -A "$ua" https://example.com/)"
done
```

→ In Cloudflare unter **Security → Bots** die AI-Crawler-Regel prüfen und die Retrieval-Bots
freigeben (Skip-Rule auf die User-Agents). Wer Pay-per-Crawl nutzt: das ist eine bewusste
Monetarisierungs-Entscheidung des Kunden, kein Default.

## 2. Content Signals Policy — die Entscheidung, die der Kunde treffen muss

Cloudflare hat am 24.09.2025 eine robots.txt-Erweiterung veröffentlicht, die **Zugriff** und
**Verwendung** trennt. Drei Signale, jeweils `yes`/`no`:

| Signal | Bedeutung |
| --- | --- |
| `search` | Index aufbauen, Link + Snippet zeigen — **ohne** AI-Zusammenfassung |
| `ai-input` | Inhalt als Input für eine Antwort verwenden (RAG, Grounding, AI Overviews) |
| `ai-train` | Inhalt zum Trainieren/Finetunen von Modellen verwenden |

```
User-agent: *
Content-Signal: search=yes, ai-input=yes, ai-train=no
Allow: /
```

→ **Empfohlener Default für Kundenprojekte:** `search=yes, ai-input=yes, ai-train=no`. Die Seite
soll gefunden und zitiert werden; das Training ist der Teil ohne Gegenleistung. Bei Kunden mit
lizenziertem oder redaktionellem Content (Verlage, Fotografie, Datenbanken) vorher explizit
fragen — und die Antwort ins Projektprotokoll, nicht nur in die Datei.

→ **Kein Standard.** Es ist ein einseitig veröffentlichtes Signal; die IETF-Gruppe **AIPREF**
arbeitet noch an der Standardisierung. Rechtlich ist es eine dokumentierte Willenserklärung
(brauchbar, wenn es je zum Streit kommt), technisch verhindert es **nichts**. Wer wirklich
sperren will, braucht Abschnitt 1 (Disallow **und** Edge-Block).

→ `Content-Signal` ist eine freie Zeile im robots.txt-Format — `next-sitemap`s
`robotsTxtOptions.policies` kann sie nicht erzeugen. Entweder ein Postbuild-Schritt, der die
Zeile anhängt, oder die eigene Route aus Abschnitt 1.

## 3. Markdown-Auslieferung aus Payload

Retrieval-Bots parsen HTML mit allem Drumherum — Nav, Cookie-Banner, Tailwind-Klassen. Dieselbe
Seite als Markdown kostet rund **80 % weniger Tokens**, und was übrig bleibt, ist der Inhalt.

Zwei Teile:

```ts
// src/middleware.ts (oder proxy.ts) — Accept-Header umschreiben
if (request.headers.get('accept')?.includes('text/markdown')) {
  return NextResponse.rewrite(new URL(`/md${request.nextUrl.pathname}`, request.url))
}
```

```ts
// src/app/md/posts/[slug]/route.ts
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const md = await getPostMarkdown(slug) // siehe unten
  if (!md) return new Response('Not found', { status: 404 })

  return new Response(md, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Vary': 'Accept',                     // ← sonst liefert der CDN-Cache HTML an Markdown-Anfragen
      'Cache-Control': 'public, max-age=0, s-maxage=3600',
    },
  })
}
```

→ **`Vary: Accept` ist Pflicht.** Ohne den Header cachen Cloudflare und der Next-Route-Cache eine
Variante und liefern sie an alle aus — derselbe Fehlermodus wie beim `Vary: Accept` für WebP in
[`image-optimization/`](../image-optimization/description.md).

→ **Zusätzlich `.md`-URLs anbieten** (`/posts/mein-post.md`). Der Accept-Header wird von vielen
Agenten nicht gesetzt, eine erratbare URL funktioniert immer — und lässt sich in `llms.txt`
verlinken.

### Der Payload-spezifische Teil: Blocks nach Markdown

`convertLexicalToMarkdown` löst nur das Rich-Text-Feld. Unsere Seiten bestehen aber aus einem
`layout`-Block-Array — Hero, Media, CTA, Accordion, Cards. Ein Markdown-Export, der nur den
Rich-Text kennt, liefert für eine typische Landingpage **fast nichts**.

```ts
// src/blocks/toMarkdown.ts — eine Funktion pro Block, neben der React-Komponente
import { convertLexicalToMarkdown, editorConfigFactory } from '@payloadcms/richtext-lexical'

const rich = (data: any, config: any) =>
  data ? convertLexicalToMarkdown({ data, editorConfig: editorConfigFactory.default({ config }) }) : ''

export const blockToMarkdown: Record<string, (block: any, config: any) => string> = {
  content:   (b, c) => b.columns?.map((col: any) => rich(col.richText, c)).join('\n\n') ?? '',
  accordion: (b, c) => b.items?.map((i: any) => `### ${i.title}\n\n${rich(i.content, c)}`).join('\n\n') ?? '',
  cta:       (b, c) => rich(b.richText, c),
  mediaBlock: (b) => (b.media?.alt ? `![${b.media.alt}](${b.media.url})` : ''), // Alt-Text ist der Inhalt
  hero:      (b, c) => `# ${b.title ?? ''}\n\n${rich(b.richText, c)}`,
  // Rein dekorative Blocks bewusst auf '' — nicht vergessen, sondern eintragen
  spacer:    () => '',
}

export const layoutToMarkdown = (layout: any[] = [], config: any) =>
  layout.map((b) => blockToMarkdown[b.blockType]?.(b, config) ?? '').filter(Boolean).join('\n\n')
```

→ **Regel für neue Blocks:** Wer einen Block anlegt, legt die `toMarkdown`-Zeile mit an — genau
wie die Sitemap-Route pro Collection in [`seo/`](../seo/description.md). Ein fehlender Eintrag
fällt sonst nie auf, weil das HTML ja stimmt. Ein `console.warn` im Dev-Modus für unbekannte
`blockType`s kostet nichts und deckt es auf.

→ **Caching wie bei den Sitemaps:** `unstable_cache` mit Tag `md-<collection>`, im
`afterChange`-Hook `revalidateTag`. Ohne das rendert jeder Bot-Abruf die Blocks neu.

## 4. `llms.txt` aus Payload generieren

Format (llmstxt.org): **H1 = einzige Pflichtangabe**, danach optional ein Blockquote als
Kurzbeschreibung, optionaler Fließtext, dann H2-Abschnitte mit Linklisten
`- [Titel](URL): Notiz`. Ein Abschnitt `## Optional` ist per Konvention das, was ein Agent bei
knappem Kontext überspringen darf.

```
# Marke

> Was die Firma macht, in zwei Sätzen.

## Leistungen

- [Beratung](https://example.com/beratung.md): Ablauf, Dauer, Preisrahmen
- [Umsetzung](https://example.com/umsetzung.md)

## Optional

- [Impressum](https://example.com/impressum.md)
```

**Kuratieren, nicht dumpen.** Der ganze Sinn ist Auswahl — eine Liste aller 200 Dokumente ist
eine Sitemap in schlechterem Format. Deshalb zwei Felder auf den Collections und ein Global für
Kopf und Reihenfolge:

```ts
// in Pages/Posts, sinnvollerweise in der Sidebar neben den SEO-Feldern
{
  name: 'llms',
  type: 'group',
  label: 'AI-Search',
  admin: { position: 'sidebar' },
  fields: [
    { name: 'include', type: 'checkbox', label: 'In llms.txt aufnehmen', defaultValue: false },
    { name: 'note', type: 'text', maxLength: 120,
      admin: { condition: (_, s) => Boolean(s?.include),
               description: 'Ein Satz: wofür ist diese Seite gut? Steht hinter dem Link.' } },
    { name: 'section', type: 'select', defaultValue: 'main',
      options: [{ label: 'Hauptteil', value: 'main' }, { label: 'Optional', value: 'optional' }],
      admin: { condition: (_, s) => Boolean(s?.include) } },
  ],
}
```

```ts
// src/app/(frontend)/llms.txt/route.ts
import { unstable_cache } from 'next/cache'

const build = unstable_cache(async () => {
  const payload = await getPayload({ config })
  const url = getServerSideURL()
  const defaults = await payload.findGlobal({ slug: 'seo-defaults' })

  const collect = async (collection: 'pages' | 'posts', prefix = '') => {
    const { docs } = await payload.find({
      collection, depth: 0, limit: 200, pagination: false, overrideAccess: false, draft: false,
      where: { and: [{ _status: { equals: 'published' } }, { 'llms.include': { equals: true } }] },
      select: { title: true, slug: true, llms: true },
    })
    return docs.map((d: any) => ({
      section: d.llms?.section === 'optional' ? 'optional' : 'main',
      line: `- [${d.title}](${url}${prefix}/${d.slug}.md)${d.llms?.note ? `: ${d.llms.note}` : ''}`,
    }))
  }

  const items = [...(await collect('pages')), ...(await collect('posts', '/posts'))]
  const main = items.filter((i) => i.section === 'main').map((i) => i.line)
  const optional = items.filter((i) => i.section === 'optional').map((i) => i.line)

  return [
    `# ${defaults.siteName}`,
    ``, `> ${defaults.description}`, ``,
    `## Inhalte`, ``, ...main,
    ...(optional.length ? [``, `## Optional`, ``, ...optional] : []),
    ``,
  ].join('\n')
}, ['llms-txt'], { tags: ['llms-txt'] })

export async function GET() {
  return new Response(await build(), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, s-maxage=3600' },
  })
}
```

→ **Dieselben vier Handgriffe wie bei der Sitemap:** Route anlegen, Cache-Tag vergeben,
`revalidateTag('llms-txt')` in den `afterChange`/`afterDelete`-Hooks der beteiligten Collections,
und die Datei in der robots.txt referenzieren (`# llms.txt: https://example.com/llms.txt` als
Kommentarzeile — es gibt keine offizielle Direktive dafür).

→ **`llms-full.txt` nur bei Doku-Portalen.** Die Datei enthält den kompletten Text aller Seiten.
Bei einer Firmenwebsite ist sie entweder nutzlos oder so groß, dass sie kein Kontextfenster
überlebt. Wenn doch: aus demselben Markdown wie Abschnitt 3 bauen, hart auf die kuratierten
Dokumente begrenzen und die Größe im Admin anzeigen.

→ **Mehrsprachig:** pro Locale eine Datei (`/llms.txt`, `/en/llms.txt`), nicht beide Sprachen in
eine — sonst hat der Agent zwei Antworten auf jede Frage.

## 5. Strukturierte Daten als `@graph`

AI-Systeme brauchen für ein Zitat drei Dinge: **wer sagt es**, **wann**, **worum geht es**. JSON-LD
liefert genau das maschinenlesbar — und ist gleichzeitig der einzige Teil dieses Skills, der auch
in der klassischen Suche noch Rich Results erzeugt.

### 5.1 Die Organisationsdaten gehören in ein Global — einmal

Der häufigste Fehler ist nicht fehlendes Markup, sondern **drei Wahrheiten**: Adresse im Impressum,
Öffnungszeiten im Footer-Block, Firmenname hart im JSON-LD. Sobald der Kunde umzieht, stimmt zwei
von drei Stellen nicht mehr. Das `seo-defaults`-Global aus
[`seo-meta-check/` §4](../seo-meta-check/description.md#4-optional-defaults-redaktionell-pflegbar-machen)
um die Organisationsdaten erweitern und **überall** daraus lesen:

```ts
// src/globals/SeoDefaults.ts — Ergänzung
{
  name: 'organization',
  type: 'group',
  label: 'Organisation (Impressum + strukturierte Daten)',
  fields: [
    { name: 'legalName', type: 'text', required: true },       // Firmenbuch-Name, nicht die Marke
    { name: 'type', type: 'select', defaultValue: 'Organization',
      options: ['Organization', 'LocalBusiness', 'ProfessionalService', 'Restaurant', 'HotelOrLodging'] },
    { name: 'logo', type: 'upload', relationTo: 'media' },      // ≥ 112×112, quadratisch
    { name: 'phone', type: 'text' },
    { name: 'email', type: 'email' },
    { name: 'vatId', type: 'text' },                            // ATU… — steht ohnehin im Impressum
    { name: 'address', type: 'group', fields: [
      { name: 'street', type: 'text' }, { name: 'postalCode', type: 'text' },
      { name: 'city', type: 'text' }, { name: 'country', type: 'text', defaultValue: 'AT' },
    ]},
    { name: 'sameAs', type: 'array', fields: [{ name: 'url', type: 'text', required: true }],
      admin: { description: 'LinkedIn, Instagram, Wikipedia, Firmenbuch, Branchenverzeichnis' } },
    { name: 'openingHours', type: 'array', admin: { condition: (_, s) => s?.type !== 'Organization' },
      fields: [
        { name: 'days', type: 'select', hasMany: true,
          options: ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'] },
        { name: 'opens', type: 'text' }, { name: 'closes', type: 'text' }, // "08:00"
      ] },
  ],
}
```

→ **`sameAs` ist für kleine Marken der wirksamste Hebel im ganzen Abschnitt.** So verbindet ein
Modell „Müller GmbH" mit *dieser* Firma statt mit 40 Namensdubletten. Firmenbuch-/Handelsregister-
und Branchenverzeichnis-Einträge zählen genauso wie Social-Profile.

→ **`LocalBusiness` statt `Organization`**, sobald es eine Adresse mit Publikumsverkehr gibt —
Tischlerei, Hotel, Ordination, Kanzlei. Nur dann sind `address`, `openingHours` und `geo`
überhaupt auswertbar. Für eine reine B2B-Agentur bleibt `Organization` richtig.

→ **Dieselbe Quelle füttert das Impressum.** Dann kann die Adresse in
[`go-live-check` Todo 4](../go-live-check/description.md) nicht mehr auseinanderlaufen.

### 5.2 Welche Collection bekommt welchen Typ

Der zweite typische Fehler: `Article` auf alles. Die Zuordnung ist nicht Geschmackssache — an ihr
hängt, welche Pflichtfelder Google erwartet.

| Collection | Typ | Pflichtfelder (Minimum) |
| --- | --- | --- |
| `pages` | `WebPage` (+ `BreadcrumbList`) | `name`, `inLanguage` |
| `posts`, `news` | `Article` / `BlogPosting` | `headline`, `datePublished`, `author`, `image` |
| `jobs` | `JobPosting` | `title`, `datePosted`, `validThrough`, `hiringOrganization`, `jobLocation` |
| `apartments`, Zimmer | `Accommodation` / `LodgingBusiness` | `name`, `address`, `numberOfRooms`, `amenityFeature` |
| `services`, `leistungen` | `Service` | `name`, `provider` (→ `@id` der Organisation), `areaServed` |
| `events` | `Event` | `name`, `startDate`, `location`, `eventStatus` |
| Produkte/Shop | `Product` + `Offer` | `name`, `image`, `offers.price`, `offers.priceCurrency`, `offers.availability` |
| FAQ-Block | `FAQPage` | `mainEntity[].name`, `acceptedAnswer.text` |

→ **Genau die Collections, die in [`seo/` §6](../seo/description.md) keine Sitemap bekommen
haben — Jobs, Apartments, Kampagnen —, haben typischerweise auch kein Schema.** Es ist derselbe
Ursprung: aus dem Template kopiert, den Rest vergessen. Der Sitemap-Abgleich im Go-Live-Check ist
deshalb gleichzeitig die Liste der Collections, deren Schema zu prüfen ist.

### 5.3 Der `@graph`

Statt drei getrennter `<script>`-Tags **ein** `@graph` mit `@id`-Verweisen — dann weiß der Parser,
dass Artikel, Autor und Organisation zusammengehören, statt drei unverbundene Objekte zu sehen.

```tsx
// src/components/JsonLd.tsx — serverseitig, aus denselben Daten wie generateMeta
const org = defaults.organization
const graph = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': org.type, '@id': `${url}/#org`,
      name: defaults.siteName, legalName: org.legalName, url,
      logo: { '@type': 'ImageObject', url: getMediaUrl(org.logo?.url) },
      telephone: org.phone, email: org.email, vatID: org.vatId,
      address: { '@type': 'PostalAddress', streetAddress: org.address?.street,
        postalCode: org.address?.postalCode, addressLocality: org.address?.city,
        addressCountry: org.address?.country },
      sameAs: org.sameAs?.map((s) => s.url),
      ...(org.type !== 'Organization' && org.openingHours?.length
        ? { openingHoursSpecification: org.openingHours.map((h) => ({
            '@type': 'OpeningHoursSpecification', dayOfWeek: h.days, opens: h.opens, closes: h.closes })) }
        : {}),
    },
    { '@type': 'WebSite', '@id': `${url}/#website`, url, inLanguage: locale,
      publisher: { '@id': `${url}/#org` } },
    { '@type': 'WebPage', '@id': `${url}${path}#page`, url: `${url}${path}`,
      name: doc.meta?.title || doc.title, inLanguage: locale,
      isPartOf: { '@id': `${url}/#website` }, datePublished: doc.createdAt, dateModified: doc.updatedAt },
    { '@type': 'BreadcrumbList', itemListElement: breadcrumbs.map((b, i) => ({
        '@type': 'ListItem', position: i + 1, name: b.label, item: `${url}${b.url}` })) },
    ...(doc.publishedAt ? [{
      '@type': 'Article', headline: doc.title, datePublished: doc.publishedAt,
      dateModified: doc.updatedAt, image: ogImage,
      author: { '@type': 'Person', name: doc.author?.name, url: doc.author?.profileUrl },
      publisher: { '@id': `${url}/#org` }, mainEntityOfPage: { '@id': `${url}${path}#page` } }] : []),
  ],
}

return <script dangerouslySetInnerHTML={{ __html: JSON.stringify(graph) }} type="application/ld+json" />
```

→ **`@id` ist der ganze Trick.** Ohne die Verweise (`publisher: { '@id': … }`) stehen drei Objekte
nebeneinander und der Bezug „dieser Artikel stammt von dieser Organisation" existiert nicht.

→ **`inLanguage` pro Locale setzen** — bei zweisprachigen Payload-Projekten sonst zwei Seiten mit
identischem Graph in unterschiedlicher Sprache. Die `@id`s müssen die Locale enthalten
(`${url}/en/…#page`), sonst überschreiben sich die Sprachversionen gegenseitig.

→ **`JSON.stringify` statt Template-String.** Ein Apostroph im Firmennamen oder ein `</script>` im
Text zerlegt sonst das Dokument — und ist gleichzeitig ein XSS-Vektor. `dangerouslySetInnerHTML`
mit `JSON.stringify` ist hier der korrekte Weg, nicht die Ausnahme.

### 5.4 Was Google 2026 noch rendert — und was nicht

Wichtig fürs Erwartungsmanagement, weil hier viele Agentur-Checklisten veraltet sind:

| Typ | Rich Result in Google | Trotzdem ausgeben? |
| --- | --- | --- |
| `Product`, `Review`/`AggregateRating`, `Event`, `JobPosting`, `Recipe`, `BreadcrumbList` | ja | ja |
| `Article`, `Organization`, `LocalBusiness` | kein eigenes Snippet, aber Knowledge-Panel- und Entitäts-Signal | ja |
| **`FAQPage`** | **nein — seit 07.05.2026 abgeschaltet**, Search-Console-Filter und Rich-Results-Test-Unterstützung im Juni 2026 entfernt | **ja**, siehe unten |
| **`HowTo`** | **nein** — Doku entfernt, kein Rich Result mehr | optional |

→ **FAQ-Markup bleibt trotzdem drin.** Es ist weiterhin gültiges Schema.org, Google sagt
ausdrücklich, dass ungenutzte strukturierte Daten nicht schaden — und für **Retrieval** ist
Frage/Antwort das Format, in dem gefragt wird. Nur die Erwartung „wir bekommen die aufklappbaren
FAQ in den Suchergebnissen" ist tot. Wer das 2024 verkauft hat, sollte den Kunden aktiv informieren,
bevor der es im Bericht selbst merkt.

→ **Kein Markup ohne sichtbaren Inhalt.** Gilt unverändert und wird auch geahndet: Die Fragen
müssen auf der Seite stehen, Preise müssen den ausgezeichneten entsprechen, Bewertungen dürfen
nicht selbst geschrieben sein (eigene „Kundenstimmen" ohne Bewertungsplattform sind kein
`AggregateRating`).

### 5.5 Die Fallen, die im Betrieb auffallen

- **`JobPosting` ohne Ablauf.** `validThrough` ist Pflicht, **und** die Stelle muss nach dem
  Besetzen von der Seite verschwinden oder klar als geschlossen markiert sein. Abgelaufene, aber
  weiter ausgelieferte Stellenanzeigen sind einer der wenigen Fälle, die zu einer manuellen
  Maßnahme führen. Praktisch: `validThrough` als Pflichtfeld in der Jobs-Collection und ein
  `beforeRead`/Filter, der abgelaufene Jobs aus Sitemap **und** Schema nimmt.
- **`dateModified` springt bei jedem Deploy.** `doc.updatedAt` ist korrekt, `new Date()` nicht —
  und ein Datum, das sich täglich ändert, ohne dass sich der Text ändert, ist ein negatives Signal.
- **`price` als String mit Währungszeichen.** `price: '1.234,00 €'` ist ungültig; es braucht
  `price: '1234.00'` plus `priceCurrency: 'EUR'`. Deutsche Zahlenformatierung ist hier der
  häufigste Validierungsfehler.
- **Bilder als relative URLs.** Im Schema müssen sie absolut sein — dieselbe `getMediaUrl`-Regel
  wie beim OG-Bild in [`seo-meta-check/` §3](../seo-meta-check/description.md#3-fix-das-og-bild-der-seite-sauber-auflösen).
- **Doppeltes Markup.** Kommt das JSON-LD sowohl aus dem Layout als auch aus einem Block, stehen
  zwei `Organization`-Objekte mit unterschiedlichen `@id`s auf der Seite. Ein Ort, ein Graph.

### 5.6 Validieren

```bash
# Was steht überhaupt drin?
curl -s https://domain.at/ | grep -o '<script type="application/ld+json">.*</script>' | head -1
```

- **Rich Results Test** (`search.google.com/test/rich-results`) für die Typen, die Google noch
  rendert — beachten: FAQ wird dort seit Juni 2026 nicht mehr geprüft.
- **Schema Markup Validator** (`validator.schema.org`) für alles andere, inklusive der Typen ohne
  Rich Result. Der zeigt auch, ob die `@id`-Verweise tatsächlich auflösen.
- **Search Console → Verbesserungen** nach zwei bis drei Wochen gegenprüfen: Dort tauchen Fehler
  auf, die beide Validatoren an der Einzel-URL nicht zeigen, weil sie erst über viele Dokumente
  sichtbar werden (z. B. eine Collection, in der `author` immer leer ist).

## 6. Redaktionelle Regeln — was tatsächlich zitiert wird

Retrieval zerlegt Seiten in **Chunks**. Zitiert wird ein Absatz, nicht eine Seite. Daraus folgen
sechs Regeln, die sich redaktionell durchhalten lassen:

1. **H2 als Frage formulieren**, so wie sie gestellt wird („Was kostet eine Sanierung?" statt
   „Kosten").
2. **Antwort in den ersten zwei Sätzen** nach der Überschrift. Alles davor (Einleitung,
   Storytelling) senkt die Chance, dass der Chunk als Antwort taugt.
3. **Absätze müssen allein stehen können.** „Wie oben beschrieben" ist im Chunk wertlos —
   Subjekt wiederholen statt referenzieren.
4. **Zahlen, Datum, Quelle** einbauen. Der messbare Teil der Princeton-Studie: Statistiken,
   Zitate und Quellenangaben bringen +30–40 %; Keyword-Dichte bringt nichts.
5. **Entitäten ausschreiben** — „Wir" ist keine Entität. Mindestens einmal pro Seite Firmenname,
   Ort, Leistung im Klartext.
6. **Aktualität sichtbar machen** (Datum im Text **und** `dateModified`). Modelle bevorzugen
   Belegbares mit Datum.

## 7. GEO-Check im Admin

Der Punkt, an dem sich das Ganze von einer PDF-Checkliste unterscheidet: dieselbe Mechanik wie
der SEO-Check aus [`seo-meta-check/`](../seo-meta-check/description.md#5-dashboard-meta-check-über-alle-seiten),
zweiter Regelsatz, **eine** View mit zwei Tabs.

```ts
// src/components/SeoCheck/geoChecks.ts — gleiche Finding/Severity-Typen wie checks.ts
export const buildGeoRows = (input: { doc: MetaDoc; markdown: string; path: string }[]): SeoRow[] =>
  input.map(({ doc, markdown, path }) => {
    const findings: Finding[] = []
    const headings = markdown.match(/^##\s+(.+)$/gm) ?? []

    if (markdown.trim().length < 300)
      findings.push({ label: 'Kaum extrahierbarer Text (Blocks ohne toMarkdown?)', severity: 'error' })
    if (headings.length && !headings.some((h) => h.includes('?')))
      findings.push({ label: 'Keine Frage-Überschrift', severity: 'warn' })
    if (!/\d/.test(markdown))
      findings.push({ label: 'Keine Zahl/Datum im Text', severity: 'warn' })
    if (!doc.llms?.include)
      findings.push({ label: 'Nicht in llms.txt', severity: 'ok' })
    // ...
    return { /* … wie in checks.ts */ }
  })
```

Dazu drei Dinge, die keine Regel prüfen kann und deshalb als **Statuszeilen** oben stehen:

- **Bot-Zugang** — das Ergebnis des `curl -A`-Tests aus Abschnitt 1, als Liste „OAI-SearchBot 200,
  PerplexityBot 403". Ein 403 gehört ganz nach oben, weil dann alles darunter egal ist.
- **`llms.txt`-Vorschau** — die generierte Datei im Klartext mit Zeilenzahl und
  `CopyToClipboard`. Redakteure müssen sehen, was ihr Häkchen produziert.
- **Markdown-Vorschau pro Dokument** — was ein Bot wirklich liest. Deckt fehlende
  `toMarkdown`-Einträge sofort auf.

→ **Die Prüfung nicht bei jedem Dashboard-Aufruf laufen lassen.** Der GEO-Check rendert Markdown
für alle Dokumente — deutlich teurer als der Meta-Check. `unstable_cache` mit Tag `geo-check`,
invalidiert im `afterChange`-Hook, und der `curl`-Teil als manueller Button, nicht automatisch.
Auf den kleinen Hetzner-Instanzen gilt dieselbe Drosselungsregel wie bei den Media-Skripten.

## 8. Messung — und warum die Zahlen nie stimmen

**Referral-Traffic (GA4):** Es gibt seit Mai 2026 einen nativen Kanal „AI Assistant", der aber
Perplexity und alles ohne Referrer ausklammert. Deshalb zusätzlich eine eigene Kanalgruppe mit
`openai`, `chatgpt`, `perplexity`, `gemini`, `claude`, `copilot` als Quell-Muster anlegen (im
`c15t`-Setup aus [`tracking/`](../tracking/description.md) mitziehen).

→ **35–70 % der AI-Klicks kommen ohne Referrer an** und landen in „Direct". Jede GA4-Zahl zu
AI-Traffic ist eine **Untergrenze** — das dem Kunden von Anfang an sagen, sonst wird der erste
Report zur Diskussion über die Messung statt über die Inhalte.

**Bot-Zugriffe:** Interessanter als die Klicks ist, *ob die Bots überhaupt kommen*. Die Daten
stehen im Reverse-Proxy-Log bzw. in den Cloudflare-Analytics (dort auch die Crawler-/robots.txt-
Ansicht). **Nicht** pro Request in die Datenbank schreiben — das kostet für jede Seite das
statische Rendering aus [`static-rendering/`](../static-rendering/description.md) und bringt
dieselbe Information schlechter.

```bash
# Auf dem Server: welche AI-Bots waren diese Woche da?
grep -aiE 'GPTBot|OAI-SearchBot|ClaudeBot|Claude-SearchBot|PerplexityBot|Bytespider' access.log \
  | grep -oiE 'GPTBot|OAI-SearchBot|ClaudeBot|Claude-SearchBot|PerplexityBot|Bytespider' \
  | sort | uniq -c | sort -rn
```

**Sichtbarkeit selbst:** stichprobenartig die 10 wichtigsten Kundenfragen in ChatGPT, Perplexity
und Google AI Overviews stellen und protokollieren, ob und wie die Marke vorkommt. Unelegant,
aber es ist die einzige Zahl, die den Kunden interessiert. Erwartungsmanagement: 3–6 Monate.

## 9. Was wir bewusst nicht machen

- **Keine AI-generierten Meta-Texte per Default.** Verlockend, aber es produziert die
  austauschbaren Texte, gegen die der ganze Rest arbeitet.
- **Kein `ai.txt`.** Dritte Datei, noch weniger Adoption als `llms.txt`, keine Unterstützung.
- **Kein Cloaking für Bots** — ausgelieferter Markdown-Inhalt muss dem HTML entsprechen.
- **Keine FAQ-Schemas ohne sichtbare FAQ.**

## Quick-Checkliste

1. `curl -A` gegen die **Prod-Domain** für `OAI-SearchBot`, `Claude-SearchBot`, `PerplexityBot`,
   `ChatGPT-User` — alles ≠ 200 zuerst in Cloudflare (Security → Bots) klären
2. robots.txt aus **einer** Quelle; Retrieval-Bots erlaubt, Training-Bots nach Kundenentscheidung
3. `Content-Signal: search=yes, ai-input=yes, ai-train=no` (oder die dokumentierte Kundenentscheidung)
4. Organisationsdaten **einmal** im `seo-defaults`-Global (inkl. `sameAs`, `LocalBusiness` bei
   Publikumsverkehr), daraus **ein** `@graph` mit `@id`-Verweisen und `inLanguage`; pro Collection
   der richtige Typ (Jobs → `JobPosting` mit `validThrough`, Apartments → `Accommodation`,
   Leistungen → `Service`); FAQ-Markup bleibt, liefert seit 05/2026 aber kein Rich Result mehr;
   mit Rich Results Test **und** Schema Markup Validator gegenprüfen
5. `blockToMarkdown` für **jeden** Block-Typ; Dev-`console.warn` für unbekannte `blockType`s
6. `.md`-Routen + Accept-Negotiation mit `Vary: Accept`, gecacht per Tag
7. `llms.txt`-Route: kuratiert über `llms.include`/`note`/`section`, Cache-Tag + `revalidateTag`
   im Hook, pro Locale eine Datei; `llms-full.txt` nur bei Doku-Portalen
8. GEO-Tab im SEO-Check mit Bot-Status, `llms.txt`-Vorschau und Markdown-Vorschau pro Dokument
9. GA4-Kanalgruppe für AI-Quellen + Bot-Zeilen im Access-Log; dem Kunden die Referrer-Lücke
   (35–70 %) vorab sagen
10. Redaktionsregeln aus Abschnitt 6 einmal mit der Redaktion durchgehen — der Teil mit der
    belegten Wirkung ist der, den kein Deployment erledigt
