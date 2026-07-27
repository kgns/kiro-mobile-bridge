/**
 * Snapshot capture service - captures DOM snapshots from Kiro via CDP
 */

/**
 * Capture chat metadata (title, active state)
 * @param {CDPConnection} cdp - CDP connection
 * @returns {Promise<{chatTitle: string, isActive: boolean}>}
 */
export async function captureMetadata(cdp) {
  if (!cdp.rootContextId) return { chatTitle: '', isActive: false };
  
  const script = `(function() {
    let chatTitle = '';
    let isActive = false;
    
    const titleSelectors = ['.chat-title', '.conversation-title', '[data-testid="chat-title"]', '.chat-header h1', '.chat-header h2'];
    for (const selector of titleSelectors) {
      const el = document.querySelector(selector);
      if (el && el.textContent) { chatTitle = el.textContent.trim(); break; }
    }
    
    const activeIndicators = ['.typing-indicator', '.loading-indicator', '[data-loading="true"]'];
    for (const selector of activeIndicators) {
      if (document.querySelector(selector)) { isActive = true; break; }
    }
    isActive = isActive || document.hasFocus();
    
    return { chatTitle, isActive };
  })()`;
  
  try {
    const result = await cdp.call('Runtime.evaluate', {
      expression: script,
      contextId: cdp.rootContextId,
      returnByValue: true
    });
    return result.result?.value || { chatTitle: '', isActive: false };
  } catch (err) {
    console.error('[Snapshot] Failed to capture metadata:', err.message);
    return { chatTitle: '', isActive: false };
  }
}

/**
 * Capture CSS styles from the page (run once per connection)
 * @param {CDPConnection} cdp - CDP connection
 * @returns {Promise<string>} - Combined CSS string
 */
export async function captureCSS(cdp) {
  if (!cdp.rootContextId) return '';
  
  const script = `(function() {
    let css = '';
    let targetDoc = document;
    const activeFrame = document.getElementById('active-frame');
    if (activeFrame && activeFrame.contentDocument) targetDoc = activeFrame.contentDocument;
    
    const rootStyles = window.getComputedStyle(targetDoc.documentElement);
    const allProps = [];
    for (let i = 0; i < rootStyles.length; i++) allProps.push(rootStyles[i]);
    
    // Safely iterate stylesheets with null check
    const styleSheets = targetDoc.styleSheets || [];
    for (const sheet of styleSheets) {
      try {
        if (sheet.cssRules) {
          for (const rule of sheet.cssRules) {
            if (rule.style) {
              for (let i = 0; i < rule.style.length; i++) {
                const prop = rule.style[i];
                if (prop.startsWith('--') && !allProps.includes(prop)) allProps.push(prop);
              }
            }
          }
        }
      } catch (e) {
        // CORS restriction on external stylesheets, skip
      }
    }
    
    let cssVars = ':root {\\n';
    for (const prop of allProps) {
      if (prop.startsWith('--')) {
        const value = rootStyles.getPropertyValue(prop).trim();
        if (value) cssVars += '  ' + prop + ': ' + value + ';\\n';
      }
    }
    cssVars += '}\\n\\n';
    css += cssVars;
    
    for (const sheet of styleSheets) {
      try {
        if (sheet.cssRules) {
          for (const rule of sheet.cssRules) css += rule.cssText + '\\n';
        }
      } catch (e) {
        // CORS restriction, skip
      }
    }
    
    const styleTags = targetDoc.querySelectorAll('style');
    for (const tag of styleTags) css += tag.textContent + '\\n';
    
    return css;
  })()`;
  
  try {
    const result = await cdp.call('Runtime.evaluate', {
      expression: script,
      contextId: cdp.rootContextId,
      returnByValue: true
    });
    return result.result?.value || '';
  } catch (err) {
    console.error('[Snapshot] Failed to capture CSS:', err.message);
    return '';
  }
}


/**
 * Capture HTML snapshot of the chat interface
 * @param {CDPConnection} cdp - CDP connection
 * @returns {Promise<{html: string, bodyBg: string, bodyColor: string} | null>}
 */
