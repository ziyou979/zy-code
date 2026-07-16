import {
  API_IMAGE_MAX_BASE64_SIZE,
  IMAGE_MAX_HEIGHT,
  IMAGE_MAX_WIDTH,
  IMAGE_TARGET_RAW_SIZE,
} from '../constants/apiLimits.js'
import { logEvent } from '../services/analytics/index.js'
import {
  type CompressedImageResult,
  createCompressedImageResult,
  createUltraCompressedJPEG,
  type ImageCompressionContext,
  tryJPEGConversion,
  tryPalettePNG,
  tryProgressiveResizing,
} from './imageCompressionStrategies.js'
import {
  createImageMetadataText,
  detectImageFormatFromBase64,
  detectImageFormatFromBuffer,
  type ImageMediaType,
} from './imageFormatHelpers.js'
import { getImageProcessor, type SharpFunction } from '../tools/FileReadTool/imageProcessor.js'
import type { ImageDimensions } from '../types/inputContent.js'
export type { ImageDimensions } from '../types/inputContent.js'
import type { ImageBlock, ImageSource } from '../types/llm.js'
import { logForDebugging } from './debug.js'
import { errorMessage } from './errors.js'
import { formatFileSize } from './format.js'
import { logError } from './log.js'

// Error type constants for analytics (numeric to comply with logEvent restrictions)
const ERROR_TYPE_MODULE_LOAD = 1
const ERROR_TYPE_PROCESSING = 2
const ERROR_TYPE_UNKNOWN = 3
const ERROR_TYPE_PIXEL_LIMIT = 4
const ERROR_TYPE_MEMORY = 5
const ERROR_TYPE_TIMEOUT = 6
const ERROR_TYPE_VIPS = 7
const ERROR_TYPE_PERMISSION = 8

/**
 * Error thrown when image resizing fails and the image exceeds the API limit.
 */
export class ImageResizeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImageResizeError'
  }
}

/**
 * Classifies image processing errors for analytics.
 *
 * Uses error codes when available (Node.js module errors), falls back to
 * message matching for libraries like sharp that don't expose error codes.
 */
function classifyImageError(error: unknown): number {
  // Check for Node.js error codes first (more reliable than string matching)
  if (error instanceof Error) {
    const errorWithCode = error as Error & { code?: string }
    if (
      errorWithCode.code === 'MODULE_NOT_FOUND' ||
      errorWithCode.code === 'ERR_MODULE_NOT_FOUND' ||
      errorWithCode.code === 'ERR_DLOPEN_FAILED'
    ) {
      return ERROR_TYPE_MODULE_LOAD
    }
    if (errorWithCode.code === 'EACCES' || errorWithCode.code === 'EPERM') {
      return ERROR_TYPE_PERMISSION
    }
    if (errorWithCode.code === 'ENOMEM') {
      return ERROR_TYPE_MEMORY
    }
  }

  // Fall back to message matching for errors without codes
  // Note: sharp doesn't expose error codes, so we must match on messages
  const message = errorMessage(error)

  // Module loading errors from our native wrapper
  if (message.includes('Native image processor module not available')) {
    return ERROR_TYPE_MODULE_LOAD
  }

  // Sharp/vips processing errors (format detection, corrupt data, etc.)
  if (
    message.includes('unsupported image format') ||
    message.includes('Input buffer') ||
    message.includes('Input file is missing') ||
    message.includes('Input file has corrupt header') ||
    message.includes('corrupt header') ||
    message.includes('corrupt image') ||
    message.includes('premature end') ||
    message.includes('zlib: data error') ||
    message.includes('zero width') ||
    message.includes('zero height')
  ) {
    return ERROR_TYPE_PROCESSING
  }

  // Pixel/dimension limit errors from sharp/vips
  if (
    message.includes('pixel limit') ||
    message.includes('too many pixels') ||
    message.includes('exceeds pixel') ||
    message.includes('image dimensions')
  ) {
    return ERROR_TYPE_PIXEL_LIMIT
  }

  // Memory allocation failures
  if (
    message.includes('out of memory') ||
    message.includes('Cannot allocate') ||
    message.includes('memory allocation')
  ) {
    return ERROR_TYPE_MEMORY
  }

  // Timeout errors
  if (message.includes('timeout') || message.includes('timed out')) {
    return ERROR_TYPE_TIMEOUT
  }

  // Vips-specific errors (VipsJpeg, VipsPng, VipsWebp, etc.)
  if (message.includes('Vips')) {
    return ERROR_TYPE_VIPS
  }

  return ERROR_TYPE_UNKNOWN
}

