/**
 * Detects rate limit messages from Claude.
 */

const RATE_LIMIT_SUBSTRING = "You've hit your limit";

/**
 * Returns true if the message text contains the rate limit indicator.
 */
export function isRateLimitMessage(text: string): boolean {
  return text.includes(RATE_LIMIT_SUBSTRING);
}
