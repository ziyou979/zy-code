import { getLocalMonthYear } from '../../constants/common.js'


export const WEB_SEARCH_TOOL_NAME = 'WebSearch'

export function getWebSearchPrompt(): string {
  const currentMonthYear = getLocalMonthYear()
  return `
- Allows ZY code to search the web and use the results to inform responses
- Provides up-to-date information for current events and recent data
- Returns search result information formatted as search result blocks, including links as markdown hyperlinks
- Use this tool for accessing information beyond the AI's knowledge cutoff
- Searches are performed automatically by ZY Code using the configured search service

CRITICAL REQUIREMENT - You MUST follow this:
  - After answering the user's question, you MUST include a sources section at the end of your response
  - In the sources section, list all relevant URLs from the search results as markdown hyperlinks: [Title](URL)
  - This is MANDATORY - never skip including sources in your response
  - The heading text for the sources section should match the language of your response: use "Sources:" for English, "来源：" for Chinese, and an appropriate equivalent for other languages
  - Example format (English):

    [Your answer here]

    Sources:
    - [Source Title 1](https://example.com/1)
    - [Source Title 2](https://example.com/2)

Usage notes:
  - If the search result snippets already contain the information needed to answer the user's question, use them directly. Do NOT call WebFetch merely to verify or expand on information already present in the snippets.
  - Domain filtering is supported to include or block specific websites via allowed_domains and blocked_domains parameters
  - Search results include title, URL, and optionally a snippet/summary
  - A single search returns up to 8 results

IMPORTANT - Use the correct year in search queries:
  - The current month is ${currentMonthYear}. You MUST use this year when searching for recent information, documentation, or current events.
  - Example: If the user asks for "latest React docs", search for "React documentation" with the current year, NOT last year
`
}
