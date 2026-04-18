/**
 * Build-time macros injected by esbuild's `define` config.
 * These are replaced at bundle time with literal values.
 * See build.ts for the actual values.
 */
declare const MACRO: {
  readonly VERSION: string
  readonly BUILD_TIME: string
  readonly PACKAGE_URL: string
  readonly NATIVE_PACKAGE_URL: string | null
  readonly FEEDBACK_CHANNEL: string
  readonly ISSUES_EXPLAINER: string
  readonly VERSION_CHANGELOG: string
}
