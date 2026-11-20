import sharp from 'sharp'

/**
 * A tiny blurred copy of a photo (16px on the longest side, WebP, ~100–200 bytes as base64), shown
 * behind the photo while it loads (src/components/Media/ImageMedia). Made once on upload
 * (src/hooks/generateBlurDataURL.ts) and stored on the media document.
 *
 * Returns null — the photo then loads over the plain card grey — for anything that isn't a raster
 * image, for images with transparent areas (logos, cut-outs: the blur would smear around the
 * shape), and when sharp can't read the file.
 */
export const makeBlurDataURL = async (
  input: Buffer,
  mimeType: string | null | undefined,
): Promise<null | string> => {
  if (!mimeType?.startsWith('image/') || mimeType === 'image/svg+xml') return null

  try {
    // rotate(): EXIF orientation, like Payload does for the stored original.
    const tiny = sharp(input).rotate().resize(16, 16, { fit: 'inside' })
    const { isOpaque } = await tiny.clone().stats()
    if (!isOpaque) return null

    const buffer = await tiny.webp({ quality: 60 }).toBuffer()
    return `data:image/webp;base64,${buffer.toString('base64')}`
  } catch {
    return null
  }
}
