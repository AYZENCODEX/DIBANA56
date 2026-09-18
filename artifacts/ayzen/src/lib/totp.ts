// Shared TOTP (RFC 6238) engine — used by the flat 2FA tab and by the
// 2FA hierarchy (category → entity) drill-down pages.
const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  const bits = clean.split("").map(c => BASE32_CHARS.indexOf(c).toString(2).padStart(5, "0")).join("");
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return new Uint8Array(bytes);
}

export async function generateTOTP(secret: string, period = 30): Promise<string> {
  try {
    const keyBytes = base32Decode(secret);
    const counter = Math.floor(Date.now() / 1000 / period);
    const counterBytes = new Uint8Array(8);
    let tmp = counter;
    for (let i = 7; i >= 0; i--) { counterBytes[i] = tmp & 0xff; tmp = Math.floor(tmp / 256); }
    const cryptoKey = await crypto.subtle.importKey("raw", keyBytes.buffer as ArrayBuffer, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
    const hmac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, counterBytes));
    const offset = hmac[19] & 0xf;
    const otp = (((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff)) % 1_000_000;
    return otp.toString().padStart(6, "0");
  } catch { return "------"; }
}
