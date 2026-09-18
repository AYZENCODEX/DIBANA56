import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Bold, Italic, Underline, List, ListOrdered, Link2, RemoveFormatting } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * components/mail/rich-text-editor.tsx
 * ─────────────────────────────────────────────────────────────────────────
 * A small contentEditable-based rich text editor for the mailbox compose
 * box — bold/italic/underline, bulleted/numbered lists, links, and clear
 * formatting. No editor library dependency (tiptap/quill/etc. aren't in
 * this workspace and there's no network access to add one) — this is the
 * same `document.execCommand` approach every mail client's "simple HTML
 * compose" used before ContentEditable-based editors got fancier, and it's
 * still universally supported for exactly this use case.
 *
 * Deliberately *uncontrolled* like a real contentEditable has to be: typing
 * updates the DOM directly and `onChange` just mirrors it out to the
 * parent's state for autosave/send. Re-rendering the parent must NOT push
 * `html` back into the DOM on every keystroke (that resets the caret) — so
 * the DOM is only synced to the `html` prop when `resetKey` changes (bump
 * it when the compose dialog opens with different seed content, e.g.
 * switching from "new message" to "edit this draft").
 */
export interface RichTextEditorHandle {
  focus: () => void;
  getHTML: () => string;
  /** Inserts HTML at the current caret if the editor has a live selection, otherwise appends it. Used for "Insert signature". */
  insertHTML: (fragment: string) => void;
}

interface RichTextEditorProps {
  html: string;
  resetKey: string | number;
  onChange: (html: string) => void;
  placeholder?: string;
  className?: string;
}

const TOOLBAR_BUTTONS: { icon: typeof Bold; cmd: string; title: string }[] = [
  { icon: Bold, cmd: "bold", title: "Bold" },
  { icon: Italic, cmd: "italic", title: "Italic" },
  { icon: Underline, cmd: "underline", title: "Underline" },
  { icon: List, cmd: "insertUnorderedList", title: "Bulleted list" },
  { icon: ListOrdered, cmd: "insertOrderedList", title: "Numbered list" },
];

export const RichTextEditor = forwardRef<RichTextEditorHandle, RichTextEditorProps>(
  ({ html, resetKey, onChange, placeholder, className }, ref) => {
    const editorRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      if (editorRef.current) editorRef.current.innerHTML = html || "";
      // Intentionally only re-syncing on resetKey change — see file header.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [resetKey]);

    useImperativeHandle(ref, () => ({
      focus: () => editorRef.current?.focus(),
      getHTML: () => editorRef.current?.innerHTML ?? "",
      insertHTML: (fragment: string) => {
        const el = editorRef.current;
        if (!el) return;
        el.focus();
        const sel = window.getSelection();
        if (sel && sel.rangeCount && el.contains(sel.anchorNode)) {
          document.execCommand("insertHTML", false, fragment);
        } else {
          el.innerHTML += fragment;
        }
        onChange(el.innerHTML);
      },
    }));

    const exec = (cmd: string) => {
      editorRef.current?.focus();
      document.execCommand(cmd, false);
      onChange(editorRef.current?.innerHTML ?? "");
    };

    const addLink = () => {
      const url = window.prompt("Link URL (https://…)");
      if (!url) return;
      editorRef.current?.focus();
      document.execCommand("createLink", false, url);
      onChange(editorRef.current?.innerHTML ?? "");
    };

    return (
      <div className={cn("border border-border/40 rounded-lg overflow-hidden bg-background/40 focus-within:border-primary/40 transition-colors", className)}>
        <div className="flex items-center gap-0.5 border-b border-border/30 px-1.5 py-1 bg-muted/10">
          {TOOLBAR_BUTTONS.map(({ icon: Icon, cmd, title }) => (
            <button
              key={cmd}
              type="button"
              title={title}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => exec(cmd)}
              className="p-1.5 rounded text-muted-foreground/60 hover:text-primary hover:bg-primary/10 transition-colors"
            >
              <Icon className="w-3.5 h-3.5" />
            </button>
          ))}
          <button
            type="button"
            title="Insert link"
            onMouseDown={(e) => e.preventDefault()}
            onClick={addLink}
            className="p-1.5 rounded text-muted-foreground/60 hover:text-primary hover:bg-primary/10 transition-colors"
          >
            <Link2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            title="Clear formatting"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => exec("removeFormat")}
            className="p-1.5 rounded text-muted-foreground/60 hover:text-primary hover:bg-primary/10 transition-colors ml-auto"
          >
            <RemoveFormatting className="w-3.5 h-3.5" />
          </button>
        </div>
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          data-placeholder={placeholder}
          onInput={() => onChange(editorRef.current?.innerHTML ?? "")}
          onBlur={() => onChange(editorRef.current?.innerHTML ?? "")}
          className={cn(
            "font-mono text-xs px-3 py-2.5 min-h-[160px] max-h-[360px] overflow-y-auto outline-none leading-relaxed",
            "[&_a]:text-primary [&_a]:underline [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4",
            "empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground/40",
          )}
        />
      </div>
    );
  },
);
RichTextEditor.displayName = "RichTextEditor";

/** Plain text -> minimal HTML (escaped, newlines to <br>) — used to seed the rich editor from a plain-text reply/forward quote or a legacy plain-text draft. */
export function textToHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML.replace(/\n/g, "<br>");
}
