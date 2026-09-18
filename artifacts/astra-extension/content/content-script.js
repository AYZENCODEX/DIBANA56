// content/content-script.js
// ─────────────────────────────────────────────────────────────────────────
// Runs on every non-ayzen.tech page. Does nothing until the background
// worker confirms (a) the user is signed in to AYZEN Account and (b) they
// have at least one vault entry whose credentials match this hostname
// (Twitter/X, Discord, Telegram, or a known webmail provider — see
// background/vault.js). Only then does it draw anything on the page.
//
// Security boundary: this script only ever holds a username (not secret)
// until the user explicitly clicks an entry in the dropdown. The password
// is fetched fresh from the background worker at that moment and used
// immediately to fill the field — never stored in a variable that outlives
// the fill, never logged.

(function () {
  const { findPasswordFields, findUsernameFieldFor } = window.__astraDetect || {};
  if (!findPasswordFields) return; // field-detect.js failed to load; fail closed, no UI.

  const handled = new WeakSet();
  let currentDropdown = null;
  let cachedMatches = null; // { matcher, matches } for this hostname, fetched once per page load

  const ICON_SVG =
    '<svg viewBox="0 0 24 24"><path d="M12 2l7 3.5v5c0 5-3 8.7-7 10.5-4-1.8-7-5.5-7-10.5v-5L12 2z"/></svg>';

  function sendMessage(msg) {
    return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
  }

  // Sets a value through the framework-safe path: React (and friends) track
  // input state via a patched value setter on the prototype, so a plain
  // `el.value = x` gets silently overwritten on next render. Calling the
  // *native* setter first, then dispatching input/change, is the standard
  // workaround used by every password-manager extension.
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function closeDropdown() {
    if (currentDropdown) {
      currentDropdown.remove();
      currentDropdown = null;
      document.removeEventListener("mousedown", onOutsideClick, true);
      document.removeEventListener("keydown", onEscape, true);
    }
  }
  function onOutsideClick(e) {
    if (currentDropdown && !currentDropdown.contains(e.target)) closeDropdown();
  }
  function onEscape(e) {
    if (e.key === "Escape") closeDropdown();
  }

  function positionNear(el, anchorRect) {
    const rect = anchorRect.getBoundingClientRect();
    el.style.top = `${window.scrollY + rect.top}px`;
    el.style.left = `${window.scrollX + rect.right + 6}px`;
  }

  async function openDropdown(triggerEl, passwordEl, usernameEl, matches, label) {
    closeDropdown();
    const dd = document.createElement("div");
    dd.className = "astra-dropdown";
    positionNear(dd, triggerEl);

    const header = document.createElement("div");
    header.className = "astra-dropdown-header";
    header.textContent = `AYZEN Astra — ${label}`;
    dd.appendChild(header);

    if (matches.length === 0) {
      const empty = document.createElement("div");
      empty.className = "astra-dropdown-empty";
      empty.textContent = "No saved credentials for this site.";
      dd.appendChild(empty);
    } else {
      for (const m of matches) {
        const item = document.createElement("div");
        item.className = "astra-dropdown-item";
        item.innerHTML = `<span class="astra-project"></span><span class="astra-username"></span>`;
        item.querySelector(".astra-project").textContent = m.projectName;
        item.querySelector(".astra-username").textContent = m.username;
        item.addEventListener("click", async () => {
          const cred = await sendMessage({
            type: "FILL_CREDENTIAL",
            entryId: m.entryId,
            hostname: location.hostname,
          });
          closeDropdown();
          if (!cred) return;
          if (usernameEl) setNativeValue(usernameEl, cred.username);
          setNativeValue(passwordEl, cred.password);
        });
        dd.appendChild(item);
      }
    }

    document.body.appendChild(dd);
    currentDropdown = dd;
    // Defer listener attach one tick so the click that opened this doesn't
    // immediately close it via the capture-phase outside-click handler.
    setTimeout(() => {
      document.addEventListener("mousedown", onOutsideClick, true);
      document.addEventListener("keydown", onEscape, true);
    }, 0);
  }

  function attachTrigger(passwordEl) {
    if (handled.has(passwordEl) || !cachedMatches) return;
    handled.add(passwordEl);

    const trigger = document.createElement("div");
    trigger.className = "astra-trigger";
    trigger.innerHTML = ICON_SVG;
    trigger.title = "Fill with AYZEN Astra";
    document.body.appendChild(trigger);

    function reposition() {
      const rect = passwordEl.getBoundingClientRect();
      trigger.style.top = `${window.scrollY + rect.top + (rect.height - 22) / 2}px`;
      trigger.style.left = `${window.scrollX + rect.right - 26}px`;
    }
    reposition();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);

    trigger.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const usernameEl = findUsernameFieldFor(passwordEl);
      openDropdown(trigger, passwordEl, usernameEl, cachedMatches.matches, cachedMatches.matcher.label);
    });
  }

  function scanForPasswordFields() {
    if (!cachedMatches || !cachedMatches.matcher) return;
    findPasswordFields().forEach(attachTrigger);
  }

  let debounceTimer = null;
  function scheduleScan() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(scanForPasswordFields, 250);
  }

  (async function init() {
    cachedMatches = await sendMessage({ type: "GET_MATCHES", hostname: location.hostname });
    if (!cachedMatches || !cachedMatches.matcher) return; // not a site Astra v1 handles — no DOM changes at all.

    scanForPasswordFields();
    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  })();
})();
