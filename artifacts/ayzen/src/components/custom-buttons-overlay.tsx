import { Link } from "wouter";
import { useCustomButtons, type CustomButton, type CustomButtonPosition } from "@/hooks/use-custom-buttons";
import { resolveDevNavIcon } from "@/lib/dev-nav-icons";
import { cn } from "@/lib/utils";

// Positioned to clear the AI chat launcher (bottom-6 right-6) and the app
// header, so custom buttons never overlap existing fixed UI.
const POSITION_CLASSES: Record<CustomButtonPosition, string> = {
  "bottom-right": "bottom-24 right-5 items-end",
  "bottom-left": "bottom-6 left-5 items-start",
  "top-right": "top-20 right-5 items-end",
  "top-left": "top-20 left-5 items-start",
};

const SIZE_CLASSES: Record<CustomButton["size"], { btn: string; icon: string }> = {
  sm: { btn: "h-9 px-3 text-xs gap-1.5", icon: "w-3.5 h-3.5" },
  md: { btn: "h-10 px-4 text-sm gap-2", icon: "w-4 h-4" },
  lg: { btn: "h-12 px-5 text-base gap-2.5", icon: "w-5 h-5" },
};

const SHAPE_CLASSES: Record<CustomButton["shape"], string> = {
  pill: "rounded-full",
  rounded: "rounded-lg",
  square: "rounded-none",
};

function variantClasses(variant: CustomButton["variant"], color: CustomButton["color"]) {
  switch (variant) {
    case "solid":
      return `bg-${color} text-${color}-foreground hover:opacity-90 border border-transparent`;
    case "outline":
      return `bg-transparent text-${color} border border-${color} hover:bg-${color}/10`;
    case "ghost":
      return `bg-${color}/10 text-${color} border border-transparent hover:bg-${color}/20`;
    default:
      return `bg-${color} text-${color}-foreground border border-transparent`;
  }
}

// Tailwind can't resolve fully dynamic class strings at build time (JIT scans
// for literal class names), so every color/variant combination that
// variantClasses() can produce is spelled out here once, ensuring the CSS
// actually ships regardless of which options an admin picks.
const _SAFELIST = [
  "bg-primary", "text-primary-foreground", "text-primary", "border-primary", "bg-primary/10", "bg-primary/20",
  "bg-secondary", "text-secondary-foreground", "text-secondary", "border-secondary", "bg-secondary/10", "bg-secondary/20",
  "bg-accent", "text-accent-foreground", "text-accent", "border-accent", "bg-accent/10", "bg-accent/20",
  "bg-success", "text-success-foreground", "text-success", "border-success", "bg-success/10", "bg-success/20",
  "bg-warning", "text-warning-foreground", "text-warning", "border-warning", "bg-warning/10", "bg-warning/20",
  "bg-danger", "text-danger-foreground", "text-danger", "border-danger", "bg-danger/10", "bg-danger/20",
];

function ButtonPill({ button }: { button: CustomButton }) {
  const Icon = resolveDevNavIcon(button.icon);
  const sizing = SIZE_CLASSES[button.size] ?? SIZE_CLASSES.md;
  const classes = cn(
    "inline-flex items-center justify-center font-mono font-medium shadow-lg backdrop-blur-sm transition-all hover:shadow-xl hover:-translate-y-0.5 active:translate-y-0",
    sizing.btn,
    SHAPE_CLASSES[button.shape] ?? SHAPE_CLASSES.pill,
    variantClasses(button.variant, button.color),
  );

  const content = (
    <>
      <Icon className={sizing.icon} />
      <span className="whitespace-nowrap">{button.label}</span>
    </>
  );

  if (button.external || /^https?:\/\//i.test(button.href)) {
    return (
      <a href={button.href} target="_blank" rel="noopener noreferrer" className={classes}>
        {content}
      </a>
    );
  }

  return (
    <Link href={button.href} className={classes}>
      {content}
    </Link>
  );
}

/** Renders every enabled custom button, grouped by corner, site-wide. */
export function CustomButtonsOverlay() {
  const { buttons } = useCustomButtons();
  if (!buttons.length) return null;

  const byPosition = buttons.reduce<Record<CustomButtonPosition, CustomButton[]>>((acc, b) => {
    if (!acc[b.position]) acc[b.position] = [];
    acc[b.position].push(b);
    return acc;
  }, {} as Record<CustomButtonPosition, CustomButton[]>);

  return (
    <>
      {(Object.keys(byPosition) as CustomButtonPosition[]).map(position => (
        <div key={position} className={cn("fixed z-40 flex flex-col gap-2.5", POSITION_CLASSES[position])}>
          {byPosition[position]
            .slice()
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map(button => <ButtonPill key={button.id} button={button} />)}
        </div>
      ))}
    </>
  );
}
