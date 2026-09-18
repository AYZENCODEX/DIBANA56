/**
 * components/vault/pin-input.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 5 — Vault Security: PINs & Session.
 *
 * Four individual digit boxes, auto-advancing on entry, backspace-to-previous,
 * and paste support (e.g. pasting "1234" fills all four). Deliberately not
 * built on components/ui/input-otp.tsx — this needs full control over each
 * box's styling to match the Vault section's mono/uppercase aesthetic (see
 * components/layout/vault-sidebar.tsx) and to fire onComplete the instant the
 * 4th digit lands, without pulling in the input-otp package's own state model.
 */
import { useRef, useState, useEffect, KeyboardEvent, ClipboardEvent } from "react";
import { cn } from "@/lib/utils";

export function PinInput({
  length = 4,
  value,
  onChange,
  onComplete,
  disabled,
  autoFocus = true,
  error,
}: {
  length?: number;
  value: string;
  onChange: (value: string) => void;
  onComplete?: (value: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  error?: boolean;
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const [focusIndex, setFocusIndex] = useState(0);

  useEffect(() => {
    if (autoFocus) refs.current[0]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const digits = Array.from({ length }, (_, i) => value[i] ?? "");

  function setDigitAt(index: number, digit: string) {
    const chars = value.split("");
    chars[index] = digit;
    const next = chars.join("").slice(0, length);
    onChange(next);
    if (digit && index < length - 1) {
      refs.current[index + 1]?.focus();
      setFocusIndex(index + 1);
    }
    if (next.length === length && next.split("").every(c => c !== "")) {
      onComplete?.(next);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>, index: number) {
    if (e.key === "Backspace") {
      if (digits[index]) {
        setDigitAt(index, "");
      } else if (index > 0) {
        refs.current[index - 1]?.focus();
        setFocusIndex(index - 1);
        setDigitAt(index - 1, "");
      }
      e.preventDefault();
    } else if (e.key === "ArrowLeft" && index > 0) {
      refs.current[index - 1]?.focus();
      setFocusIndex(index - 1);
    } else if (e.key === "ArrowRight" && index < length - 1) {
      refs.current[index + 1]?.focus();
      setFocusIndex(index + 1);
    }
  }

  function handlePaste(e: ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, length);
    if (!text) return;
    e.preventDefault();
    onChange(text);
    const nextFocus = Math.min(text.length, length - 1);
    refs.current[nextFocus]?.focus();
    setFocusIndex(nextFocus);
    if (text.length === length) onComplete?.(text);
  }

  return (
    <div className="flex items-center justify-center gap-2.5">
      {digits.map((d, i) => (
        <input
          key={i}
          ref={el => { refs.current[i] = el; }}
          type="password"
          inputMode="numeric"
          pattern="\d*"
          maxLength={1}
          value={d}
          disabled={disabled}
          autoComplete="off"
          onFocus={() => setFocusIndex(i)}
          onChange={e => {
            const digit = e.target.value.replace(/\D/g, "").slice(-1);
            setDigitAt(i, digit);
          }}
          onKeyDown={e => handleKeyDown(e, i)}
          onPaste={handlePaste}
          className={cn(
            "w-12 h-14 text-center text-lg font-mono font-bold rounded-lg border bg-muted/20 outline-none transition-all",
            "focus:border-primary focus:bg-primary/5 focus:shadow-[0_0_0_3px_rgba(34,211,238,0.1)]",
            error ? "border-destructive/60 text-destructive" : "border-border/50 text-foreground",
            focusIndex === i && !error && "border-primary/50",
            disabled && "opacity-50 cursor-not-allowed"
          )}
        />
      ))}
    </div>
  );
}
