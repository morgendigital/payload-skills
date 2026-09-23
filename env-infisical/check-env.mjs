#!/usr/bin/env node
/**
 * Gleicht die Umgebungsvariablen des Projekts gegen Infisical ab.
 *
 * Nach `scripts/check-env.mjs` kopieren und als `pnpm check:env` eintragen.
 *
 *   node scripts/check-env.mjs              # alle Environments
 *   node scripts/check-env.mjs --env=prod   # eines
 *   node scripts/check-env.mjs --quiet      # nur Befunde, kein Bestand
 *
 * Exit 1, sobald etwas fehlt oder ein Platzhalter stehen geblieben ist —
 * damit taugt es als Gate vor dem Go-live.
 *
 * Werte werden gelesen, aber NIE ausgegeben. Berichtet wird nur der Name.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Katalog. Was hier steht, wird erwartet — auch wenn es (noch) kein Code liest.
// Genau das ist der Punkt: sonst faellt eine Variable erst beim Deployment auf.
// ---------------------------------------------------------------------------
const pkg = existsSync('package.json') ? JSON.parse(readFileSync('package.json', 'utf8')) : {}
const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
const hat = (name) => Boolean(deps[name])
const datei = (p) => existsSync(p)

const KATALOG = [
  // --- immer ---
  { key: 'DATABASE_URL', quelle: 'extern', wenn: true },
  { key: 'PAYLOAD_SECRET', quelle: 'selbst', wenn: true, proEnv: true },
  { key: 'NEXT_PUBLIC_SERVER_URL', quelle: 'extern', wenn: true, proEnv: true },
  { key: 'CRON_SECRET', quelle: 'selbst', wenn: true, proEnv: true },
  { key: 'PREVIEW_SECRET', quelle: 'selbst', wenn: true, proEnv: true },
  // Liest Next selbst — taucht in keinem grep auf, fehlt deshalb fast immer.
  { key: 'NEXT_SERVER_ACTIONS_ENCRYPTION_KEY', quelle: 'selbst', wenn: true, proEnv: true },

  // Nur wo Build- und Laufzeit-Adresse auseinanderfallen. Ein Platzhalter darin
  // macht den Build aktiv kaputt, weil der Wrapper ihn dann benutzt.
  { key: 'DATABASE_URL_BUILD', quelle: 'extern', wenn: true, optional: true },

  // --- S3 ---
  ...['S3_BUCKET', 'S3_ENDPOINT', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'].map(
    (key) => ({
      key,
      quelle: key.includes('KEY') ? 'extern' : 'fest',
      wenn: () => hat('@payloadcms/storage-s3'),
      // Nicht "immer verschieden": der Bucket ist an die Datenbank gekoppelt.
      anDb: key === 'S3_BUCKET',
    }),
  ),

  // --- imgproxy ---
  ...['NEXT_PUBLIC_IMGPROXY_URL', 'NEXT_PUBLIC_IMGPROXY_BUCKET'].map((key) => ({
    key,
    quelle: 'fest',
    wenn: () => hat('@payloadcms/storage-s3'),
    anDb: key.endsWith('BUCKET'),
    hinweis: 'in Dokploy als BUILD-Env, sonst bleibt der Loader stumm deaktiviert',
  })),

  // --- Mailversand ---
  ...['RESEND_API_KEY', 'EMAIL_FROM_ADDRESS', 'EMAIL_FROM_NAME'].map((key) => ({
    key,
    quelle: 'extern',
    wenn: () => hat('resend') || hat('@payloadcms/email-resend'),
  })),
  // SMTP_PASSWORD, nicht SMTP_PASS — so heisst es im Adapter aus
  // form-submissions-email. Ein falscher Name im Katalog meldet die Variable als
  // "aus dem Code" fehlend und die richtige als verwaist.
  ...['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD'].map((key) => ({
    key,
    quelle: 'extern',
    wenn: () => hat('nodemailer') || hat('@payloadcms/email-nodemailer'),
    optional: true,
  })),
  {
    key: 'EMAIL_NOTIFY_TO',
    quelle: 'extern',
    wenn: () => hat('resend') || hat('nodemailer'),
    proEnv: true,
    hinweis: 'Testumgebungen auf @northlight.at, nie auf das Kundenpostfach',
  },
  ...['ALERT_RESEND_API_KEY', 'ALERT_RESEND_FROM', 'ALERT_RESEND_TO'].map((key) => ({
    key,
    quelle: 'fest',
    wenn: () => hat('resend') || hat('nodemailer'),
    // Optional, solange der Laufzeit-Alarm aus email-test nicht gebaut ist —
    // sonst steht check:env dauerhaft auf Exit 1 und wird ignoriert.
    optional: true,
    hinweis: 'Agentur-Account fuer den Laufzeit-Alarm (email-test), nie der Kunden-Key',
  })),

  // --- Formulare ---
  {
    key: 'ALTCHA_HMAC_KEY',
    quelle: 'selbst',
    proEnv: true,
    wenn: () => hat('altcha') || hat('altcha-lib'),
  },

  // --- Tracking ---
  // Alle optional: Ohne ID registriert c15t schlicht kein Skript, und die Seite
  // funktioniert. Pflicht waeren sie erst, wenn der Kunde sie geliefert hat —
  // bis dahin stuende check:env sonst dauerhaft auf Exit 1.
  ...[
    'NEXT_PUBLIC_GTM_ID',
    'NEXT_PUBLIC_GA4_MEASUREMENT_ID',
    'NEXT_PUBLIC_GOOGLE_TAG_ID',
    'NEXT_PUBLIC_GOOGLE_ADS_ID',
    'NEXT_PUBLIC_META_PIXEL_ID',
  ].map((key) => ({
    key,
    quelle: 'extern',
    optional: true,
    wenn: () => hat('@c15t/nextjs') || hat('c15t'),
    hinweis: 'serverseitig lesen und als Prop durchreichen, nie im Client aus process.env',
  })),
  {
    // Nur im hosted-Modus. Offline braucht keinen Backend-Endpunkt.
    key: 'NEXT_PUBLIC_C15T_URL',
    quelle: 'extern',
    optional: true,
    wenn: () => hat('@c15t/nextjs') || hat('c15t'),
  },

  // --- Keycloak ---
  ...['KEYCLOAK_ISSUER', 'KEYCLOAK_CLIENT_ID', 'KEYCLOAK_CLIENT_SECRET', 'BETTER_AUTH_SECRET'].map(
    (key) => ({ key, quelle: 'extern', wenn: () => hat('better-auth') }),
  ),
].filter((e) => (typeof e.wenn === 'function' ? e.wenn() : e.wenn))

// Von Laufzeit/Framework gesetzt — nie in Infisical erwartet.
const IGNORIEREN =
  /^(NODE_ENV|NODE_OPTIONS|PORT|CI|ANALYZE|npm_|VERCEL_|__NEXT_|NEXT_RUNTIME|NEXT_PHASE|TZ$)/

const PLATZHALTER = /^(test|todo|changeme|xxx|placeholder|your_?secret_?here|)$/i

// ---------------------------------------------------------------------------
const args = process.argv.slice(2)
const nurEnv = args.find((a) => a.startsWith('--env='))?.split('=')[1]
const quiet = args.includes('--quiet')
// Environments dieses Projekts. Nicht jedes Projekt hat ein staging — die
// CLI kann keine Environments auflisten, deshalb steht die Liste hier.
const ALLE_ENVS = (process.env.INFISICAL_ENVS || 'dev,prod').split(',').map((e) => e.trim())
const ENVS = nurEnv ? [nurEnv] : ALLE_ENVS

/** Alle Env-Zugriffe aus dem Projektcode. */
function ausCode() {
  const treffer = new Set()
  const wurzeln = ['src', 'scripts'].filter(datei)
  const einzeln = readdirSync('.').filter(
    (f) => /^(next\.config|next-sitemap\.config|redirects|vercel)\./.test(f) && statSync(f).isFile(),
  )

  // Sich selbst nicht mitlesen — dieses Skript nennt Variablennamen in Beispielen.
  const selbst = fileURLToPath(import.meta.url)

  const lies = (p) => {
    if (resolve(p) === selbst) return
    const t = readFileSync(p, 'utf8')
    for (const m of t.matchAll(/process\.env(?:\.([A-Z0-9_]+)|\[['"]([A-Z0-9_]+)['"]\])/g)) {
      const k = m[1] || m[2]
      // Namen, die auf `_` enden, stammen aus Fliesstext wie
      // `process.env.NEXT_PUBLIC_*` in einem Kommentar — keine echte Variable.
      if (k.length > 1 && !k.endsWith('_')) treffer.add(k)
    }
  }
  const lauf = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && !e.name.startsWith('.')) lauf(p)
      } else if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extname(e.name))) {
        lies(p)
      }
    }
  }
  wurzeln.forEach(lauf)
  einzeln.forEach(lies)
  return [...treffer].filter((k) => !IGNORIEREN.test(k))
}

