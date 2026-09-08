# Live Preview & Draft Preview — Vorschau, die der Kunde versteht

Das sichtbarste Feature im ganzen Admin: Redaktion tippt links, rechts steht die echte Seite.
Technisch sind es **zwei getrennte Dinge**, die im Alltag ständig verwechselt werden:

| | Live Preview | Draft Preview („Vorschau"-Button) |
| --- | --- | --- |
| Was | Die Seite im **iframe neben dem Editor**, aktualisiert beim Speichern (oder live via Autosave) | Der Entwurf in einem **eigenen Tab**, wie ihn der Besucher sähe |
| Config | `admin.livePreview` | `admin.preview` |
| Wofür | Layout bauen, Blocks sortieren | Abnahme, „schick mir den Link" |

Beide laufen über **denselben** Draft-Mode-Endpoint. Es lohnt, sie zusammen aufzusetzen.

## 1. Konfiguration

```ts
// src/payload.config.ts
admin: {
  livePreview: {
    url: ({ data, collectionConfig, req }) =>
      `${process.env.NEXT_PUBLIC_SERVER_URL}/next/preview?${new URLSearchParams({
        collection: collectionConfig?.slug ?? 'pages',
        path: buildPath({ collection: collectionConfig?.slug, slug: data?.slug, locale: req.locale }),
        previewSecret: process.env.PREVIEW_SECRET ?? '',
      })}`,
    collections: ['pages', 'posts'],
    breakpoints: [
      { name: 'mobile', label: 'Mobil', width: 375, height: 667 },
      { name: 'tablet', label: 'Tablet', width: 768, height: 1024 },
      { name: 'desktop', label: 'Desktop', width: 1440, height: 900 },
    ],
  },
}
```

→ **`url` als Funktion, nicht als String.** Die String-Variante aus der Doku funktioniert nur für
eine einzige Collection ohne Locale. Sobald es `/posts/…`, mehrere Sprachen oder Prefix-Routen
gibt, braucht es dieselbe Pfadlogik wie beim Canonical in
[seo §3](../seo/description.md) — am besten **eine** gemeinsame `buildPath`-Funktion für Canonical,
Sitemap, `llms.txt` und Preview. Vier Stellen, die auseinanderlaufen können, sind drei zu viel.

→ **`NEXT_PUBLIC_SERVER_URL`, nicht `localhost`.** Der häufigste „Preview ist weiß"-Fall in
Produktion: Die URL kommt aus einer Konstante, die lokal stimmt.

→ **Breakpoints sind das, was der Kunde im Termin sieht.** Drei Stück reichen; sie kosten nichts
und machen aus „geht das auch auf dem Handy?" eine Klickfrage.

## 2. Der Draft-Mode-Endpoint

```ts
// src/app/(frontend)/next/preview/route.ts
export async function GET(req: Request): Promise<Response> {
  const payload = await getPayload({ config: configPromise })
  const { searchParams } = new URL(req.url)
  const path = searchParams.get('path')

  if (searchParams.get('previewSecret') !== process.env.PREVIEW_SECRET)
    return new Response('Nicht erlaubt', { status: 403 })
  if (!path?.startsWith('/'))
    return new Response('Nur relative Pfade', { status: 400 })   // ← Open-Redirect-Schutz

  const { user } = await payload.auth({ headers: req.headers, req: req as never })
  const draft = await draftMode()
  if (!user) { draft.disable(); return new Response('Nicht erlaubt', { status: 403 }) }

  draft.enable()
  redirect(path)
}
```

→ **Beides prüfen: Secret *und* Session.** Das Secret allein ist ein Passwort in einer URL, die im
Verlauf, im Referrer und im Server-Log landet. Die Session allein reicht nicht, weil der Endpoint
sonst als Umleitungs-Gadget offen steht. Und `path.startsWith('/')` ist nicht Kosmetik: Ohne die
Prüfung ist das ein Open Redirect — genau die Art Fund, die
[security-check](../security-check/description.md) meint.

→ **Ein `exit-preview`-Endpoint gehört dazu** (`draft.disable()` + Redirect). Ohne ihn bleibt der
Redakteur im Draft-Mode und wundert sich, warum er unveröffentlichte Inhalte sieht, wenn er die
Seite „normal" aufruft — inklusive Screenshots im Kunden-Chat.

## 3. Die drei Fallen, die es in unserem Stack wirklich hat

### 3.1 Der iframe wird von den eigenen Security-Headern geblockt

Live Preview lädt die Frontend-Seite **im iframe des Admins**. Die Header aus
[security-check](../security-check/description.md) verbieten genau das:

```js
// next.config.js — Preview-Pfad ausnehmen, Rest streng lassen
{
  key: 'Content-Security-Policy',
  value: "frame-ancestors 'self' https://example.com",   // statt frame-ancestors 'none'
}
```

→ Symptom: leerer weißer Kasten im Admin, Fehler nur in der Browser-Konsole
(`Refused to display … in a frame`). Wer den Header nicht kennt, sucht stundenlang im
Payload-Setup. **`X-Frame-Options: DENY` muss weg** — der Header kennt keine Ausnahmen und
überstimmt in manchen Browsern die CSP; `frame-ancestors` ist der modernere und feiner steuerbare
Ersatz. Liegen Admin und Frontend auf derselben Domain (Standard bei uns), reicht `'self'`.

### 3.2 `draftMode()` macht die Route dynamisch — und kippt euer SSG

Das ist die teure Falle. Der Zugriff auf `draftMode()` ist eine dynamische API: Eine Route, die
sie liest, wird nicht mehr statisch gerendert. Das offizielle Website-Template liest sie **ganz
oben in `page.tsx`** — damit ist die komplette Seiten-Route dynamisch, und die Arbeit aus
[static-rendering](../static-rendering/description.md) ist stillschweigend weg.

→ **Nach dem Einbau der Preview den Build-Output gegenprüfen** — dieselbe Prüfung wie im
Static-Rendering-Skill:

```bash
pnpm build | grep -E "^[│├└ ]*[○ƒ●] /"
# ○ = statisch, ● = SSG mit generateStaticParams, ƒ = dynamisch bei jedem Request
```

Steht vor euren Seiten-Routen nach dem Umbau ein `ƒ`, hat die Preview euch die Auslieferung
umgestellt. Der Ausweg ist, den Draft-Zweig **aus der statischen Route herauszuhalten**: die
öffentliche Route rendert ausschließlich veröffentlichte Inhalte, und der Draft-Mode läuft über
ein eigenes Route-Segment. Es kostet etwas Duplizierung — und ist billiger als eine Seite, die
ab sofort jeden Request live rendert.

→ **Vor/Nach messen, nicht schätzen.** Das ist der einzige Weg, das sauber zu belegen, und die
Zahlen stehen ohnehin im Static-Rendering-Skill.

### 3.3 Die Abfrage muss Entwürfe auch wirklich laden

```ts
const { isEnabled: draft } = await draftMode()

const result = await payload.find({
  collection: 'pages',
  draft,                                   // ← ohne das kommt immer die veröffentlichte Version
  overrideAccess: draft,                   // Entwürfe sind nicht öffentlich lesbar
  user: draft ? user : undefined,
  depth: 1,                                // meta.image! siehe seo-meta-check §3
  where: draft
    ? { slug: { equals: slug } }
    : { and: [{ slug: { equals: slug } }, { _status: { equals: 'published' } }] },
})
```

→ **`draft: true` allein reicht nicht.** Bleibt der `_status: published`-Filter stehen, findet die
Abfrage eine nie veröffentlichte Seite gar nicht — Symptom: Preview zeigt 404, obwohl das
Dokument im Admin offen ist. Genau dieser Filter steht in den Sitemap-Routen ([seo §6](../seo/description.md))
zu Recht drin und wird beim Kopieren mitgeschleppt.

## 4. Autosave: aus „Vorschau" wird „live"

Ohne Autosave aktualisiert sich die Vorschau erst beim Speichern. Mit Autosave tippt die Redaktion
und sieht das Ergebnis — der Effekt, den alle meinen, wenn sie „Live Preview" sagen.

```ts
versions: {
  drafts: { autosave: { interval: 800 } },
  maxPerDoc: 20,                            // ← nicht optional, siehe unten
}
```

→ **`maxPerDoc` setzen, sonst wächst die Versions-Tabelle unbegrenzt.** Bei 800 ms Autosave
erzeugt eine halbe Stunde Redaktionsarbeit hunderte Versionen — pro Dokument. Das trifft später
ausgerechnet die Migrationen (`ALTER TABLE` auf einer riesigen Versions-Tabelle sperrt, siehe
[database-migrations](../database-migrations/description.md)).

→ **Den Revalidierungs-Hook gegen Autosave absichern.** Ein `afterChange`-Hook, der stumpf
`revalidatePath` aufruft, feuert jetzt im Sekundentakt für Entwürfe, die niemand sieht. Der Hook
muss auf `doc._status === 'published'` prüfen — und beim Wechsel von `published` zurück auf
`draft` einmal revalidieren, sonst bleibt eine zurückgezogene Seite im Cache stehen.

→ **Mehrsprachig:** Der iframe zeigt die Locale, die im Admin aktiv ist. Wenn die Preview-URL die
Locale nicht mitgibt, sieht der Redakteur beim Bearbeiten der englischen Fassung die deutsche
Seite und meldet einen Bug, der keiner ist.

## 5. Was der Kunde davon merken soll

Die Technik ist die halbe Miete; der Rest ist, dass es benutzbar aussieht:

- **Feldbeschreibungen statt Schulung.** `admin.description` an den Feldern, die im Preview nicht
  offensichtlich sind.
- **`admin.preview` auch auf Collections ohne Live Preview** (News, Jobs) — der „Vorschau"-Link
  zum Verschicken ist oft wichtiger als der iframe.
- **Preview-Link für die Abnahme**: Entwurf + Link an den Kunden, Freigabe, dann veröffentlichen.
  Das ersetzt in kleinen Projekten den ganzen Freigabe-Workflow.
- **Grenzen ansagen.** Der iframe ist die echte Seite, aber im Editor-Layout: Sticky Header,
  Scroll-Effekte und `100vh`-Sektionen sehen im schmalen Rahmen anders aus. Besonders mit
  [Lenis](../lenis-smooth-scroll/description.md) — im iframe verhält sich Scrollen nicht wie im
  echten Fenster. Einmal zeigen, dann fragt niemand mehr.

## Quick-Checkliste

1. `admin.livePreview.url` als **Funktion** mit derselben `buildPath`-Logik wie Canonical/Sitemap;
   URL aus `NEXT_PUBLIC_SERVER_URL`
2. Breakpoints Mobil/Tablet/Desktop eintragen
3. `/next/preview`-Route prüft **Secret und Session** und lehnt nicht-relative Pfade ab;
   `exit-preview` existiert
4. `frame-ancestors 'self'` statt `'none'`, `X-Frame-Options: DENY` entfernt — sonst weißer iframe
5. **Build-Output nach dem Einbau prüfen** (`○`/`●` vs. `ƒ`): Wenn Seiten-Routen dynamisch geworden
   sind, den Draft-Zweig aus der statischen Route herauslösen
6. Abfrage: `draft`, `overrideAccess`, `user`, `depth >= 1` und **kein** `_status: published`-Filter
   im Draft-Fall
7. Autosave nur mit `maxPerDoc`; Revalidierungs-Hook auf `_status === 'published'` beschränkt
8. Preview-URL enthält die Locale; einmal in beiden Sprachen gegengeprüft
9. Vor Go-Live: Preview als **Redakteur** (nicht als Admin) testen — die Access Control ist ein
   anderer Pfad
