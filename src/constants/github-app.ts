export const PR_TITLE = 'Add ZY Code GitHub Workflow'

export const GITHUB_ACTION_SETUP_DOCS_URL =
  'https://github.com/zy-ai/zy-code-action/blob/main/docs/setup.md'

export const WORKFLOW_CONTENT = `name: ZY Code

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  issues:
    types: [opened, assigned]
  pull_request_review:
    types: [submitted]

jobs:
  zy:
    if: |
      (github.event_name == 'issue_comment' && contains(github.event.comment.body, '@zy')) ||
      (github.event_name == 'pull_request_review_comment' && contains(github.event.comment.body, '@zy')) ||
      (github.event_name == 'pull_request_review' && contains(github.event.review.body, '@zy')) ||
      (github.event_name == 'issues' && (contains(github.event.issue.body, '@zy') || contains(github.event.issue.title, '@zy')))
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
      issues: read
      id-token: write
      actions: read # Required for Zy to read CI results on PRs
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 1

      - name: Run ZY Code
        id: zy
        uses: zy-ai/zy-code-action@v1
        with:
          zy_code_api_key: \${{ secrets.ZY_CODE_API_KEY }}

          # This is an optional setting that allows Zy to read CI results on PRs
          additional_permissions: |
            actions: read

          # Optional: Give a custom prompt to ZY. If this is not specified, ZY will perform the instructions specified in the comment that tagged it.
          # prompt: 'Update the pull request description to include a summary of changes.'

          # Optional: Add zy_args to customize behavior and configuration
          # See https://github.com/zy-ai/zy-code-action/blob/main/docs/usage.md
          # or https://code.zy.com/docs/en/cli-reference for available options
          # zy_args: '--allowed-tools Bash(gh pr:*)'

`

export const PR_BODY = `## 🤖 Installing ZY Code GitHub App

This PR adds a GitHub Actions workflow that enables ZY Code integration in our repository.

### What is ZY Code?

[ZY Code](https://zy.com/zy-code) is an AI coding agent that can help with:
- Bug fixes and improvements  
- Documentation updates
- Implementing new features
- Code reviews and suggestions
- Writing tests
- And more!

### How it works

Once this PR is merged, we'll be able to interact with Zy by mentioning @zy in a pull request or issue comment.
Once the workflow is triggered, Zy will analyze the comment and surrounding context, and execute on the request in a GitHub action.

### Important Notes

- **This workflow won't take effect until this PR is merged**
- **@zy mentions won't work until after the merge is complete**
- The workflow runs automatically whenever Zy is mentioned in PR or issue comments
- Zy gets access to the entire PR or issue context including files, diffs, and previous comments

### Security

- Our API key is securely stored as a GitHub Actions secret
- Only users with write access to the repository can trigger the workflow
- All Zy runs are stored in the GitHub Actions run history
- Zy's default tools are limited to reading/writing files and interacting with our repo by creating comments, branches, and commits.
- We can add more allowed tools by adding them to the workflow file like:

\`\`\`
allowed_tools: Bash(npm install),Bash(npm run build),Bash(npm run lint),Bash(npm run test)
\`\`\`

There's more information in the [Zy Code action repo](https://github.com/zy-ai/zy-code-action).

After merging this PR, let's try mentioning @zy in a comment on any PR to get started!`

export const CODE_REVIEW_PLUGIN_WORKFLOW_CONTENT = `name: ZY Code Review

on:
  pull_request:
    types: [opened, synchronize, ready_for_review, reopened]
    # Optional: Only run on specific file changes
    # paths:
    #   - "src/**/*.ts"
    #   - "src/**/*.tsx"
    #   - "src/**/*.js"
    #   - "src/**/*.jsx"

jobs:
  zy-review:
    # Optional: Filter by PR author
    # if: |
    #   github.event.pull_request.user.login == 'external-contributor' ||
    #   github.event.pull_request.user.login == 'new-developer' ||
    #   github.event.pull_request.author_association == 'FIRST_TIME_CONTRIBUTOR'

    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
      issues: read
      id-token: write

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 1

      - name: Run ZY Code Review
        id: zy-review
        uses: zy-ai/zy-code-action@v1
        with:
          zy_code_api_key: \${{ secrets.ZY_CODE_API_KEY }}
          plugin_marketplaces: 'https://github.com/zy-ai/zy-code.git'
          plugins: 'code-review@zy-code-plugins'
          prompt: '/code-review:code-review \${{ github.repository }}/pull/\${{ github.event.pull_request.number }}'
          # See https://github.com/zy-ai/zy-code-action/blob/main/docs/usage.md
          # or https://code.zy.com/docs/en/cli-reference for available options

`
