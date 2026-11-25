// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Config, PayloadRequest } from 'payload'
import { translateOperation } from '@payload-enchants/translator'

import { openAIResolver } from '@/plugins/translator/openAIResolver'
import { requireTranslatorAuth } from '@/plugins/translator/requireTranslatorAuth'

const req = { payload: { logger: { error: vi.fn() } } } as unknown as PayloadRequest
const answer = (content: Record<string, string>) =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }))

const translate = (texts: string[]) =>
  openAIResolver({ apiKey: 'test' }).resolve({ localeFrom: 'de', localeTo: 'en', req, texts })

afterEach(() => vi.unstubAllGlobals())

describe('openAIResolver', () => {
  it('keeps order and the spaces between rich text fragments', async () => {
    vi.stubGlobal('fetch', async () => answer({ '1': 'strong', '0': 'We build' }))

    expect(await translate(['Wir bauen ', ' starke'])).toEqual({
      success: true,
      translatedTexts: ['We build ', ' strong'],
    })
  })

  it('fails when a translation is missing', async () => {
    vi.stubGlobal('fetch', async () => answer({ '0': 'One' }))

    expect(await translate(['Eins', 'Zwei'])).toEqual({ success: false })
  })

  it('does not call the API without texts', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    expect(await translate([])).toEqual({ success: true, translatedTexts: [] })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('requireTranslatorAuth', () => {
  const handler = vi.fn(async () => Response.json({ success: true }))
  const config = requireTranslatorAuth({
    endpoints: [{ path: '/translator/translate', method: 'post', handler }],
  } as unknown as Config) as Config
  const guarded = config.endpoints![0]!.handler

  it('rejects anonymous requests', async () => {
    const res = await guarded({ user: null } as unknown as PayloadRequest)

    expect(res.status).toBe(401)
    expect(handler).not.toHaveBeenCalled()
  })

  it('passes logged-in users through', async () => {
    const res = await guarded({ user: { id: '1' } } as unknown as PayloadRequest)

    expect(res.status).toBe(200)
  })
})

// Guards patches/@payload-enchants__translator@1.3.0.patch against being lost on an update
describe('patched translator', () => {
  const source = { published: false, meta: { description: 'Beschreibung' } }
  const findByID = vi.fn(async () => structuredClone(source))
  const payload = {
    findByID,
    config: {
      collections: [
        {
          slug: 'pages',
          fields: [
            { name: 'published', type: 'checkbox' },
            {
              name: 'meta',
              type: 'group',
              fields: [{ name: 'description', type: 'text', localized: true }],
            },
          ],
        },
      ],
      custom: {
        translator: {
          resolvers: [
            {
              key: 'mark',
              resolve: ({ texts }: { texts: string[] }) => ({
                success: true,
                translatedTexts: texts.map((text) => `EN:${text}`),
              }),
            },
          ],
        },
      },
    },
  }

  it('reads the draft, keeps target values and fills a missing group', async () => {
    const result = await translateOperation({
      req: { payload } as unknown as PayloadRequest,
      collectionSlug: 'pages',
      id: '1',
      locale: 'en',
      localeFrom: 'de',
      resolver: 'mark',
      overrideAccess: false,
      emptyOnly: true,
      data: { published: true },
    } as never)

    expect(findByID).toHaveBeenCalledWith(
      expect.objectContaining({ draft: true, overrideAccess: false }),
    )
    expect(result).toEqual({
      success: true,
      translatedData: { published: true, meta: { description: 'EN:Beschreibung' } },
    })
  })
})
