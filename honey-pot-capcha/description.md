# ALTCHA und Honeypot in Payload-Formularen

Öffentliche Formulare lassen sich mit einem **Honeypot** (verstecktes Feld) und **ALTCHA** (Proof-of-Work-Challenge) absichern. Die Prüfung erfolgt in **Server Actions** vor dem Schreiben in Payload. Importpfade (z. B. zu Hilfsfunktionen) musst du in deinem Zielprojekt anpassen.

**Abhängigkeiten (Beispiel):** `altcha`, `altcha-lib` — sowie ein Framework mit Server Actions und einer HTTP-Route für Challenges (hier Next.js App Router).

---

## Umgebungsvariable

| Variable          | Bedeutung                                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ALTCHA_HMAC_KEY` | Geheimer Schlüssel (z. B. zufällige Zeichenkette, 32+ Zeichen). Ohne Key schlägt die Verifizierung fehl; die Challenge-Route sollte mit Fehler antworten. |

---

## Challenge-Route (GET)

Erzeugt eine signierte Challenge; der Browser-Widget ruft diese URL ab.

```typescript
import { createChallenge } from "altcha-lib";
import { NextResponse } from "next/server";

const hmacKey = process.env.ALTCHA_HMAC_KEY;

export async function GET() {
  if (!hmacKey) {
    return NextResponse.json(
      { error: "ALTCHA not configured" },
      { status: 500 },
    );
  }

  const challenge = await createChallenge({
    hmacKey,
    maxNumber: 100000,
    expires: new Date(Date.now() + 5 * 60 * 1000),
  });

  return NextResponse.json(challenge);
}
```

**Bekannte Falle: ALTCHA-Attributname.** `challengeurl` ist das **v2**-Attribut. Ab
`altcha` **v3** heißt es **`challenge`** — `challengeurl` wird dort still
ignoriert, das Widget fällt auf `""` zurück, holt die aktuelle Seite statt der
Challenge-Route und meldet in der Konsole wortwörtlich:

```
ALTCHA verification failed: Server responded with invalid content-type.
Expected application/json, received text/html; charset=utf-8.
```

Dieser Text ist der zuverlässigste Einstieg beim Debuggen — er zeigt sich
identisch bei jedem Attribut-Mismatch, unabhängig vom Projekt. Vor jedem
Einsatz die tatsächlich unterstützten Attribute am installierten Paket
prüfen, statt der Doku im Kopf zu vertrauen (die Attributnamen ändern sich
zwischen Majorversionen):

```js
customElements.get("altcha-widget").observedAttributes;
```

Das Attribut im Widget muss zur Challenge-Route passen (hier z. B. `/api/altcha`).

---

## Gemeinsame Hilfsfunktionen (Server)

```typescript
import { verifySolution } from "altcha-lib";

const hmacKey = process.env.ALTCHA_HMAC_KEY;

const consumedPayloads = new Map<string, number>();
const CONSUMED_TTL = 5 * 60 * 1000;

function cleanupConsumedPayloads() {
  const now = Date.now();
  for (const [key, timestamp] of consumedPayloads) {
    if (now - timestamp > CONSUMED_TTL) {
      consumedPayloads.delete(key);
    }
  }
}

export async function verifyAltcha(payload: string | null): Promise<boolean> {
  const trimmed = typeof payload === "string" ? payload.trim() : "";
  if (!hmacKey) {
    if (process.env.NODE_ENV === "development") {
      console.error("[ALTCHA] ALTCHA_HMAC_KEY fehlt.");
    }
    return false;
  }
  if (!trimmed) return false;

  cleanupConsumedPayloads();

  if (consumedPayloads.has(trimmed)) {
    return false;
  }

  try {
    return await verifySolution(trimmed, hmacKey);
  } catch {
    return false;
  }
}

export function markAltchaPayloadConsumed(payload: string | null): void {
  const trimmed = typeof payload === "string" ? payload.trim() : "";
  if (!trimmed) return;
  consumedPayloads.set(trimmed, Date.now());
}

const MIN_FILL_TIME_MS = 1500;

