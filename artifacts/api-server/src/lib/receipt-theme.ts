/**
 * lib/receipt-theme.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * One shared, "fantastic"-looking PDFKit template for every public receipt
 * type in AYZEN (finance ledger entries already have their own plainer
 * receipt in routes/finance.ts — this is the richer template used by the
 * newer Local Entity / Vault Entity / Project P&L receipts). Kept as a
 * single function so all three surfaces stay visually consistent and a
 * future 4th receipt type doesn't need to reinvent the layout.
 *
 * PDFKit has no native gradients, so the "gradient" header is faked with a
 * dark base band plus a lighter overlay band beneath it — reads as a duotone
 * banner rather than flat single-color.
 */
import PDFDocument from "pdfkit";
import type { Response } from "express";

export type ReceiptStat = {
  label: string;
  value: string;
  /** Hex color for the value text. Defaults to near-black. */
  color?: string;
};

export interface FantasticReceiptConfig {
  /** e.g. "Local Entity", "Vault Entity", "Project P&L" */
  kicker: string;
  /** Big title — entity name / project name */
  title: string;
  /** Small line under the title — e.g. category, serial, or platform */
  subtitle?: string;
  /** Single-letter or short glyph shown in the avatar badge (e.g. first letter of title) */
  avatarLetter: string;
  /** Big hero number, e.g. "+42.5%" or "$1,204.00" */
  heroValue: string;
  heroLabel: string;
  /** true = green (gain), false = red (loss), undefined = neutral gray */
  heroPositive?: boolean;
  stats: ReceiptStat[];
  /** Free-text notes block, optional */
  notes?: string | null;
  receiptId: string | number;
  issuedBy?: string | null;
  filenamePrefix: string;
}

const BRAND = "#00a89f";
const BRAND_DARK = "#026b66";
const INK = "#12181c";
const MUTED = "#8a97a0";
const LINE = "#e4e9eb";
const GREEN = "#0f9d58";
const RED = "#e4453a";
const CARD_BG = "#f6f9f9";

export function streamFantasticReceiptPdf(res: Response, cfg: FantasticReceiptConfig): void {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="ayzen-${cfg.filenamePrefix}-${cfg.receiptId}.pdf"`);

  const doc = new PDFDocument({ margin: 0, size: "A4" });
  doc.pipe(res);

  const pageWidth = doc.page.width;
  const marginX = 48;
  const contentWidth = pageWidth - marginX * 2;

  // ── Duotone header band ─────────────────────────────────────────────────
  doc.rect(0, 0, pageWidth, 168).fill(BRAND_DARK);
  doc.rect(0, 108, pageWidth, 60).fill(BRAND);

  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(22).text("AYZEN", marginX, 42);
  doc.font("Helvetica").fontSize(10).fillColor("#d9f5f2").text(cfg.kicker.toUpperCase(), marginX, 70, { characterSpacing: 1.5 });

  doc.font("Helvetica").fontSize(9).fillColor("#d9f5f2").text(
    `Receipt #${cfg.receiptId}  ·  Generated ${new Date().toLocaleString()}`,
    marginX, 42, { width: contentWidth, align: "right" },
  );

  // Avatar badge — circle with the entity's first letter, sitting on the
  // seam between the two header bands.
  const avatarCx = marginX + 34;
  const avatarCy = 138;
  doc.circle(avatarCx, avatarCy, 30).fill("#ffffff");
  doc.font("Helvetica-Bold").fontSize(22).fillColor(BRAND_DARK)
    .text(cfg.avatarLetter.slice(0, 1).toUpperCase(), avatarCx - 30, avatarCy - 13, { width: 60, align: "center" });

  doc.font("Helvetica-Bold").fontSize(20).fillColor("#ffffff")
    .text(cfg.title, marginX + 80, 122, { width: contentWidth - 80 });
  if (cfg.subtitle) {
    doc.font("Helvetica").fontSize(11).fillColor("#eafffb")
      .text(cfg.subtitle, marginX + 80, 146, { width: contentWidth - 80 });
  }

  // ── Hero stat card ───────────────────────────────────────────────────────
  const heroTop = 196;
  const heroColor = cfg.heroPositive === true ? GREEN : cfg.heroPositive === false ? RED : INK;
  doc.roundedRect(marginX, heroTop, contentWidth, 92, 14).fillAndStroke(CARD_BG, LINE);
  doc.font("Helvetica").fontSize(10).fillColor(MUTED)
    .text(cfg.heroLabel.toUpperCase(), marginX + 24, heroTop + 20, { characterSpacing: 1.2 });
  doc.font("Helvetica-Bold").fontSize(38).fillColor(heroColor)
    .text(cfg.heroValue, marginX + 22, heroTop + 36, { width: contentWidth - 44 });

  // ── Stat grid (2 columns) ────────────────────────────────────────────────
  const gridTop = heroTop + 92 + 24;
  const colGap = 16;
  const colWidth = (contentWidth - colGap) / 2;
  const rowHeight = 58;
  let x = marginX;
  let y = gridTop;
  cfg.stats.forEach((stat, i) => {
    const col = i % 2;
    if (col === 0 && i !== 0) y += rowHeight + 12;
    x = marginX + col * (colWidth + colGap);

    doc.roundedRect(x, y, colWidth, rowHeight, 10).fillAndStroke("#ffffff", LINE);
    doc.font("Helvetica").fontSize(8.5).fillColor(MUTED)
      .text(stat.label.toUpperCase(), x + 14, y + 12, { width: colWidth - 28, characterSpacing: 1 });
    doc.font("Helvetica-Bold").fontSize(14).fillColor(stat.color ?? INK)
      .text(stat.value, x + 14, y + 30, { width: colWidth - 28 });
  });

  let cursorY = y + rowHeight + 28;

  if (cfg.notes) {
    doc.font("Helvetica-Bold").fontSize(9).fillColor(MUTED).text("NOTES", marginX, cursorY, { characterSpacing: 1 });
    cursorY += 14;
    doc.font("Helvetica").fontSize(10.5).fillColor(INK).text(cfg.notes, marginX, cursorY, { width: contentWidth });
    cursorY = doc.y + 20;
  }

  if (cfg.issuedBy) {
    doc.font("Helvetica").fontSize(9.5).fillColor(MUTED).text(`Issued by ${cfg.issuedBy}`, marginX, cursorY);
    cursorY += 20;
  }

  // ── Footer ───────────────────────────────────────────────────────────────
  const footerY = Math.max(cursorY + 12, doc.page.height - 90);
  doc.moveTo(marginX, footerY).lineTo(pageWidth - marginX, footerY).strokeColor(LINE).stroke();
  doc.font("Helvetica").fontSize(8).fillColor(MUTED).text(
    "This is a system-generated receipt from AYZEN. Anyone holding this link can view it — nothing else in the account is reachable from here.",
    marginX, footerY + 12, { width: contentWidth },
  );

  doc.end();
}
