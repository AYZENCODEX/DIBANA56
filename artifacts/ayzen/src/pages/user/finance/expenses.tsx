import { FinanceEntryList } from "@/components/finance/finance-entry-list";

export default function FinanceExpensesPage() {
  return (
    <FinanceEntryList
      kind="expense"
      title="Expenses"
      description="Recurring o upcoming khoroch — category diye tag kore rakho"
      showRepay={false}
    />
  );
}
