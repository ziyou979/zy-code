/**
 * ZY Code API 限制。
 *
 * 这些常量定义 API 强制执行的服务端限制。
 * 本文件保持零依赖，以免产生循环导入。
 *
 * 最后核对：2025-12-22
 * 来源：api/api/schemas/messages/blocks/ 与 api/api/config.py
 *
 * 后续计划：从服务端动态获取限制，参见 issue #13240。
 */

// =============================================================================
// 图片限制
// =============================================================================

/**
 * Base64 编码后图片的最大尺寸（由 API 强制执行）。
 * Base64 字符串长度超过此值时，API 会拒绝该图片。
 * 注意：这里限制的是 Base64 长度，不是原始字节数；Base64 会使体积增加约 33%。
 */
export const API_IMAGE_MAX_BASE64_SIZE = 5 * 1024 * 1024 // 5 MB

/**
 * 为保证编码后不超过 Base64 限制，原始图片采用此目标尺寸。
 * Base64 编码会把体积扩大为 4/3，因此最大原始尺寸推导如下：
 * raw_size * 4/3 = base64_size → raw_size = base64_size * 3/4
 */
export const IMAGE_TARGET_RAW_SIZE = (API_IMAGE_MAX_BASE64_SIZE * 3) / 4 // 3.75 MB

/**
 * 客户端调整图片尺寸时使用的最大宽高。
 *
 * 注意：API 会在服务端调整超过 1568px 的图片（来源：encoding/full_encoding.py），
 * 此过程不会报错。客户端采用略大的 2000px 限制，以便在适合时保留更多画质。
 *
 * API_IMAGE_MAX_BASE64_SIZE（5MB）才是实际硬限制，超过后 API 会报错。
 */
export const IMAGE_MAX_WIDTH = 2000
export const IMAGE_MAX_HEIGHT = 2000

// =============================================================================
// PDF 限制
// =============================================================================

/**
 * 编码后仍能满足 API 请求限制的 PDF 原始文件最大尺寸。
 * API 的请求总尺寸上限为 32MB。Base64 编码会增加约 33%（4/3），因此 20MB
 * 原始文件约为 27MB Base64 数据，可为会话上下文预留空间。
 */
export const PDF_TARGET_RAW_SIZE = 20 * 1024 * 1024 // 20 MB

/**
 * API 接受的 PDF 最大页数。
 */
export const API_PDF_MAX_PAGES = 100

/**
 * PDF 超过此尺寸后会提取为逐页图片，不再作为 Base64 文档块发送。
 * 该阈值只适用于直连 API；非直连 API 始终采用提取流程。
 */
export const PDF_EXTRACT_SIZE_THRESHOLD = 3 * 1024 * 1024 // 3 MB

/**
 * 逐页提取流程允许的 PDF 最大尺寸。超过此值会被拒绝，以免处理超大文件。
 */
export const PDF_MAX_EXTRACT_SIZE = 100 * 1024 * 1024 // 100 MB

/**
 * Read 工具通过 pages 参数单次最多提取的页数。
 */
export const PDF_MAX_PAGES_PER_READ = 20

/**
 * 通过 @ 提及超过此页数的 PDF 时，将按引用处理，不会内联到上下文中。
 */
export const PDF_AT_MENTION_INLINE_THRESHOLD = 10

// =============================================================================
// 媒体数量限制
// =============================================================================

/**
 * 每个 API 请求允许的媒体项（图片与 PDF）最大数量。
 * API 会用含义不清的错误拒绝超限请求，因此在客户端先行校验并给出明确提示。
 */
export const API_MAX_MEDIA_PER_REQUEST = 100
