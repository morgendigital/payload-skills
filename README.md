# payload-skills

Collection of practical checklists and implementation notes for **Payload CMS** with **Next.js** (media setup, security, auth, links, popups, tracking, forms, and styling). Each topic lives in its own folder under `description.md`.

## Markdown files

| Document | What it covers |
| -------- | -------------- |
| [payload-start/description.md](payload-start/description.md) | Bootstrapping a new Payload site (target: **Dokploy on Hetzner**): upload limits, WebP/Sharp resize, **`@payloadcms/storage-s3`**, proxy/body limits for large files, then experimental two-step Next.js build. |
| [security-check/description.md](security-check/description.md) | Pre-deployment security checklist for Next.js, Payload, and hosting: HTTP headers, env/secrets, CORS, rate limiting, file uploads, admin hardening, and infrastructure basics. |
| [honey-pot-capcha/description.md](honey-pot-capcha/description.md) | Public Payload forms: **honeypot** field plus **ALTCHA** proof-of-work — challenge route, server-side verification, replay protection, and Server Actions before writing to Payload (`altcha` / `altcha-lib`, Next.js App Router). |
| [tracking/description.md](tracking/description.md) | How GTM, tracking, and the cookie banner fit together: `c15t` consent manager, provider setup, categories, and central `pushTrackingEvent` behavior. |
| [keycloak/description.md](keycloak/description.md) | Keycloak + Payload + Better Auth: quick checklist for new URLs (`ORIGIN`, redirect URIs, logout) plus full Next.js guide — client setup, callbacks, strategies, Payload admin access, authorization, and code examples. |
| [advanced-link/description.md](advanced-link/description.md) | CMS link system: Payload `link()` / `linkGroup()`, Lexical rich-text links, `CMSLink`, internal docs vs custom URLs, and **action** links (e.g. newsletter popup via custom events). |
| [pop-up/description.md](pop-up/description.md) | Marketing popup and newsletter dialog: Payload globals (`popup`, `newsletterTexts`), layout wiring, Lenis, CMSLink actions, and the popup section block. |
| [northlight-global-css/description.md](northlight-global-css/description.md) | Placeholder heading for global CSS variables in the Northlight Payload template (extend this file when documenting tokens). |

## Folder layout

Each skill-style folder is named after the topic; open the linked `description.md` for the full content.
