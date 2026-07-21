import type { ImageSource } from '../../types/llm.js'

type SharpLikeInstance = {
  resize(
    width: number,
    height: number,
    options: { fit: 'inside'; withoutEnlargement: boolean },
  ): SharpLikeInstance
  png(options: { compressionLevel: number; palette: boolean; colors?: number }): SharpLikeInstance
  jpeg(options: { quality: number }): SharpLikeInstance
  webp(options: { quality: number }): SharpLikeInstance
  toBuffer(): Promise<Buffer>
}

type SharpLikeFunction = (buffer: Buffer) => SharpLikeInstance

export interface ImageCompressionContext {
  imageBuffer: Buffer
  metadata: { width?: number; height?: number; format?: string }
  format: string
  maxBytes: number
  originalSize: number
}

export interface CompressedImageResult {
  base64: string
  mediaType: ImageSource['mediaType']
  originalSize: number
}

export function createCompressedImageResult(
  buffer: Buffer,
  mediaType: string,
  originalSize: number,
): CompressedImageResult {
  const normalizedMediaType = mediaType === 'jpg' ? 'jpeg' : mediaType
  return {
    base64: buffer.toString('base64'),
    mediaType: `image/${normalizedMediaType}` as ImageSource['mediaType'],
    originalSize,
  }
}

export async function tryProgressiveResizing(
  context: ImageCompressionContext,
  sharp: SharpLikeFunction,
): Promise<CompressedImageResult | null> {
  const scalingFactors = [1.0, 0.75, 0.5, 0.25]

  for (const scalingFactor of scalingFactors) {
    const newWidth = Math.round((context.metadata.width || 2000) * scalingFactor)
    const newHeight = Math.round((context.metadata.height || 2000) * scalingFactor)

    let resizedImage = sharp(context.imageBuffer).resize(newWidth, newHeight, {
      fit: 'inside',
      withoutEnlargement: true,
    })

    resizedImage = applyFormatOptimizations(resizedImage, context.format)

    const resizedBuffer = await resizedImage.toBuffer()

    if (resizedBuffer.length <= context.maxBytes) {
      return createCompressedImageResult(resizedBuffer, context.format, context.originalSize)
    }
  }

  return null
}

function applyFormatOptimizations(image: SharpLikeInstance, format: string): SharpLikeInstance {
  switch (format) {
    case 'png':
      return image.png({
        compressionLevel: 9,
        palette: true,
      })
    case 'jpeg':
    case 'jpg':
      return image.jpeg({ quality: 80 })
    case 'webp':
      return image.webp({ quality: 80 })
    default:
      return image
  }
}

export async function tryPalettePNG(
  context: ImageCompressionContext,
  sharp: SharpLikeFunction,
): Promise<CompressedImageResult | null> {
  const palettePng = await sharp(context.imageBuffer)
    .resize(800, 800, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .png({
      compressionLevel: 9,
      palette: true,
      colors: 64,
    })
    .toBuffer()

  if (palettePng.length <= context.maxBytes) {
    return createCompressedImageResult(palettePng, 'png', context.originalSize)
  }

  return null
}

export async function tryJPEGConversion(
  context: ImageCompressionContext,
  quality: number,
  sharp: SharpLikeFunction,
): Promise<CompressedImageResult | null> {
  const jpegBuffer = await sharp(context.imageBuffer)
    .resize(600, 600, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality })
    .toBuffer()

  if (jpegBuffer.length <= context.maxBytes) {
    return createCompressedImageResult(jpegBuffer, 'jpeg', context.originalSize)
  }

  return null
}

export async function createUltraCompressedJPEG(
  context: ImageCompressionContext,
  sharp: SharpLikeFunction,
): Promise<CompressedImageResult> {
  const ultraCompressedBuffer = await sharp(context.imageBuffer)
    .resize(400, 400, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 20 })
    .toBuffer()

  return createCompressedImageResult(ultraCompressedBuffer, 'jpeg', context.originalSize)
}
