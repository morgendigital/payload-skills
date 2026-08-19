# E-Mail-Test — Versand prüfen und Ausfälle mitbekommen

Gehört zu **jedem** Projekt mit Formularmails, direkt neben
[form-submissions-email](../form-submissions-email/description.md). Dort steht, wie der
Versand aufgebaut wird — hier steht, wie man **vor dem Go-Live prüft, dass er funktioniert**,
und wie man **danach mitbekommt, dass er aufgehört hat**.

Der zweite Teil ist der wichtigere. Ein Mailfehler ist in einem sauber gebauten Projekt still:
Die Einsendung liegt in der Collection, das Formular meldet dem Besucher „danke", und im
Container-Log steht eine Zeile, die niemand liest. Der Kunde merkt es, wenn sich Wochen später
ein Bewerber beschwert.

Zwei Regeln:

1. **Der Versand wird vor dem Go-Live einmal echt getestet** — Verify *und* Versand, mit
   Anhang, an eine `@northlight.at`-Adresse.
2. **Ein Versandfehler alarmiert die Agentur über einen zweiten Anbieter.** Wenn der
   Kunden-SMTP ausfällt, kann die Warnung nicht über denselben Kanal laufen. Deshalb geht sie
   über **Resend** an **office@northlight.at**, unabhängig davon, welcher Provider im Projekt
   konfiguriert ist.

Reihenfolge: **Todo 1** Testskript → **Todo 2** Port/TLS richtig setzen → **Todo 3**
Laufzeit-Alarm über Resend → **Todo 4** Abnahme.

---

## Todo 1: Testskript — Verify und Versand getrennt

**Datei:** `src/scripts/testSmtp.ts`, Script in der `package.json`

`transporter.verify()` baut die Verbindung auf, handelt TLS aus und meldet sich an — mehr
nicht. Das ist der schnelle Durchlauf für Konfigurationsfragen und kostet den Kunden keine
Testmail. Der Versand ist der zweite Schritt und erst der beweist Zustellung.

```ts
import 'dotenv/config'
import { createSmtpTransporter } from '../lib/smtpTransporter'

async function main() {
  const transporter = createSmtpTransporter()

  try {
    await transporter.verify()
    console.log('SMTP verify: OK')
  } catch (error) {
    console.error('SMTP verify failed:', error instanceof Error ? error.message : error)
    process.exitCode = 1
    return
  }

  const to = process.argv.find((a) => a.startsWith('--send='))?.slice('--send='.length)
    ?? process.env.SMTP_TEST_TO
  if (!to) {
    console.log('Kein Empfänger: SMTP_TEST_TO setzen oder --send=… übergeben.')
    return
  }

  const info = await transporter.sendMail({
    from: process.env.MAIL_FROM_EMAIL!,
    to,
    subject: 'SMTP-Test',
    text: 'Wenn das ankommt, funktioniert der ausgehende Versand.',
  })
  console.log('Test mail sent. messageId:', info.messageId)
}

main()
```

```json
"test:smtp": "cross-env NODE_OPTIONS=--no-deprecation tsx src/scripts/testSmtp.ts"
```

```bash
pnpm test:smtp                              # nur Verbindung + Login
pnpm test:smtp --send=office@northlight.at  # echter Versand
```

Zugangsdaten kommen aus der `.env`. Für einen Durchlauf mit anderen Daten (z. B. der alte
Provider zum Gegentest) nicht die `.env` umbauen, sondern eine zweite Datei anlegen und
`dotenv` darauf zeigen lassen — `dotenv` überschreibt nichts, was schon in `process.env` steht:

```bash
DOTENV_CONFIG_PATH=./smtp-alt.env pnpm test:smtp --send=office@northlight.at
```