export function isLikelyBotSubmission(contactTimeRaw: unknown): boolean {
  if (typeof contactTimeRaw !== "string" || contactTimeRaw === "") return false;

  const mountedAt = Number(contactTimeRaw);
  if (!Number.isFinite(mountedAt) || mountedAt <= 0) return false;

  const elapsed = Date.now() - mountedAt;
  if (elapsed < 0 || elapsed > 24 * 60 * 60 * 1000) return false;

  return elapsed < MIN_FILL_TIME_MS;
}
```

Hinweis: Die Map lebt im Speicher der einen Node-Prozesses — bei horizontaler Skalierung ggf. durch geteilten Store ersetzen.

---

## Bekannte Falle: Honeypot als reine Vorhandensein-Prüfung

**Live-Vorfall (karlingerhof.at, August 2026):** `isHoneypotFilled` prüfte
ursprünglich nur, ob das versteckte Feld überhaupt einen Wert hatte — jeder
Wert galt als Bot. Browser-Passwortmanager (1Password, Bitwarden, Safari)
tragen in solche Felder aber trotzdem Text ein; `autocomplete="off"` wird dafür
seit Jahren ignoriert. Ein echter Gast mit aktivem Passwortmanager bekam die
Erfolgsmeldung angezeigt — Server Actions geben bei Honeypot-Treffer bewusst
`{ success: true }` zurück, damit Bots nichts merken (siehe unten) — obwohl
nichts gespeichert und keine Mail verschickt wurde. Da Honeypot-Treffer
absichtlich **nicht** persistiert werden, tauchte das nirgends auf: kein
Log, kein Datenbankeintrag, keine fehlgeschlagene Mail. Nur eine
zurückgemeldete Nutzerbeschwerde ("Anfrage gesendet, nie angekommen") hat es
sichtbar gemacht.

**Fix:** zeitbasiert statt Vorhandensein-basiert (siehe `isLikelyBotSubmission`
oben plus `Honeypot`-Komponente unten). Das Feld trägt jetzt einen
Mount-Zeitpunkt, den JavaScript erst nach dem Hydratisieren setzt. Nur ein
Wert, der eindeutig "vor wenigen Millisekunden gesetzt" bedeutet, gilt als
Bot — leere Werte (kein JS gelaufen) und unlesbarer Text (z. B. von einem
Passwortmanager) lassen die Prüfung bewusst durch. Ein Bot ganz ohne JS fällt
stattdessen über ALTCHA, das ebenfalls JS braucht — die Zeitprüfung verliert
dadurch keine Abdeckung, nur die False-Positive-Quelle.

---

## Komponente: Honeypot

Feldname **`contact_time`** muss zu `isLikelyBotSubmission` passen. Der
Zeitstempel wird erst nach dem Mounten per Effekt gesetzt, nicht als
`defaultValue` — sonst würde die Uhrzeit des Server-Renders im HTML landen,
und `Date.now() - mountedAt` bei jedem Submit einen Wert zeigen, der die
tatsächliche Ausfüllzeit unterschätzt (der Effekt läuft ohnehin erst nach der
Hydration, ein `defaultValue` mit `Date.now()` würde zudem denselben
Zeitstempel serverseitig einfrieren und bei jedem Seitenaufruf für alle
Besucher identisch — und damit nutzlos — machen).

```tsx
"use client";

import React, { useEffect, useState } from "react";

export const Honeypot: React.FC = () => {
  const [mountedAt, setMountedAt] = useState("");

  useEffect(() => {
    setMountedAt(String(Date.now()));
  }, []);

  return (
    <div
      aria-hidden="true"
      className="absolute overflow-hidden"
      style={{ left: "-9999px" }}
    >
      <input
        type="text"
        name="contact_time"
        tabIndex={-1}
        autoComplete="off"
        value={mountedAt}
        readOnly
      />
    </div>
  );
};
```

Das umgebende `<form>` sollte `position: relative` haben, damit die absolute Positionierung des Wrappers passt.

---

## Komponente: AltchaWidget (Client)

```tsx
"use client";

import React, { useEffect, useRef } from "react";

