/**
 * TriggerMatcher service - Pattern matching utilities for trigger checking.
 *
 * Provides utilities for:
 * - Regex pattern matching (with ReDoS protection)
 * - Ignore pattern checking
 * - Extracting fields from tool_use blocks
 * - Getting content blocks from messages
 */

import { type ContentBlock, type ParsedMessage } from '@main/types';
import { createSafeRegExp } from '@main/utils/regexValidation';

// =============================================================================
// Pattern Matching
// =============================================================================

/**
 * Checks if content matches a pattern.
 * Uses validated regex to prevent ReDoS attacks.
 */
export function matchesPattern(content: string, pattern: string): boolean {
  const regex = createSafeRegExp(pattern, 'i');
  if (!regex) {
    // Pattern is invalid or potentially dangerous, reject match
    return false;
  }
  return regex.test(content);
}

/**
 * Checks if content matches any of the ignore patterns.
 * Uses validated regex to prevent ReDoS attacks.
 */
export function matchesIgnorePatterns(content: string, ignorePatterns?: string[]): boolean {
  if (!ignorePatterns || ignorePatterns.length === 0) {
    return false;
  }

  for (const pattern of ignorePatterns) {
    const regex = createSafeRegExp(pattern, 'i');
    if (regex?.test(content)) {
      return true;
    }
    // Invalid or potentially dangerous patterns are skipped
  }

  return false;
}

// =============================================================================
// Field Extraction
// =============================================================================

/**
 * Extracts the specified field from a tool_use block.
 */
export function extractToolUseField(
  toolUse: { name: string; input?: Record<string, unknown> },
  matchField?: string
): string | null {
  if (!matchField || !toolUse.input) return null;

  const value = toolUse.input[matchField];
  if (typeof value === 'string') {
    return value;
  }
  if (value !== undefined) {
    return JSON.stringify(value);
  }
  return null;
}

/**
 * Gets content blocks from a message, handling both array and object formats.
 */
export function getContentBlocks(message: ParsedMessage): ContentBlock[] {
  if (Array.isArray(message.content)) {
    return message.content;
  }
  return [];
}
