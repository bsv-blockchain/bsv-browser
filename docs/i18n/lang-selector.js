(function () {
  'use strict';

  var LANGUAGES = [
    { code: 'en', name: 'English' },
    { code: 'zh', name: '中文' },
    { code: 'hi', name: 'हिन्दी' },
    { code: 'es', name: 'Español' },
    { code: 'fr', name: 'Français' },
    { code: 'ar', name: 'العربية' },
    { code: 'pt', name: 'Português' },
    { code: 'bn', name: 'বাংলা' },
    { code: 'ru', name: 'Русский' },
    { code: 'id', name: 'Indonesia' },
    { code: 'ja', name: '日本語' },
    { code: 'pl', name: 'Polski' }
  ];

  function getCurrentLang() {
    if (typeof window.getCurrentLang === 'function') {
      return window.getCurrentLang();
    }
    // Fallback detection
    var lang;
    try {
      lang = localStorage.getItem('bsvb-lang');
      if (lang) return lang;
    } catch (e) { /* ignore */ }
    var navLang = (navigator.language || (navigator.languages && navigator.languages[0]) || '');
    lang = navLang.slice(0, 2).toLowerCase();
    return lang || 'en';
  }

  function buildSelector() {
    var currentLang = getCurrentLang();

    // Container
    var container = document.createElement('div');
    container.id = 'bsvb-lang-selector';

    // Toggle button
    var btn = document.createElement('button');
    btn.id = 'bsvb-lang-btn';
    btn.setAttribute('aria-label', 'Select language');
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = '🌐 ' + currentLang.toUpperCase();

    // Dropdown panel
    var dropdown = document.createElement('div');
    dropdown.id = 'bsvb-lang-dropdown';
    dropdown.setAttribute('role', 'menu');

    LANGUAGES.forEach(function (lang) {
      var optBtn = document.createElement('button');
      optBtn.className = 'bsvb-lang-option' + (lang.code === currentLang ? ' active' : '');
      optBtn.setAttribute('role', 'menuitem');
      optBtn.setAttribute('data-lang', lang.code);
      optBtn.textContent = (lang.code === currentLang ? '✓ ' : '') + lang.name;
      optBtn.addEventListener('click', function () {
        closeDropdown();
        if (typeof window.setLanguage === 'function') {
          window.setLanguage(lang.code);
        }
      });
      dropdown.appendChild(optBtn);
    });

    function openDropdown() {
      dropdown.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
    }

    function closeDropdown() {
      dropdown.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    }

    function toggleDropdown() {
      if (dropdown.classList.contains('open')) {
        closeDropdown();
      } else {
        openDropdown();
      }
    }

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleDropdown();
    });

    // Close on outside click
    document.addEventListener('click', function (e) {
      if (!container.contains(e.target)) {
        closeDropdown();
      }
    });

    // Close on Escape key
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' || e.keyCode === 27) {
        closeDropdown();
      }
    });

    container.appendChild(dropdown);
    container.appendChild(btn);
    document.body.appendChild(container);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildSelector);
  } else {
    buildSelector();
  }
}());
