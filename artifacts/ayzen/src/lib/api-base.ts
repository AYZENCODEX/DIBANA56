/**
 * getApiBase() — returns the base URL for all API calls.
 *
 * Development / Replit:   VITE_API_URL is empty → use relative "/api" (proxied by Vite)
 * Vercel / Render deploy: set VITE_API_URL to the full API server URL
 *   e.g. VITE_API_URL=https://ayzen-api.onrender.com
 *
 * Frontend code uses:  `${getApiBase()}/auth/login`  (no "/api" prefix needed when using this helper)
 * Or keep existing:    `${getApiBase()}/api/auth/login` — both work because VITE_API_URL never has a trailing slash.
 *
 * When VITE_API_URL is set the frontend calls the API cross-origin so the API
 * server must respond with appropriate CORS headers.
 */
export function getApiBase(): string {
  const viteUrl = import.meta.env.VITE_API_URL as string | undefined;
  if (viteUrl && viteUrl.trim() !== "") {
    return viteUrl.replace(/\/$/, "");
  }
  // Fall back to relative path (same origin, Vite proxies /api → localhost:apiPort)
  const basePath = (import.meta.env.BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "";
  return basePath;
}
