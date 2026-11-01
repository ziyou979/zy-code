/** 输入能力声明保留具体 MIME；通用类别仍用于未细分格式的模型。 */
export const MODEL_INPUT_MODALITIES = ['text', 'image', 'document'] as const
export type ModelInputModality = (typeof MODEL_INPUT_MODALITIES)[number] | `${string}/${string}`

export function isModelInputModality(value: unknown): value is ModelInputModality {
  return (
    typeof value === 'string' &&
    (value === 'text' ||
      value === 'image' ||
      value === 'document' ||
      (value.length <= 255 && /^[A-Za-z0-9!#$&^_.+\-]+\/[A-Za-z0-9!#$&^_.+\-]+$/.test(value)))
  )
}

export function isImageInput(value: ModelInputModality): boolean {
  return value === 'image' || value.toLowerCase().startsWith('image/')
}

/** MIME 精确匹配；宽泛类别只覆盖同类附件，不把任意 application/* 当成文档。 */
export function acceptsModelInput(
  supported: readonly ModelInputModality[],
  actual: ModelInputModality,
): boolean {
  const normalized = actual.toLowerCase()
  return supported.some(
    (value) =>
      value.toLowerCase() === normalized ||
      (value === 'image' && isImageInput(actual)) ||
      (value === 'document' && normalized === 'application/pdf') ||
      (value === 'text' && normalized.startsWith('text/')),
  )
}
