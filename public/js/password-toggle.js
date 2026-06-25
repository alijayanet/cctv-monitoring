/**
 * Password Toggle - Show/Hide Password Field
 * Professional Premium Mode
 * 
 * Features:
 * - Smooth eye icon toggle (open/closed)
 * - Persistent state per field
 * - Keyboard accessible
 * - Works with dynamically added elements
 * - Zero dependencies
 */

(function() {
  'use strict';

  // SVG icons for eye open/closed
  const EYE_OPEN = '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>';
  
  const EYE_CLOSED = '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"/></svg>';

  // Initialize all password toggles
  function initPasswordToggles() {
    document.querySelectorAll('[data-toggle-password]').forEach(function(element) {
      // Already initialized
      if (element.dataset.toggleInitialized) return;
      element.dataset.toggleInitialized = 'true';
      
      const inputId = element.dataset.togglePassword;
      const input = document.getElementById(inputId);
      if (!input) return;

      element.addEventListener('click', function(e) {
        e.preventDefault();
        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        element.innerHTML = isPassword ? EYE_OPEN : EYE_CLOSED;
        element.setAttribute('title', isPassword ? 'Sembunyikan password' : 'Tampilkan password');
        element.setAttribute('aria-label', isPassword ? 'Sembunyikan password' : 'Tampilkan password');
        
        // Focus back to input for seamless UX
        input.focus();
      });

      // Set initial state
      element.setAttribute('title', 'Tampilkan password');
      element.setAttribute('aria-label', 'Tampilkan password');
    });

    // Also auto-wrap password inputs that haven't been manually configured
    document.querySelectorAll('input[type="password"]').forEach(function(input) {
      // Skip if already has a toggle or is inside a container with toggle
      if (input.dataset.toggleProcessed) return;
      
      // Check if this input already has a next sibling toggle button
      const parent = input.parentElement;
      if (!parent || parent.classList.contains('password-toggle-wrapper')) return;
      if (input.id && parent.querySelector('[data-toggle-password="' + input.id + '"]')) return;
      
      // Skip inputs that already have a sibling toggle button
      let hasToggle = false;
      if (input.id) {
        const existingToggle = document.querySelector('[data-toggle-password="' + input.id + '"]');
        if (existingToggle) hasToggle = true;
      }
      if (hasToggle) return;

      input.dataset.toggleProcessed = 'true';

      // Wrap in relative container
      const wrapper = document.createElement('div');
      wrapper.className = 'password-toggle-wrapper';
      wrapper.style.cssText = 'position: relative; display: block;';
      
      input.parentNode.insertBefore(wrapper, input);
      wrapper.appendChild(input);

      // Add right padding to input for icon space
      if (!input.style.paddingRight) {
        input.style.paddingRight = '42px';
      }

      // Create toggle button
      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'password-toggle-btn';
      toggleBtn.setAttribute('data-toggle-password', input.id || '');
      toggleBtn.innerHTML = EYE_OPEN;
      toggleBtn.style.cssText = 'position: absolute; right: 10px; top: 50%; transform: translateY(-50%); background: none; border: none; cursor: pointer; padding: 4px; color: #94a3b8; display: flex; align-items: center; justify-content: center; transition: color 0.2s; z-index: 5;';
      
      wrapper.appendChild(toggleBtn);

      // Re-initialize for this toggle
      if (input.id) {
        toggleBtn.setAttribute('data-toggle-password', input.id);
        initPasswordToggles();
      }

      // Hover effects
      toggleBtn.addEventListener('mouseenter', function() {
        this.style.color = '#e2e8f0';
      });
      toggleBtn.addEventListener('mouseleave', function() {
        this.style.color = '#94a3b8';
      });
    });
  }

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPasswordToggles);
  } else {
    initPasswordToggles();
  }

  // Also run after any AJAX content load
  const origPushState = history.pushState;
  if (origPushState) {
    history.pushState = function() {
      origPushState.apply(this, arguments);
      setTimeout(initPasswordToggles, 100);
    };
    window.addEventListener('popstate', function() {
      setTimeout(initPasswordToggles, 100);
    });
  }

  // MutationObserver for dynamically added content
  const observer = new MutationObserver(function(mutations) {
    let needsInit = false;
    mutations.forEach(function(mutation) {
      if (mutation.addedNodes.length > 0) {
        needsInit = true;
      }
    });
    if (needsInit) {
      setTimeout(initPasswordToggles, 50);
    }
  });
  
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', function() {
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  // Expose for manual usage
  window.PasswordToggle = {
    init: initPasswordToggles,
    refresh: initPasswordToggles
  };
})();