type AltchaWidgetProps = {
  className?: string;
  auto?: "off" | "onfocus" | "onload" | "onsubmit";
};

export const AltchaWidget: React.FC<AltchaWidgetProps> = ({
  className: _className,
  auto = "onsubmit",
}) => {
  const widgetRef = useRef<HTMLElement>(null);

  useEffect(() => {
    import("altcha");
  }, []);

  return (
    <altcha-widget
      ref={widgetRef}
      challenge="/api/altcha"
      auto={auto}
      style={{ display: "none" }}
    />
  );
};
```

- **`auto="onsubmit"` (Standard):** Challenge beim Absenden — gut für einfache HTML-Formulare.
- **`auto="onload"`:** Challenge früh starten — sinnvoll bei `react-hook-form` oder wenn du vor dem Fetch explizit `verify()` aufrufest.

Das Web Component trägt die Lösung als Formularfeld **`altcha`** in `FormData` ein (wenn das Widget im `<form>` liegt).

---

## Variante A: Generischer Form-Builder (react-hook-form)

**Idee:** Dynamische Felder, Submit baut `FormData` aus dem DOM-Formular, setzt `altcha` explizit und schickt Metadaten (z. B. `formId`, JSON der Werte) an die Server Action.

**JSX-Ausschnitt im Formular:**

```tsx
<form ref={formRef} className="relative" onSubmit={handleSubmit(onSubmit)}>
  <Honeypot />
  {/* … dynamische Felder … */}
  <AltchaWidget auto="onload" />
  <button type="submit">Senden</button>
</form>
```

**Client: `verified`-Event und Payload-Ref**

```tsx
const formRef = useRef<HTMLFormElement>(null);
const altchaPayloadRef = useRef<string | null>(null);

useEffect(
  () => {
    const form = formRef.current;
    if (!form) return;
    const widget = form.querySelector("altcha-widget");
    if (!widget) return;

    const onVerified = (e: Event) => {
      const detail = (e as CustomEvent<{ payload?: string }>).detail;
      altchaPayloadRef.current = detail?.payload ?? null;
    };

    widget.addEventListener("verified", onVerified);
    return () => widget.removeEventListener("verified", onVerified);
  },
  [
    /* deps: z. B. Formular-ID / Felderanzahl */
  ],
);
```

**Client: vor dem Aufruf der Server Action**

```tsx
const formEl = formRef.current;
if (!formEl) return;

const formData = new FormData(formEl);

const widget = formEl.querySelector("altcha-widget") as
  | (HTMLElement & { getState?: () => string; verify?: () => Promise<void> })
  | null;

let altchaPayload = altchaPayloadRef.current?.trim() || null;

if (!altchaPayload && widget && typeof widget.verify === "function") {
  try {
    await widget.verify();
    await new Promise<void>((r) => queueMicrotask(() => r()));
    altchaPayload = altchaPayloadRef.current?.trim() || null;
  } catch {
    // Fehler anzeigen
    return;
  }
}

if (!altchaPayload) {
  // Fehler anzeigen
  return;
}

formData.set("altcha", altchaPayload);
// formData.set('formId', …)
// formData.set('submissionJson', …)

const result = await submitFormBuilderForm(formData);
```

Nach fehlgeschlagenem Submit: `altchaPayloadRef.current = null` und ggf. erneut `widget.verify()`.

**Server Action (Muster — Collection und Feldnamen anpassen):**

```typescript
"use server";

import { getPayload } from "payload";
import configPromise from "@payload-config";
import {
  isLikelyBotSubmission,
  markAltchaPayloadConsumed,
  verifyAltcha,
} from "./altcha";

