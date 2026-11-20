import type { CollectionBeforeChangeHook } from 'payload'

import type { Media } from '../payload-types'

import { makeBlurDataURL } from '../utilities/makeBlurDataURL'

/**
 * Makes the blurred loading placeholder (`blurDataURL`) whenever a file comes in: new upload,
 * replaced file, crop in the admin. Payload has put the file on `req.file` by the time this runs.
 * Edits without a new file (alt text, focal point) keep the stored value.
 */
export const generateBlurDataURL: CollectionBeforeChangeHook<Media> = async ({
  data,
  originalDoc,
  req,
}) => {
  const file = req.file

  if (file?.data?.length) {
    data.blurDataURL = await makeBlurDataURL(file.data, file.mimetype)
  } else if (data.filename && data.filename !== originalDoc?.filename) {
    // New file but no bytes to read: drop the old photo's blur rather than show the wrong one.
    data.blurDataURL = null
  }

  return data
}
