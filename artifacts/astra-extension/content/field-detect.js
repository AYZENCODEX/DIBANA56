// content/field-detect.js
// ─────────────────────────────────────────────────────────────────────────
// Finds password fields, and for each one the field it's paired with (the
// username/email/phone box a login form). Exposed as window.__astraDetect
// so content-script.js can call it without a bundler.
//
// Deliberately simple for v1 — real login pages overwhelmingly follow this
// shape (one visible password input, one preceding text/email input in the
// same <form> or, failing that, the nearest preceding text-like input in
// document order). Multi-step flows (username on one screen, password on
// the next — Twitter/X's newer flow does this) are handled by tracking the
// last text input Astra saw filled/focused even after the DOM around it
// changes screens.

(function () {
  const TEXT_LIKE_TYPES = new Set(["text", "email", "tel", ""]);

  function isVisible(el) {
    if (!el || !(el instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  }

  function findPasswordFields(root = document) {
    return Array.from(root.querySelectorAll('input[type="password"]')).filter(isVisible);
  }

  function findUsernameFieldFor(passwordEl) {
    const form = passwordEl.closest("form");
    const scope = form || document;
    const candidates = Array.from(
      scope.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], input:not([type])')
    ).filter(isVisible);

    // Prefer the candidate immediately before the password field in DOM/tab
    // order within the same form; fall back to the last visible text-like
    // input seen anywhere on the page (covers split username-then-password
    // screens where the username field isn't in the DOM anymore).
    const before = candidates.filter((el) => {
      const pos = el.compareDocumentPosition(passwordEl);
      return !!(pos & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    if (before.length) return before[before.length - 1];
    if (candidates.length) return candidates[0];
    return window.__astraLastTextInput || null;
  }

  // Track the most recently focused text-like input globally, for split
  // (multi-step) login flows.
  document.addEventListener(
    "focusin",
    (e) => {
      const el = e.target;
      if (el instanceof HTMLInputElement && TEXT_LIKE_TYPES.has(el.type)) {
        window.__astraLastTextInput = el;
      }
    },
    true
  );

  window.__astraDetect = { findPasswordFields, findUsernameFieldFor, isVisible };
})();