export async function submitFormBuilderForm(formData: FormData) {
  if (isLikelyBotSubmission(formData.get("contact_time"))) {
    return { success: true };
  }

  const altchaPayload = formData.get("altcha") as string | null;
  if (!(await verifyAltcha(altchaPayload))) {
    return {
      success: false,
      error: "Verifizierung fehlgeschlagen. Bitte versuchen Sie es erneut.",
    };
  }

  // … formId, submissionJson parsen, validieren …

  const payload = await getPayload({ config: configPromise });

  await payload.create({
    collection: "form-submissions",
    data: {
      /* form, submissionData, … */
    },
    overrideAccess: true,
  });

  markAltchaPayloadConsumed(altchaPayload);
  return { success: true };
}
```

---

## Variante B: Festes Kontaktformular ( natives Submit )

**Idee:** Ein `<form>`, `FormData(event.currentTarget)`, keine Ref-Logik für ALTCHA nötig, wenn `auto="onsubmit"` ausreicht.

**JSX-Ausschnitt:**

```tsx
<form onSubmit={handleSubmit}>
  <Honeypot />
  {/* … Felder … */}
  <AltchaWidget />
  <button type="submit">Nachricht senden</button>
</form>
```

**Submit-Handler (Kurzfassung):**

```tsx
const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }
  const formData = new FormData(form);
  startTransition(async () => {
    const result = await submitKontaktForm(formData);
    // …
  });
};
```

**Server Action (Muster — Validierung und Collection anpassen):**

```typescript
"use server";

import { getPayload } from "payload";
import configPromise from "@payload-config";
import {
  isLikelyBotSubmission,
  markAltchaPayloadConsumed,
  verifyAltcha,
} from "./altcha";

export async function submitKontaktForm(formData: FormData) {
  if (isLikelyBotSubmission(formData.get("contact_time"))) {
    return { success: true };
  }

  const altchaPayload = formData.get("altcha") as string | null;
  if (!(await verifyAltcha(altchaPayload))) {
    return {
      success: false,
      error: "Verifizierung fehlgeschlagen. Bitte versuchen Sie es erneut.",
    };
  }

  // … Felder aus formData lesen und validieren …

  const payload = await getPayload({ config: configPromise });

  await payload.create({
    collection: "kontaktSubmissions",
    overrideAccess: true,
    data: {
      /* … */
    },
  });

  markAltchaPayloadConsumed(altchaPayload);
  return { success: true };
}
```

---

## Reihenfolge in Server Actions (immer gleich)

1. **`isLikelyBotSubmission(formData.get('contact_time'))`** → bei Treffer **`{ success: true }`** zurückgeben (Bot merkt nicht, dass er gefiltert wurde).
2. **`verifyAltcha(formData.get('altcha'))`** → bei Fehler klare Nutzermeldung.
3. Eigene Validierung und **`payload.create`**.
4. Nur nach erfolgreichem Speichern: **`markAltchaPayloadConsumed(altchaPayload)`**.

Was danach kommt — Einsendungs-Collection, Dateien in einer geschützten Upload-Collection
(nicht `media`) und die Benachrichtigungsmail samt Anhängen —, steht in
[form-submissions-email](../form-submissions-email/description.md).

---

## Test ohne Mailversand

Die „Bekannte Falle" oben beschreibt, was ein Attribut-Mismatch **verursacht**.
Das hier prüft aktiv, **ob** er gerade vorliegt — nach jedem Deploy, nach jedem
`altcha`-Upgrade, nicht nur beim Lesen des Codes. Ein kaputter Spamschutz
schlägt bei **jeder** Anfrage fehl, ohne dass es von selbst auffällt (siehe
Vorfall oben) — die einzige Konversionsstrecke der Seite verdient einen
aktiven Test, kein Vertrauen auf den letzten Blick in den Code.

Seite im Browser öffnen, dann in der Konsole ausführen. Schritt 2 löst
**keine** Mail aus, solange die Server Action erst nach der ALTCHA-Prüfung
etwas verschickt (siehe „Reihenfolge in Server Actions" oben).

**1. Sniff: Fragt das Widget wirklich die Challenge-Route ab?**

Fängt exakt den Attribut-Mismatch aus der „Bekannten Falle" ab, unabhängig
davon, ob die Ursache `challengeurl` vs. `challenge` ist oder ein Tippfehler
im Pfad:

```js
(async () => { const calls=[]; const of=window.fetch;
  window.fetch=async function(...a){ const u=a[0]?.url||String(a[0]); const r=await of.apply(this,a);
    calls.push({u, status:r.status, ct:r.headers.get('content-type'), finalUrl:r.url}); return r; };
  const w=document.querySelector('altcha-widget'); try{ await w.verify(); }catch(e){}
  window.fetch=of; return JSON.stringify(calls); })()
