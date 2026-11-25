import type { Plugin } from 'payload'

const TRANSLATE_PATH = '/translator/translate'

/**
 * `@payload-enchants/translator` registers its endpoint without any auth check, and Payload does
 * not protect custom endpoints on its own: anyone could read document fields through it and spend
 * the OpenAI budget. Must be listed after `translator()` in the plugins array.
 */
export const requireTranslatorAuth: Plugin = (config) => {
  const endpoints = config.endpoints ?? []

  // Fail the build rather than silently leaving the endpoint open after a plugin change.
  if (!endpoints.some((endpoint) => endpoint.path === TRANSLATE_PATH)) {
    if (!config.localization) return config
    throw new Error(`requireTranslatorAuth: endpoint ${TRANSLATE_PATH} not found`)
  }

  return {
    ...config,
    endpoints: endpoints.map((endpoint) => {
      if (endpoint.path !== TRANSLATE_PATH) return endpoint

      return {
        ...endpoint,
        handler: (req) => {
          if (!req.user) {
            return Response.json({ success: false }, { status: 401 })
          }

          return endpoint.handler(req)
        },
      }
    }),
  }
}
