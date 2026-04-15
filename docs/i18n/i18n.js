(function () {
  'use strict';

  var SUPPORTED_LANGS = ['en', 'zh', 'hi', 'es', 'fr', 'ar', 'pt', 'bn', 'ru', 'id', 'ja', 'pl'];

  function detectLang() {
    var lang;

    // 1. URL hash: #lang=xx
    var hash = location.hash || '';
    var hashMatch = hash.match(/[#&]lang=([a-z]{2})/i);
    if (hashMatch) {
      lang = hashMatch[1].toLowerCase();
      if (SUPPORTED_LANGS.indexOf(lang) !== -1) return lang;
    }

    // 2. localStorage
    try {
      lang = localStorage.getItem('bsvb-lang');
      if (lang && SUPPORTED_LANGS.indexOf(lang) !== -1) return lang;
    } catch (e) { /* ignore */ }

    // 3. navigator.language
    var navLang = (navigator.language || (navigator.languages && navigator.languages[0]) || '');
    lang = navLang.slice(0, 2).toLowerCase();
    if (lang && SUPPORTED_LANGS.indexOf(lang) !== -1) return lang;

    // 4. Default
    return 'en';
  }

  function getPage() {
    var pathname = location.pathname || '';
    if (pathname.slice(-12) === 'support.html') return 'support';
    if (pathname.slice(-12) === 'privacy.html') return 'privacy';
    if (pathname.slice(-10) === 'usage.html') return 'usage';
    if (pathname.slice(-12) === 'landing.html') return 'landing';
    return 'index';
  }

  function applyTranslations(translations, lang) {
    // [data-i18n] → textContent
    var textEls = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < textEls.length; i++) {
      var el = textEls[i];
      var key = el.getAttribute('data-i18n');
      if (key && translations[key] !== undefined) {
        el.textContent = translations[key];
      }
    }

    // [data-i18n-html] → innerHTML
    var htmlEls = document.querySelectorAll('[data-i18n-html]');
    for (var j = 0; j < htmlEls.length; j++) {
      var elH = htmlEls[j];
      var keyH = elH.getAttribute('data-i18n-html');
      if (keyH && translations[keyH] !== undefined) {
        elH.innerHTML = translations[keyH];
      }
    }

    // _meta.title
    if (translations['_meta.title']) {
      document.title = translations['_meta.title'];
    }

    // _meta.description
    if (translations['_meta.description']) {
      var metaDesc = document.querySelector('meta[name="description"]');
      if (metaDesc) {
        metaDesc.setAttribute('content', translations['_meta.description']);
      }
    }

    // _css.* → CSS custom properties on :root
    Object.keys(translations).forEach(function(k) {
      if (k.slice(0, 5) === '_css.') {
        document.documentElement.style.setProperty('--' + k.slice(5), translations[k]);
      }
    });

    // lang attribute
    document.documentElement.lang = lang;

    // dir attribute
    document.documentElement.dir = (lang === 'ar') ? 'rtl' : 'ltr';
  }

  function removeLoadingClass() {
    document.documentElement.classList.remove('i18n-loading');
  }

  function runI18n() {
    var lang = detectLang();

    if (lang === 'en') {
      removeLoadingClass();
      return;
    }

    var page = getPage();
    var url = './i18n/' + lang + '/' + page + '.json';

    fetch(url)
      .then(function (response) {
        if (!response.ok) {
          throw new Error('HTTP ' + response.status);
        }
        return response.json();
      })
      .then(function (translations) {
        applyTranslations(translations, lang);
        removeLoadingClass();
      })
      .catch(function () {
        removeLoadingClass();
      });
  }

  // Public API
  window.setLanguage = function (lang) {
    if (SUPPORTED_LANGS.indexOf(lang) === -1) return;

    try {
      localStorage.setItem('bsvb-lang', lang);
    } catch (e) { /* ignore */ }

    // Remove existing #lang=xx from hash and add new one
    var hash = location.hash || '';
    hash = hash.replace(/[#&]?lang=[a-z]{2}/gi, '').replace(/^#?/, '');
    // Rebuild hash
    var newHash = hash ? hash + '&lang=' + lang : 'lang=' + lang;
    location.hash = newHash;

    location.reload();
  };

  window.getCurrentLang = function () {
    return detectLang();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runI18n);
  } else {
    runI18n();
  }
}());