/**
 * Computes a simple numeric hash of a string for analytics grouping.
 * Uses djb2 algorithm, returning a 32-bit unsigned integer.
 */
function hashString(str: string): number {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0
  }
  return hash >>> 0
}

export interface ResizeResult {
  buffer: Buffer
  mediaType: string
  dimensions?: ImageDimensions
}

/**
 * Extracted from FileReadTool's readImage function
 * Resizes image buffer to meet size and dimension constraints
 */
export async function maybeResizeAndDownsampleImageBuffer(
  imageBuffer: Buffer,
  originalSize: number,
  ext: string,
): Promise<ResizeResult> {
  if (imageBuffer.length === 0) {
    // Empty buffer would fall through the catch block below (sharp throws
    // "Unable to determine image format"), and the fallback's size check
    // `0 ≤ 5MB` would pass it through, yielding an empty base64 string
    // that the API rejects with `image cannot be empty`.
    throw new ImageResizeError('Image file is empty (0 bytes)')
  }
  try {
    const sharp = await getImageProcessor()
    const image = sharp(imageBuffer)
    const metadata = await image.metadata()

    const mediaType = metadata.format ?? ext
    // Normalize "jpg" to "jpeg" for media type compatibility
    const normalizedMediaType = mediaType === 'jpg' ? 'jpeg' : mediaType

    // If dimensions aren't available from metadata
    if (!metadata.width || !metadata.height) {
      if (originalSize > IMAGE_TARGET_RAW_SIZE) {
        // Create fresh sharp instance for compression
        const compressedBuffer = await sharp(imageBuffer).jpeg({ quality: 80 }).toBuffer()
        return { buffer: compressedBuffer, mediaType: 'jpeg' }
      }
      // Return without dimensions if we can't determine them
      return { buffer: imageBuffer, mediaType: normalizedMediaType }
    }

    // Store original dimensions (guaranteed to be defined here)
    const originalWidth = metadata.width
    const originalHeight = metadata.height

    // Calculate dimensions while maintaining aspect ratio
    let width = originalWidth
    let height = originalHeight

    // Check if the original file just works
    if (
      originalSize <= IMAGE_TARGET_RAW_SIZE &&
      width <= IMAGE_MAX_WIDTH &&
      height <= IMAGE_MAX_HEIGHT
    ) {
      return {
        buffer: imageBuffer,
        mediaType: normalizedMediaType,
        dimensions: {
          originalWidth,
          originalHeight,
          displayWidth: width,
          displayHeight: height,
        },
      }
    }

    const needsDimensionResize = width > IMAGE_MAX_WIDTH || height > IMAGE_MAX_HEIGHT
    const isPng = normalizedMediaType === 'png'

    // If dimensions are within limits but file is too large, try compression first
    // This preserves full resolution when possible
    if (!needsDimensionResize && originalSize > IMAGE_TARGET_RAW_SIZE) {
      // For PNGs, try PNG compression first to preserve transparency
      if (isPng) {
        // Create fresh sharp instance for each compression attempt
        const pngCompressed = await sharp(imageBuffer)
          .png({ compressionLevel: 9, palette: true })
          .toBuffer()
        if (pngCompressed.length <= IMAGE_TARGET_RAW_SIZE) {
          return {
            buffer: pngCompressed,
            mediaType: 'png',
            dimensions: {
              originalWidth,
              originalHeight,
              displayWidth: width,
              displayHeight: height,
            },
          }
        }
      }
      // Try JPEG compression (lossy but much smaller)
      for (const quality of [80, 60, 40, 20]) {
        // Create fresh sharp instance for each attempt
        const compressedBuffer = await sharp(imageBuffer).jpeg({ quality }).toBuffer()
        if (compressedBuffer.length <= IMAGE_TARGET_RAW_SIZE) {
          return {
            buffer: compressedBuffer,
            mediaType: 'jpeg',
            dimensions: {
              originalWidth,
              originalHeight,
              displayWidth: width,
              displayHeight: height,
            },
          }
        }
      }
      // Quality reduction alone wasn't enough, fall through to resize
    }

    // Constrain dimensions if needed
    if (width > IMAGE_MAX_WIDTH) {
      height = Math.round((height * IMAGE_MAX_WIDTH) / width)
      width = IMAGE_MAX_WIDTH
    }

    if (height > IMAGE_MAX_HEIGHT) {
      width = Math.round((width * IMAGE_MAX_HEIGHT) / height)
      height = IMAGE_MAX_HEIGHT
    }

    // IMPORTANT: Always create fresh sharp(imageBuffer) instances for each operation.
    // The native image-processor-napi module doesn't properly apply format conversions
    // when reusing a sharp instance after calling toBuffer(). This caused a bug where
    // all compression attempts (PNG, JPEG at various qualities) returned identical sizes.
    logForDebugging(`Resizing to ${width}x${height}`)
    const resizedImageBuffer = await sharp(imageBuffer)
      .resize(width, height, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .toBuffer()

    // If still too large after resize, try compression
    if (resizedImageBuffer.length > IMAGE_TARGET_RAW_SIZE) {
      // For PNGs, try PNG compression first to preserve transparency
      if (isPng) {
        const pngCompressed = await sharp(imageBuffer)
          .resize(width, height, {
            fit: 'inside',
            withoutEnlargement: true,
          })
          .png({ compressionLevel: 9, palette: true })
          .toBuffer()
        if (pngCompressed.length <= IMAGE_TARGET_RAW_SIZE) {
          return {
            buffer: pngCompressed,
            mediaType: 'png',
            dimensions: {
              originalWidth,
              originalHeight,
              displayWidth: width,
              displayHeight: height,
            },
          }
        }
      }

      // Try JPEG with progressively lower quality
      for (const quality of [80, 60, 40, 20]) {
        const compressedBuffer = await sharp(imageBuffer)
          .resize(width, height, {
            fit: 'inside',
            withoutEnlargement: true,
          })
          .jpeg({ quality })
          .toBuffer()
        if (compressedBuffer.length <= IMAGE_TARGET_RAW_SIZE) {
          return {
            buffer: compressedBuffer,
            mediaType: 'jpeg',
            dimensions: {
              originalWidth,
              originalHeight,
              displayWidth: width,
              displayHeight: height,
            },
          }
        }
      }
      // If still too large, resize smaller and compress aggressively
      const smallerWidth = Math.min(width, 1000)
      const smallerHeight = Math.round((height * smallerWidth) / Math.max(width, 1))
      logForDebugging('Still too large, compressing with JPEG')
      const compressedBuffer = await sharp(imageBuffer)
        .resize(smallerWidth, smallerHeight, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: 20 })
        .toBuffer()
      logForDebugging(`JPEG compressed buffer size: ${compressedBuffer.length}`)
      return {
        buffer: compressedBuffer,
        mediaType: 'jpeg',
        dimensions: {
          originalWidth,
          originalHeight,
          displayWidth: smallerWidth,
          displayHeight: smallerHeight,
        },
      }
    }

    return {
      buffer: resizedImageBuffer,
      mediaType: normalizedMediaType,
      dimensions: {
        originalWidth,
        originalHeight,
        displayWidth: width,
        displayHeight: height,
      },
    }
  } catch (error) {
    // Log the error and emit analytics event
    logError(error as Error)
    const errorType = classifyImageError(error)
    const errorMsg = errorMessage(error)
    logEvent('zy_image_resize_failed', {
      original_size_bytes: originalSize,
      error_type: errorType,
      error_message_hash: hashString(errorMsg),
    })

    // Detect actual format from magic bytes instead of trusting extension
    const detected = detectImageFormatFromBuffer(imageBuffer)
    const normalizedExt = detected.slice(6) // Remove 'image/' prefix

    // Calculate the base64 size (API limit is on base64-encoded length)
    const base64Size = Math.ceil((originalSize * 4) / 3)

    // Size-under-5MB does not imply dimensions-under-cap. Don't return the
    // raw buffer if the PNG header says it's oversized — fall through to
    // ImageResizeError instead. PNG sig is 8 bytes, IHDR dims at 16-24.
    const overDim =
      imageBuffer.length >= 24 &&
      imageBuffer[0] === 0x89 &&
      imageBuffer[1] === 0x50 &&
      imageBuffer[2] === 0x4e &&
      imageBuffer[3] === 0x47 &&
      (imageBuffer.readUInt32BE(16) > IMAGE_MAX_WIDTH ||
        imageBuffer.readUInt32BE(20) > IMAGE_MAX_HEIGHT)

    // If original image's base64 encoding is within API limit, allow it through uncompressed
    if (base64Size <= API_IMAGE_MAX_BASE64_SIZE && !overDim) {
      logEvent('zy_image_resize_fallback', {
        original_size_bytes: originalSize,
        base64_size_bytes: base64Size,
        error_type: errorType,
      })
      return { buffer: imageBuffer, mediaType: normalizedExt }
    }

    // Image is too large and we failed to compress it - fail with user-friendly error
    throw new ImageResizeError(
      overDim
        ? `Unable to resize image — dimensions exceed the ${IMAGE_MAX_WIDTH}x${IMAGE_MAX_HEIGHT}px limit and image processing failed. ` +
            `Please resize the image to reduce its pixel dimensions.`
        : `Unable to resize image (${formatFileSize(originalSize)} raw, ${formatFileSize(base64Size)} base64). ` +
            `The image exceeds the 5MB API limit and compression failed. ` +
            `Please resize the image manually or use a smaller image.`,
    )
  }
}

