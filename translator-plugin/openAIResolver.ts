import type { TranslateResolver } from '@payload-enchants/translator/resolvers/types'

// Replaces the plugin's own `openAIResolver`: its default model (gpt-3.5-turbo) is shut down,
// it parses free-form answers and never checks that it got one translation per input.
const DEFAULT_MODEL = 'gpt-5.6-luna'
const CHUNK_LENGTH = 100
const TIMEOUT_MS = 90_000

type Options = {
  apiKey: string | undefined
  model?: string
}

const buildPrompt = (localeFrom: string, localeTo: string) =>
  [
    `You translate website copy of a company from locale "${localeFrom}" to locale "${localeTo}".`,
    'The input is a JSON object. Translate every value and return it under the same key.',
    'Keys are in document order. Neighbouring values are often fragments of one sentence that was split by formatting (bold, links): translate them so that they still read correctly when joined again, and never merge, move or drop a fragment.',
    'Keep brand names, personal names, URLs, e-mail addresses, placeholders such as {{name}} and HTML entities unchanged.',
    'Return a value unchanged if there is nothing to translate.',
  ].join('\n')

// Rich text nodes carry the spaces between words; the model tends to trim them.
const keepOuterWhitespace = (source: string, translated: string) => {
  const leading = source.match(/^\s*/)?.[0] ?? ''
  const trailing = source.trim() ? (source.match(/\s*$/)?.[0] ?? '') : ''

  return source.trim() ? `${leading}${translated.trim()}${trailing}` : source
}

const translateChunk = async ({
  apiKey,
  localeFrom,
  localeTo,
  model,
  texts,
}: {
  apiKey: string
  localeFrom: string
  localeTo: string
  model: string
  texts: string[]
}): Promise<string[]> => {
  const keys = texts.map((_, index) => String(index))

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: buildPrompt(localeFrom, localeTo) },
        {
          role: 'user',
          content: JSON.stringify(Object.fromEntries(texts.map((text, i) => [keys[i], text]))),
        },
      ],
      // One required property per input, so the answer cannot be shorter or shifted.
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'translations',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: keys,
            properties: Object.fromEntries(keys.map((key) => [key, { type: 'string' }])),
          },
        },
      },
    }),
  })

  const data = await response.json()

  if (!response.ok) {
    throw new Error(`OpenAI ${response.status}: ${data?.error?.message ?? 'unknown error'}`)
  }

  const content = data?.choices?.[0]?.message?.content
  if (!content) throw new Error('OpenAI answered without content')

  const parsed = JSON.parse(content) as Record<string, unknown>

  return texts.map((source, i) => {
    const translated = parsed[keys[i]!]
    if (typeof translated !== 'string') throw new Error(`OpenAI skipped text ${i}`)

    return keepOuterWhitespace(source, translated)
  })
}

export const openAIResolver = ({ apiKey, model }: Options): TranslateResolver => ({
  // The key stays `openai` so the plugin's button labels keep working.
  key: 'openai',
  resolve: async ({ localeFrom, localeTo, req, texts }) => {
    if (!apiKey) {
      req.payload.logger.error('Translation failed: OPENAI_KEY is not set')
      return { success: false }
    }

    try {
      const chunks: string[][] = []
      for (let i = 0; i < texts.length; i += CHUNK_LENGTH) {
        chunks.push(texts.slice(i, i + CHUNK_LENGTH))
      }

      const translated = await Promise.all(
        chunks.map((chunk) =>
          translateChunk({
            apiKey,
            localeFrom,
            localeTo,
            model: model || DEFAULT_MODEL,
            texts: chunk,
          }),
        ),
      )

      return { success: true, translatedTexts: translated.flat() }
    } catch (err) {
      req.payload.logger.error({ err, msg: 'Translation with OpenAI failed' })
      return { success: false }
    }
  },
})
