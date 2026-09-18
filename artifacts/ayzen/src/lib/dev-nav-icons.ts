import {
  Circle, Bot, Users, Cpu, Puzzle, Settings, Image, Coins, DollarSign,
  LayoutDashboard, Terminal, Code2, Database, Server, Activity, Radio,
  Zap, Shield, ShieldCheck, Wallet, Store, Star, Trophy, Share2,
  HelpCircle, Send, Mail, AtSign, Key, Globe, FlaskConical, Timer,
  Boxes, Network, Rss, Cast, ClipboardList, Rocket, Handshake, LineChart,
  PlayCircle, AppWindow, Megaphone, Building2, Folder, FolderGit2,
  CheckSquare, ListTodo, MessageSquare, Flame, Bookmark, History,
  Smartphone, QrCode, ArrowLeftRight, TerminalSquare, XCircle, RefreshCw,
  Home, MoreHorizontal, Vault, User, Fuel, Link2, Search, Palette,
  Banknote, CreditCard, TrendingUp, Settings2, LayoutPanelTop, LayoutList,
  // Phase 4 — Exchange sidebar sub-type expansion
  Gift, Package, BarChart3, Sparkles, Gem,
} from "lucide-react";
import type { ElementType } from "react";

export const DEV_NAV_ICON_MAP: Record<string, ElementType> = {
  Circle, Bot, Users, Cpu, Puzzle, Settings, Image, Coins, DollarSign,
  LayoutDashboard, Terminal, Code2, Database, Server, Activity, Radio,
  Zap, Shield, ShieldCheck, Wallet, Store, Star, Trophy, Share2,
  HelpCircle, Send, Mail, AtSign, Key, Globe, FlaskConical, Timer,
  Boxes, Network, Rss, Cast, ClipboardList, Rocket, Handshake, LineChart,
  PlayCircle, AppWindow, Megaphone, Building2, Folder, FolderGit2,
  CheckSquare, ListTodo, MessageSquare, Flame, Bookmark, History,
  Smartphone, QrCode, ArrowLeftRight, TerminalSquare, XCircle, RefreshCw,
  Home, MoreHorizontal, Vault, User, Fuel, Link2, Search, Palette,
  Banknote, CreditCard, TrendingUp, Settings2, LayoutPanelTop, LayoutList,
  Gift, Package, BarChart3, Sparkles, Gem,
};

export const DEV_NAV_ICON_NAMES = Object.keys(DEV_NAV_ICON_MAP);

export function resolveDevNavIcon(name: string | null | undefined): ElementType {
  return (name && DEV_NAV_ICON_MAP[name]) || Circle;
}

// Domain-neutral aliases — same map, used by the Config Manager (config
// entries store icons as string names too, same reason dev_nav does).
export const CONFIG_ICON_MAP = DEV_NAV_ICON_MAP;
export const CONFIG_ICON_NAMES = DEV_NAV_ICON_NAMES;
export const resolveConfigIcon = resolveDevNavIcon;
