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
      proEnv: key === 'S3_BUCKET',
    }),
  ),

  // --- imgproxy ---
  ...['NEXT_PUBLIC_IMGPROXY_URL', 'NEXT_PUBLIC_IMGPROXY_BUCKET'].map((key) => ({
    key,
    quelle: 'fest',
    wenn: () => hat('@payloadcms/storage-s3'),
    proEnv: key.endsWith('BUCKET'),
    hinweis: 'in Dokploy als BUILD-Env, sonst bleibt der Loader stumm deaktiviert',
  })),

  // --- Mailversand ---
  ...['RESEND_API_KEY', 'EMAIL_FROM_ADDRESS', 'EMAIL_FROM_NAME'].map((key) => ({
    key,
    quelle: 'extern',
    wenn: () => hat('resend') || hat('@payloadcms/email-resend'),
  })),
  ...['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'].map((key) => ({
    key,
    quelle: 'extern',
    wenn: () => hat('nodemailer') || hat('@payloadcms/email-nodemailer'),
    optional: true,
  })),
  ...['ALERT_RESEND_API_KEY', 'ALERT_RESEND_FROM', 'ALERT_RESEND_TO'].map((key) => ({
    key,
    quelle: 'fest',
    wenn: () => hat('resend') || hat('nodemailer'),
    hinweis: 'Agentur-Account fuer den Laufzeit-Alarm, nie der Kunden-Key',
  })),

  // --- Formulare ---
  {
    key: 'ALTCHA_HMAC_KEY',
    quelle: 'selbst',
    proEnv: true,
    wenn: () => hat('altcha') || hat('altcha-lib'),
  },

  // --- Tracking ---
  ...['NEXT_PUBLIC_GTM_ID', 'NEXT_PUBLIC_C15T_URL'].map((key) => ({
    key,
    quelle: 'extern',
    wenn: () => hat('@c15t/nextjs') || hat('c15t'),
    hinweis: 'serverseitig lesen und als Prop durchreichen, nicht window.*',
  })),

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
const ENVS = nurEnv ? [nurEnv] : ['dev', 'staging', 'prod']

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
      if (k.length > 1) treffer.add(k)
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
  if (fehltOptional.length && !quiet) {
    console.log(`  optional, nicht gesetzt: ${fehltOptional.join(', ')}`)
  }
  if (verwaist.length && !quiet) {
    console.log(`  verwaist (nirgends gelesen): ${verwaist.join(', ')}`)
  }
  if (!fehlt.length && !platzhalter.length) console.log('  ok')
  console.log()
}

// Secrets, die ueber alle Environments identisch sind — fast immer ein Versehen.
if (proEnvWerte.size > 1) {
  const identisch = KATALOG.filter((e) => e.proEnv)
    .map((e) => e.key)
    .filter((k) => {
      const werte = [...proEnvWerte.values()].map((m) => m.get(k)).filter(Boolean)
      return werte.length === proEnvWerte.size && new Set(werte).size === 1
    })
  if (identisch.length) {
    fehler++
    console.log(`WARNUNG: ueber alle Environments identisch, sollte je Environment verschieden sein:`)
    console.log(`  ${identisch.join(', ')}\n`)
  }
}

if (fehler) {
  console.error('Nicht vollstaendig. Siehe oben.')
  process.exit(1)
}
console.log('Alle Environments vollstaendig.')
