// background/background.js
// ─────────────────────────────────────────────────────────────────────────
// Astra v1 core: keeps the toolbar badge in sync with AYZEN Account login
// status, and answers two messages from content scripts / the popup:
//   { type: "GET_MATCHES", hostname }        -> { matcher, matches }
//   { type: "FILL_CREDENTIAL", entryId, hostname } -> { username, password } | null
//   { type: "GET_STATUS" }                   -> { signedIn, user }
//   { type: "REFRESH_VAULT" }                -> { ok: true }
//
// This is the ONLY place the session token or decrypted vault data ever
// exists outside the AYZEN web app itself. Content scripts never see the
// token; they see match summaries (username only) and, on explicit click,
// one credential pair for the entry the user picked.

import { fetchAccountStatus } from "./session.js";
import { getMatchesForHostname, fillCredential, getVaultEntries, clearVaultCache } from "./vault.js";

const ICONS_ON = {
  16: "icons/icon-16.png",
  32: "icons/icon-32.png",
  48: "icons/icon-48.png",
  128: "icons/icon-128.png",
};
const ICONS_OFF = {
  16: "icons/icon-16-off.png",
  32: "icons/icon-32-off.png",
  48: "icons/icon-48-off.png",
  128: "icons/icon-128-off.png",
};

async function refreshBadge() {
  const status = await fetchAccountStatus();
  await chrome.action.setIcon({ path: status.signedIn ? ICONS_ON : ICONS_OFF });
  await chrome.action.setTitle({
    title: status.signedIn
      ? `AYZEN Astra — signed in${status.user?.email ? ` as ${status.user.email}` : ""}`
      : "AYZEN Astra — signed out",
  });
  return status;
}

// Recheck on install/startup, and periodically (session can expire, or the
// user can sign out on the web app) via chrome.alarms — service workers
// don't keep a setInterval alive, so alarms is the correct MV3 pattern.
chrome.runtime.onInstalled.addListener(() => {
  refreshBadge();
  chrome.alarms.create("astra-status-refresh", { periodInMinutes: 5 });
});
chrome.runtime.onStartup.addListener(() => {
  refreshBadge();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "astra-status-refresh") refreshBadge();
});

// The session cookie changing (sign-in, sign-out, expiry) is the most
// immediate signal we get — react right away instead of waiting for the
// next alarm tick, and drop the vault cache so a stale user's data can
// never be served to whoever is signed in next on this device.
chrome.cookies.onChanged.addListener((change) => {
  if (change.cookie.name === "ayzen_session") {
    clearVaultCache();
    refreshBadge();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "GET_STATUS": {
        sendResponse(await refreshBadge());
        break;
      }
      case "GET_MATCHES": {
        sendResponse(await getMatchesForHostname(message.hostname));
        break;
      }
      case "FILL_CREDENTIAL": {
        sendResponse(await fillCredential(message.entryId, message.hostname));
        break;
      }
      case "REFRESH_VAULT": {
        await getVaultEntries({ forceRefresh: true });
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse(null);
    }
  })();
  return true; // keep the message channel open for the async response above
});