export interface ImageBlockWithDimensions {
  block: ImageBlock
  dimensions?: ImageDimensions
}

/**
 * Resizes an image content block if needed
 * Takes an image ImageBlock and returns a resized version if necessary
 * Also returns dimension information for coordinate mapping
 */
export async function maybeResizeAndDownsampleImageBlock(
  imageBlock: ImageBlock,
): Promise<ImageBlockWithDimensions> {
  // Decode base64 to buffer
  const imageBuffer = Buffer.from(imageBlock.data, 'base64')
  const originalSize = imageBuffer.length

  // Extract extension from media type
  const mediaType = imageBlock.mimeType
  const ext = mediaType?.split('/')[1] || 'png'

  // Resize if needed
  const resized = await maybeResizeAndDownsampleImageBuffer(imageBuffer, originalSize, ext)

  // Return resized image block with dimension info
  return {
    block: {
      type: 'image',
      mimeType: `image/${resized.mediaType}` as ImageSource['mediaType'],
      data: resized.buffer.toString('base64'),
    },
    dimensions: resized.dimensions,
  }
}

/**
 * Compresses an image buffer to fit within a maximum byte size.
 *
 * Uses a multi-strategy fallback approach because simple compression often fails for
 * large screenshots, high-resolution photos, or images with complex gradients. Each
 * strategy is progressively more aggressive to handle edge cases where earlier
 * strategies produce files still exceeding the size limit.
 *
 * Strategy (from FileReadTool):
 * 1. Try to preserve original format (PNG, JPEG, WebP) with progressive resizing
 * 2. For PNG: Use palette optimization and color reduction if needed
 * 3. Last resort: Convert to JPEG with aggressive compression
 *
 * This ensures images fit within context windows while maintaining format when possible.
 */
