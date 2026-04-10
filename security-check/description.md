# Next.js + Payload CMS – Security Checklist vor Deployment

> Praktische Maßnahmen, die sich ohne großen Aufwand in jedes Projekt integrieren lassen.  
> Aufgeteilt nach: Next.js, Payload CMS und Infrastruktur/Hosting.

---

## 1. HTTP Security Headers

Konfiguration in `next.config.js` unter `headers()`. Diese Headers sollten auf **jeder** Route aktiv sein.

```js
// next.config.js
const securityHeaders = [
  {
    key: "X-DNS-Prefetch-Control",
    value: "on",
  },
  {
    key: "X-Frame-Options",
    value: "SAMEORIGIN", // Verhindert Clickjacking
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff", // Verhindert MIME-Sniffing
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()", // Nur benötigte APIs freigeben
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload", // HSTS – nur wenn HTTPS garantiert
  },
];

module.exports = {
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};
```

---

## 2. Content Security Policy (CSP)

CSP schützt vor XSS. Für Next.js + Payload (mit Rich Text Editor) muss sie sorgfältig kalibriert werden.

```js
// Ergänzung zu securityHeaders oben
{
  key: 'Content-Security-Policy',
  value: [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",        // 'unsafe-inline' für Payload Admin nötig – wenn möglich durch Nonce ersetzen
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",        // blob: für Payload-Uploads, https: für externe Bilder
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",                   // Kein Einbetten in iframes erlaubt
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; '),
},
```

> **Hinweis:** Payload CMS Admin Panel braucht `unsafe-inline` für Scripts/Styles. In Produktion empfiehlt sich, den Admin-Pfad (`/admin`) separat zu behandeln oder einen Nonce-basierten Ansatz zu verfolgen.

---

## 3. CORS

### Next.js API Routes

```js
// middleware.ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const ALLOWED_ORIGINS = [
  'https://deinedomain.at',
  'https://www.deinedomain.at',
  // Lokal nur in Development:
  ...(process.env.NODE_ENV === 'development' ? ['http://localhost:3000'] : []),
];

export function middleware(request: NextRequest) {
  const origin = request.headers.get('origin') ?? '';
  const isAllowed = ALLOWED_ORIGINS.includes(origin);

  const response = NextResponse.next();

  if (isAllowed) {
    response.headers.set('Access-Control-Allow-Origin', origin);
  }

  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  response.headers.set('Access-Control-Max-Age', '86400');

  if (request.method === 'OPTIONS') {
    return new NextResponse(null, { status: 204, headers: response.headers });
  }

  return response;
}

export const config = {
  matcher: '/api/:path*',
};
```

### Payload CMS CORS Config

```ts
// payload.config.ts
import { buildConfig } from "payload/config";

export default buildConfig({
  serverURL: process.env.NEXT_PUBLIC_SERVER_URL,
  cors: ["https://deinedomain.at", "https://www.deinedomain.at"],
  csrf: ["https://deinedomain.at", "https://www.deinedomain.at"],
  // ...
});
```

---

## 4. Environment Variables absichern

```bash
# .env.example – kein echter Wert, nur Struktur dokumentieren
PAYLOAD_SECRET=                    # Min. 32 Zeichen, zufällig generiert
MONGODB_URI=
NEXT_PUBLIC_SERVER_URL=
```

### Secrets und zufällige Werte erzeugen

Für `PAYLOAD_SECRET` und andere geheime Schlüssel nur **kryptographisch sichere Zufallswerte** verwenden – keine Wörterbuch-Passwörter und keine selbst erdachten Strings.

```bash
# OpenSSL: 32 Bytes als Base64 (typisch > 40 Zeichen, gut für Payload)
openssl rand -base64 32

# OpenSSL: 32 Bytes als Hex (64 Zeichen)
openssl rand -hex 32

# Node.js (lokal, ohne Extra-Pakete)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Den ausgegebenen Wert **einmalig** in `.env` eintragen bzw. in der Hosting-Oberfläche (z. B. Dokploy → Environment Variables) setzen – **nicht** committen oder per Chat/E-Mail teilen.

**Nicht geheime** Werte wie `NEXT_PUBLIC_SERVER_URL` sind keine Secrets: hier die echte Produktions-URL eintragen (`https://deinedomain.at`), ohne Generator.

**Regeln:**

- `.env` niemals committen – in `.gitignore` eintragen
- `NEXT_PUBLIC_` Prefix nur für Werte, die im Browser sichtbar sein dürfen
- Payload `secret` Key sollte **mindestens 32 zufällige Zeichen** haben
- Secrets in Produktionsumgebung über Deployment-Plattform setzen (Dokploy Environment Variables)

---

## 5. Payload CMS – Admin-Panel absichern

### Admin-Route verstecken / schützen

```ts
// payload.config.ts
export default buildConfig({
  admin: {
    user: Users.slug,
    // Optional: Admin-URL auf nicht-standardmäßigen Pfad verlegen
    // Nicht als alleinige Sicherheitsmaßnahme geeignet, aber reduziert automatisierte Angriffe
  },
  // ...
});
```

### Starkes Passwort / E-Mail-Authentifizierung erzwingen

```ts
// collections/Users.ts
const Users: CollectionConfig = {
  slug: "users",
  auth: {
    tokenExpiration: 7200, // 2 Stunden
    verify: false, // E-Mail-Verifizierung nach Bedarf aktivieren
    maxLoginAttempts: 5, // Brute-Force-Schutz
    lockTime: 600000, // 10 Minuten Sperrzeit
  },
  // ...
};
```

### Access Control für Collections