**Empfänger ist immer eine `@northlight.at`-Adresse**, nie der Kunde — Begründung in
[form-submissions-email](../form-submissions-email/description.md#testmails-gehen-an-northlightat--nicht-an-den-kunden):
Testbewerbungen im Kundenpostfach erzeugen Rückfragen, und eine Mail innerhalb derselben
Domäne wird intern zugestellt, ohne dass SPF/DKIM/DMARC je bewertet werden.

---

## Todo 2: Port und TLS — die Fehlermeldung sagt, welcher von beiden falsch ist

Die häufigste Ursache für „die Mails gehen nicht" ist kein Passwort, sondern eine
widersprüchliche Port/TLS-Kombination:

| Port | Verfahren | `secure` |
| ---- | --------- | -------- |
| 465 | implizites TLS — die Verbindung ist ab Byte 1 verschlüsselt | `true` |
| 587 | Klartext, dann STARTTLS-Upgrade | `false` (+ `requireTLS: true`) |
| 25 | wie 587, providerseitig oft gesperrt | `false` |

`SMTP_SECURE` sollte deshalb nicht frei neben `SMTP_PORT` stehen — der Port entscheidet, die
Env-Variable ist nur Fallback für exotische Ports:

```ts
const port = Number(process.env.SMTP_PORT ?? 587)
const secureEnv = process.env.SMTP_SECURE
const secure = port === 465 ? true : port === 587 || port === 25 ? false : secureEnv === 'true'

if (secureEnv !== undefined && (secureEnv === 'true') !== secure) {
  console.warn(`SMTP_SECURE=${secureEnv} passt nicht zu SMTP_PORT=${port}; verwende secure=${secure}.`)
}

return nodemailer.createTransport({
  host, port, secure,
  requireTLS: !secure, // auf 587 kein stiller Klartextversand
  auth: user && pass ? { user, pass } : undefined,
})
```

Ohne diese Ableitung wandert der Fehler in die Env — und dort in Dokploy, wo ihn beim nächsten
Providerwechsel niemand sieht.

### Fehlermeldungen zuordnen

| Meldung | Ursache | Fix |
| ------- | ------- | --- |
| `wrong version number` (`tls_validate_record_header`) | TLS-Handshake auf einem Klartext-Port, also `secure: true` auf 587/25 | Port entscheiden lassen (oben) |
| Timeout / kein Verbindungsaufbau auf 465 | Der Anbieter hört dort nicht — **Exchange Online kann kein 465** | Port 587 |
| `535 5.7.139 Authentication unsuccessful` | Microsoft 365: SMTP AUTH ist für das Postfach nicht freigeschaltet, Security Defaults blocken Legacy-Auth, MFA ohne App-Passwort, oder Shared Mailbox ohne Lizenz | siehe unten |
| `5.7.60 SendAsDenied` | `from` ist nicht das angemeldete Postfach und hat keine SendAs-Berechtigung | `from` = Login-Adresse, Bewerberadresse in `replyTo` |
| `550 5.7.1` / Spam-Ordner | SPF/DKIM der Absenderdomain passen nicht zum Versandweg | DNS-Records ergänzen |

Ein Ausweichport hilft nur bei der ersten und zweiten Zeile. Alles ab `535` passiert **nach**
dem TLS-Handshake — das ist eine Frage der Zugangsdaten, kein Transportproblem.

### Microsoft 365 / Exchange Online

Nur Port **587 mit STARTTLS**, 465 existiert dort nicht. SMTP AUTH ist bei allen Tenants, die
nach Anfang 2020 angelegt wurden, standardmäßig aus:

```powershell
Set-TransportConfig -SmtpClientAuthenticationDisabled $false
Set-CASMailbox -Identity postfach@kunde.tld -SmtpClientAuthenticationDisabled $false
```

**Zeitlich befristet:** Microsoft schaltet Basic Auth für SMTP AUTH zum Ende 2026 ab; neue
Tenants können es ab Januar 2027 nicht mehr aktivieren, ein endgültiges Abschaltdatum wird
2027 angekündigt. Ein Projekt, das heute auf M365-SMTP mit Benutzer/Passwort gesetzt wird,
braucht danach OAuth (XOAUTH2) oder einen anderen Versandweg — beim Kickoff ansprechen.

---

## Todo 3: Laufzeit-Alarm über Resend — der eigentliche Punkt

**Datei:** `src/lib/email/failureAlert.ts`

Ein Testlauf beweist den Zustand von heute. Kunden ändern Passwörter, Microsoft dreht Basic
Auth ab, ein Postfach läuft voll. Deshalb meldet die App jeden fehlgeschlagenen Versand
selbst — über **Resend**, weil der reguläre Weg in genau diesem Moment kaputt ist.

**Gedrosselt**, sonst erzeugt ein defekter SMTP-Server pro Formulareinsendung eine Alarmmail:
eine Mail pro Fehlerursache und 6 Stunden. Der Zähler ist prozesslokal — nach Redeploy oder
bei mehreren Instanzen kann eine Ursache erneut alarmieren. Das ist die richtige Richtung:
lieber ein Alarm zu viel als ein verpasster.

Die Alarmmail nutzt **dasselbe React-Email-Setup wie die Formularmails** (`src/emails/…`) —
ein eigenes Template `MailFailureAlert.tsx`, aus dem `render()` HTML und Plaintext erzeugt.
Kein zweiter Mailstack für den Alarm, und die Mail ist im Postfach lesbar statt eine
Log-Zeile im Body.

```tsx
const ALERT_RECIPIENT = 'office@northlight.at'
const THROTTLE_WINDOW_MS = 6 * 60 * 60 * 1000
const lastAlertByCause = new Map<string, number>()

/** Volatile Anteile raus, damit derselbe Defekt denselben Key ergibt. */
function causeKey(message: string): string {
  return message
    .replace(/\[[^\]]*\]/g, '')                       // Server-IDs in Klammern
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '')      // Zeitstempel
    .replace(/\b[0-9A-F]{8,}\b/gi, '')                // Message-/Trace-IDs
    .replace(/\s+/g, ' ').trim().slice(0, 200)
}

export async function reportEmailFailure({ context, recipient, message }: {
  context: string; recipient: string; message: string
}): Promise<void> {
  const apiKey = process.env.ALERT_RESEND_API_KEY   // eigener Agentur-Account, siehe unten
  const from = process.env.ALERT_RESEND_FROM_EMAIL
  if (!apiKey || !from) return                        // still überspringen, nur loggen

  const key = causeKey(message)
  const last = lastAlertByCause.get(key)
  if (last !== undefined && Date.now() - last < THROTTLE_WINDOW_MS) return
  lastAlertByCause.set(key, Date.now())

  const template = (
    <MailFailureAlert
      site={site} context={context} recipient={recipient} message={message}
      smtpHost={process.env.SMTP_HOST ?? 'nicht gesetzt'}
      smtpPort={process.env.SMTP_PORT ?? '587 (Default)'}
      smtpSecure={process.env.SMTP_SECURE ?? 'nicht gesetzt'}
      throttleHours={THROTTLE_HOURS}
    />
  )
  const [html, text] = await Promise.all([render(template), render(template, { plainText: true })])

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: ALERT_RECIPIENT, subject: `Mailversand gestört: ${site}`, html, text }),
  })
}
```

**Die SMTP-Konfiguration gehört in die Mail.** Host, Port und `SMTP_SECURE` im Body sparen den
Weg ins Dokploy-Log — die häufigste Ursache steht damit schon in der Warnung.

Aufgerufen wird das an **einer** Stelle — dort, wo der Versand ohnehin sein `catch` hat, nicht
in jeder Route:

```ts
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unexpected email error'
  await reportEmailFailure({ context: subject, recipient: to, message })
  return { data: null, error: { message } }
}
```

Kein `await` zu vergessen: In einer Serverless-Umgebung endet die Funktion sonst, bevor der
Request draußen ist.

### Voraussetzungen

| Variable | Zweck |
| -------- | ----- |
| `ALERT_RESEND_API_KEY` | **Agentur-Account.** Fehlt er, wird der Alarm still übersprungen und nur geloggt — das gehört auf die Go-Live-Checkliste. |
| `ALERT_RESEND_FROM_EMAIL` | Absender auf einer **im Agentur-Account verifizierten** Domain. Eine unverifizierte Domain lässt den Alarm still scheitern. |

**Nicht `RESEND_API_KEY` wiederverwenden.** In Projekten, die Resend als regulären Mailadapter
fahren (siehe [form-submissions-email Todo 1](../form-submissions-email/description.md)), gehört
dieser Account dem Kunden — der Alarm ginge dann über sein Kontingent und seine Absenderdomain,
und beim Wechsel auf Kunden-SMTP verschwindet der Key womöglich ganz. Deshalb eigene Variablen
und **kein Fallback** auf die generischen.

Der Alarm ergänzt `mailStatus` / `mailError` auf der Einsendung (siehe
[form-submissions-email Todo 3](../form-submissions-email/description.md)) — dort steht, *welche*
Einsendung betroffen ist, die Alarmmail sagt, *dass* gerade etwas kaputt ist.

---

## Todo 4: Abnahme

Beides gehört einmal durchgespielt, sonst ist der Alarm ein ungetesteter Pfad, der genau dann
nicht funktioniert, wenn er gebraucht wird.

**Versand:** `pnpm test:smtp --send=office@northlight.at`, dann im Rohtext der Mail
`Authentication-Results` prüfen — `spf=pass` und `dkim=pass` müssen dort stehen. Danach das
echte Formular auf der Live-Seite einmal absenden, mit Anhang.

**Alarm:** Erst die Vorschau (`pnpm test:email-alert` rendert das Template, ohne zu senden),
dann der echte Pfad — `pnpm test:email-alert --send` oder `SMTP_PASS` temporär verfälschen und
das Formular absenden. Die Alarmmail muss bei `office@northlight.at` liegen. Direkt danach ein zweites Mal absenden → **keine** zweite Mail
(Drosselung greift). Anschließend Passwort zurücksetzen und den Versand erneut prüfen.

---

## Checkliste

- [ ] `test:smtp`-Script vorhanden, Verify und Versand getrennt aufrufbar.
- [ ] `secure` wird aus dem Port abgeleitet, `requireTLS` auf 587 gesetzt; widersprüchliche
      Env erzeugt eine Warnung statt eines TLS-Fehlers.
- [ ] Bei M365: SMTP AUTH für Tenant und Postfach freigeschaltet, Ablauf von Basic Auth
      (Ende 2026) im Projektprotokoll vermerkt.
- [ ] Testmail an `@northlight.at` verschickt, `spf=pass` / `dkim=pass` im Header geprüft.
- [ ] Live-Formular einmal echt abgesendet, inklusive Anhang.
- [ ] `reportEmailFailure` im `catch` des Versands, mit `await`.
- [ ] Alarmtemplate als React Email neben den Formularmails, HTML **und** Plaintext gerendert.
- [ ] `RESEND_API_KEY` und `RESEND_FROM_EMAIL` in Dokploy gesetzt, Absenderdomain in Resend
      verifiziert.
- [ ] Alarm mit falschem Passwort provoziert, Mail kam an, zweiter Versuch löste keine
      zweite Mail aus.
- [ ] Nach jedem Providerwechsel: Verify, Testversand und Alarm erneut durchlaufen.