export async function compressImageBuffer(
  imageBuffer: Buffer,
  maxBytes: number = IMAGE_TARGET_RAW_SIZE,
  originalMediaType?: string,
): Promise<CompressedImageResult> {
  // Extract format from originalMediaType if provided (e.g., "image/png" -> "png")
  const fallbackFormat = originalMediaType?.split('/')[1] || 'jpeg'
  const normalizedFallback = fallbackFormat === 'jpg' ? 'jpeg' : fallbackFormat

  try {
    const sharp = await getImageProcessor()
    const metadata = await sharp(imageBuffer).metadata()
    const format = metadata.format || normalizedFallback
    const originalSize = imageBuffer.length

    const context: ImageCompressionContext = {
      imageBuffer,
      metadata,
      format,
      maxBytes,
      originalSize,
    }

    // If image is already within size limit, return as-is without processing
    if (originalSize <= maxBytes) {
      return createCompressedImageResult(imageBuffer, format, originalSize)
    }

    // Try progressive resizing with format preservation
    const resizedResult = await tryProgressiveResizing(context, sharp)
    if (resizedResult) {
      return resizedResult
    }

    // For PNG, try palette optimization
    if (format === 'png') {
      const palettizedResult = await tryPalettePNG(context, sharp)
      if (palettizedResult) {
        return palettizedResult
      }
    }

    // Try JPEG conversion with moderate compression
    const jpegResult = await tryJPEGConversion(context, 50, sharp)
    if (jpegResult) {
      return jpegResult
    }

    // Last resort: ultra-compressed JPEG
    return await createUltraCompressedJPEG(context, sharp)
  } catch (error) {
    // Log the error and emit analytics event
    logError(error as Error)
    const errorType = classifyImageError(error)
    const errorMsg = errorMessage(error)
    logEvent('zy_image_compress_failed', {
      original_size_bytes: imageBuffer.length,
      max_bytes: maxBytes,
      error_type: errorType,
      error_message_hash: hashString(errorMsg),
    })

    // If original image is within the requested limit, allow it through
    if (imageBuffer.length <= maxBytes) {
      // Detect actual format from magic bytes instead of trusting the provided media type
      const detected = detectImageFormatFromBuffer(imageBuffer)
      return {
        base64: imageBuffer.toString('base64'),
        mediaType: detected,
        originalSize: imageBuffer.length,
      }
    }

    // Image is too large and compression failed - throw error
    throw new ImageResizeError(
      `Unable to compress image (${formatFileSize(imageBuffer.length)}) to fit within ${formatFileSize(maxBytes)}. ` +
        `Please use a smaller image.`,
    )
  }
}

