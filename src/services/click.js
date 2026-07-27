/**
 * Click service - handles UI element clicks via CDP
 */
import { MODEL_NAMES } from '../utils/constants.js';

/**
 * Build the click script for CDP evaluation
 * This is separated for maintainability and testing
 * @param {object} clickInfo - Element identification info (already sanitized)
 * @returns {string} - JavaScript expression
 */
function buildClickScript(clickInfo) {
  // Escape the clickInfo for safe inclusion in the script
  const safeClickInfo = JSON.stringify(clickInfo);
  const modelNamesJson = JSON.stringify(MODEL_NAMES);

  return `(function() {
    let targetDoc = document;
    const activeFrame = document.getElementById('active-frame');
    if (activeFrame && activeFrame.contentDocument) targetDoc = activeFrame.contentDocument;
    
    const info = ${safeClickInfo};
    const modelNames = ${modelNamesJson};
    let element = null;
    let matchMethod = '';
    
    // Helper functions
    const isVisible = (el) => el && el.offsetParent !== null;
    const findModelName = (text) => {
      const lowerText = text.toLowerCase();
      for (const m of modelNames) {
        if (lowerText.includes(m)) return m;
      }
      return null;
    };
    
    // CRITICAL: Find React fiber and check for onClick handler
    const getReactFiber = (el) => {
      for (const key of Object.keys(el)) {
        if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
          return el[key];
        }
      }
      return null;
    };
    
    const hasReactOnClick = (el) => {
      const fiber = getReactFiber(el);
      if (!fiber) return false;
      // Check memoizedProps for onClick
      const props = fiber.memoizedProps || fiber.pendingProps || {};
      return !!(props.onClick || props.onPointerDown || props.onMouseDown || props.onPress);
    };
    
    // Find the element with actual React onClick handler (walk up tree)
    const findClickableAncestor = (el, maxDepth = 5) => {
      let current = el;
      let depth = 0;
      while (current && depth < maxDepth) {
        if (hasReactOnClick(current)) {
          console.log('[Click] Found React onClick on ancestor at depth', depth, current.tagName);
          return current;
        }
        current = current.parentElement;
        depth++;
      }
      return null;
    };
    
    // Find innermost clickable child
    const findClickableChild = (el) => {
      // Check children for React onClick
      const children = el.querySelectorAll('*');
      for (const child of children) {
        if (hasReactOnClick(child) && isVisible(child)) {
          console.log('[Click] Found React onClick on child:', child.tagName);
          return child;
        }
      }
      return null;
    };
    
    // =========================================================================
    // Positional Reference (preferred)
    // The snapshot stamps every element with data-kr in document order, so the
    // ref the mobile client sends back identifies the exact element that was
    // tapped. Walking this DOM in the same order reproduces that numbering.
    // Verified against a fingerprint first: if Kiro's DOM changed between the
    // snapshot and the tap the indices have shifted, and we fall through to the
    // text-based matchers below rather than click whatever now sits at that spot.
    // =========================================================================
    if (typeof info.refIndex === 'number' && info.refIndex >= 0) {
      try {
        const walker = targetDoc.createTreeWalker(targetDoc.body, NodeFilter.SHOW_ELEMENT);
        let i = 0;
        let candidate = walker.nextNode();
        while (candidate && i < info.refIndex) {
          i++;
          candidate = walker.nextNode();
        }
        // offsetParent is null for position:fixed elements (popups, dialogs), so
        // fall back to a non-zero box rather than rejecting a valid target.
        const refVisible = (el) => {
          if (isVisible(el)) return true;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        if (candidate && i === info.refIndex && refVisible(candidate)) {
          const tagOk = !info.refTag || candidate.tagName.toLowerCase() === info.refTag;
          // getAttribute rather than className: on SVG elements className is an
          // SVGAnimatedString, and icons are common click targets.
          const cls = (candidate.getAttribute('class') || '').substring(0, 200);
          const classOk = !!info.refClass && cls === info.refClass;
          const text = (candidate.textContent || '').replace(/\\s+/g, ' ').trim().substring(0, 60);
          const textOk = !!info.refText && text === info.refText;
          // An unclassed, textless element (a bare icon wrapper) has nothing to
          // fingerprint; accept it when the snapshot saw the same emptiness.
          const bothBlank = !info.refClass && !info.refText && !cls && !text;
          // Position alone is not enough - require the element to still look like
          // the one that was tapped.
          if (tagOk && (classOk || textOk || bothBlank)) {
            element = candidate;
            matchMethod = 'ref-' + info.refIndex;
          } else {
            console.log('[Click] Stale ref ' + info.refIndex + ' (tag=' + tagOk + ' class=' + classOk + ' text=' + textOk + '), falling back to text match');
          }
        }
      } catch (e) {}
    }
    
    // Determine element type
    const isTabClick = info.isTab || info.role === 'tab';
    const isCloseButton = info.isCloseButton || (info.ariaLabel && info.ariaLabel.toLowerCase() === 'close');
    const isToggle = info.isToggle || info.role === 'switch';
    const isModelSelector = info.isModelSelector;
    const isModelOption = info.isModelOption;
    const isMessageActionButton = info.isMessageActionButton && info.parentMessageContext;
    
    // =========================================================================
    // Message Action Buttons (Restore, Copy, Retry - per-message buttons)
    // Uses parent message context to find the right button
    // =========================================================================
    if (isMessageActionButton && !element) {
      // Use ariaLabel if available, otherwise fall back to text content
      const searchLabel = (info.ariaLabel || info.text || '').toLowerCase().trim();
      const messageContext = (info.parentMessageContext || '').toLowerCase();
      
      // Find all message containers
      const messageSelectors = [
        '[class*="message"]',
        '[class*="Message"]', 
        '[class*="chat-turn"]',
        '[class*="chatTurn"]',
        '[class*="conversation-item"]',
        '[class*="turn"]',
        '[data-message-id]',
        '[data-turn-id]'
      ];
      
      let targetMessage = null;
      
      // Strategy 1: Find message by context text match
      for (const sel of messageSelectors) {
        try {
          const messages = targetDoc.querySelectorAll(sel);
          for (const msg of messages) {
            if (!isVisible(msg)) continue;
            const msgText = (msg.textContent || '').toLowerCase();
            // Check if this message contains our context snippet
            if (messageContext && msgText.includes(messageContext.substring(0, 30))) {
              targetMessage = msg;
              break;
            }
          }
          if (targetMessage) break;
        } catch(e) {}
      }
      
      // Strategy 2: If no exact match, try partial matching with first 20 chars
      if (!targetMessage && messageContext.length > 20) {
        const shortContext = messageContext.substring(0, 20);
        for (const sel of messageSelectors) {
          try {
            const messages = targetDoc.querySelectorAll(sel);
            for (const msg of messages) {
              if (!isVisible(msg)) continue;
              const msgText = (msg.textContent || '').toLowerCase();
              if (msgText.includes(shortContext)) {
                targetMessage = msg;
                break;
              }
            }
            if (targetMessage) break;
          } catch(e) {}
        }
      }
      
      // Now find the button within the target message
      if (targetMessage) {
        // Look for button with matching aria-label within this message
        const buttons = targetMessage.querySelectorAll('button, [role="button"]');
        for (const btn of buttons) {
          if (!isVisible(btn)) continue;
          const btnAriaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
          if (searchLabel && btnAriaLabel && (btnAriaLabel === searchLabel || btnAriaLabel.includes(searchLabel))) {
            element = btn;
            matchMethod = 'message-action-context-match';
            break;
          }
        }
        
        // Fallback: find by text content
        if (!element) {
          for (const btn of buttons) {
            if (!isVisible(btn)) continue;
            const btnText = (btn.textContent || '').trim().toLowerCase();
            if (searchLabel && (btnText === searchLabel || btnText.includes(searchLabel))) {
              element = btn;
              matchMethod = 'message-action-text-match';
              break;
            }
          }
        }
      }
      
      // If still not found, log for debugging
      if (!element && targetMessage) {
        matchMethod = 'message-found-button-not-found';
      } else if (!targetMessage) {
        matchMethod = 'message-not-found';
      }
    }
    
    // =========================================================================
    // Composer Control by selector (model / effort / agent trigger, autopilot
    // toggle). The mobile client sends the exact Kiro selector so we don't have
    // to guess by text — reliable for any model, and it hits the autopilot
    // checkbox input directly (clicking the wrapper div does not toggle it).
    // =========================================================================
    if (info.isComposerControl && info.controlSelector && !element) {
      try {
        const el = targetDoc.querySelector(info.controlSelector);
        if (el && isVisible(el)) { element = el; matchMethod = 'composer-control'; }
      } catch (e) {}
    }
    
    // =========================================================================
    // Popup/Listbox Option by text (model / effort / agent dropdown items).
    // Matches an option inside the currently open Kiro popup by its text, so it
    // works for every option without any hardcoded model list.
    // =========================================================================
    if (info.isListboxOption && !element) {
      const search = (info.text || '').trim();
      const menus = targetDoc.querySelectorAll('.chat-input-popup-menu, [role="listbox"], [role="menu"]');
      for (const menu of menus) {
        if (!isVisible(menu)) continue;
        const opts = menu.querySelectorAll('.chat-input-popup-option, [role="option"], [role="menuitem"]');
        for (const o of opts) {
          if (!isVisible(o)) continue;
          const tx = (o.textContent || '').trim();
          if (tx === search || (search.length > 8 && (tx.startsWith(search.substring(0, 20)) || search.startsWith(tx.substring(0, 20))))) {
            element = o;
            matchMethod = 'listbox-option';
            break;
          }
        }
        if (element) break;
      }
    }
    
    // =========================================================================
    // Model Selector Button Click
    // =========================================================================
    if (isModelSelector && !element) {
      // Strategy 1: Find Kiro's specific dropdown trigger
      const kiroDropdownTrigger = targetDoc.querySelector('button.kiro-dropdown-trigger[aria-haspopup="true"]');
      if (kiroDropdownTrigger && isVisible(kiroDropdownTrigger)) {
        const triggerText = (kiroDropdownTrigger.textContent || '').toLowerCase();
        if (modelNames.some(m => triggerText.includes(m))) {
          element = kiroDropdownTrigger;
          matchMethod = 'kiro-dropdown-trigger';
        }
      }
      
      // Strategy 2: Find by aria-haspopup with model text
      if (!element) {
        const hasPopupButtons = targetDoc.querySelectorAll('button[aria-haspopup="true"], button[aria-haspopup="listbox"], button[aria-haspopup="menu"]');
        for (const btn of hasPopupButtons) {
          if (!isVisible(btn)) continue;
          const btnText = (btn.textContent || '').toLowerCase();
          if (modelNames.some(m => btnText.includes(m))) {
            element = btn;
            matchMethod = 'aria-haspopup-model';
            break;
          }
        }
      }
      
      // Strategy 3: Find by class patterns
      if (!element) {
        const modelSelectors = [
          '.kiro-dropdown-trigger',
          '[class*="model-selector"]', '[class*="modelSelector"]',
          '[class*="model-dropdown"]', '[class*="modelDropdown"]',
          'button[class*="dropdown-trigger"]'
        ];
        
        for (const sel of modelSelectors) {
          try {
            const candidates = targetDoc.querySelectorAll(sel);
            for (const c of candidates) {
              if (isVisible(c)) {
                element = c;
                matchMethod = 'model-selector-class';
                break;
              }
            }
            if (element) break;
          } catch(e) {}
        }
      }
    }
    
    // =========================================================================
    // Model Option Selection (from dropdown menu)
    // =========================================================================
    if (isModelOption && !element) {
      const searchText = (info.text || '').trim().toLowerCase();
      const searchModelName = findModelName(searchText);
      
      // Check if dropdown is currently open
      const openDropdown = targetDoc.querySelector('.kiro-dropdown-menu, [class*="dropdown-menu"][class*="open"], [role="listbox"], [role="menu"]');
      const isDropdownOpen = openDropdown && isVisible(openDropdown);
      
      // If dropdown is NOT open, we need to open it first
      if (!isDropdownOpen) {
        const dropdownTrigger = targetDoc.querySelector('.kiro-dropdown-trigger[aria-haspopup="true"], button[aria-haspopup="true"], button[aria-haspopup="listbox"]');
        if (dropdownTrigger && isVisible(dropdownTrigger)) {
          const triggerText = (dropdownTrigger.textContent || '').toLowerCase();
          if (modelNames.some(m => triggerText.includes(m))) {
            dropdownTrigger.click();
            return { found: true, clicked: true, needsRetry: true, matchMethod: 'dropdown-opened-for-option' };
          }
        }
      }
      
      // Strategy 1: Find Kiro's specific dropdown items
      const kiroDropdownItems = targetDoc.querySelectorAll('.kiro-dropdown-item, .kiro-dropdown-menu > div');
      for (const item of kiroDropdownItems) {
        if (!isVisible(item)) continue;
        const itemText = (item.textContent || '').trim().toLowerCase();
        const itemModelName = findModelName(itemText);
        
        if (searchModelName && itemModelName && searchModelName === itemModelName) {
          const searchVersion = searchText.match(/\\d+\\.?\\d*/)?.[0];
          const itemVersion = itemText.match(/\\d+\\.?\\d*/)?.[0];
          
          if (!searchVersion || !itemVersion || searchVersion === itemVersion) {
            element = item;
            matchMethod = 'kiro-dropdown-item';
            break;
          }
        }
      }
      
      // Strategy 2: Find by role selectors
      if (!element) {
        const optionSelectors = ['[role="option"]', '[role="menuitem"]', '[class*="dropdown-item"]', '[class*="menu-item"]'];
        
        for (const sel of optionSelectors) {
          try {
            const options = targetDoc.querySelectorAll(sel);
            for (const opt of options) {
              if (!isVisible(opt)) continue;
              const optText = (opt.textContent || '').trim().toLowerCase();
              if (searchText && (optText.includes(searchText) || searchText.includes(optText.substring(0, 20)))) {
                element = opt;
                matchMethod = 'model-option-role';
                break;
              }
            }
            if (element) break;
          } catch(e) {}
        }
      }
      
      // Strategy 3: Find any clickable element in dropdown with matching model name
      if (!element && searchText && searchModelName) {
        const dropdownMenu = targetDoc.querySelector('.kiro-dropdown-menu, [class*="dropdown-menu"], [role="listbox"], [role="menu"]');
        if (dropdownMenu) {
          const allItems = dropdownMenu.querySelectorAll('*');
          for (const item of allItems) {
            if (item.children.length > 5) continue;
            if (!isVisible(item)) continue;
            const itemText = (item.textContent || '').trim().toLowerCase();
            const itemModelName = findModelName(itemText);
            
            if (itemModelName && searchModelName === itemModelName) {
              element = item;
              matchMethod = 'dropdown-menu-item';
              break;
            }
          }
        }
      }
    }
    
    // =========================================================================
    // Send Button
    // =========================================================================
    if (info.isSendButton && !element) {
      const sendSelectors = ['button[data-variant="submit"]', 'svg.lucide-arrow-right', 'button[type="submit"]', 'button[aria-label*="send" i]'];
      for (const sel of sendSelectors) {
        try {
          const el = targetDoc.querySelector(sel);
          if (el) {
            element = el.closest('button') || el;
            if (element && !element.disabled) { matchMethod = 'send-button'; break; }
          }
        } catch(e) {}
      }
    }
    
    // =========================================================================
    // Toggle/Switch
    // =========================================================================
    if (isToggle && !element) {
      if (info.toggleId) {
        element = targetDoc.getElementById(info.toggleId);
        if (element) matchMethod = 'toggle-id';
      }
      if (!element && info.text) {
        const toggles = targetDoc.querySelectorAll('.kiro-toggle-switch, [role="switch"]');
        for (const t of toggles) {
          const label = t.querySelector('label');
          if (label && label.textContent.trim().toLowerCase().includes(info.text.toLowerCase())) {
            element = t.querySelector('input') || t;
            matchMethod = 'toggle-label';
            break;
          }
        }
      }
    }
    
    // =========================================================================
    // SMART DETECTION: Long text in snackbar = Dialog Choice, not Notification
    // If text is > 30 chars and we're in a snackbar, treat as dialog choice
    // =========================================================================
    const searchTextForSmartDetect = (info.text || '').trim();
    if (info.isNotificationButton && searchTextForSmartDetect.length > 30 && !info.isDialogChoice) {
      // This is likely a dialog choice card, not a simple notification button
      info.isDialogChoice = true;
      info.isNotificationButton = false;
      console.log('[Click] Smart detect: Long text in notification area, treating as dialog choice');
    }
    
    // =========================================================================
    // Dialog Choice Buttons (spec workflow options, modal choices, welcome screens)
    // MOVED BEFORE Notification handler for priority
    // =========================================================================
    if (info.isDialogChoice && !element) {
      const searchText = (info.text || '').trim().toLowerCase();
      
      // Strategy 1: Find clickable divs/buttons in snackbar body or welcome screens with matching text
      const dialogSelectors = [
        '.kiro-snackbar-body > div',
        '.kiro-snackbar-body [class*="choice"]',
        '.kiro-snackbar-body [class*="option"]',
        '.kiro-snackbar [class*="choice"]',
        '.kiro-snackbar [class*="option"]',
        '[class*="dialog"] [class*="choice"]',
        '[class*="dialog"] [class*="option"]',
        '[class*="modal"] [class*="choice"]',
        '[class*="modal"] [class*="option"]',
        '[role="dialog"] button',
        '[role="dialog"] [role="button"]',
        '[role="alertdialog"] button',
        '[role="alertdialog"] [role="button"]',
        // Welcome/onboarding screen selectors
        '[class*="welcome"] [class*="choice"]',
        '[class*="welcome"] [class*="option"]',
        '[class*="Welcome"] [class*="Choice"]',
        '[class*="Welcome"] [class*="Option"]',
        '[class*="onboarding"] [class*="choice"]',
        '[class*="onboarding"] [class*="option"]',
        '[class*="Onboarding"] [class*="Choice"]',
        '[class*="build"] [class*="choice"]',
        '[class*="build"] [class*="option"]',
        '[class*="Build"] [class*="Choice"]',
        // Direct choice/option cards
        '[class*="choice-card"]',
        '[class*="choiceCard"]',
        '[class*="ChoiceCard"]',
        '[class*="option-card"]',
        '[class*="optionCard"]',
        '[class*="OptionCard"]',
        // Vibe/Spec specific (common Kiro patterns)
        '[class*="vibe"]',
        '[class*="Vibe"]',
        '[class*="spec"]',
        '[class*="Spec"]'
      ];
      
      // DEBUG: Log what we're searching for
      console.log('[Click Debug] Searching for dialog choice:', searchText.substring(0, 50));
      
      for (const sel of dialogSelectors) {
        try {
          const items = targetDoc.querySelectorAll(sel);
          for (const item of items) {
            if (!isVisible(item)) continue;
            const itemText = (item.textContent || '').trim().toLowerCase();
            // Match if text contains search text or vice versa (partial match)
            if (searchText && (itemText.includes(searchText) || searchText.includes(itemText.substring(0, 30)))) {
              element = item;
              matchMethod = 'dialog-choice-selector';
              
              // DEBUG: Log detailed info about the found element
              console.log('[Click Debug] Found via selector:', sel);
              console.log('[Click Debug] Element tag:', item.tagName, 'class:', (item.className || '').substring(0, 80));
              console.log('[Click Debug] Element text:', itemText.substring(0, 60));
              
              // Check for React fiber
              let hasReactFiber = false;
              for (const key of Object.keys(item)) {
                if (key.startsWith('__reactFiber') || key.startsWith('__reactInternalInstance')) {
                  hasReactFiber = true;
                  console.log('[Click Debug] Has React fiber:', key);
                  break;
                }
              }
              if (!hasReactFiber) console.log('[Click Debug] NO React fiber found on element!');
              
              // Check parent for React fiber
              if (!hasReactFiber && item.parentElement) {
                for (const key of Object.keys(item.parentElement)) {
                  if (key.startsWith('__reactFiber') || key.startsWith('__reactInternalInstance')) {
                    console.log('[Click Debug] Parent has React fiber:', key);
                    break;
                  }
                }
              }
              
              break;
            }
          }
          if (element) break;
        } catch(e) {}
      }
      
      // Strategy 2: Find any clickable element in snackbar body with matching text
      if (!element && searchText) {
        const snackbarBody = targetDoc.querySelector('.kiro-snackbar-body');
        if (snackbarBody) {
          console.log('[Click Debug] Searching in snackbar-body');
          const allClickables = snackbarBody.querySelectorAll('div, button, [role="button"], [tabindex="0"], [class*="cursor-pointer"]');
          for (const item of allClickables) {
            if (!isVisible(item)) continue;
            if (item.children.length > 10) continue;
            const itemText = (item.textContent || '').trim().toLowerCase();
            if (itemText.includes(searchText) || searchText.includes(itemText.substring(0, 30))) {
              element = item;
              matchMethod = 'dialog-choice-snackbar-body';
              console.log('[Click Debug] Found in snackbar-body:', item.tagName, (item.className || '').substring(0, 60));
              break;
            }
          }
        }
      }
      
      // Strategy 3: Find by cursor pointer style in snackbar/dialog areas
      if (!element && searchText) {
        const dialogContainers = targetDoc.querySelectorAll('.kiro-snackbar, [role="dialog"], [role="alertdialog"], [class*="modal"], [class*="dialog"], [class*="welcome"], [class*="Welcome"]');
        console.log('[Click Debug] Found', dialogContainers.length, 'dialog/snackbar containers');
        for (const container of dialogContainers) {
          if (!isVisible(container)) continue;
          console.log('[Click Debug] Checking container:', container.className?.substring(0, 60));
          const allElements = container.querySelectorAll('*');
          for (const item of allElements) {
            if (!isVisible(item)) continue;
            if (item.children.length > 10) continue;
            const computedStyle = window.getComputedStyle(item);
            const isClickable = computedStyle.cursor === 'pointer' || item.getAttribute('tabindex') === '0';
            if (!isClickable) continue;
            const itemText = (item.textContent || '').trim().toLowerCase();
            if (itemText.includes(searchText) || searchText.includes(itemText.substring(0, 30))) {
              element = item;
              matchMethod = 'dialog-choice-cursor-pointer';
              console.log('[Click Debug] Found via cursor-pointer:', item.tagName, (item.className || '').substring(0, 60));
              break;
            }
          }
          if (element) break;
        }
      }
      
      // Strategy 4: Search for clickable cards anywhere
      if (!element && searchText) {
        const cardSelectors = ['[class*="card"]', '[class*="Card"]', '[class*="choice"]', '[class*="Choice"]', '[class*="option"]', '[class*="Option"]'];
        for (const sel of cardSelectors) {
          try {
            const cards = targetDoc.querySelectorAll(sel);
            for (const card of cards) {
              if (!isVisible(card)) continue;
              if (card.children.length > 15) continue;
              const cardText = (card.textContent || '').trim().toLowerCase();
              if (cardText.includes(searchText) || searchText.includes(cardText.substring(0, 30))) {
                const computedStyle = window.getComputedStyle(card);
                if (computedStyle.cursor === 'pointer' || card.getAttribute('tabindex') === '0' || card.tagName === 'BUTTON' || card.getAttribute('role') === 'button') {
                  element = card;
                  matchMethod = 'dialog-choice-card-fallback';
                  break;
                }
              }
            }
            if (element) break;
          } catch(e) {}
        }
      }
    }
    
    // =========================================================================
    // Notification Banner Buttons
    // =========================================================================
    if (info.isNotificationButton && !element) {
      const searchText = (info.text || '').trim().toLowerCase();
      const searchAriaLabel = (info.ariaLabel || '').trim().toLowerCase();
      
      const snackbarButtons = targetDoc.querySelectorAll('.kiro-snackbar button, .kiro-snackbar-actions button, .kiro-snackbar-header button');
      
      // Strategy 1: Find by text
      for (const btn of snackbarButtons) {
        if (!isVisible(btn)) continue;
        const btnText = (btn.textContent || '').trim().toLowerCase();
        if (searchText && btnText && (btnText.includes(searchText) || searchText.includes(btnText))) {
          element = btn;
          matchMethod = 'snackbar-button-text';
          break;
        }
      }
      
      // Strategy 2: Find X/close/dismiss icon button
      if (!element && (searchText === 'close' || searchText === 'dismiss' || searchText === 'x' || 
                       searchText === 'icon-button' || searchText === '' || !searchText ||
                       searchAriaLabel.includes('close') || searchAriaLabel.includes('dismiss'))) {
        for (const btn of snackbarButtons) {
          if (!isVisible(btn)) continue;
          const btnAriaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
          const isExpandBtn = btnAriaLabel.includes('expand') || btn.classList.contains('kiro-snackbar-expand');
          
          if (isExpandBtn) continue;
          
          if (btnAriaLabel.includes('close') || btnAriaLabel.includes('dismiss') ||
              btn.querySelector('.codicon-close, .codicon-x, [class*="close"]')) {
            element = btn;
            matchMethod = 'snackbar-dismiss-button';
            break;
          }
          
          const isIconBtn = btn.classList.contains('kiro-icon-button');
          const btnText = (btn.textContent || '').trim();
          if (isIconBtn && !btnText && !isExpandBtn) {
            element = btn;
            matchMethod = 'snackbar-icon-dismiss';
            break;
          }
        }
      }
      
      // Strategy 3: Find by aria-label
      if (!element && searchAriaLabel && !searchAriaLabel.includes('expand')) {
        for (const btn of snackbarButtons) {
          if (!isVisible(btn)) continue;
          const btnAriaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
          if (btnAriaLabel.includes('expand')) continue;
          if (btnAriaLabel && (btnAriaLabel.includes(searchAriaLabel) || searchAriaLabel.includes(btnAriaLabel))) {
            element = btn;
            matchMethod = 'snackbar-button-aria';
            break;
          }
        }
      }
      
      // Strategy 4: Find in agent-outcome notifications
      if (!element) {
        const outcomeButtons = targetDoc.querySelectorAll('.agent-outcome button, .agent-outcome-notification button, [class*="outcome"] button');
        for (const btn of outcomeButtons) {
          if (!isVisible(btn)) continue;
          const btnText = (btn.textContent || '').trim().toLowerCase();
          if (searchText && (btnText.includes(searchText) || searchText.includes(btnText))) {
            element = btn;
            matchMethod = 'outcome-button';
            break;
          }
        }
      }
      
      // Strategy 5: Find expand/collapse arrow (only if explicitly requested)
      if (!element && (searchText.includes('expand') || searchAriaLabel.includes('expand'))) {
        const expandArrow = targetDoc.querySelector('.kiro-snackbar [class*="expand"], .kiro-snackbar [class*="arrow"], .kiro-snackbar [class*="chevron"], .kiro-snackbar button[aria-label*="expand" i]');
        if (expandArrow && isVisible(expandArrow)) {
          element = expandArrow;
          matchMethod = 'snackbar-expand';
        }
      }
    }
    
    // =========================================================================
    // Tool Action Buttons (edit, cancel, approve, run buttons in tool panels)
    // =========================================================================
    if (info.isToolActionButton && !element) {
      const searchAction = (info.actionType || info.ariaLabel || info.text || '').trim().toLowerCase();
      
      // Map common action names to codicon classes
      const actionToIconMap = {
        'edit': ['codicon-edit', 'codicon-pencil'],
        'cancel': ['codicon-x', 'codicon-close', 'codicon-chrome-close'],
        'approve': ['codicon-check', 'codicon-pass', 'codicon-check-all'],
        'run': ['codicon-play', 'codicon-run', 'codicon-debug-start'],
        'stop': ['codicon-debug-stop', 'codicon-stop'],
        'retry': ['codicon-refresh', 'codicon-sync'],
        'trust': ['codicon-shield', 'codicon-verified'],
        'accept': ['codicon-check', 'codicon-pass']
      };
      
      // Strategy 1: Find by aria-label
      if (searchAction) {
        const ariaButtons = targetDoc.querySelectorAll('button[aria-label], [role="button"][aria-label]');
        for (const btn of ariaButtons) {
          if (!isVisible(btn)) continue;
          const btnAriaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
          if (btnAriaLabel.includes(searchAction) || searchAction.includes(btnAriaLabel)) {
            element = btn;
            matchMethod = 'tool-action-aria';
            break;
          }
        }
      }
      
      // Strategy 2: Find by codicon class
      if (!element && searchAction) {
        const iconClasses = actionToIconMap[searchAction] || [];
        for (const iconClass of iconClasses) {
          const icons = targetDoc.querySelectorAll('.' + iconClass);
          for (const icon of icons) {
            if (!isVisible(icon)) continue;
            // Get the clickable parent (button or role=button)
            const clickableParent = icon.closest('button, [role="button"], [tabindex="0"]');
            if (clickableParent && isVisible(clickableParent)) {
              element = clickableParent;
              matchMethod = 'tool-action-icon-' + iconClass;
              break;
            }
          }
          if (element) break;
        }
      }
      
      // Strategy 3: Find icon buttons in tool/command panels by position
      if (!element && searchAction) {
        // Look for button groups in tool panels
        const toolPanelSelectors = [
          '[class*="tool-action"]',
          '[class*="toolAction"]',
          '[class*="command-action"]',
          '[class*="background-process"]',
          '[class*="backgroundProcess"]',
          '[class*="tool-panel"]',
          '[class*="action-bar"]',
          '[class*="actionBar"]'
        ];
        
        for (const sel of toolPanelSelectors) {
          try {
            const panels = targetDoc.querySelectorAll(sel);
            for (const panel of panels) {
              if (!isVisible(panel)) continue;
              const buttons = panel.querySelectorAll('button, [role="button"]');
              for (const btn of buttons) {
                if (!isVisible(btn)) continue;
                const btnAriaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
                const btnTitle = (btn.getAttribute('title') || '').toLowerCase();
                const hasMatchingIcon = actionToIconMap[searchAction]?.some(cls => btn.querySelector('.' + cls));
                
                if (btnAriaLabel.includes(searchAction) || btnTitle.includes(searchAction) || hasMatchingIcon) {
                  element = btn;
                  matchMethod = 'tool-action-panel';
                  break;
                }
              }
              if (element) break;
            }
            if (element) break;
          } catch(e) {}
        }
      }
      
      // Strategy 4: Find any visible icon button with matching codicon
      if (!element && searchAction && actionToIconMap[searchAction]) {
        const allButtons = targetDoc.querySelectorAll('button, [role="button"]');
        for (const btn of allButtons) {
          if (!isVisible(btn)) continue;
          const hasMatchingIcon = actionToIconMap[searchAction].some(cls => btn.querySelector('.' + cls));
          if (hasMatchingIcon) {
            element = btn;
            matchMethod = 'tool-action-global-icon';
            break;
          }
        }
      }
    }
    
    // =========================================================================
    // Close Button
    // =========================================================================
    if (isCloseButton && !element) {
      const closeButtons = targetDoc.querySelectorAll('[aria-label="close"], .kiro-tabs-item-close, [class*="close"]');
      if (info.parentTabLabel) {
        const searchLabel = info.parentTabLabel.trim().toLowerCase();
        for (const btn of closeButtons) {
          const parentTab = btn.closest('[role="tab"]');
          if (parentTab) {
            const labelEl = parentTab.querySelector('.kiro-tabs-item-label, [class*="label"]');
            const tabLabel = labelEl ? labelEl.textContent.trim().toLowerCase() : '';
            if (tabLabel.includes(searchLabel) || searchLabel.includes(tabLabel)) {
              element = btn;
              matchMethod = 'close-button-by-tab';
              break;
            }
          }
        }
      }
      if (!element && closeButtons.length > 0) {
        for (const btn of closeButtons) {
          const parentTab = btn.closest('[role="tab"]');
          if (parentTab && parentTab.getAttribute('aria-selected') === 'true') {
            element = btn;
            matchMethod = 'close-button-selected';
            break;
          }
        }
      }
    }
    
    // =========================================================================
    // Tab Click
    // =========================================================================
    if (isTabClick && !element) {
      const allTabs = targetDoc.querySelectorAll('[role="tab"]');
      const searchText = (info.tabLabel || info.text || '').trim().toLowerCase();
      for (const tab of allTabs) {
        const labelEl = tab.querySelector('.kiro-tabs-item-label, [class*="label"]');
        const tabText = labelEl ? labelEl.textContent.trim().toLowerCase() : tab.textContent.trim().toLowerCase();
        if (searchText && (tabText.includes(searchText) || searchText.includes(tabText))) {
          element = tab;
          matchMethod = 'tab-label';
          break;
        }
      }
    }
    
    // =========================================================================
    // File Link
    // =========================================================================
    if (info.isFileLink && info.filePath && !element) {
      const fileName = info.filePath.split('/').pop().split('\\\\').pop();
      const fileSelectors = ['a[href*="' + fileName + '"]', '[data-path*="' + fileName + '"]', 'code', 'span', '[class*="file"]'];
      for (const selector of fileSelectors) {
        try {
          const candidates = targetDoc.querySelectorAll(selector);
          for (const el of candidates) {
            const text = (el.textContent || '').trim();
            if (text.includes(info.filePath) || text.includes(fileName)) {
              element = el;
              matchMethod = 'file-link';
              break;
            }
          }
          if (element) break;
        } catch(e) {}
      }
    }
    
    // =========================================================================
    // Aria Label Match
    // =========================================================================
    if (info.ariaLabel && !element && !isCloseButton) {
      try {
        const escapedLabel = info.ariaLabel.replace(/"/g, '\\\\"');
        const candidates = targetDoc.querySelectorAll('[aria-label="' + escapedLabel + '"]');
        const targetIndex = typeof info.elementIndex === 'number' ? info.elementIndex : -1;
        
        // Collect all visible matching elements
        const matchingElements = [];
        for (const c of candidates) {
          if (!isVisible(c)) continue;
          const label = (c.getAttribute('aria-label') || '').toLowerCase();
          if (!label.includes('close')) {
            matchingElements.push(c);
          }
        }
        
        // Use index-based selection if provided and multiple matches exist
        if (targetIndex >= 0 && matchingElements.length > 1) {
          if (targetIndex < matchingElements.length) {
            element = matchingElements[targetIndex];
            matchMethod = 'aria-label-indexed-' + targetIndex + '-of-' + matchingElements.length;
          } else {
            // Index out of bounds means this DOM no longer matches the snapshot the
            // index came from. Picking another element here is a guess that clicks
            // something the user never tapped, so leave it unresolved.
            console.log('[Click] aria-label index ' + targetIndex + ' out of range (' + matchingElements.length + ' matches), not guessing');
          }
        } else if (matchingElements.length > 0) {
          element = matchingElements[0];
          matchMethod = 'aria-label';
        }
      } catch(e) {}
    }
    
    // =========================================================================
    // History/Session List Items
    // =========================================================================
    if (info.isHistoryItem && !element) {
      const searchText = (info.text || '').trim().toLowerCase();
      const datePattern = /\\d{1,2}\\/\\d{1,2}\\/\\d{4}|\\d{1,2}:\\d{2}:\\d{2}/;
      const allDivs = targetDoc.querySelectorAll('div, li, article');
      const historyItems = [];
      
      for (const item of allDivs) {
        if (item.children.length > 15) continue;
        const text = item.textContent || '';
        if (datePattern.test(text) && text.length > 20 && text.length < 500) {
          historyItems.push(item);
        }
      }
      
      for (const item of historyItems) {
        const itemText = (item.textContent || '').trim().toLowerCase();
        if (searchText && (itemText.includes(searchText) || searchText.includes(itemText.substring(0, 50)))) {
          element = item;
          matchMethod = 'history-item-date';
          break;
        }
      }
      
      if (!element) {
        const historySelectors = ['[role="listitem"]', '[role="option"]', '[class*="history"] > *', '[class*="session"] > *'];
        for (const selector of historySelectors) {
          try {
            const items = targetDoc.querySelectorAll(selector);
            for (const item of items) {
              const itemText = (item.textContent || '').trim().toLowerCase();
              if (searchText && (itemText.includes(searchText) || searchText.includes(itemText.substring(0, 50)))) {
                element = item;
                matchMethod = 'history-item-selector';
                break;
              }
            }
            if (element) break;
          } catch(e) {}
        }
      }
    }
    
    // =========================================================================
    // Text Content Match (fallback)
    // =========================================================================
    if (info.text && info.text.trim() && !element) {
      const searchText = info.text.trim();
      const searchTextLower = searchText.toLowerCase();
      const targetIndex = typeof info.elementIndex === 'number' ? info.elementIndex : -1;
      
      // Extended selectors to include dialog/snackbar elements AND generic divs with cursor pointer
      const allElements = targetDoc.querySelectorAll('button, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="listitem"], a, [tabindex="0"], [class*="cursor-pointer"], .kiro-snackbar-body > div, [class*="choice"], [class*="option"], [class*="action"], [class*="card"], [class*="Card"]');
      
      // Collect ALL matching elements first (for index-based selection)
      const matchingElements = [];
      
      for (const el of allElements) {
        if (!isVisible(el)) continue;
        if (!isCloseButton) {
          const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
          if (ariaLabel.includes('close')) continue;
        }
        const elText = (el.textContent || '').trim();
        const elTextLower = elText.toLowerCase();
        
        // Exact match or contains match
        if (elText === searchText || elTextLower === searchTextLower || 
            elText.includes(searchText) || elTextLower.includes(searchTextLower) ||
            (elText.length >= 10 && searchText.includes(elText)) ||
            (elTextLower.length >= 10 && searchTextLower.includes(elTextLower))) {
          matchingElements.push(el);
        }
      }
      
      // Sort matching elements to prefer clickable ones (cursor: pointer)
      if (matchingElements.length > 1) {
        matchingElements.sort((a, b) => {
          const aStyle = window.getComputedStyle(a);
          const bStyle = window.getComputedStyle(b);
          const aClickable = aStyle.cursor === 'pointer' || a.getAttribute('tabindex') === '0' || a.getAttribute('role') === 'button';
          const bClickable = bStyle.cursor === 'pointer' || b.getAttribute('tabindex') === '0' || b.getAttribute('role') === 'button';
          if (aClickable && !bClickable) return -1;
          if (!aClickable && bClickable) return 1;
          // Prefer elements with fewer children (more specific)
          return a.children.length - b.children.length;
        });
      }
      
      // If we have an index and multiple matches, use the indexed element
      if (targetIndex >= 0 && matchingElements.length > 1) {
        if (targetIndex < matchingElements.length) {
          element = matchingElements[targetIndex];
          matchMethod = 'text-content-indexed-' + targetIndex + '-of-' + matchingElements.length;
        } else {
          // Index out of bounds means this DOM no longer matches the snapshot the
          // index came from. Picking another element here is a guess that clicks
          // something the user never tapped, so leave it unresolved.
          console.log('[Click] text index ' + targetIndex + ' out of range (' + matchingElements.length + ' matches), not guessing');
        }
      } else if (matchingElements.length > 0) {
        // No index provided or only one match, use first match (now sorted by clickability)
        element = matchingElements[0];
        matchMethod = 'text-content';
      }
      
      // If still not found, try a broader search in snackbar/dialog/welcome areas
      if (!element) {
        const containers = targetDoc.querySelectorAll('.kiro-snackbar, [role="dialog"], [role="alertdialog"], [class*="modal"], [class*="dialog"], [class*="welcome"], [class*="Welcome"], [class*="build"], [class*="Build"]');
        for (const container of containers) {
          if (!isVisible(container)) continue;
          const clickables = container.querySelectorAll('div, button, span, [tabindex]');
          const dialogMatches = [];
          
          for (const el of clickables) {
            if (!isVisible(el)) continue;
            if (el.children.length > 10) continue;
            const elText = (el.textContent || '').trim();
            const elTextLower = elText.toLowerCase();
            if (elTextLower.includes(searchTextLower) || searchTextLower.includes(elTextLower.substring(0, 30))) {
              dialogMatches.push(el);
            }
          }
          
          if (dialogMatches.length > 0) {
            if (targetIndex >= 0 && targetIndex < dialogMatches.length) {
              element = dialogMatches[targetIndex];
              matchMethod = 'text-content-dialog-indexed';
            } else {
              element = dialogMatches[0];
              matchMethod = 'text-content-dialog';
            }
            break;
          }
        }
      }
    }
    
    // =========================================================================
    // Command Trust Dialog Buttons (Full command, Partial, Base options)
    // =========================================================================
    if (info.isCommandTrustOption && !element) {
      const searchText = (info.text || '').trim().toLowerCase();
      
      // Strategy: Find ANY div with matching text - these are clickable trust options
      if (searchText) {
        const allDivs = targetDoc.querySelectorAll('div');
        for (const div of allDivs) {
          if (!isVisible(div)) continue;
          if (div.children.length > 25) continue;
          
          const divText = (div.textContent || '').trim().toLowerCase();
          if (divText.length < 5 || divText.length > 300) continue;
          
          // Match by keywords: full command, base
          const hasFullMatch = searchText.includes('full') && divText.includes('full');
          const hasBaseMatch = searchText.includes('base') && divText.includes('base');
          const hasDirectMatch = divText.startsWith(searchText.substring(0, 15)) || 
                                  searchText.startsWith(divText.substring(0, 15));
          
          if (hasFullMatch || hasBaseMatch || hasDirectMatch) {
            element = div;
            matchMethod = 'command-trust-div';
            break;
          }
        }
      }
    }
    
    // =========================================================================
    // Command Panel Action Buttons (play/run, edit, cancel, approve)
    // =========================================================================
    if (info.isCommandPanelAction && !element) {
      const searchAction = (info.actionType || '').trim().toLowerCase();
      const searchText = (info.text || '').trim().toLowerCase();
      const searchAriaLabel = (info.ariaLabel || '').trim().toLowerCase();
      
      // Map actions to codicon classes
      const commandActionIcons = {
        'run': ['codicon-play', 'codicon-run', 'codicon-debug-start', 'codicon-triangle-right'],
        'play': ['codicon-play', 'codicon-run', 'codicon-debug-start', 'codicon-triangle-right'],
        'edit': ['codicon-edit', 'codicon-pencil'],
        'cancel': ['codicon-x', 'codicon-close', 'codicon-chrome-close'],
        'approve': ['codicon-check', 'codicon-pass'],
        'stop': ['codicon-debug-stop', 'codicon-stop', 'codicon-primitive-square']
      };
      
      // Strategy 1: Find by aria-label match (most reliable for icon buttons)
      if (searchAriaLabel) {
        const allButtons = targetDoc.querySelectorAll('button, [role="button"]');
        for (const btn of allButtons) {
          if (!isVisible(btn)) continue;
          const btnAriaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
          const btnTitle = (btn.getAttribute('title') || '').toLowerCase();
          // Exact or partial match on aria-label
          if ((btnAriaLabel && (btnAriaLabel === searchAriaLabel || btnAriaLabel.includes(searchAriaLabel) || searchAriaLabel.includes(btnAriaLabel))) ||
              (btnTitle && (btnTitle === searchAriaLabel || btnTitle.includes(searchAriaLabel) || searchAriaLabel.includes(btnTitle)))) {
            element = btn;
            matchMethod = 'command-panel-aria-exact';
            break;
          }
        }
      }
      
      // Strategy 2: Find by action type aria-label keywords
      if (!element && searchAction) {
        const actionKeywords = {
          'run': ['run', 'play', 'execute', 'start'],
          'edit': ['edit', 'modify', 'change'],
          'cancel': ['cancel', 'reject', 'deny', 'dismiss'],
          'approve': ['approve', 'accept', 'allow', 'confirm'],
          'stop': ['stop', 'terminate', 'kill', 'abort']
        };
        const keywords = actionKeywords[searchAction] || [searchAction];
        
        const allButtons = targetDoc.querySelectorAll('button, [role="button"]');
        for (const btn of allButtons) {
          if (!isVisible(btn)) continue;
          const btnAriaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
          const btnTitle = (btn.getAttribute('title') || '').toLowerCase();
          
          for (const keyword of keywords) {
            if (btnAriaLabel.includes(keyword) || btnTitle.includes(keyword)) {
              element = btn;
              matchMethod = 'command-panel-action-keyword-' + keyword;
              break;
            }
          }
          if (element) break;
        }
      }
      
      // Strategy 3: Find by codicon icon
      if (!element && searchAction && commandActionIcons[searchAction]) {
        for (const iconClass of commandActionIcons[searchAction]) {
          const icons = targetDoc.querySelectorAll('.' + iconClass);
          for (const icon of icons) {
            if (!isVisible(icon)) continue;
            const clickableParent = icon.closest('button, [role="button"], [tabindex="0"]');
            if (clickableParent && isVisible(clickableParent)) {
              element = clickableParent;
              matchMethod = 'command-panel-icon-' + iconClass;
              break;
            }
          }
          if (element) break;
        }
      }
      
      // Strategy 4: Find green/colored play button (often has specific styling)
      if (!element && (searchAction === 'run' || searchAction === 'play')) {
        const allButtons = targetDoc.querySelectorAll('button, [role="button"]');
        for (const btn of allButtons) {
          if (!isVisible(btn)) continue;
          // Check for play icon inside
          if (btn.querySelector('.codicon-play, .codicon-run, .codicon-debug-start, .codicon-triangle-right, [class*="play"], [class*="run"]')) {
            element = btn;
            matchMethod = 'command-panel-play-icon';
            break;
          }
          // Check for green color (common for run buttons)
          const computedStyle = window.getComputedStyle(btn);
          const bgColor = computedStyle.backgroundColor;
          if (bgColor && (bgColor.includes('rgb(0, 128') || bgColor.includes('rgb(34, 197') || bgColor.includes('rgb(22, 163') || bgColor.includes('green'))) {
            element = btn;
            matchMethod = 'command-panel-green-button';
            break;
          }
        }
      }
    }
    
    // =========================================================================
    // UNIVERSAL FALLBACK - Last resort for any clickable element
    // This handles cases where specific handlers fail to find the element
    // =========================================================================
    if (!element && info.text && info.text.trim()) {
      const searchText = info.text.trim();
      const searchTextLower = searchText.toLowerCase();
      const searchWords = searchTextLower.split(/\\s+/).filter(w => w.length > 2);
      
      // Strategy 1: Find ANY visible element with matching text
      const allElements = targetDoc.querySelectorAll('*');
      let bestMatch = null;
      let bestScore = 0;
      
      for (const el of allElements) {
        if (!isVisible(el)) continue;
        // Skip containers with many children (likely wrapper divs)
        if (el.children.length > 12) continue;
        // Skip very small elements
        const rect = el.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 15) continue;
        
        const elText = (el.textContent || '').trim();
        const elTextLower = elText.toLowerCase();
        
        // Skip if text is too long (likely a container)
        if (elText.length > 300) continue;
        
        // Calculate match score
        let score = 0;
        
        // Exact match
        if (elTextLower === searchTextLower) score = 100;
        // Contains full search text
        else if (elTextLower.includes(searchTextLower)) score = 80;
        // Search text contains element text
        else if (searchTextLower.includes(elTextLower) && elText.length > 3) score = 70;
        // Word matching
        else {
          const matchedWords = searchWords.filter(w => elTextLower.includes(w));
          if (matchedWords.length > 0) {
            score = 30 + (matchedWords.length / searchWords.length) * 40;
          }
        }
        
        // Boost score for clickable elements
        const computedStyle = window.getComputedStyle(el);
        if (computedStyle.cursor === 'pointer') score += 15;
        if (el.tagName === 'BUTTON') score += 20;
        if (el.getAttribute('role') === 'button') score += 15;
        if (el.getAttribute('tabindex') === '0') score += 10;
        if (el.onclick) score += 10;
        
        // Boost for elements in snackbar/dialog
        if (el.closest('.kiro-snackbar, [role="dialog"], [class*="modal"]')) score += 10;
        
        if (score > bestScore) {
          bestScore = score;
          bestMatch = el;
        }
      }
      
      // Use best match if score is good enough
      if (bestMatch && bestScore >= 40) {
        element = bestMatch;
        matchMethod = 'universal-fallback-score-' + bestScore;
      }
      
      // Strategy 2: If still no match, try clicking at coordinates of text
      if (!element) {
        // Find element containing the text using TreeWalker
        const walker = document.createTreeWalker(
          targetDoc.body,
          NodeFilter.SHOW_TEXT,
          null,
          false
        );
        
        let node;
        while (node = walker.nextNode()) {
          const nodeText = (node.textContent || '').trim().toLowerCase();
          // Whitespace-only text nodes are everywhere, and an empty string is a
          // substring of anything - without this guard the reverse test below is
          // true for every search string, so a total miss ends up clicking the
          // first container in the conversation.
          if (nodeText.length < 4) continue;
          const containsSearch = searchTextLower.length >= 3 && nodeText.includes(searchTextLower);
          const isPartOfSearch = searchTextLower.length > nodeText.length &&
            searchTextLower.includes(nodeText.substring(0, 20));
          if (containsSearch || isPartOfSearch) {
            const parent = node.parentElement;
            if (parent && isVisible(parent)) {
              element = parent;
              matchMethod = 'universal-text-walker';
              break;
            }
          }
        }
      }
    }
    
    // =========================================================================
    // Execute Click
    // =========================================================================
    if (!element) return { found: false, error: 'Element not found' };
    
    // CRITICAL: Find the element with actual React onClick handler
    // The element we found by text might be a container, not the actual clickable
    let clickTarget = element;
    let reactClickableFound = false;
    
    // exactClick: click the resolved element itself and skip the ancestor/child
    // React-handler search. Required for precise selector targets like the
    // autopilot checkbox input, whose onClick lives on a wrapper that does NOT
    // toggle when clicked — redirecting to it silently breaks the toggle.
    if (info.exactClick) {
      console.log('[Click] exactClick: using resolved element directly');
    } else if (hasReactOnClick(element)) {
      // First check if current element has React onClick
      console.log('[Click] Current element has React onClick');
      reactClickableFound = true;
    } else {
      // Try to find clickable ancestor (handler might be on parent)
      const clickableAncestor = findClickableAncestor(element);
      if (clickableAncestor) {
        clickTarget = clickableAncestor;
        matchMethod = matchMethod + '-react-ancestor';
        reactClickableFound = true;
        console.log('[Click] Using ancestor with React onClick:', clickableAncestor.tagName);
      } else {
        // Try to find clickable child
        const clickableChild = findClickableChild(element);
        if (clickableChild) {
          clickTarget = clickableChild;
          matchMethod = matchMethod + '-react-child';
          reactClickableFound = true;
          console.log('[Click] Using child with React onClick:', clickableChild.tagName);
        }
      }
    }
    
    if (!reactClickableFound && !info.exactClick) {
      console.log('[Click] WARNING: No React onClick found on element or ancestors/children');
    }
    
    // Use the click target (might be different from original element)
    element = clickTarget;
    
    // Get bounding rect for position info
    const rect = element.getBoundingClientRect();
    
    const elementInfo = {
      tag: element.tagName,
      className: element.className?.substring?.(0, 150) || '',
      role: element.getAttribute('role'),
      ariaHaspopup: element.getAttribute('aria-haspopup'),
      ariaExpanded: element.getAttribute('aria-expanded'),
      dataState: element.getAttribute('data-state'),
      tabindex: element.getAttribute('tabindex'),
      textContent: (element.textContent || '').substring(0, 80),
      cursor: window.getComputedStyle(element).cursor,
      pointerEvents: window.getComputedStyle(element).pointerEvents,
      childCount: element.children.length,
      parentTag: element.parentElement?.tagName,
      parentClass: (element.parentElement?.className || '').substring(0, 100),
      grandparentTag: element.parentElement?.parentElement?.tagName,
      grandparentClass: (element.parentElement?.parentElement?.className || '').substring(0, 100),
      boundingRect: { 
        top: Math.round(rect.top), 
        left: Math.round(rect.left), 
        width: Math.round(rect.width), 
        height: Math.round(rect.height) 
      },
      isInViewport: rect.top >= 0 && rect.left >= 0 && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth,
      hasOnclick: !!element.onclick,
      hasClickListeners: element._listeners ? Object.keys(element._listeners).includes('click') : 'unknown'
    };
    
    // DETAILED DEBUG LOG - Print full element hierarchy
    console.log('[Click] === DETAILED ELEMENT INFO ===');
    console.log('[Click] Tag:', elementInfo.tag);
    console.log('[Click] Class:', elementInfo.className);
    console.log('[Click] Role:', elementInfo.role, '| Tabindex:', elementInfo.tabindex);
    console.log('[Click] Text:', elementInfo.textContent);
    console.log('[Click] Cursor:', elementInfo.cursor, '| PointerEvents:', elementInfo.pointerEvents);
    console.log('[Click] Rect:', JSON.stringify(elementInfo.boundingRect), '| InViewport:', elementInfo.isInViewport);
    console.log('[Click] Parent:', elementInfo.parentTag, '-', elementInfo.parentClass?.substring(0, 60));
    console.log('[Click] Grandparent:', elementInfo.grandparentTag, '-', elementInfo.grandparentClass?.substring(0, 60));
    console.log('[Click] Children:', elementInfo.childCount, '| HasOnclick:', elementInfo.hasOnclick);
    console.log('[Click] =============================');

    
    try {
      // Always use full event sequence for React/modern framework compatibility
      // Modern frameworks often use PointerEvents instead of MouseEvents
      const rect = element.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      
      const eventOpts = { 
        bubbles: true, 
        cancelable: true, 
        view: window,
        clientX: centerX,
        clientY: centerY,
        button: 0,
        buttons: 1,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        width: 1,
        height: 1,
        pressure: 0.5
      };
      
      // Focus element first for accessibility and some components that require focus
      if (element.focus && typeof element.focus === 'function') {
        try { element.focus(); } catch(e) {}
      }
      
      // CRITICAL: Dispatch PointerEvents FIRST - modern React/UI libs use these
      // Many snackbar/dialog components use onPointerDown instead of onClick
      try {
        element.dispatchEvent(new PointerEvent('pointerenter', { ...eventOpts, bubbles: false }));
        element.dispatchEvent(new PointerEvent('pointerover', eventOpts));
        element.dispatchEvent(new PointerEvent('pointerdown', eventOpts));
        element.dispatchEvent(new PointerEvent('pointerup', eventOpts));
      } catch(pe) {
        console.log('[Click] PointerEvent dispatch failed, continuing with MouseEvents');
      }
      
      // Then dispatch MouseEvents for legacy compatibility
      element.dispatchEvent(new MouseEvent('mouseenter', { ...eventOpts, bubbles: false }));
      element.dispatchEvent(new MouseEvent('mouseover', eventOpts));
      element.dispatchEvent(new MouseEvent('mousedown', eventOpts));
      element.dispatchEvent(new MouseEvent('mouseup', eventOpts));
      element.dispatchEvent(new MouseEvent('click', eventOpts));
      
      return { found: true, clicked: true, matchMethod, elementInfo };
    } catch (e) {
      // Fallback to simple click if event dispatch fails
      try {
        element.click();
        return { found: true, clicked: true, matchMethod: matchMethod + '-fallback', elementInfo };
      } catch (e2) {
        return { found: true, clicked: false, error: 'Click failed: ' + e2.message };
      }
    }
  })()`;
}

