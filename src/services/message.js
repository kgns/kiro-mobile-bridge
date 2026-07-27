/**
 * Message injection service - sends messages to Kiro chat via CDP
 */
import { escapeForJavaScript, validateMessage } from '../utils/security.js';

/**
 * Create script to inject message into chat input
 * @param {string} messageText - Message to inject
 * @returns {string} - JavaScript expression
 */
function createInjectScript(messageText) {
  // Use proper escaping to prevent XSS and injection attacks
  const escaped = escapeForJavaScript(messageText);
  
  return `(async () => {
    const text = '${escaped}';
    let targetDoc = document;
    const activeFrame = document.getElementById('active-frame');
    if (activeFrame && activeFrame.contentDocument) targetDoc = activeFrame.contentDocument;
    
    // Find the CHAT INPUT editor specifically (not any contenteditable in the page)
    // Look for the input area at the bottom of the chat, not message bubbles
    let editor = null;
    
    // Strategy 1: Find by common chat input container patterns
    const inputContainerSelectors = [
      '[class*="chat-input"]',
      '[class*="message-input"]', 
      '[class*="composer"]',
      '[class*="input-area"]',
      '[class*="InputArea"]',
      'form[class*="chat"]',
      '[data-testid*="input"]'
    ];
    
    for (const containerSel of inputContainerSelectors) {
      const container = targetDoc.querySelector(containerSel);
      if (container) {
        const editorInContainer = container.querySelector('.tiptap.ProseMirror[contenteditable="true"], [data-lexical-editor="true"][contenteditable="true"], [contenteditable="true"], textarea');
        if (editorInContainer && editorInContainer.offsetParent !== null) {
          editor = editorInContainer;
          break;
        }
      }
    }
    
    // Strategy 2: Find TipTap/ProseMirror editors that are visible and near a submit button
    if (!editor) {
      const allEditors = [...targetDoc.querySelectorAll('.tiptap.ProseMirror[contenteditable="true"]')].filter(el => el.offsetParent !== null);
      for (const ed of allEditors) {
        // Check if there's a submit button nearby (sibling or in same parent form)
        const parent = ed.closest('form') || ed.parentElement?.parentElement?.parentElement;
        if (parent) {
          const hasSubmit = parent.querySelector('button[data-variant="submit"], button[type="submit"], svg.lucide-arrow-right');
          if (hasSubmit) { editor = ed; break; }
        }
      }
      // Fallback to last visible TipTap editor
      if (!editor && allEditors.length > 0) editor = allEditors.at(-1);
    }
    
    // Strategy 3: Find Lexical editors
    if (!editor) {
      const lexicalEditors = [...targetDoc.querySelectorAll('[data-lexical-editor="true"][contenteditable="true"]')].filter(el => el.offsetParent !== null);
      for (const ed of lexicalEditors) {
        const parent = ed.closest('form') || ed.parentElement?.parentElement?.parentElement;
        if (parent) {
          const hasSubmit = parent.querySelector('button[data-variant="submit"], button[type="submit"]');
          if (hasSubmit) { editor = ed; break; }
        }
      }
      if (!editor && lexicalEditors.length > 0) editor = lexicalEditors.at(-1);
    }
    
    // Strategy 4: Generic contenteditable (last resort)
    if (!editor) {
      const editables = [...targetDoc.querySelectorAll('[contenteditable="true"]')].filter(el => el.offsetParent !== null);
      editor = editables.at(-1);
    }
    
    // Strategy 5: Textarea fallback
    if (!editor) {
      const textareas = [...targetDoc.querySelectorAll('textarea')].filter(el => el.offsetParent !== null);
      editor = textareas.at(-1);
    }
    
    if (!editor) return { ok: false, error: 'editor_not_found' };
    
    const isTextarea = editor.tagName.toLowerCase() === 'textarea';
    const isProseMirror = editor.classList.contains('ProseMirror') || editor.classList.contains('tiptap');
    const isLexical = editor.hasAttribute('data-lexical-editor');
    
    // Insert a soft line break at the caret. ProseMirror and Lexical both bind
    // Shift+Enter to "insert line break" and listen for plain keydown events, so
    // driving their own keybinding produces the break their document model expects.
    const insertLineBreak = () => {
      const before = editor.innerHTML;
      editor.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true, cancelable: true,
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, shiftKey: true
      }));
      if (editor.innerHTML !== before) return true;
      try { if (targetDoc.execCommand('insertText', false, '\\n')) return true; } catch (e) {}
      return editor.innerHTML !== before;
    };
    
    // Insert text at the caret one line at a time. A single insertText carrying
    // embedded newlines gets collapsed to spaces by both editors, so the breaks
    // have to be issued separately. Returns false only when the editor rejects
    // insertText outright, so the caller can fall back to a direct DOM write.
    const insertRichText = (value) => {
      const lines = String(value).split('\\n');
      let accepted = false;
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) insertLineBreak();
        if (!lines[i]) continue;
        let inserted = false;
        try { inserted = !!targetDoc.execCommand('insertText', false, lines[i]); } catch (e) {}
        if (inserted) accepted = true;
        else if (!accepted) return false;
      }
      return true;
    };
    
    // Focus the editor first
    editor.focus();
    await new Promise(r => setTimeout(r, 50));
    
    if (isTextarea) {
      // Textarea: simple value assignment
      editor.value = text;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (isProseMirror) {
      // ProseMirror/TipTap: Insert text at end (preserves existing attachments)
      // Move cursor to end
      const selection = targetDoc.getSelection();
      const range = targetDoc.createRange();
      range.selectNodeContents(editor);
      range.collapse(false); // collapse to end
      selection.removeAllRanges();
      selection.addRange(range);
      // Insert text via execCommand to properly trigger state sync
      if (!insertRichText(text)) {
        const p = targetDoc.createElement('p');
        p.textContent = text;
        editor.appendChild(p);
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      }
    } else if (isLexical) {
      // Lexical: Move cursor to end and insert (preserves existing attachments)
      const selection = targetDoc.getSelection();
      const range = targetDoc.createRange();
      range.selectNodeContents(editor);
      range.collapse(false); // collapse to end
      selection.removeAllRanges();
      selection.addRange(range);
      
      // Insert new text using execCommand (Lexical intercepts this)
      if (!insertRichText(text)) {
        editor.textContent += text;
        editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      }
    } else {
      // Generic contenteditable - insert at end
      const selection = targetDoc.getSelection();
      const range = targetDoc.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      
      if (!insertRichText(text)) {
        editor.textContent += text;
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      }
    }
    
    // Wait for editor state to sync
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise(r => setTimeout(r, 100));
    
    // Find and click submit button
    const submitButton = targetDoc.querySelector('button[data-variant="submit"]:not([disabled])') ||
                         targetDoc.querySelector('svg.lucide-arrow-right')?.closest('button:not([disabled])') ||
                         targetDoc.querySelector('button[type="submit"]:not([disabled])') ||
                         targetDoc.querySelector('button[aria-label*="send" i]:not([disabled])');
    
    if (submitButton) {
      submitButton.click();
      return { ok: true, method: 'click_submit' };
    }
    
    // Fallback: Enter key
    editor.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13 }));
    return { ok: true, method: 'enter_key' };
  })()`;
}

/**
 * Inject a message into the chat via CDP
 * @param {CDPConnection} cdp - CDP connection
 * @param {string} message - Message text
 * @returns {Promise<{success: boolean, method?: string, error?: string}>}
 */
export async function injectMessage(cdp, message) {
  // Validate message before processing
  const validation = validateMessage(message);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }
  
  if (!cdp.rootContextId) {
    return { success: false, error: 'No execution context available' };
  }
  
  try {
    const result = await cdp.call('Runtime.evaluate', {
      expression: createInjectScript(message),
      contextId: cdp.rootContextId,
      returnByValue: true,
      awaitPromise: true
    });
    
    if (result.exceptionDetails) {
      return { success: false, error: result.exceptionDetails.exception?.description || 'Unknown error' };
    }
    
    const value = result.result?.value;
    if (value?.ok) {
      console.log(`[Inject] Message sent via ${value.method}`);
      return { success: true, method: value.method };
    }
    return { success: false, error: value?.error || 'Injection failed' };
  } catch (err) {
    console.error('[Inject] CDP call failed:', err.message);
    return { success: false, error: err.message };
  }
}