```

Erwartet: ein Request auf die Challenge-Route mit `application/json`. Zeigt der
Log stattdessen die aktuelle Seiten-URL mit `text/html`, liegt der
Attribut-Mismatch vor.

**2. Ganze Kette bis zur Serverprüfung, ohne das echte Formular zu benutzen:**

Baut ein eigenes, unsichtbares Widget, löst es und schickt das Token direkt an
die Guard-Logik. Setzt eine dedizierte Guard-Route voraus (Muster:
`/api/form-guard`, siehe `Form/Component.tsx`-Variante deines Projekts); bei
reiner Server-Action-Kopplung (Variante A/B oben) ersatzweise gegen eine
Test-Route mit derselben `verifyAltcha`-Logik prüfen.

```js
(async () => { const el=document.createElement('altcha-widget');
  el.setAttribute('challenge','/api/altcha'); el.setAttribute('name','altcha');
  el.style.display='none'; document.body.appendChild(el);
  await new Promise(r=>setTimeout(r,300)); await el.verify();
  const val=el.querySelector('input[name=altcha]').value; el.remove();
  const r=await fetch('/api/form-guard',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({altcha: val, contact_time: ''})});
  return JSON.stringify({status:r.status, body: await r.text()}); })()
```

Erwartet: `{"status":200,"body":"{\"success\":true}"}`. Kommt stattdessen ein
Fehler zur Verifizierung, passen Widget-Payload und `ALTCHA_HMAC_KEY` auf dem
Server nicht zusammen (z. B. Key zwischen Build- und Runtime-Umgebung
unterschiedlich gesetzt).

**3. Challenge-Route direkt, unabhängig vom Browser:**

```bash
curl -si https://deine-domain.tld/api/altcha | head -20
```

Erwartet: `200` und `content-type: application/json`.

**Nach dem Deploy zusätzlich das ausgelieferte Markup prüfen** — der Build ist
erst dann wirklich drüben, wenn das Attribut stimmt:

```bash
curl -s https://deine-domain.tld/pfad-mit-formular | grep -o 'challenge[a-z]*="[^"]*"'
```

Erwartet: `challenge="..."` (nicht `challengeurl=`). Danach Schritt 1 und 2 gegen
die Live-Seite wiederholen — ein lokal funktionierender Build sagt nichts
darüber, ob derselbe Fehler nach dem Deploy erneut auftritt (z. B. weil eine
andere `altcha`-Version installiert wurde).

**Lokal:** `verifyAltcha` lässt ohne gesetzten `ALTCHA_HMAC_KEY` in Development
alles durch (siehe Hilfsfunktion oben) — ohne den Key testet man also die
Abwesenheit des Schutzes, nicht seine Funktion. Vor einem lokalen Test prüfen,
ob der Key in der `.env` steht.

Ein echter Absendetest (durchs sichtbare Formular, mit Klick auf Absenden)
löst dagegen eine echte Mail aus. Den nur bewusst, mit erkennbarem Testtext,
und nach Rücksprache mit dem Team machen.

---

## Checkliste für weitere Formulare

1. `Honeypot` im `<form>`; Name `contact_time` oder Hilfsfunktion anpassen.
2. `AltchaWidget` im `<form>`; bei komplexem Client ggf. `auto="onload"` und `verified` / `verify()` wie in Variante A. Attributname am installierten Paket prüfen (`challenge` bei v3, siehe oben).
3. Server Action: Honeypot (zeitbasiert) → ALTCHA → Logik → `markAltchaPayloadConsumed`.
4. `ALTCHA_HMAC_KEY` in jeder Umgebung setzen.
5. Honeypot nie auf reine Vorhandensein-Prüfung zurückbauen — siehe „Bekannte Falle" oben.
6. Nach jedem Deploy und jedem `altcha`-Upgrade: Testroutine oben durchlaufen, bevor der erste echte Nutzer die Formulare erreicht.
