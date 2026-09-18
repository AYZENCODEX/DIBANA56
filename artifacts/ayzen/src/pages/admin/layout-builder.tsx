import { useState } from "react";
import { useLayoutPages, useLayoutEditor, type LayoutSectionRow } from "@/hooks/use-page-layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { LayoutPanelTop, GripVertical, Loader2, Save, Eye, EyeOff } from "lucide-react";

function SectionRow({
  section, index, dragging, onDragStart, onDragEnter, onDragEnd, onToggle,
}: {
  section: LayoutSectionRow;
  index: number;
  dragging: boolean;
  onDragStart: (i: number) => void;
  onDragEnter: (i: number) => void;
  onDragEnd: () => void;
  onToggle: (visible: boolean) => void;
}) {
  return (
    <div
      draggable
      onDragStart={() => onDragStart(index)}
      onDragEnter={() => onDragEnter(index)}
      onDragOver={(e) => e.preventDefault()}
      onDragEnd={onDragEnd}
      className={cn(
        "flex items-center gap-2.5 p-3 rounded-lg border border-border/50 bg-card cursor-grab active:cursor-grabbing transition-all",
        dragging && "opacity-40 scale-[0.98]",
        !section.visible && "opacity-50"
      )}
    >
      <GripVertical className="w-4 h-4 text-muted-foreground/50 flex-shrink-0" />
      <Badge variant="outline" className="text-[9px] font-mono w-6 justify-center flex-shrink-0">{index + 1}</Badge>
      <span className="text-sm font-mono flex-1">{section.label}</span>
      {section.visible ? <Eye className="w-3.5 h-3.5 text-muted-foreground/40" /> : <EyeOff className="w-3.5 h-3.5 text-muted-foreground/40" />}
      <Switch checked={section.visible} onCheckedChange={onToggle} />
    </div>
  );
}

export default function AdminLayoutBuilder() {
  const { pages, isLoading: pagesLoading } = useLayoutPages();
  const [selectedPage, setSelectedPage] = useState<string | null>(null);
  const { sections, setSections, isLoading, save } = useLayoutEditor(selectedPage ?? "");
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);

  const reorder = (from: number, to: number) => {
    if (from === to) return;
    setSections(prev => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
    setDirty(true);
  };

  const toggleVisible = (id: number, visible: boolean) => {
    setSections(prev => prev.map(s => s.id === id ? { ...s, visible } : s));
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const result = await save(sections);
      if (result.ok) { toast({ title: "Layout saved" }); setDirty(false); }
      else toast({ title: "Couldn't save layout", description: result.error, variant: "destructive" });
    } finally { setSaving(false); }
  };

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-5">
      <div className="flex items-center gap-2.5">
        <LayoutPanelTop className="w-5 h-5 text-primary" />
        <div>
          <h1 className="text-lg font-mono font-semibold">Layout Builder</h1>
          <p className="text-xs text-muted-foreground font-mono">
            Drag to reorder sections, toggle to hide. Only pages listed here have been wired to read this order live.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-[220px_1fr] gap-4">
        <Card className="h-fit">
          <CardContent className="p-2">
            {pagesLoading ? (
              <div className="flex justify-center py-8"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>
            ) : pages.length === 0 ? (
              <p className="text-xs text-muted-foreground font-mono p-3">No pages registered yet.</p>
            ) : (
              <div className="space-y-1">
                {pages.map(p => (
                  <button
                    key={p.pageKey}
                    onClick={() => { setSelectedPage(p.pageKey); setDirty(false); }}
                    className={cn(
                      "w-full text-left px-2.5 py-2 rounded-md text-xs font-mono flex items-center gap-2 transition-colors",
                      selectedPage === p.pageKey ? "bg-primary/10 text-primary" : "hover:bg-muted/30 text-muted-foreground"
                    )}
                  >
                    <LayoutPanelTop className="w-3.5 h-3.5 flex-shrink-0" />
                    <span className="flex-1 truncate">{p.label}</span>
                    <Badge variant="outline" className="text-[9px]">{p.sectionCount}</Badge>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-3">
            {!selectedPage ? (
              <div className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
                <LayoutPanelTop className="w-6 h-6 opacity-40" />
                <p className="text-sm font-mono">Pick a page on the left.</p>
              </div>
            ) : isLoading ? (
              <div className="flex justify-center py-16"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
            ) : (
              <div className="space-y-3">
                <div className="flex justify-end">
                  <Button size="sm" className="gap-1.5" onClick={handleSave} disabled={saving || !dirty}>
                    {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                    {saving ? "Saving..." : "Save Layout"}
                  </Button>
                </div>
                <div className="space-y-1.5">
                  {sections.map((section, i) => (
                    <SectionRow
                      key={section.id}
                      section={section}
                      index={i}
                      dragging={dragIndex === i}
                      onDragStart={setDragIndex}
                      onDragEnter={(i2) => { if (dragIndex !== null) reorder(dragIndex, i2); setDragIndex(i2); }}
                      onDragEnd={() => setDragIndex(null)}
                      onToggle={(v) => toggleVisible(section.id, v)}
                    />
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