export async function captureSnapshot(cdp) {
  if (!cdp.rootContextId) {
    console.log('[Snapshot] No rootContextId available');
    return null;
  }
  
  const script = `(function() {
    let targetDoc = document;
    let targetBody = document.body;
    
    const activeFrame = document.getElementById('active-frame');
    if (activeFrame && activeFrame.contentDocument) {
      targetDoc = activeFrame.contentDocument;
      targetBody = targetDoc.body;
    }
    
    if (!targetBody) return { html: '<div style="padding:20px;color:#888;">No content found</div>', bodyBg: '', bodyColor: '' };
    
    const bodyStyles = window.getComputedStyle(targetBody);
    const bodyBg = bodyStyles.backgroundColor || '';
    const bodyColor = bodyStyles.color || '';
    
    const scrollContainers = targetDoc.querySelectorAll('[class*="scroll"], [style*="overflow"]');
    
    for (const container of scrollContainers) {
      if (container.scrollHeight > container.clientHeight) {
        const isHistoryPanel = container.matches('[class*="history"], [class*="History"], [class*="session-list"], [class*="SessionList"]') ||
          container.closest('[class*="history"], [class*="History"], [class*="session-list"], [class*="SessionList"]');
        
        if (isHistoryPanel) {
          container.scrollTop = 0;
        } else {
          container.scrollTop = container.scrollHeight;
        }
      }
    }
    
    const clone = targetBody.cloneNode(true);
    
    // Stamp a positional reference on every cloned element. The mobile client sends
    // the ref of whatever the user tapped, and the click service resolves it by
    // walking this same DOM in the same order, which gives an exact target instead
    // of re-guessing one from truncated text. Only the clone is stamped; Kiro's
    // live DOM is never modified. Must run before the portal/floating clones are
    // appended below so those copies stay unstamped rather than carrying duplicates.
    const refWalker = targetDoc.createTreeWalker(clone, NodeFilter.SHOW_ELEMENT);
    let refCount = 0;
    let refNode = refWalker.nextNode();
    while (refNode) {
      refNode.setAttribute('data-kr', String(refCount++));
      refNode = refWalker.nextNode();
    }
    
    // CRITICAL: Sync checkbox checked PROPERTY to ATTRIBUTE before serialization
    // cloneNode doesn't copy JS properties, only HTML attributes
    // So we need to explicitly set the checked attribute based on the property
    const originalCheckboxes = targetBody.querySelectorAll('input[type="checkbox"]');
    const clonedCheckboxes = clone.querySelectorAll('input[type="checkbox"]');
    originalCheckboxes.forEach((orig, i) => {
      if (clonedCheckboxes[i]) {
        if (orig.checked) {
          clonedCheckboxes[i].setAttribute('checked', 'checked');
        } else {
          clonedCheckboxes[i].removeAttribute('checked');
        }
        // Also sync aria-checked for accessibility
        clonedCheckboxes[i].setAttribute('aria-checked', orig.checked ? 'true' : 'false');
      }
    });
    
    // Radios need the same treatment as checkboxes: the clone carries attributes
    // but not the live checked property, so a selected option would arrive
    // unselected and any :checked-driven selection styling would be lost.
    const originalRadios = targetBody.querySelectorAll('input[type="radio"]');
    const clonedRadios = clone.querySelectorAll('input[type="radio"]');
    originalRadios.forEach((orig, i) => {
      const cloned = clonedRadios[i];
      if (!cloned) return;
      if (orig.checked) {
        cloned.setAttribute('checked', 'checked');
      } else {
        cloned.removeAttribute('checked');
      }
      cloned.setAttribute('aria-checked', orig.checked ? 'true' : 'false');
    });
    
    // Mark the focused element. Pseudo-classes can't be serialized at all, so a
    // focus ring is invisible in the snapshot - and that ring is how Kiro shows
    // which option you just picked in a choice/approval prompt. The mobile client
    // styles this attribute to draw the ring back in.
    try {
      const activeEl = targetDoc.activeElement;
      if (activeEl && activeEl !== targetBody && targetBody.contains(activeEl)) {
        // The clone is a deep copy of this body and nothing above has changed its
        // shape, so walking both trees in step pairs each original with its copy.
        const origWalker = targetDoc.createTreeWalker(targetBody, NodeFilter.SHOW_ELEMENT);
        const cloneWalker = targetDoc.createTreeWalker(clone, NodeFilter.SHOW_ELEMENT);
        let orig = origWalker.nextNode();
        let copy = cloneWalker.nextNode();
        while (orig && copy && orig !== activeEl) {
          orig = origWalker.nextNode();
          copy = cloneWalker.nextNode();
        }
        if (orig === activeEl && copy) {
          copy.setAttribute('data-kr-focus', 'true');
          try {
            if (activeEl.matches(':focus-visible')) copy.setAttribute('data-kr-focus-visible', 'true');
          } catch (e) {
            // :focus-visible unsupported, the plain focus marker is enough
          }
        }
      }
    } catch (e) {
      // Focus capture is best-effort
    }
    
    // Also sync role="switch" elements that might not be checkboxes
    const originalSwitches = targetBody.querySelectorAll('[role="switch"]');
    const clonedSwitches = clone.querySelectorAll('[role="switch"]');
    originalSwitches.forEach((orig, i) => {
      if (clonedSwitches[i]) {
        const isChecked = orig.getAttribute('aria-checked') === 'true' || 
                          orig.getAttribute('data-state') === 'checked' ||
                          orig.checked === true;
        clonedSwitches[i].setAttribute('aria-checked', isChecked ? 'true' : 'false');
        clonedSwitches[i].setAttribute('data-state', isChecked ? 'checked' : 'unchecked');
      }
    });
    
    // Capture any portal/overlay content that might be outside the body
    // Radix UI and similar libraries render dropdowns in portals at document root
    const portals = targetDoc.querySelectorAll('[data-radix-portal], [data-radix-popper-content-wrapper], [class*="portal"], [class*="Portal"]');
    portals.forEach(portal => {
      try {
        const portalClone = portal.cloneNode(true);
        clone.appendChild(portalClone);
      } catch(e) {
        // Clone failed, skip
      }
    });
    
    // Also check for any floating/overlay elements at document level
    const floatingSelectors = [
      'body > [role="listbox"]', 
      'body > [role="menu"]', 
      'body > [data-state="open"]', 
      'body > [class*="dropdown"]',
      'body > div[style*="position: absolute"]',
      'body > div[style*="position: fixed"]'
    ];
    
    floatingSelectors.forEach(sel => {
      try {
        targetDoc.querySelectorAll(sel).forEach(el => {
          const elClone = el.cloneNode(true);
          clone.appendChild(elClone);
        });
      } catch(e) {
        // Selector failed, skip
      }
    });
    
    // Remove ONLY tooltips from clone - preserve everything else
    try {
      clone.querySelectorAll('[role="tooltip"]').forEach(el => el.remove());
    } catch(e) {
      // Removal failed, continue
    }
    
    // Fix SVG currentColor
    clone.querySelectorAll('svg').forEach(svg => {
      try {
        const computedColor = '#cccccc';
        svg.querySelectorAll('[fill="currentColor"]').forEach(el => el.setAttribute('fill', computedColor));
        svg.querySelectorAll('[stroke="currentColor"]').forEach(el => el.setAttribute('stroke', computedColor));
      } catch(e) {
        // SVG fix failed, continue
      }
    });
    
    // Remove placeholder text
    try {
      clone.querySelectorAll('[contenteditable="true"], [data-lexical-editor="true"]').forEach(editable => {
        const parent = editable.parentElement;
        if (parent) {
          Array.from(parent.children).forEach(sibling => {
            if (sibling === editable) return;
            const text = (sibling.textContent || '').toLowerCase();
            if (text.includes('ask') || text.includes('question') || text.includes('task') || text.includes('describe')) {
              sibling.remove();
            }
          });
        }
      });
      
      clone.querySelectorAll('[class*="placeholder"], [class*="Placeholder"], [data-placeholder]').forEach(el => {
        if (!el.matches('[contenteditable], [data-lexical-editor], textarea, input')) {
          if (!el.querySelector('[contenteditable], [data-lexical-editor], textarea, input')) el.remove();
        }
      });
    } catch(e) {
      // Placeholder removal failed, continue
    }
    
    return { html: clone.outerHTML, bodyBg, bodyColor };
  })()`;
  
  try {
    const result = await cdp.call('Runtime.evaluate', {
      expression: script,
      contextId: cdp.rootContextId,
      returnByValue: true
    });
    
    return result.result?.value || null;
  } catch (err) {
    console.error('[Snapshot] Failed to capture HTML:', err.message);
    return null;
  }
}

