import { describe, expect, test } from 'bun:test'
import { categorizeAgentError } from '../../src/utils/agentErrorCategorizer.js'

describe('categorizeAgentError', () => {
  test('usage_limit: API usage limit exceeded', () => {
    expect(categorizeAgentError(new Error('This request would exceed your usage limit'))).toBe(
      'usage_limit',
    )
    expect(categorizeAgentError(new Error('billing has been suspended'))).toBe('usage_limit')
    expect(categorizeAgentError(new Error('insufficient_quota'))).toBe('usage_limit')
    expect(categorizeAgentError(new Error('quota exceeded'))).toBe('usage_limit')
  })

  test('rate_limited: 429 rate limit', () => {
    expect(categorizeAgentError(new Error('Rate limit exceeded'))).toBe('rate_limited')
    expect(categorizeAgentError(new Error('429 Too Many Requests'))).toBe('rate_limited')
    expect(categorizeAgentError(new Error('rate_limit: too many requests'))).toBe('rate_limited')
  })

  test('server_error: 5xx / overloaded', () => {
    expect(categorizeAgentError(new Error('529 Service Overloaded'))).toBe('server_error')
    expect(categorizeAgentError(new Error('overloaded_server_error'))).toBe('server_error')
    expect(categorizeAgentError(new Error('502 Bad Gateway'))).toBe('server_error')
    expect(categorizeAgentError(new Error('503 Service Unavailable'))).toBe('server_error')
    expect(categorizeAgentError(new Error('504 Gateway Timeout'))).toBe('server_error')
    expect(categorizeAgentError(new Error('5xx server error'))).toBe('server_error')
    expect(categorizeAgentError(new Error('internal_server_error'))).toBe('server_error')
    expect(categorizeAgentError(new Error('service_unavailable'))).toBe('server_error')
  })

  test('refusal: model refusal / safety filter', () => {
    expect(categorizeAgentError(new Error('This request was refused'))).toBe('refusal')
    expect(categorizeAgentError(new Error('Safety check failed'))).toBe('refusal')
    expect(categorizeAgentError(new Error('harmful content detected'))).toBe('refusal')
    expect(categorizeAgentError(new Error('content_filter triggered'))).toBe('refusal')
  })

  test('stream_failure: stream / timeout / connection error', () => {
    expect(categorizeAgentError(new Error('Stream connection closed'))).toBe('stream_failure')
    expect(categorizeAgentError(new Error('watchdog timeout'))).toBe('stream_failure')
    expect(categorizeAgentError(new Error('socket hang up'))).toBe('stream_failure')
    expect(categorizeAgentError(new Error('Connection reset by peer'))).toBe('stream_failure')
    expect(categorizeAgentError(new Error('network error'))).toBe('stream_failure')
    expect(categorizeAgentError(new Error('eof during stream'))).toBe('stream_failure')
  })

  test('internal: unrecognized errors', () => {
    expect(categorizeAgentError(new Error('Something unexpected happened'))).toBe('internal')
    expect(categorizeAgentError(new Error('TypeError: Cannot read property'))).toBe('internal')
    expect(categorizeAgentError(new Error('Unknown error'))).toBe('internal')
  })

  test('undefined returns internal', () => {
    expect(categorizeAgentError(undefined)).toBe('internal')
  })

  test('string error returns internal', () => {
    expect(categorizeAgentError('something broke')).toBe('internal')
  })

  test('null error returns internal', () => {
    expect(categorizeAgentError(null)).toBe('internal')
  })

  test('case insensitive matching', () => {
    expect(categorizeAgentError(new Error('USAGE LIMIT'))).toBe('usage_limit')
    expect(categorizeAgentError(new Error('Rate LIMIT'))).toBe('rate_limited')
    expect(categorizeAgentError(new Error('SERVER ERROR'))).toBe('server_error')
    expect(categorizeAgentError(new Error('STREAM FAILURE'))).toBe('stream_failure')
  })
})
