/**
 * XML / 标签剥离工具纯函数。
 *
 * 从 displayTags.ts 提取。纯正则/字符串操作，无 IO 无副作用。
 */

/** 匹配 XML 标签块的全局正则。 */
export const XML_TAG_BLOCK_PATTERN = /<[^>]+>/g

/**
 * Strip all XML/HTML tags from a string.
 */
export function stripDisplayTags(text: string): string {
  return text.replace(XML_TAG_BLOCK_PATTERN, '').trim()
}

/**
 * Strip XML/HTML tags, returning undefined if the result is empty.
 */
export function stripDisplayTagsAllowEmpty(text: string): string | undefined {
  const stripped = stripDisplayTags(text)
  return stripped || undefined
}

/** 匹配 IDE 上下文标签的全局正则。 */
export const IDE_CONTEXT_TAGS_PATTERN = /<context_file>[\s\S]*?<\/context_file>|<context_model>[\s\S]*?<\/context_model>|<context_query>[\s\S]*?<\/context_query>/g

/**
 * Strip IDE context tags from a string.
 */
export function stripIdeContextTags(text: string): string {
  return text.replace(IDE_CONTEXT_TAGS_PATTERN, '').trim()
}
