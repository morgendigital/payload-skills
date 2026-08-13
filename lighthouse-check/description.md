# Lighthouse-Check — verpflichtend vor jedem Go-Live

**Wann:** vor jedem Go-Live, nach jedem größeren Feature-Merge und nach jeder Änderung an
Build, Caching, Medien oder Tracking. Nicht optional — ohne bestandenen Check geht kein
Projekt live.

**Wogegen:** immer gegen die **Produktions-URL** nach dem Deploy, nie gegen `localhost`.
Dev-Builds sind unkomprimiert, ungecacht und liefern wertlose Zahlen.

## Ausführen

Lighthouse braucht kein Setup im Projekt, nur einen installierten Chrome:

```bash
export CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

npx -y lighthouse@13 https://example.com/ \
  --output=json --output-path=./lh-mobile.json \
  --chrome-flags="--headless=new" --quiet

npx -y lighthouse@13 https://example.com/ --preset=desktop \
  --output=json --output-path=./lh-desktop.json \
  --chrome-flags="--headless=new" --quiet
```

Mindestens die **Startseite** plus je eine **Detailseite** und eine **Landingpage** prüfen —
die Startseite ist oft die einzige mit Hero-Video und damit nicht repräsentativ.

### Kontrolllauf ohne Bot-Challenge

Steht die Seite hinter Cloudflare mit aktivierten **JavaScript Detections**, wird headless
Chrome gechallenged und `/cdn-cgi/challenge-platform/…/main.js` verfälscht das Ergebnis
massiv. An northlight.at gemessen: **Performance 34 mit, 49 ohne** das Skript, TBT
**4.300 ms gegen 400 ms**. Immer einen Gegenlauf machen, bevor ihr eine Zahl bewertet:

```bash
npx -y lighthouse@13 https://example.com/ \
  --blocked-url-patterns="*cdn-cgi*" \
  --output=json --output-path=./lh-mobile-noCF.json \
  --chrome-flags="--headless=new" --quiet
```

Klaffen die beiden Läufe weit auseinander, ist das ein eigener Befund: Prüft in Cloudflare
unter **Security → Bots**, ob ihr die JavaScript Detections wirklich braucht.

## Gate — diese Werte müssen stehen

| Kriterium | Grenze | Warum |
| --------- | ------ | ----- |
| SEO | **100** | Alles darunter sind Fehler im eigenen Markup, nie Fremdverschulden. |
| Accessibility | **≥ 95** | Rechtliches Risiko; die Funde sind fast immer in Minuten behebbar. **Untergrenze, kein Konformitätsnachweis** — Lighthouse prüft eine Teilmenge auf einer URL im Ausgangszustand. Der vollständige Check steht in [`accessibility/`](../accessibility/description.md). |
| Best Practices | **≥ 90** | Ausnahme dokumentieren, wenn GTM/gtag die Privacy-Sandbox-APIs melden. |
| LCP (mobil) | **≤ 2,5 s** | Core Web Vital. |
| CLS | **≤ 0,1** | Core Web Vital. |
| TBT (mobil) | **≤ 300 ms** | Labor-Stellvertreter für INP. |
| Seitengewicht | **< 3 MB** total | Ohne Video sollten < 1,5 MB stehen. |
| First Load JS | **< 300 kB** | Steht im `next build`-Output pro Route. |

Der Performance-**Score** selbst ist kein Gate — er schwankt zwischen Läufen. Gemessen wird
an LCP, CLS, TBT und Gewicht.

## Auswerten

Der HTML-Report ist zum Anschauen, die JSON-Datei zum Arbeiten. Diese vier Abfragen finden
in der Praxis fast jeden Befund:

```bash
# Was wiegt die Seite, und woraus besteht sie?
node -e "const a=require('./lh-mobile.json').audits;
(a['resource-summary'].details.items).forEach(i=>console.log(i.resourceType.padEnd(12),
  String(i.requestCount).padStart(3), String(Math.round(i.transferSize/1024)).padStart(7),'KB'))"

# Die größten Einzelressourcen
node -e "const a=require('./lh-mobile.json').audits;
a['network-requests'].details.items.filter(i=>i.transferSize>0)
  .sort((x,y)=>y.transferSize-x.transferSize).slice(0,10)
  .forEach(i=>console.log(String(Math.round(i.transferSize/1024)).padStart(6),'KB', i.url.slice(0,90)))"

# Wer verbrennt Main-Thread-Zeit?
node -e "const a=require('./lh-mobile.json').audits;
a['bootup-time'].details.items.slice(0,8)
  .forEach(i=>console.log(String(Math.round(i.total)).padStart(6),'ms', i.url.slice(0,80)))"

# Welche Audits sind durchgefallen?
node -e "const r=require('./lh-mobile.json');
['accessibility','best-practices'].forEach(c=>{console.log('---',c);
  Object.values(r.audits).filter(x=>x.score!==null&&x.score<1&&
    r.categories[c].auditRefs.some(ar=>ar.id===x.id)).forEach(x=>console.log(' •',x.title))})"
```

## Was in diesen Projekten typischerweise hochkommt

- **Medien fressen das Budget.** Ein Hero-Video ist regelmäßig 90 % des Seitengewichts. An
  northlight.at: 20 von 21,5 MB aus einer einzigen 41-MB-MP4, die per `autoPlay` sofort
  geladen wurde — `preload="metadata"` hilft dagegen nichts, `autoPlay` übersteuert es.
  Hero-Loops gehören auf 1–3 MB komprimiert, mit eigener Mobil-Variante.
- **Cloudflare-Challenge** (siehe Gegenlauf oben).
- **GTM und gtag** liefern ~300 KB, davon die Hälfte ungenutzt, und erzeugen sämtliche
  „deprecated API"-Abzüge (Shared Storage, Protected Audience, `StorageType.persistent`).
  Wenn schon Plausible läuft: prüfen, ob GTM + GA4 + Pixel wirklich alle gebraucht werden,
  und ob GTM erst nach Consent lädt.
- **Ungenutztes JS aus schweren Libraries.** three.js, matter-js, gsap, lottie und swiper
  landen schnell im geteilten Chunk. `pnpm analyze` (Bundle-Analyzer) zeigt, was drin ist;
  `dynamic()` für alles, was nur auf einzelnen Seiten vorkommt.
- **`aria-label`-Mismatches.** Ein generiertes `aria-label={\`Go to ${…}\`}` überschreibt den
  sichtbaren Linktext und fällt bei `label-content-name-mismatch` durch. Bei sichtbarem Text
  gehört gar kein `aria-label` an den Link; steckt ein React-Element in der Template-String-
  Interpolation, steht am Ende sogar `Go to [object Object]` im Markup.
- **Kontrast im Cookie-Banner.** Die c15t-Default-Buttons reißen die Kontrastgrenze — über
  das Theme korrigieren.

## Checkliste

- [ ] Gegen die **Produktions-URL** gelaufen, nicht gegen localhost.
- [ ] Mobil **und** Desktop, dazu Startseite + Detailseite + Landingpage.
- [ ] Gegenlauf mit `--blocked-url-patterns="*cdn-cgi*"`, wenn Cloudflare davor steht.
- [ ] Gate-Tabelle oben erfüllt — oder Abweichung im PR begründet.
- [ ] `x-nextjs-cache: HIT` auf den geprüften Seiten (sonst zuerst
      [static-rendering](../static-rendering/description.md) abarbeiten).
- [ ] Nach den Fixes erneut gelaufen und die neuen Zahlen im PR notiert.
