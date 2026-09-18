import { Bot } from "lucide-react";
import { AiChat } from "@/components/ai-chat";

// Zynth's dedicated user-facing page (master plan §2 — "AI assistant
// layer"). Everything the chat does — DB-connected answers, the
// create_vault/complete_task/get_password/add_roi action blocks — already
// lives in <AiChat/> (previously only reachable as a floating widget); this
// page just docks that same component full-page instead of duplicating its
// ~400 lines of chat/action logic.
//
// This page existing is what makes the Zynth subdomain split meaningful —
// see CHANGES_ZYNTH_SUBDOMAIN_SPLIT.md for why the split was withheld
// until there was a real homePath to send zynth.ayzen.tech visitors to.
export default function AssistantPage() {
  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] p-4 md:p-6">
      <div className="flex items-center gap-2 mb-4 shrink-0">
        <Bot className="w-5 h-5 text-primary" />
        <h1 className="text-lg font-semibold">AYZEN AI — Zynth</h1>
      </div>
      <div className="flex-1 min-h-0">
        <AiChat standalone />
      </div>
    </div>
  );
}
