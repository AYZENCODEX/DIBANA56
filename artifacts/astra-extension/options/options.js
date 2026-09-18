// options/options.js
import { getConfig, setConfig } from "../background/config.js";

async function load() {
  const cfg = await getConfig();
  document.getElementById("api-base").value = cfg.apiBase;
  document.getElementById("cookie-domain").value = cfg.cookieDomain;
}

document.getElementById("save").addEventListener("click", async () => {
  const apiBase = document.getElementById("api-base").value.trim().replace(/\/+$/, "");
  const cookieDomain = document.getElementById("cookie-domain").value.trim();
  await setConfig({ apiBase, cookieDomain });
  const saved = document.getElementById("saved");
  saved.textContent = "Saved.";
  setTimeout(() => (saved.textContent = ""), 2000);
});

load();