/** Key → Wert aus Infisical. Werte werden nur verglichen, nie ausgegeben. */
function ausInfisical(env) {
  let roh
  try {
    roh = execFileSync('infisical', ['export', `--env=${env}`, '--format=dotenv'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    console.error(`  ! Environment "${env}" nicht lesbar (existiert es? infisical login?)`)
    return null
  }
  const map = new Map()
  for (const zeile of roh.split('\n')) {
    const m = zeile.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m) map.set(m[1], m[2].replace(/^['"]|['"]$/g, ''))
  }
  return map
}

const codeKeys = ausCode()
const katalogKeys = KATALOG.map((e) => e.key)
const erwartet = [...new Set([...codeKeys, ...katalogKeys])].sort()
const eintrag = (k) => KATALOG.find((e) => e.key === k)

console.log(`Erwartet: ${erwartet.length} Variablen (${codeKeys.length} aus dem Code, Rest Katalog)\n`)

let fehler = 0
const proEnvWerte = new Map()

for (const env of ENVS) {
  const vorhanden = ausInfisical(env)
  if (!vorhanden) {
    fehler++
    continue
  }
  proEnvWerte.set(env, vorhanden)

  const fehlt = erwartet.filter((k) => !vorhanden.has(k) && !eintrag(k)?.optional)
  const fehltOptional = erwartet.filter((k) => !vorhanden.has(k) && eintrag(k)?.optional)
  const platzhalter = erwartet.filter((k) => vorhanden.has(k) && PLATZHALTER.test(vorhanden.get(k)))
  const verwaist = [...vorhanden.keys()].filter((k) => !erwartet.includes(k))

  // Mongo-Adresse ohne Datenbanknamen landet still in der Default-DB `test`.
  const ohneDbName = ['DATABASE_URL', 'DATABASE_URL_BUILD']
    .filter((k) => vorhanden.has(k))
    .filter((k) => {
      const v = vorhanden.get(k)
      if (!/^mongodb(\+srv)?:\/\//.test(v)) return false
      const m = v.match(/^mongodb(?:\+srv)?:\/\/[^/?]+(\/[^?]*)?/)
      return !m?.[1] || m[1] === '/'
    })

  console.log(`### ${env}  (${vorhanden.size} gesetzt)`)
  if (fehlt.length) {
    fehler++
    console.log(`  FEHLT (${fehlt.length}):`)
    for (const k of fehlt) {
      const e = eintrag(k)
      const q = e ? { selbst: 'selbst erzeugen', extern: 'vom Kunden', fest: 'bekannter Wert' }[e.quelle] : 'aus dem Code'
      console.log(`    - ${k}  → ${q}${e?.hinweis ? `  (${e.hinweis})` : ''}`)
    }
  }
  if (platzhalter.length) {
    fehler++
    console.log(`  PLATZHALTER (${platzhalter.length}): ${platzhalter.join(', ')}`)
  }
  if (ohneDbName.length) {
    fehler++
    console.log(`  OHNE DATENBANKNAMEN (${ohneDbName.length}): ${ohneDbName.join(', ')}`)
    console.log(`    → landet in Mongos Default-DB "test", nicht in einer eigenen`)
  }
  if (fehltOptional.length && !quiet) {
    console.log(`  optional, nicht gesetzt: ${fehltOptional.join(', ')}`)
  }
  if (verwaist.length && !quiet) {
    console.log(`  verwaist (nirgends gelesen): ${verwaist.join(', ')}`)
  }
  if (!fehlt.length && !platzhalter.length && !ohneDbName.length) console.log('  ok')
  console.log()
}

if (proEnvWerte.size > 1) {
  const paare = []
  const namen = [...proEnvWerte.keys()]
  for (let i = 0; i < namen.length; i++)
    for (let j = i + 1; j < namen.length; j++) paare.push([namen[i], namen[j]])

  const warnungen = []

  // 1. Secrets muessen sich je Environment unterscheiden — ausnahmslos.
  for (const k of KATALOG.filter((e) => e.proEnv).map((e) => e.key)) {
    for (const [a, b] of paare) {
      const va = proEnvWerte.get(a).get(k)
      const vb = proEnvWerte.get(b).get(k)
      if (va && vb && va === vb) {
        warnungen.push(`${k}: in ${a} und ${b} identisch — Secrets gehoeren je Environment erzeugt`)
      }
    }
  }

  // Zwei Environments zeigen auf dieselbe Datenbank, sobald sich ihre Adress-Mengen
  // ueberschneiden — DATABASE_URL und DATABASE_URL_BUILD sind zwei Wege zum selben
  // Ziel. Ein reiner String-Vergleich von DATABASE_URL sieht das nicht: intern
  // Docker-Host, von aussen Tailscale.
  const adressen = (env) =>
    new Set(
      ['DATABASE_URL', 'DATABASE_URL_BUILD']
        .map((k) => proEnvWerte.get(env).get(k))
        .filter(Boolean),
    )
  const gleicheDb = (a, b) => {
    const A = adressen(a)
    return [...adressen(b)].some((x) => A.has(x))
  }

  // 2. Der Bucket ist an die Datenbank gekoppelt, nicht an das Environment.
  //    Gleiche DB  -> gleicher Bucket ist PFLICHT (sonst zeigen Media-Dokumente
  //                   auf Dateien, die das andere Environment nicht sieht).
  //    Andere DB   -> getrennter Bucket, sonst ueberschreiben sich Uploads.
  for (const k of KATALOG.filter((e) => e.anDb).map((e) => e.key)) {
    for (const [a, b] of paare) {
      const dbGleich = gleicheDb(a, b)
      const va = proEnvWerte.get(a).get(k)
      const vb = proEnvWerte.get(b).get(k)
      if (!va || !vb) continue
      if (dbGleich && va !== vb) {
        warnungen.push(
          `${k}: ${a} und ${b} teilen sich die Datenbank, aber nicht den Bucket — ` +
            `Media-Dokumente zeigen dann auf Dateien, die das jeweils andere nicht sieht`,
        )
      }
      if (!dbGleich && va === vb) {
        warnungen.push(
          `${k}: ${a} und ${b} haben getrennte Datenbanken, aber denselben Bucket — ` +
            `ein Upload kann die Datei des anderen ueberschreiben`,
        )
      }
    }
  }

  if (warnungen.length) {
    fehler++
    console.log('WARNUNG:')
    for (const w of warnungen) console.log(`  - ${w}`)
    console.log()
  }
}

if (fehler) {
  console.error('Nicht vollstaendig. Siehe oben.')
  process.exit(1)
}
console.log('Alle Environments vollstaendig.')
