# Next.js Standalone auf Dokploy (Railpack und Dockerfile)

Gemessen auf einem Hetzner-Prod-Host mit ~20 Payload/Next-Apps (`taxi-app-prod`,
150 GB Root): die Platte lag bei **90 %** (`129 G` belegt). Build-Cache war
**0 B** — der Verbrauch waren **App-Images à 1,5–3,2 GB** (Unique) plus Mongo-Volumes.
`docker image prune -f` brachte **0 B**, weil keine dangling Images mehr da waren;
jedes Image hing an einem laufenden Swarm-Task.

Ursache: Railpack/Nixpacks (und viele Templates) starten mit `next start` und
packen praktisch den ganzen Tree inklusive `node_modules` ins Image. Next.js
**Standalone** liefert nur den Runtime-Server — oft **&lt;500 MB** statt multi-GB.

## Todo 1: `output: 'standalone'`

**Datei:** `next.config.ts` / `next.config.mjs`

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // …
};

export default nextConfig;
```

Nach dem Build liegen unter `.next/standalone/` der Server und die nötigen
Abhängigkeiten; `.next/static` und `public` müssen zur Laufzeit daneben liegen
(Dockerfile kopiert sie; bei Railpack bleiben sie im Workspace, wenn der Start
aus dem App-Root läuft).

## Todo 2: Railpack (Dokploy Build-Type „Railpack")

Standalone **funktioniert mit Railpack** — Railway dokumentiert genau das.

**`package.json`** — Start auf den Standalone-Server:

```json
{
  "scripts": {
    "build": "next build",
    "start": "node .next/standalone/server.js"
  }
}
```

Monorepo (App unter `apps/web` o. Ä.) — Pfad nach dem ersten Build prüfen
(`ls .next/standalone`) und ggf.:

```json
"start": "node .next/standalone/apps/web/server.js"
```

Oder in Dokploy Environment:

| Variable | Wert |
| --- | --- |
| `RAILPACK_START_CMD` | `node .next/standalone/server.js` |
| `HOSTNAME` | `0.0.0.0` |
| Port | `3000` |

Ohne `HOSTNAME=0.0.0.0` lauscht Next im Container oft nur auf localhost —
Dokploy/Traefik sieht die App als down.

**Einschränkung Railpack:** Der Start wird schlank, das **Image** kann trotzdem
noch `node_modules` und Build-Artefakte enthalten. Für maximale Einsparung
Build-Type **Dockerfile** (Todo 3). Für den Fleet-Standard reicht oft schon
Standalone + Railpack, wenn danach Docker-Müll regelmäßig weg ist (Moatline →
Server → Docker storage, oder Auto-Clean bei vollem Disk).

⚠️ **`start` darf `NODE_OPTIONS` nicht überschreiben** — siehe
[memory-limit](../memory-limit/description.md). Vorlage:

```json
"start": "cross-env NODE_OPTIONS=\"--no-deprecation $NODE_OPTIONS\" node .next/standalone/server.js"
```

## Todo 3: Dockerfile (kleinste Images)

Dokploy Build-Type **Dockerfile**. Multi-Stage, Runner nur Standalone:

```dockerfile
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm i --frozen-lockfile

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && pnpm build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
```

**.dockerignore** (sonst landet Dev-Kram im Kontext):

```
node_modules
.next
.git
**/*.md
src/**/*.test.*
```

Prüfen, was im Image steckt:

```bash
docker run --rm IMAGE sh -c 'du -xh --max-depth=2 /app | sort -h | tail -20'
```

Dominantes `/app/node_modules` → Standalone greift nicht oder falscher `COPY`.

## Todo 4: Payload / Media / Mongo (neben dem Image)

- **Media in S3/R2**, nicht im Image und nicht auf dem App-Disk-Volume — sonst
  wachsen Image *und* Platte mit jedem Upload ([payload-start](../payload-start/description.md)).
- **Eine Mongo-Major** pro Host (nicht parallel 6 + 7 + 8) — spart Base-Images.
- Mongo-Volumes (~400–700 MB/App) sind meist echte Daten; `docker volume prune`
  nur nach Prüfung von Volumes mit `LINKS=0`. Payload-Versioning begrenzen, wenn
  Collections den Großteil ausmachen.
- Builds möglichst auf einen **Dokploy Build-Server** (`serverType: build` /
  `server.buildServers`), nicht auf dem App-Host — sonst füllen Deploy-Spitzen
  dieselbe Platte, auf der die Kunden-DBs liegen.

## Todo 5: Nach dem Deploy aufräumen

Jeder Redeploy hinterlässt ein altes Image. Auf dem Host:

```bash
docker system df
docker image prune -f          # nur dangling
docker container prune -f      # Exited Swarm-Tasks
# aggressiver, nur ungenutzte getaggte Images:
# docker image prune -af
```

In Moatline: Server → Overview → **Docker storage** (Build-Cache / Unused
Images). Volumes werden dort absichtlich nicht gelöscht.

Wenn die Root-Platte über dem Schwellwert liegt und Docker reclaimable Space
meldet, räumt Moatline über die Dokploy-API automatisch Build-Cache und
ungenutzte Images auf (App- und Moatline-Host gleichermaßen, sobald der Agent
meldet und Dokploy verknüpft ist).

## Checkliste neues / bestehendes Projekt

1. [ ] `output: 'standalone'` in `next.config`
2. [ ] Start = `node .next/standalone/server.js` (Pfad im Monorepo geprüft)
3. [ ] `HOSTNAME=0.0.0.0`, Port 3000
4. [ ] `NODE_OPTIONS` wird angehängt, nicht ersetzt ([memory-limit](../memory-limit/description.md))
5. [ ] Media auf S3; `.dockerignore` vorhanden
6. [ ] Nach erstem Deploy Image-Größe prüfen (`docker images` / `du` im Container)
7. [ ] Bei &lt;1 GB Unique: Railpack reicht; bei weiterhin multi-GB: Dockerfile
