import React from 'react';

// =============================================================================
// Syntax Highlighting (Basic Token-based)
// =============================================================================

// Basic keyword sets for common languages
const KEYWORDS: Record<string, Set<string>> = {
  typescript: new Set([
    'import',
    'export',
    'from',
    'const',
    'let',
    'var',
    'function',
    'class',
    'interface',
    'type',
    'enum',
    'return',
    'if',
    'else',
    'for',
    'while',
    'do',
    'switch',
    'case',
    'break',
    'continue',
    'try',
    'catch',
    'finally',
    'throw',
    'new',
    'this',
    'super',
    'extends',
    'implements',
    'async',
    'await',
    'public',
    'private',
    'protected',
    'static',
    'readonly',
    'abstract',
    'as',
    'typeof',
    'instanceof',
    'in',
    'of',
    'keyof',
    'void',
    'never',
    'unknown',
    'any',
    'null',
    'undefined',
    'true',
    'false',
    'default',
  ]),
  javascript: new Set([
    'import',
    'export',
    'from',
    'const',
    'let',
    'var',
    'function',
    'class',
    'return',
    'if',
    'else',
    'for',
    'while',
    'do',
    'switch',
    'case',
    'break',
    'continue',
    'try',
    'catch',
    'finally',
    'throw',
    'new',
    'this',
    'super',
    'extends',
    'async',
    'await',
    'typeof',
    'instanceof',
    'in',
    'of',
    'void',
    'null',
    'undefined',
    'true',
    'false',
    'default',
  ]),
  python: new Set([
    'import',
    'from',
    'as',
    'def',
    'class',
    'return',
    'if',
    'elif',
    'else',
    'for',
    'while',
    'break',
    'continue',
    'try',
    'except',
    'finally',
    'raise',
    'with',
    'as',
    'pass',
    'lambda',
    'yield',
    'global',
    'nonlocal',
    'assert',
    'and',
    'or',
    'not',
    'in',
    'is',
    'True',
    'False',
    'None',
    'async',
    'await',
    'self',
    'cls',
  ]),
  rust: new Set([
    'fn',
    'let',
    'mut',
    'const',
    'static',
    'struct',
    'enum',
    'impl',
    'trait',
    'pub',
    'mod',
    'use',
    'crate',
    'self',
    'super',
    'where',
    'for',
    'loop',
    'while',
    'if',
    'else',
    'match',
    'return',
    'break',
    'continue',
    'move',
    'ref',
    'as',
    'in',
    'unsafe',
    'async',
    'await',
    'dyn',
    'true',
    'false',
    'type',
    'extern',
  ]),
  go: new Set([
    'package',
    'import',
    'func',
    'var',
    'const',
    'type',
    'struct',
    'interface',
    'map',
    'chan',
    'go',
    'defer',
    'return',
    'if',
    'else',
    'for',
    'range',
    'switch',
    'case',
    'default',
    'break',
    'continue',
    'fallthrough',
    'select',
    'nil',
    'true',
    'false',
  ]),
};

// Extend tsx/jsx to use typescript/javascript keywords
KEYWORDS.tsx = KEYWORDS.typescript;
KEYWORDS.jsx = KEYWORDS.javascript;

/**
 * Very basic tokenization for syntax highlighting.
 * This is a simple approach without a full parser.
 */
export function highlightLine(line: string, language: string): React.ReactNode[] {
  const keywords = KEYWORDS[language] || new Set();

  // If no highlighting support, return plain text as single-element array
  if (keywords.size === 0 && !['json', 'css', 'html', 'bash', 'markdown'].includes(language)) {
    return [line];
  }

  const segments: React.ReactNode[] = [];
  let currentPos = 0;
  const lineLength = line.length;

  while (currentPos < lineLength) {
    const remaining = line.slice(currentPos);

    // Check for string (double quote)
    if (remaining.startsWith('"')) {
      const endQuote = remaining.indexOf('"', 1);
      if (endQuote !== -1) {
        const str = remaining.slice(0, endQuote + 1);
        segments.push(
          React.createElement(
            'span',
            { key: currentPos, style: { color: 'var(--syntax-string)' } },
            str
          )
        );
        currentPos += str.length;
        continue;
      }
    }

    // Check for string (single quote)
    if (remaining.startsWith("'")) {
      const endQuote = remaining.indexOf("'", 1);
      if (endQuote !== -1) {
        const str = remaining.slice(0, endQuote + 1);
        segments.push(
          React.createElement(
            'span',
            { key: currentPos, style: { color: 'var(--syntax-string)' } },
            str
          )
        );
        currentPos += str.length;
        continue;
      }
    }

    // Check for template literal (backtick)
    if (remaining.startsWith('`')) {
      const endQuote = remaining.indexOf('`', 1);
      if (endQuote !== -1) {
        const str = remaining.slice(0, endQuote + 1);
        segments.push(
          React.createElement(
            'span',
            { key: currentPos, style: { color: 'var(--syntax-string)' } },
            str
          )
        );
        currentPos += str.length;
        continue;
      }
    }

    // Check for comment (// style)
    if (remaining.startsWith('//')) {
      segments.push(
        React.createElement(
          'span',
          { key: currentPos, style: { color: 'var(--syntax-comment)', fontStyle: 'italic' } },
          remaining
        )
      );
      break;
    }

    // Check for comment (# style for Python/Shell)
    if ((language === 'python' || language === 'bash') && remaining.startsWith('#')) {
      segments.push(
        React.createElement(
          'span',
          { key: currentPos, style: { color: 'var(--syntax-comment)', fontStyle: 'italic' } },
          remaining
        )
      );
      break;
    }

    // Check for numbers
    const numberMatch = /^(\d+\.?\d*)/.exec(remaining);
    if (numberMatch && (currentPos === 0 || /\W/.test(line[currentPos - 1]))) {
      segments.push(
        React.createElement(
          'span',
          { key: currentPos, style: { color: 'var(--syntax-number)' } },
          numberMatch[1]
        )
      );
      currentPos += numberMatch[1].length;
      continue;
    }

    // Check for keywords and identifiers
    const wordMatch = /^([a-zA-Z_$][a-zA-Z0-9_$]*)/.exec(remaining);
    if (wordMatch) {
      const word = wordMatch[1];
      if (keywords.has(word)) {
        segments.push(
          React.createElement(
            'span',
            { key: currentPos, style: { color: 'var(--syntax-keyword)', fontWeight: 500 } },
            word
          )
        );
      } else if ((word[0]?.toUpperCase() ?? '') === word[0] && word.length > 1) {
        // Likely a type/class name
        segments.push(
          React.createElement(
            'span',
            { key: currentPos, style: { color: 'var(--syntax-type)' } },
            word
          )
        );
      } else {
        segments.push(word);
      }
      currentPos += word.length;
      continue;
    }

    // Check for operators and punctuation
    const opMatch = /^([=<>!+\-*/%&|^~?:;,.{}()[\]])/.exec(remaining);
    if (opMatch) {
      segments.push(
        React.createElement(
          'span',
          { key: currentPos, style: { color: 'var(--syntax-operator)' } },
          opMatch[1]
        )
      );
      currentPos += 1;
      continue;
    }

    // Default: just add the character
    segments.push(remaining[0]);
    currentPos += 1;
  }

  return segments;
}
