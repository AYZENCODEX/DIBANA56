/**
 * lib/zip-writer.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * A tiny, dependency-free ZIP (PKZIP) writer used by
 * `GET /ayzen-email/mailbox/:id/attachments/download-all`. There's no zip
 * library anywhere in this workspace's package.json and adding one would mean
 * regenerating pnpm-lock.yaml for the whole monorepo, so this builds a valid
 * .zip byte-for-byte using only Node's built-in `zlib` (for DEFLATE
 * compression) — same approach rich-text-editor.tsx took for "no new
 * dependency" in the compose upgrade.
 *
 * Supports exactly what we need: a flat list of named in-memory buffers,
 * each individually DEFLATE-compressed (falling back to STORE if deflating
 * doesn't actually shrink the file), packed into one archive with a standard
 * End Of Central Directory record. No ZIP64 (not needed — mailbox
 * attachments are capped at MAX_ATTACHMENT_BYTES per file and a handful of
 * files per message, nowhere near the 4GB/65535-entry ZIP64 thresholds).
 */
import { deflateRawSync } from "zlib";

export interface ZipEntry {
  name: string;
  data: Buffer;
}

// Standard ZIP CRC-32 (polynomial 0xEDB88320), table-built once at module
// load. This is the exact checksum the ZIP spec requires per entry — not
// related to any application-level integrity check elsewhere in the app.
const CRC_TABLE: number[] = (() => {
  const table = new Array<number>(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// DOS date/time packed into 16+16 bits, as the ZIP local/central headers
// require — "now" is fine here, nobody's diffing attachment timestamps out
// of a mail export.
function dosDateTime(d = new Date()): { time: number; date: number } {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

/** Builds a complete .zip file in memory from a flat list of entries. */
export function buildZip(entries: ZipEntry[]): Buffer {
  const { time, date } = dosDateTime();
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const deflated = deflateRawSync(entry.data);
    // Only actually use DEFLATE if it helps — tiny or already-compressed
    // files (jpg, zip, pdf w/ compressed streams) can come out larger.
    const useDeflate = deflated.length < entry.data.length;
    const method = useDeflate ? 8 : 0; // 8 = DEFLATE, 0 = STORE
    const payload = useDeflate ? deflated : entry.data;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
    localHeader.writeUInt16LE(20, 4); // version needed to extract
    localHeader.writeUInt16LE(0x0800, 6); // general purpose flag: bit 11 = UTF-8 filename
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length

    localParts.push(localHeader, nameBuf, payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // central directory header signature
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed to extract
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal file attributes
    centralHeader.writeUInt32LE(0, 38); // external file attributes
    centralHeader.writeUInt32LE(offset, 42); // relative offset of local header

    centralParts.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + payload.length;
  }

  const centralDirStart = offset;
  const centralDir = Buffer.concat(centralParts);
  const centralDirSize = centralDir.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(0, 4); // number of this disk
  eocd.writeUInt16LE(0, 6); // disk where central directory starts
  eocd.writeUInt16LE(entries.length, 8); // number of records on this disk
  eocd.writeUInt16LE(entries.length, 10); // total number of records
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(centralDirStart, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralDir, eocd]);
}

/**
 * De-duplicates filenames the way most zip tools do — "invoice.pdf",
 * "invoice (1).pdf", "invoice (2).pdf" — so two attachments that happened to
 * share a name (e.g. two "receipt.pdf" forwards in the same thread) don't
 * silently overwrite each other once extracted.
 */
export function dedupeNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw) => {
    const name = raw && raw.trim() ? raw.trim() : "attachment";
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    if (count === 0) return name;
    const dot = name.lastIndexOf(".");
    return dot > 0 ? `${name.slice(0, dot)} (${count})${name.slice(dot)}` : `${name} (${count})`;
  });
}