/**
 * Click an element in the Kiro UI via CDP
 * @param {CDPConnection} cdp - CDP connection
 * @param {object} clickInfo - Element identification info (should be sanitized)
 * @returns {Promise<{success: boolean, matchMethod?: string, error?: string}>}
 */
export async function clickElement(cdp, clickInfo) {
  // Log click attempt with relevant flags
  const flags = [];
  if (clickInfo.isCommandTrustOption) flags.push('CommandTrust');
  if (clickInfo.isCommandPanelAction) flags.push('CommandAction:' + (clickInfo.actionType || '?'));
  if (clickInfo.isToolActionButton) flags.push('ToolAction:' + (clickInfo.actionType || '?'));
  if (clickInfo.isNotificationButton) flags.push('Notification');
  if (clickInfo.isDialogChoice) flags.push('DialogChoice');
  if (clickInfo.isMessageActionButton) flags.push('MessageAction');
  if (clickInfo.parentMessageContext) flags.push('Context:' + clickInfo.parentMessageContext.substring(0, 20) + '...');
  if (typeof clickInfo.elementIndex === 'number') flags.push(`Index:${clickInfo.elementIndex}/${clickInfo.totalMatches || '?'}`);

  console.log(`[Click] Attempting: "${(clickInfo.text || clickInfo.ariaLabel || 'unknown').substring(0, 40)}" [${flags.join(', ') || 'generic'}]`);

  const script = buildClickScript(clickInfo);

  // Get all available contexts to try
  const contextsToTry = [cdp.rootContextId];

  // Add other contexts if available (for snackbar/dialog in different context)
  if (cdp.contexts && cdp.contexts.length > 1) {
    for (const ctx of cdp.contexts) {
      if (ctx.id !== cdp.rootContextId) {
        contextsToTry.push(ctx.id);
      }
    }
    console.log(`[Click] Will try ${contextsToTry.length} context(s): ${contextsToTry.join(', ')}`);
  }

  let lastError = null;
  let lastElementInfo = null;

  // Try each context until we find and click the element
  for (const contextId of contextsToTry) {
    try {
      console.log(`[Click] Trying context ${contextId}...`);

      const result = await cdp.call('Runtime.evaluate', {
        expression: script,
        contextId: contextId,
        returnByValue: true
      });

      const elementInfo = result.result?.value;

      if (!elementInfo?.found) {
        console.log(`[Click] Element not found in context ${contextId}`);
        continue; // Try next context
      }

      lastElementInfo = elementInfo;

      // If JS click worked, we're done
      if (elementInfo.clicked) {
        console.log(`[Click] Success via: ${elementInfo.matchMethod} (context ${contextId})`);
        return {
          success: true,
          matchMethod: elementInfo.matchMethod,
          needsRetry: elementInfo.needsRetry,
          elementInfo: elementInfo.elementInfo,
          contextId: contextId
        };
      }

      // If element was found but JS click didn't work, try CDP Input.dispatchMouseEvent
      if (elementInfo.elementInfo?.boundingRect) {
        const rect = elementInfo.elementInfo.boundingRect;
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;

        console.log(`[Click] JS click failed in context ${contextId}, trying CDP Input at (${x}, ${y})`);

        try {
          await cdp.call('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: x,
            y: y,
            button: 'left',
            clickCount: 1
          });

          await new Promise(resolve => setTimeout(resolve, 50));

          await cdp.call('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: x,
            y: y,
            button: 'left',
            clickCount: 1
          });

          console.log(`[Click] CDP Input.dispatchMouseEvent success (context ${contextId})`);
          return {
            success: true,
            matchMethod: elementInfo.matchMethod + '-cdp-input',
            elementInfo: elementInfo.elementInfo,
            contextId: contextId
          };
        } catch (inputErr) {
          console.log('[Click] CDP Input failed:', inputErr.message);
          lastError = inputErr.message;
        }
      }

      lastError = elementInfo.error || 'Click failed';

    } catch (err) {
      console.error(`[Click] CDP error in context ${contextId}:`, err.message);
      lastError = err.message;
      // Continue to try other contexts
    }
  }

  // All contexts failed
  if (lastElementInfo?.found) {
    console.log('[Click] Found but click failed in all contexts:', lastError);
    return { success: false, error: lastError || 'Click failed in all contexts' };
  }

  console.log('[Click] Element not found in any context:', clickInfo.text?.substring(0, 30) || clickInfo.ariaLabel || 'unknown');
  return { success: false, error: 'Element not found in any context' };
}