```ts
// Beispiel: Nur authentifizierte Nutzer dürfen lesen
{
  access: {
    read: ({ req: { user } }) => Boolean(user),
    create: ({ req: { user } }) => Boolean(user),
    update: ({ req: { user } }) => Boolean(user),
    delete: ({ req: { user } }) => user?.role === 'admin',
  },
}
```

---

## 6. Rate Limiting

Schützt API-Routen vor Brute-Force und DoS-Angriffen.

```bash
npm install @upstash/ratelimit @upstash/redis
# oder ohne externe Abhängigkeit: next-rate-limit
```

```ts
// lib/ratelimit.ts (Upstash Beispiel)
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

export const ratelimit = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.slidingWindow(10, "10 s"), // 10 Requests pro 10 Sekunden
});
```

```ts
// app/api/contact/route.ts
import { ratelimit } from "@/lib/ratelimit";

export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for") ?? "127.0.0.1";
  const { success } = await ratelimit.limit(ip);

  if (!success) {
    return Response.json({ error: "Too many requests" }, { status: 429 });
  }
  // ...
}
```

---

## 7. Dependency Security

```bash
# Auf bekannte Sicherheitslücken prüfen
npm audit

# Automatisch behebbare Lücken fixen
npm audit fix

# Regelmäßig deps updaten
npx npm-check-updates -u
```

- `package-lock.json` committen (exakte Versionen sichern)
- In CI/CD `npm audit --audit-level=high` als Step einbauen

---

## 8. Next.js Image Optimization absichern

```js
// next.config.js
module.exports = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "deinedomain.at",
      },
      // Nur explizit erlaubte Hosts – nie '*' verwenden
    ],
  },
};
```

---

## 9. Input-Validierung & Sanitization

```bash
npm install zod
```

```ts
// Alle API-Eingaben mit Zod validieren
import { z } from "zod";

const contactSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  message: z.string().min(10).max(2000),
});

export async function POST(req: Request) {
  const body = await req.json();
  const result = contactSchema.safeParse(body);

  if (!result.success) {
    return Response.json({ error: result.error.flatten() }, { status: 400 });
  }
  // result.data ist typsicher und validiert
}
```

---

## 10. Sensitive Routes via Middleware schützen

```ts
// middleware.ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const token = request.cookies.get("payload-token");

  // Payload Admin ohne gültigen Cookie blocken (zusätzliche Schicht)
  if (request.nextUrl.pathname.startsWith("/admin") && !token) {
    return NextResponse.redirect(new URL("/admin/login", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*", "/api/:path*"],
};
```

---

## 11. Logging & Error Handling

```ts
// Keine internen Fehler an den Client leaken
export async function GET() {
  try {
    // ...
  } catch (error) {
    console.error("[API Error]", error); // Intern loggen
    return Response.json(
      { error: "Internal Server Error" }, // Generische Meldung nach außen
      { status: 500 },
    );
  }
}
```

---

## 12. React Doctor (Codebase-Gesundheit)

[React Doctor](https://www.react.doctor/) ist ein CLI-Tool, das das Projektverzeichnis scannt: Es erkennt automatisch Next.js, React-Version und Setup und prüft u. a. **Security**, Performance, Korrektheit, Accessibility und Next.js-spezifische Regeln (60+ Regeln) sowie optional toten Code. Am Ende gibt es einen **Score von 0–100** mit konkreten Hinweisen – gut als Zusatz zu `npm audit` und manuellen Reviews.

```bash
# Im Projektroot ausführen
npx -y react-doctor@latest .

# Details pro Regel mit Datei/Zeile
npx -y react-doctor@latest . --verbose

# Nur numerischen Score (z. B. für Skripte)
npx -y react-doctor@latest . --score

# CI / Agenten: Prompts überspringen
npx -y react-doctor@latest . -y

# Nur geänderte Dateien (schneller, z. B. in PR-Pipelines)
npx -y react-doctor@latest . --diff
```

**Einordnung:** Ergänzt die Checkliste hier – ersetzt keine Penetrationstests und keine Konfiguration von Headers/CORS. Optional: `react-doctor.config.json` im Root für ignorierte Regeln (siehe [Repository / Docs](https://github.com/aidenybai/react-doctor)).

---

## 13. Deployment-Checkliste (Dokploy / Hetzner)

| Punkt                                                           | Erledigt |
| --------------------------------------------------------------- | -------- |
| `NODE_ENV=production` gesetzt                                   | ☐        |
| `PAYLOAD_SECRET` min. 32 Zeichen                                | ☐        |
| `.env` nicht im Git-Repo                                        | ☐        |
| HTTPS / SSL aktiv (NPM oder Cloudflare)                         | ☐        |
| CORS-Whitelist auf Produktionsdomain beschränkt                 | ☐        |
| Security Headers aktiv (via `curl -I https://domain.at` prüfen) | ☐        |
| Payload Admin-Passwort geändert (kein Default)                  | ☐        |
| `npm audit` ohne kritische Findings                             | ☐        |
| React Doctor ausgeführt (Security-/Lint-Findings abgearbeitet)  | ☐        |
| MongoDB nicht öffentlich erreichbar (nur intern)                | ☐        |
| Rate Limiting auf kritischen API-Routen                         | ☐        |
| Fehler-Logging eingerichtet (z. B. Sentry oder eigenes Logging) | ☐        |

---

## Tools zur Verifikation

```bash
# Security Headers online prüfen
# https://securityheaders.com

# SSL-Konfiguration prüfen
# https://www.ssllabs.com/ssltest/

# Headers lokal prüfen
curl -I https://deinedomain.at

# React / Next.js Codebase (Security, Performance, A11y, Next.js-Regeln)
npx -y react-doctor@latest . --verbose
```

---

_Erstellt für Morgendigital GmbH – Next.js + Payload CMS Projekte_
