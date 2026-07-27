/**
 * Security utilities for input validation and sanitization
 * Prevents path traversal, XSS, and other security vulnerabilities
 */
import path from 'path';

/**
 * Validate that a file path resolves within an allowed root directory
 * Prevents path traversal attacks (e.g., ../../etc/passwd)
 * 
 * @param {string} filePath - The file path to validate (can be relative or absolute)
 * @param {string} rootDir - The allowed root directory
 * @returns {{valid: boolean, resolvedPath: string|null, error: string|null}}
 */
export function validatePathWithinRoot(filePath, rootDir) {
  if (!filePath || typeof filePath !== 'string') {
    return { valid: false, resolvedPath: null, error: 'Invalid file path' };
  }

  if (!rootDir || typeof rootDir !== 'string') {
    return { valid: false, resolvedPath: null, error: 'Invalid root directory' };
  }

  try {
    // Normalize and resolve both paths to absolute paths
    const normalizedRoot = path.resolve(rootDir);
    const resolvedPath = path.resolve(rootDir, filePath);

    // Ensure the resolved path starts with the root directory
    // Add path.sep to prevent matching partial directory names
    // e.g., /home/user vs /home/username
    const rootWithSep = normalizedRoot.endsWith(path.sep)
      ? normalizedRoot
      : normalizedRoot + path.sep;

    if (!resolvedPath.startsWith(rootWithSep) && resolvedPath !== normalizedRoot) {
      return {
        valid: false,
        resolvedPath: null,
        error: 'Path traversal detected: path resolves outside allowed directory'
      };
    }

    return { valid: true, resolvedPath, error: null };
  } catch (err) {
    return { valid: false, resolvedPath: null, error: `Path validation error: ${err.message}` };
  }
}

/**
 * Escape a string for safe inclusion in JavaScript code
 * Handles all special characters that could break string literals or enable injection
 * 
 * @param {string} str - The string to escape
 * @returns {string} - Escaped string safe for JS inclusion
 */
export function escapeForJavaScript(str) {
  if (typeof str !== 'string') {
    return '';
  }

  return str
    .replace(/\\/g, '\\\\')     // Backslashes first (must be first!)
    .replace(/'/g, "\\'")        // Single quotes
    .replace(/"/g, '\\"')        // Double quotes
    .replace(/`/g, '\\`')        // Backticks (template literals)
    .replace(/\$/g, '\\$')       // Dollar signs (template literal interpolation)
    .replace(/\n/g, '\\n')       // Newlines
    .replace(/\r/g, '\\r')       // Carriage returns
    .replace(/\t/g, '\\t')       // Tabs
    .replace(/\0/g, '\\0')       // Null bytes
    .replace(/\u2028/g, '\\u2028')  // Line separator
    .replace(/\u2029/g, '\\u2029'); // Paragraph separator
}

/**
 * Validate and sanitize click info object
 * Ensures all properties are of expected types and within reasonable limits
 * 
 * @param {object} clickInfo - The click info object to validate
 * @returns {{valid: boolean, sanitized: object|null, error: string|null}}
 */
export function sanitizeClickInfo(clickInfo) {
  if (!clickInfo || typeof clickInfo !== 'object') {
    return { valid: false, sanitized: null, error: 'Click info must be an object' };
  }

  const sanitized = {};

  // String properties with max length
  const stringProps = [
    { name: 'tag', maxLength: 50 },
    { name: 'text', maxLength: 200 },
    { name: 'ariaLabel', maxLength: 200 },
    { name: 'role', maxLength: 50 },
    { name: 'className', maxLength: 500 },
    { name: 'tabLabel', maxLength: 100 },
    { name: 'parentTabLabel', maxLength: 100 },
    { name: 'filePath', maxLength: 500 },
    { name: 'toggleId', maxLength: 100 },
    { name: 'actionType', maxLength: 50 },
    { name: 'parentMessageContext', maxLength: 150 },
    { name: 'controlSelector', maxLength: 120 },
    { name: 'refTag', maxLength: 50 },
    { name: 'refClass', maxLength: 200 },
    { name: 'refText', maxLength: 60 }
  ];

  for (const { name, maxLength } of stringProps) {
    if (clickInfo[name] !== undefined) {
      if (typeof clickInfo[name] !== 'string') {
        sanitized[name] = String(clickInfo[name]).substring(0, maxLength);
      } else {
        sanitized[name] = clickInfo[name].substring(0, maxLength);
      }
    }
  }

  // controlSelector is passed to document.querySelector on Kiro's page. It's
  // JSON-encoded into the eval script (so no code injection), but constrain it
  // to a conservative CSS-selector charset as defense in depth.
  if (sanitized.controlSelector !== undefined) {
    sanitized.controlSelector = sanitized.controlSelector.replace(/[^A-Za-z0-9 .#_\-\[\]="':>*(),]/g, '');
  }

  // Boolean properties
  const boolProps = [
    'isTab', 'isCloseButton', 'isToggle', 'isModelSelector', 'isModelOption',
    'isSendButton', 'isFileLink', 'isNotificationButton', 'isIconButton', 'isHistoryItem',
    'isDialogChoice', 'isToolActionButton', 'isCommandPanelAction', 'isCommandTrustOption',
    'isMessageActionButton', 'isAttachment',
    'isComposerControl', 'isListboxOption', 'exactClick'
  ];

  for (const name of boolProps) {
    if (clickInfo[name] !== undefined) {
      sanitized[name] = Boolean(clickInfo[name]);
    }
  }

  // Number properties (for element indexing)
  const numberProps = [
    { name: 'elementIndex', max: 1000 },
    { name: 'totalMatches', max: 1000 },
    // refIndex is a position within Kiro's whole chat DOM, which runs to tens of
    // thousands of elements in a long conversation.
    { name: 'refIndex', max: 500000 }
  ];

  for (const { name, max } of numberProps) {
    if (clickInfo[name] !== undefined) {
      const num = parseInt(clickInfo[name], 10);
      if (!isNaN(num) && num >= 0 && num < max) {
        sanitized[name] = num;
      }
    }
  }

  return { valid: true, sanitized, error: null };
}

/**
 * Validate message text for injection
 * 
 * @param {string} message - The message to validate
 * @returns {{valid: boolean, error: string|null}}
 */
export function validateMessage(message) {
  if (!message || typeof message !== 'string') {
    return { valid: false, error: 'Message must be a non-empty string' };
  }

  if (message.length > 50000) {
    return { valid: false, error: 'Message exceeds maximum length (50000 characters)' };
  }

  return { valid: true, error: null };
}

/**
 * Sanitize a file path by removing null bytes and normalizing
 * Does NOT validate path traversal - use validatePathWithinRoot for that
 * 
 * @param {string} filePath - The file path to sanitize
 * @returns {string} - Sanitized file path
 */
export function sanitizeFilePath(filePath) {
  if (typeof filePath !== 'string') {
    return '';
  }

  // Remove null bytes which can be used to bypass security checks
  return filePath.replace(/\0/g, '');
}
