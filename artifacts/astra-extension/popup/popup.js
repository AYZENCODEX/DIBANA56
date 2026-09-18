// popup/popup.js
import { getConfig } from "../background/config.js";

function sendMessage(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

async function activeTabHostname() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    return tab?.url ? new URL(tab.url).hostname : null;
  } catch {
    return null;
  }
}

async function render() {
  const status = await sendMessage({ type: "GET_STATUS" });
  const statusLine = document.getElementById("status-line");
  const signedOut = document.getElementById("signed-out");
  const signedIn = document.getElementById("signed-in");

  if (!status?.signedIn) {
    statusLine.textContent = "Signed out";
    signedOut.classList.remove("hidden");
    signedIn.classList.add("hidden");
    const { apiBase } = await getConfig();
    document.getElementById("sign-in-link").href = `${apiBase}/login`;
    return;
  }

  statusLine.textContent = "Signed in";
  signedOut.classList.add("hidden");
  signedIn.classList.remove("hidden");
  document.getElementById("user-email").textContent = status.user?.email ?? "";

  const hostname = await activeTabHostname();
  const matchesContainer = document.getElementById("site-matches");
  matchesContainer.innerHTML = "";

  if (!hostname) {
    matchesContainer.innerHTML = '<p class="empty-note">No active page.</p>';
    return;
  }

  const result = await sendMessage({ type: "GET_MATCHES", hostname });
  if (!result?.matcher) {
    matchesContainer.innerHTML = `<p class="empty-note">Astra doesn't cover ${hostname} yet.</p>`;
    return;
  }
  if (result.matches.length === 0) {
    matchesContainer.innerHTML = `<p class="empty-note">No saved ${result.matcher.label} credentials.</p>`;
    return;
  }
  for (const m of result.matches) {
    const div = document.createElement("div");
    div.className = "match-item";
    div.innerHTML = `<div class="project"></div><div class="username"></div>`;
    div.querySelector(".project").textContent = m.projectName;
    div.querySelector(".username").textContent = m.username;
    matchesContainer.appendChild(div);
  }
}

document.getElementById("refresh-btn")?.addEventListener("click", async (e) => {
  e.preventDefault();
  const btn = e.target;
  btn.textContent = "Refreshing…";
  await sendMessage({ type: "REFRESH_VAULT" });
  await render();
  btn.textContent = "Refresh vault";
});

render();