/**
 * Compresses an image buffer to fit within a token limit.
 * Converts tokens to bytes using the formula: maxBytes = (maxTokens / 0.125) * 0.75
 */
export async function compressImageBufferWithTokenLimit(
  imageBuffer: Buffer,
  maxTokens: number,
  originalMediaType?: string,
): Promise<CompressedImageResult> {
  // Convert token limit to byte limit
  // base64 uses about 4/3 the original size, so we reverse this
  const maxBase64Chars = Math.floor(maxTokens / 0.125)
  const maxBytes = Math.floor(maxBase64Chars * 0.75)

  return compressImageBuffer(imageBuffer, maxBytes, originalMediaType)
}

/**
 * Compresses an image block to fit within a maximum byte size.
 * Wrapper around compressImageBuffer for ImageBlock.
 */
export async function compressImageBlock(
  imageBlock: ImageBlock,
  maxBytes: number = IMAGE_TARGET_RAW_SIZE,
): Promise<ImageBlock> {
  // Decode base64 to buffer
  const imageBuffer = Buffer.from(imageBlock.data, 'base64')

  // Check if already within size limit
  if (imageBuffer.length <= maxBytes) {
    return imageBlock
  }

  // Compress the image
  const compressed = await compressImageBuffer(imageBuffer, maxBytes)

  return {
    type: 'image',
    mimeType: compressed.mediaType,
    data: compressed.base64,
  }
}

export { createImageMetadataText, detectImageFormatFromBase64, detectImageFormatFromBuffer }
