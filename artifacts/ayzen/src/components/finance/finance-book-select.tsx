import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { financeApi } from "@/lib/finance-api";
import type { FinanceBook } from "@/config/finance";

/**
 * Book switcher for the accounting pages (Chart of Accounts / Journal /
 * Reports) — Phase 3 Multi-book. `value` is "" for "use my default book";
 * an explicit id otherwise. Renders nothing while there's only the one
 * (default) book, so single-book users never see book-switching UI at all.
 */
export function BookSelect({ value, onChange }: { value: string; onChange: (bookId: string) => void }) {
  const { token } = useAuth();
  const [books, setBooks] = useState<FinanceBook[]>([]);

  useEffect(() => { financeApi.listBooks(token).then(setBooks).catch(() => setBooks([])); }, [token]);

  if (books.length <= 1) return null;

  return (
    <Select value={value || "default"} onValueChange={v => onChange(v === "default" ? "" : v)}>
      <SelectTrigger className="w-[180px] h-9"><SelectValue placeholder="Book" /></SelectTrigger>
      <SelectContent>
        <SelectItem value="default">Default book</SelectItem>
        {books.map(b => <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}