/**
 * Capture Editor panel snapshot (currently open file)
 * @param {CDPConnection} cdp - CDP connection
 * @returns {Promise<{fileName: string, language: string, content: string, lineCount: number, hasContent: boolean} | null>}
 */
export async function captureEditor(cdp) {
  if (!cdp.rootContextId) return null;
  
  const script = `(function() {
    let targetDoc = document;
    const activeFrame = document.getElementById('active-frame');
    if (activeFrame && activeFrame.contentDocument) targetDoc = activeFrame.contentDocument;
    
    const result = { html: '', fileName: '', language: '', content: '', lineCount: 0, hasContent: false };
    
    // CRITICAL: First check if there's an active editor tab
    // If no active tab exists, return early with hasContent: false
    let hasActiveEditorTab = false;
    const editorTabSelectors = [
      '.tab.active',
      '[role="tab"][aria-selected="true"]',
      '.tabs-container .tab.active',
      '.editor-group-container .tab.active'
    ];
    
    for (const selector of editorTabSelectors) {
      try {
        const activeTab = targetDoc.querySelector(selector);
        if (activeTab && activeTab.offsetParent !== null) {
          // Verify it's actually an editor tab (not a panel tab)
          const tabText = (activeTab.textContent || '').trim();
          // Editor tabs typically have file extensions or are in editor area
          const isEditorTab = activeTab.closest('.editor-group-container, .tabs-container, [class*="editor"]');
          if (isEditorTab && tabText.length > 0) {
            hasActiveEditorTab = true;
            break;
          }
        }
      } catch(e) {}
    }
    
    // If no active editor tab, return empty result
    if (!hasActiveEditorTab) {
      return result;
    }
    
    // Get active tab / file name
    const tabSelectors = ['.tab.active .label-name', '.tab.active', '[role="tab"][aria-selected="true"]'];
    for (const selector of tabSelectors) {
      try {
        const tab = targetDoc.querySelector(selector);
        if (tab && tab.textContent) {
          result.fileName = tab.textContent.trim().split('\\n')[0].trim();
          if (result.fileName) break;
        }
      } catch(e) {
        // Selector failed, continue
      }
    }
    
    // Method 1: Try VS Code/Kiro API (acquireVsCodeApi or global vscode)
    try {
      // Check for VS Code webview API
      if (typeof acquireVsCodeApi === 'function') {
        const vscode = acquireVsCodeApi();
        if (vscode && vscode.getState) {
          const state = vscode.getState();
          if (state && state.content) {
            result.content = state.content;
            result.lineCount = state.content.split('\\n').length;
            result.hasContent = true;
          }
        }
      }
    } catch(e) {
      // VS Code API not available
    }
    
    // Method 2: Try Monaco API with multiple access patterns
    if (!result.content) {
      try {
        const monacoEditors = targetDoc.querySelectorAll('.monaco-editor');
        for (const editorEl of monacoEditors) {
          // Try various ways to access the editor instance
          let editorInstance = null;
          
          // Direct property access
          editorInstance = editorEl.__vscode_editor__ || editorEl._editor;
          
          // Try global monaco
          if (!editorInstance && window.monaco && window.monaco.editor) {
            const editors = window.monaco.editor.getEditors ? window.monaco.editor.getEditors() : [];
            if (editors.length > 0) editorInstance = editors[0];
          }
          
          // Try to find editor via data attributes or parent elements
          if (!editorInstance) {
            const editorContainer = editorEl.closest('[data-uri]') || editorEl.closest('.editor-instance');
            if (editorContainer && editorContainer._editor) {
              editorInstance = editorContainer._editor;
            }
          }
          
          if (editorInstance && editorInstance.getModel) {
            const model = editorInstance.getModel();
            if (model) {
              result.content = model.getValue();
              result.lineCount = model.getLineCount();
              result.language = model.getLanguageId ? model.getLanguageId() : '';
              result.hasContent = true;
              break;
            }
          }
        }
      } catch(e) {
        // Monaco API not available, continue
      }
    }
    
    // Method 3: Try to get content from Monaco's internal model store
    if (!result.content) {
      try {
        if (window.monaco && window.monaco.editor) {
          const models = window.monaco.editor.getModels ? window.monaco.editor.getModels() : [];
          // Find the model that matches the active file
          for (const model of models) {
            const uri = model.uri ? model.uri.toString() : '';
            if (result.fileName && uri.includes(result.fileName)) {
              result.content = model.getValue();
              result.lineCount = model.getLineCount();
              result.language = model.getLanguageId ? model.getLanguageId() : '';
              result.hasContent = true;
              break;
            }
          }
          // If no match by filename, use the first model with content
          if (!result.content && models.length > 0) {
            const model = models[0];
            result.content = model.getValue();
            result.lineCount = model.getLineCount();
            result.language = model.getLanguageId ? model.getLanguageId() : '';
            result.hasContent = true;
          }
        }
      } catch(e) {
        // Model store not accessible
      }
    }
    
    // Method 4: Fallback - Extract from view-lines (visible lines only)
    if (!result.content) {
      const viewLines = targetDoc.querySelector('.monaco-editor .view-lines');
      if (viewLines) {
        const lines = viewLines.querySelectorAll('.view-line');
        if (lines.length > 0) {
          let codeContent = '';
          let minLineNum = Infinity, maxLineNum = 0;
          const lineMap = new Map();
          
          // Get line height from first line for accurate line number calculation
          let lineHeight = 19;
          if (lines[0]) {
            const firstLineTop = parseFloat(lines[0].style.top) || 0;
            const secondLine = lines[1];
            if (secondLine) {
              const secondLineTop = parseFloat(secondLine.style.top) || 0;
              if (secondLineTop > firstLineTop) {
                lineHeight = secondLineTop - firstLineTop;
              }
            }
          }
          
          lines.forEach(line => {
            const top = parseFloat(line.style.top) || 0;
            const lineNum = Math.round(top / lineHeight) + 1;
            lineMap.set(lineNum, line.textContent || '');
            minLineNum = Math.min(minLineNum, lineNum);
            maxLineNum = Math.max(maxLineNum, lineNum);
          });
          
          // Get total line count from scrollbar or line numbers if available
          let totalLines = maxLineNum;
          const lineNumbersContainer = targetDoc.querySelector('.monaco-editor .line-numbers');
          if (lineNumbersContainer) {
            const lastLineNum = lineNumbersContainer.querySelector('.line-numbers:last-child');
            if (lastLineNum) {
              const num = parseInt(lastLineNum.textContent, 10);
              if (!isNaN(num) && num > totalLines) totalLines = num;
            }
          }
          
          // Also try to get total from editor's scrollable height
          const scrollableElement = targetDoc.querySelector('.monaco-editor .monaco-scrollable-element');
          if (scrollableElement) {
            const scrollHeight = scrollableElement.scrollHeight;
            const estimatedLines = Math.ceil(scrollHeight / lineHeight);
            if (estimatedLines > totalLines) totalLines = estimatedLines;
          }
          
          for (let i = minLineNum; i <= maxLineNum; i++) {
            codeContent += (lineMap.get(i) || '') + '\\n';
          }
          
          result.content = codeContent;
          result.lineCount = totalLines;
          result.startLine = minLineNum;
          result.endLine = maxLineNum;
          result.hasContent = codeContent.trim().length > 0;
          
          // Always mark as partial when using view-lines fallback
          result.isPartial = true;
          if (minLineNum > 1 || maxLineNum < totalLines) {
            result.note = 'Showing lines ' + minLineNum + '-' + maxLineNum + ' of ' + totalLines + '. Use Explorer to open full file.';
          } else {
            result.note = 'Visible lines only. Use Explorer to open full file.';
          }
        }
      }
    }
    
    // Detect language from filename
    if (!result.language && result.fileName) {
      const ext = result.fileName.split('.').pop()?.toLowerCase();
      const extMap = {
        'ts': 'typescript', 'tsx': 'typescript', 'js': 'javascript', 'jsx': 'javascript',
        'py': 'python', 'java': 'java', 'html': 'html', 'css': 'css', 'json': 'json',
        'md': 'markdown', 'yaml': 'yaml', 'yml': 'yaml', 'go': 'go', 'rs': 'rust',
        'c': 'c', 'cpp': 'cpp', 'h': 'c', 'cs': 'csharp', 'rb': 'ruby', 'php': 'php',
        'sql': 'sql', 'sh': 'bash', 'vue': 'vue', 'svelte': 'svelte'
      };
      result.language = extMap[ext] || ext || '';
    }
    
    return result;
  })()`;
  
  try {
    const result = await cdp.call('Runtime.evaluate', {
      expression: script,
      contextId: cdp.rootContextId,
      returnByValue: true
    });
    return result.result?.value || null;
  } catch (err) {
    console.error('[Editor] Failed to capture:', err.message);
    return null;
  }
}
