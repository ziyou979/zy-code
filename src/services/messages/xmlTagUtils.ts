export const XML_TAG_BLOCK_PATTERN = /<[^>]+>/g

export function stripDisplayTags(text: string): string {
  return text.replace(XML_TAG_BLOCK_PATTERN, '').trim()
}

export function stripDisplayTagsAllowEmpty(text: string): string | undefined {
  const stripped = stripDisplayTags(text)
  return stripped || undefined
}

export const IDE_CONTEXT_TAGS_PATTERN =
  /<context_file>[\s\S]*?<\/context_file>|<context_model>[\s\S]*?<\/context_model>|<context_query>[\s\S]*?<\/context_query>/g

export function stripIdeContextTags(text: string): string {
  return text.replace(IDE_CONTEXT_TAGS_PATTERN, '').trim()
}
