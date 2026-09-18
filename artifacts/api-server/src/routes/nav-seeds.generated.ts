// AUTO-GENERATED seed data — extracted from the original hardcoded nav arrays
// in app-sidebar.tsx via the TypeScript AST (scripts/gen_seed.mjs), so every
// existing link/icon/pluginSlug is preserved exactly when a role's sidebar
// switches from hardcoded to DB-driven. Do not hand-edit — re-run the
// generator if the pre-migration static arrays ever need to be re-synced.

export interface SeedLeaf { label: string; icon: string; href: string; pluginSlug?: string; }
// children is SeedEntry[] (not SeedLeaf[]) so a section can itself contain
// sections — needed by the Protocols "Exchange" group, whose platform nodes
// (Binance/Bitget/Kucoin/Bybit) are sections nested inside the Exchange
// section. ensureSeeded() in nav.ts walks this recursively.
export interface SeedSection { label: string; icon: string; children: SeedEntry[]; }
export type SeedEntry = SeedLeaf | SeedSection;
export interface SeedGroup { label: string; icon: string; items: SeedEntry[]; }

export const NAV_SEEDS: Record<string, SeedGroup[]> = {
  "admin": [
    {
      "label": "Platform",
      "icon": "LayoutDashboard",
      "items": [
        {
          "label": "Overview",
          "icon": "LayoutDashboard",
          "href": "/admin/dashboard"
        }
      ]
    },
    {
      "label": "Operators",
      "icon": "Users",
      "items": [
        {
          "label": "Users",
          "icon": "Users",
          "href": "/admin/users"
        },
        {
          "label": "Entities",
          "icon": "Database",
          "href": "/admin/vault",
          "pluginSlug": "vault"
        }
      ]
    },
    {
      "label": "Protocols",
      "icon": "FolderGit2",
      "items": [
        {
          "label": "Projects",
          "icon": "FolderGit2",
          "href": "/admin/projects",
          "pluginSlug": "projects"
        },
        {
          "label": "Tasks",
          "icon": "CheckSquare",
          "href": "/admin/tasks",
          "pluginSlug": "tasks"
        }
      ]
    },
    {
      "label": "Tools",
      "icon": "Fuel",
      "items": [
        {
          "label": "Gas Tracker",
          "icon": "Fuel",
          "href": "/admin/tools/gas"
        },
        {
          "label": "Wallet Analysis",
          "icon": "Wallet",
          "href": "/admin/tools/wallet"
        },
        {
          "label": "Streak & Spam",
          "icon": "CheckSquare",
          "href": "/admin/tools/streak"
        }
      ]
    },
    {
      "label": "Team",
      "icon": "Users",
      "items": [
        {
          "label": "Overview",
          "icon": "Users",
          "href": "/admin/teams"
        },
        {
          "label": "Team Vault",
          "icon": "Vault",
          "href": "/admin/team-vault"
        }
      ]
    },
    {
      "label": "Community",
      "icon": "Radio",
      "items": [
        {
          "label": "Broadcast",
          "icon": "Radio",
          "href": "/admin/broadcast",
          "pluginSlug": "broadcast"
        },
        {
          "label": "Referrals",
          "icon": "Share2",
          "href": "/admin/referrals",
          "pluginSlug": "referrals"
        },
        {
          "label": "Leaderboard",
          "icon": "Trophy",
          "href": "/admin/leaderboard",
          "pluginSlug": "leaderboard"
        },
        {
          "label": "Support",
          "icon": "HelpCircle",
          "href": "/admin/support",
          "pluginSlug": "support"
        }
      ]
    },
    {
      "label": "Finance",
      "icon": "Coins",
      "items": [
        {
          "label": "Credit Approvals",
          "icon": "Coins",
          "href": "/admin/credits"
        },
        {
          "label": "Subscriptions",
          "icon": "Star",
          "href": "/admin/subscriptions"
        },
        {
          "label": "P2P Marketplace",
          "icon": "Store",
          "href": "/admin/marketplace"
        }
      ]
    },
    {
      "label": "Monitoring",
      "icon": "History",
      "items": [
        {
          "label": "Activity Log",
          "icon": "History",
          "href": "/admin/activity"
        },
        {
          "label": "Health Rules",
          "icon": "ShieldCheck",
          "href": "/admin/health-rules"
        }
      ]
    },
    {
      "label": "Config",
      "icon": "Settings",
      "items": [
        {
          "label": "Categories",
          "icon": "Database",
          "href": "/admin/categories"
        },
        {
          "label": "Networks",
          "icon": "Radio",
          "href": "/admin/tools/networks"
        },
        {
          "label": "Plugins",
          "icon": "Puzzle",
          "href": "/admin/plugins"
        },
        {
          "label": "Key Manager",
          "icon": "Key",
          "href": "/admin/key-manager"
        },
        {
          "label": "Config Manager",
          "icon": "Settings2",
          "href": "/admin/config-manager"
        },
        {
          "label": "Settings",
          "icon": "Settings",
          "href": "/admin/settings"
        }
      ]
    },
    {
      "label": "Developer",
      "icon": "Code2",
      "items": [
        {
          "label": "Live Console",
          "icon": "Terminal",
          "href": "/admin/developer?tab=console"
        },
        {
          "label": "Telemetry",
          "icon": "Activity",
          "href": "/admin/developer?tab=telemetry"
        },
        {
          "label": "Ping Test",
          "icon": "RefreshCwIcon",
          "href": "/admin/developer?tab=ping"
        },
        {
          "label": "Functions",
          "icon": "Server",
          "href": "/admin/developer?tab=functions"
        },
        {
          "label": "Error Log",
          "icon": "XCircle",
          "href": "/admin/developer?tab=errors"
        },
        {
          "label": "Shell",
          "icon": "TerminalSquare",
          "href": "/admin/developer?tab=shell"
        },
        {
          "label": "Database",
          "icon": "Database",
          "href": "/admin/developer?tab=db"
        }
      ]
    }
  ],
  "moderator": [
    {
      "label": "Command",
      "icon": "LayoutDashboard",
      "items": [
        {
          "label": "Home",
          "icon": "Home",
          "href": "/dashboard"
        },
        {
          "label": "Overview",
          "icon": "LayoutDashboard",
          "children": [
            {
              "label": "Daily Check-in",
              "icon": "Flame",
              "href": "/checkin"
            },
            {
              "label": "Activity Log",
              "icon": "History",
              "href": "/history"
            },
            {
              "label": "Dashboard",
              "icon": "LayoutDashboard",
              "href": "/dashboard"
            }
          ]
        }
      ]
    },
    {
      "label": "Protocols",
      "icon": "FolderGit2",
      "items": [
        {
          "label": "Project",
          "icon": "FolderGit2",
          "href": "/projects",
          "pluginSlug": "projects"
        },
        {
          "label": "Onchain",
          "icon": "Boxes",
          "children": [
            { "label": "Overview", "icon": "LayoutDashboard", "href": "/projects?rollup=Onchain",       "pluginSlug": "projects" },
            { "label": "Mainnet",  "icon": "Network",         "href": "/projects?type=onchain-mainnet", "pluginSlug": "projects" },
            { "label": "Testnet",  "icon": "FlaskConical",    "href": "/projects?type=onchain-testnet", "pluginSlug": "projects" }
          ]
        },
        {
          "label": "Exchange",
          "icon": "ArrowLeftRight",
          "children": [
            { "label": "Overview", "icon": "LayoutDashboard", "href": "/projects?rollup=Exchange", "pluginSlug": "projects" },
            {
              "label": "Binance",
              "icon": "Building2",
              "children": [
                { "label": "Overview", "icon": "LayoutDashboard", "href": "/projects?rollup=Exchange:Binance", "pluginSlug": "projects" },
                {
                  "label": "Trading",
                  "icon": "TrendingUp",
                  "children": [
                    { "label": "Overview",    "icon": "LayoutDashboard", "href": "/projects?type=binance-trading",         "pluginSlug": "projects" },
                    { "label": "Volume",      "icon": "BarChart3",       "href": "/projects?type=binance-trading-volume",      "pluginSlug": "projects" },
                    { "label": "Competition", "icon": "Trophy",          "href": "/projects?type=binance-trading-competition", "pluginSlug": "projects" },
                    { "label": "Alpha",       "icon": "Sparkles",        "href": "/projects?type=binance-trading-alpha",       "pluginSlug": "projects" }
                  ]
                },
                {
                  "label": "Instant",
                  "icon": "Zap",
                  "children": [
                    { "label": "Overview",      "icon": "LayoutDashboard", "href": "/projects?type=binance-instant",            "pluginSlug": "projects" },
                    { "label": "Reward Hub",    "icon": "Gift",            "href": "/projects?type=binance-instant-rewardhub",  "pluginSlug": "projects" },
                    { "label": "Red Packet",    "icon": "Package",         "href": "/projects?type=binance-instant-redpacket",  "pluginSlug": "projects" },
                    { "label": "Live",          "icon": "Radio",           "href": "/projects?type=binance-instant-live",       "pluginSlug": "projects" },
                    { "label": "Learn to Earn", "icon": "Rocket",          "href": "/projects?type=binance-instant-learn2earn", "pluginSlug": "projects" }
                  ]
                },
                {
                  "label": "Web3",
                  "icon": "Globe",
                  "children": [
                    { "label": "Overview", "icon": "LayoutDashboard", "href": "/projects?type=binance-web3",         "pluginSlug": "projects" },
                    { "label": "Booster",  "icon": "Rocket",          "href": "/projects?type=binance-web3-booster", "pluginSlug": "projects" },
                    { "label": "Alpha",    "icon": "Sparkles",        "href": "/projects?type=binance-web3-alpha",   "pluginSlug": "projects" }
                  ]
                },
                { "label": "Refer",    "icon": "Share2",          "href": "/projects?type=binance-refer",      "pluginSlug": "projects" },
                { "label": "Other",    "icon": "MoreHorizontal",  "href": "/projects?type=binance-other",      "pluginSlug": "projects" }
              ]
            },
            {
              "label": "Bitget",
              "icon": "Building2",
              "children": [
                { "label": "Overview",     "icon": "LayoutDashboard", "href": "/projects?rollup=Exchange:Bitget", "pluginSlug": "projects" },
                { "label": "CandyBomb",    "icon": "Zap",             "href": "/projects?type=bitget-candybomb",  "pluginSlug": "projects" },
                { "label": "Hold",         "icon": "Lock",            "href": "/projects?type=bitget-hold",       "pluginSlug": "projects" },
                { "label": "Refer",        "icon": "Share2",          "href": "/projects?type=bitget-refer",      "pluginSlug": "projects" },
                { "label": "Other",        "icon": "MoreHorizontal",  "href": "/projects?type=bitget-other",      "pluginSlug": "projects" },
                { "label": "Mystery Box",  "icon": "Gamepad2",        "href": "/projects?type=bitget-mysterybox", "pluginSlug": "projects" }
              ]
            },
            {
              "label": "Kucoin",
              "icon": "Building2",
              "children": [
                { "label": "Overview",       "icon": "LayoutDashboard", "href": "/projects?rollup=Exchange:Kucoin", "pluginSlug": "projects" },
                {
                  "label": "Trading",
                  "icon": "TrendingUp",
                  "children": [
                    { "label": "Overview", "icon": "LayoutDashboard", "href": "/projects?type=kucoin-trading",        "pluginSlug": "projects" },
                    { "label": "Gempool",  "icon": "Gem",             "href": "/projects?type=kucoin-trading-gempool", "pluginSlug": "projects" },
                    { "label": "Volume",   "icon": "BarChart3",       "href": "/projects?type=kucoin-trading-volume",  "pluginSlug": "projects" },
                    { "label": "PnL",      "icon": "LineChart",       "href": "/projects?type=kucoin-trading-pnl",     "pluginSlug": "projects" }
                  ]
                },
                { "label": "Refer",          "icon": "Share2",          "href": "/projects?type=kucoin-refer",      "pluginSlug": "projects" },
                { "label": "Learn to Earn",  "icon": "Rocket",          "href": "/projects?type=kucoin-learn2earn", "pluginSlug": "projects" },
                { "label": "Other",          "icon": "MoreHorizontal",  "href": "/projects?type=kucoin-other",      "pluginSlug": "projects" }
              ]
            },
            {
              "label": "Bybit",
              "icon": "Building2",
              "children": [
                { "label": "Overview",   "icon": "LayoutDashboard", "href": "/projects?rollup=Exchange:Bybit", "pluginSlug": "projects" },
                { "label": "Hold",       "icon": "Lock",            "href": "/projects?type=bybit-hold",       "pluginSlug": "projects" },
                { "label": "Wednesday",  "icon": "Timer",           "href": "/projects?type=bybit-wednesday",  "pluginSlug": "projects" },
                { "label": "Refer",      "icon": "Share2",          "href": "/projects?type=bybit-refer",      "pluginSlug": "projects" },
                { "label": "Other",      "icon": "MoreHorizontal",  "href": "/projects?type=bybit-other",      "pluginSlug": "projects" }
              ]
            },
            { "label": "Other", "icon": "MoreHorizontal", "href": "/projects?type=exchange-other", "pluginSlug": "projects" }
          ]
        },
        {
          "label": "Web3",
          "icon": "Globe",
          "children": [
            { "label": "Overview", "icon": "LayoutDashboard", "href": "/projects?rollup=Web3",   "pluginSlug": "projects" },
            { "label": "Dex",      "icon": "ArrowLeftRight",  "href": "/projects?type=web3-dex", "pluginSlug": "projects" },
            { "label": "Dapp",     "icon": "AppWindow",       "href": "/projects?type=web3-dapp","pluginSlug": "projects" },
            { "label": "Other",    "icon": "MoreHorizontal",  "href": "/projects?type=web3-other","pluginSlug": "projects" }
          ]
        },
        {
          "label": "Social",
          "icon": "Megaphone",
          "children": [
            { "label": "Overview", "icon": "LayoutDashboard", "href": "/projects?rollup=Social",        "pluginSlug": "projects" },
            { "label": "Twitter",  "icon": "Rss",             "href": "/projects?type=social-twitter",  "pluginSlug": "projects" },
            { "label": "Warpcast", "icon": "Cast",            "href": "/projects?type=social-warpcast", "pluginSlug": "projects" }
          ]
        },
        {
          "label": "App",
          "icon": "AppWindow",
          "children": [
            { "label": "Overview", "icon": "LayoutDashboard", "href": "/projects?rollup=App",      "pluginSlug": "projects" },
            { "label": "Wallet",   "icon": "Wallet",          "href": "/projects?type=app-wallet", "pluginSlug": "projects" },
            { "label": "Mining",   "icon": "Cpu",             "href": "/projects?type=app-mining", "pluginSlug": "projects" },
            { "label": "Refer",    "icon": "Share2",          "href": "/projects?type=app-refer",  "pluginSlug": "projects" }
          ]
        },
        {
          "label": "Task",
          "icon": "CheckSquare",
          "href": "/tasks",
          "pluginSlug": "tasks"
        }
      ]
    },
    {
      "label": "Vault",
      "icon": "Vault",
      "items": [
        {
          "label": "Vault",
          "icon": "Vault",
          "href": "/vault"
        }
      ]
    },
    {
      "label": "Market",
      "icon": "Store",
      "items": [
        {
          "label": "Market Wallet",
          "icon": "Wallet",
          "href": "/marketplace/wallet"
        },
        {
          "label": "AZN Market",
          "icon": "Zap",
          "href": "/marketplace/azn"
        },
        {
          "label": "NFT Market",
          "icon": "Image",
          "href": "/marketplace/nft"
        },
        {
          "label": "Vault Market",
          "icon": "Vault",
          "href": "/marketplace/vault",
          "pluginSlug": "vault"
        },
        {
          "label": "P2P Market",
          "icon": "Handshake",
          "href": "/marketplace/p2p"
        },
        {
          "label": "Polymarket",
          "icon": "LineChart",
          "children": [
            {
              "label": "Wallet",
              "icon": "Wallet",
              "href": "/marketplace/polymarket?tab=wallet"
            },
            {
              "label": "Overview",
              "icon": "LayoutDashboard",
              "href": "/marketplace/polymarket?tab=overview"
            },
            {
              "label": "AI Agent",
              "icon": "BotIcon",
              "href": "/marketplace/polymarket?tab=ai-agent"
            },
            {
              "label": "Market",
              "icon": "Store",
              "href": "/marketplace/polymarket?tab=market"
            },
            {
              "label": "Order History",
              "icon": "History",
              "href": "/marketplace/polymarket?tab=order-history"
            }
          ]
        },
        {
          "label": "Order History",
          "icon": "History",
          "href": "/marketplace/order-history"
        }
      ]
    },
    {
      "label": "Teams",
      "icon": "Users",
      "items": [
        {
          "label": "Overview",
          "icon": "LayoutDashboard",
          "href": "/teams"
        },
        {
          "label": "Members",
          "icon": "Users",
          "href": "/teams?tab=members"
        },
        {
          "label": "Chat",
          "icon": "MessageSquare",
          "href": "/teams?tab=chat"
        },
        {
          "label": "Tasks",
          "icon": "ListTodo",
          "href": "/teams?tab=tasks"
        },
        {
          "label": "Missions",
          "icon": "Swords",
          "href": "/teams?tab=missions"
        },
        {
          "label": "Browse Teams",
          "icon": "Search",
          "href": "/teams?tab=browse"
        },
        {
          "label": "Invite Link",
          "icon": "Link2",
          "href": "/teams?tab=invite"
        }
      ]
    },
    {
      "label": "Earn",
      "icon": "DollarSign",
      "items": [
        {
          "label": "Earn Center",
          "icon": "DollarSign",
          "children": [
            {
              "label": "Link to Earn",
              "icon": "Link2",
              "href": "/earn?tab=link-to-earn"
            },
            {
              "label": "Watch Ads",
              "icon": "PlayCircle",
              "href": "/earn?tab=watch-ads"
            }
          ]
        },
        {
          "label": "Referral",
          "icon": "Share2",
          "href": "/referrals",
          "pluginSlug": "referrals"
        }
      ]
    },
    {
      "label": "Social",
      "icon": "MessageCircle",
      "items": [
        {
          "label": "Message",
          "icon": "MessageCircle",
          "href": "/inbox"
        },
        {
          "label": "Operators",
          "icon": "Trophy",
          "href": "/leaderboard",
          "pluginSlug": "leaderboard"
        },
        {
          "label": "Profile",
          "icon": "UserCircle",
          "href": "/profile"
        },
        {
          "label": "Support",
          "icon": "HelpCircle",
          "href": "/support",
          "pluginSlug": "support"
        }
      ]
    },
    {
      "label": "System",
      "icon": "Settings",
      "items": [
        {
          "label": "Settings",
          "icon": "Settings",
          "href": "/settings"
        },
        {
          "label": "Security",
          "icon": "ShieldCheck",
          "href": "/security"
        }
      ]
    }
  ],
  "team_leader": [
    {
      "label": "Command",
      "icon": "LayoutDashboard",
      "items": [
        {
          "label": "Dashboard",
          "icon": "LayoutDashboard",
          "href": "/dashboard"
        },
        {
          "label": "Daily Check-in",
          "icon": "Flame",
          "href": "/checkin"
        },
        {
          "label": "Activity Log",
          "icon": "History",
          "href": "/history"
        },
        {
          "label": "Team Settings",
          "icon": "Settings",
          "href": "/teams?tab=panel"
        }
      ]
    },
    {
      "label": "Team Overview",
      "icon": "Users",
      "items": [
        {
          "label": "Team Home",
          "icon": "LayoutDashboard",
          "href": "/teams"
        },
        {
          "label": "Members",
          "icon": "Users",
          "href": "/teams?tab=members"
        },
        {
          "label": "Chat",
          "icon": "MessageSquare",
          "href": "/teams?tab=chat"
        },
        {
          "label": "Browse Teams",
          "icon": "Search",
          "href": "/teams?tab=browse"
        },
        {
          "label": "Invite Link",
          "icon": "Link2",
          "href": "/teams?tab=invite"
        }
      ]
    },
    {
      "label": "Team Progress",
      "icon": "BarChart2",
      "items": [
        {
          "label": "Task Progress",
          "icon": "ListTodo",
          "href": "/teams?tab=tasks"
        },
        {
          "label": "Missions",
          "icon": "Swords",
          "href": "/teams?tab=missions"
        },
        {
          "label": "Leaderboard",
          "icon": "Trophy",
          "href": "/teams?tab=leaderboard"
        },
        {
          "label": "Projects",
          "icon": "FolderGit2",
          "href": "/teams?tab=projects"
        }
      ]
    },
    {
      "label": "Team Finance",
      "icon": "Coins",
      "items": [
        {
          "label": "Team Vault",
          "icon": "Vault",
          "href": "/teams?tab=vault"
        },
        {
          "label": "AZN & Credits",
          "icon": "Coins",
          "href": "/credits"
        }
      ]
    },
    {
      "label": "Team Panel",
      "icon": "Settings",
      "items": [
        {
          "label": "Team Settings",
          "icon": "Settings",
          "href": "/teams?tab=panel"
        }
      ]
    },
    {
      "label": "Protocols",
      "icon": "FolderGit2",
      "items": [
        {
          "label": "Project",
          "icon": "FolderGit2",
          "href": "/projects",
          "pluginSlug": "projects"
        },
        {
          "label": "Onchain",
          "icon": "Boxes",
          "children": [
            { "label": "Overview", "icon": "LayoutDashboard", "href": "/projects?rollup=Onchain",       "pluginSlug": "projects" },
            { "label": "Mainnet",  "icon": "Network",         "href": "/projects?type=onchain-mainnet", "pluginSlug": "projects" },
            { "label": "Testnet",  "icon": "FlaskConical",    "href": "/projects?type=onchain-testnet", "pluginSlug": "projects" }
          ]
        },
        {
          "label": "Exchange",
          "icon": "ArrowLeftRight",
          "children": [
            { "label": "Overview", "icon": "LayoutDashboard", "href": "/projects?rollup=Exchange", "pluginSlug": "projects" },
            {
              "label": "Binance",
              "icon": "Building2",
              "children": [
                { "label": "Overview", "icon": "LayoutDashboard", "href": "/projects?rollup=Exchange:Binance", "pluginSlug": "projects" },
                {
                  "label": "Trading",
                  "icon": "TrendingUp",
                  "children": [
                    { "label": "Overview",    "icon": "LayoutDashboard", "href": "/projects?type=binance-trading",         "pluginSlug": "projects" },
                    { "label": "Volume",      "icon": "BarChart3",       "href": "/projects?type=binance-trading-volume",      "pluginSlug": "projects" },
                    { "label": "Competition", "icon": "Trophy",          "href": "/projects?type=binance-trading-competition", "pluginSlug": "projects" },
                    { "label": "Alpha",       "icon": "Sparkles",        "href": "/projects?type=binance-trading-alpha",       "pluginSlug": "projects" }
                  ]
                },
                {
                  "label": "Instant",
                  "icon": "Zap",
                  "children": [
                    { "label": "Overview",      "icon": "LayoutDashboard", "href": "/projects?type=binance-instant",            "pluginSlug": "projects" },
                    { "label": "Reward Hub",    "icon": "Gift",            "href": "/projects?type=binance-instant-rewardhub",  "pluginSlug": "projects" },
                    { "label": "Red Packet",    "icon": "Package",         "href": "/projects?type=binance-instant-redpacket",  "pluginSlug": "projects" },
                    { "label": "Live",          "icon": "Radio",           "href": "/projects?type=binance-instant-live",       "pluginSlug": "projects" },
                    { "label": "Learn to Earn", "icon": "Rocket",          "href": "/projects?type=binance-instant-learn2earn", "pluginSlug": "projects" }
                  ]
                },
                {
                  "label": "Web3",
                  "icon": "Globe",
                  "children": [
                    { "label": "Overview", "icon": "LayoutDashboard", "href": "/projects?type=binance-web3",         "pluginSlug": "projects" },
                    { "label": "Booster",  "icon": "Rocket",          "href": "/projects?type=binance-web3-booster", "pluginSlug": "projects" },
                    { "label": "Alpha",    "icon": "Sparkles",        "href": "/projects?type=binance-web3-alpha",   "pluginSlug": "projects" }
                  ]
                },
                { "label": "Refer",    "icon": "Share2",          "href": "/projects?type=binance-refer",      "pluginSlug": "projects" },
                { "label": "Other",    "icon": "MoreHorizontal",  "href": "/projects?type=binance-other",      "pluginSlug": "projects" }
              ]
            },
            {
              "label": "Bitget",
              "icon": "Building2",
              "children": [
                { "label": "Overview",     "icon": "LayoutDashboard", "href": "/projects?rollup=Exchange:Bitget", "pluginSlug": "projects" },
                { "label": "CandyBomb",    "icon": "Zap",             "href": "/projects?type=bitget-candybomb",  "pluginSlug": "projects" },
                { "label": "Hold",         "icon": "Lock",            "href": "/projects?type=bitget-hold",       "pluginSlug": "projects" },
                { "label": "Refer",        "icon": "Share2",          "href": "/projects?type=bitget-refer",      "pluginSlug": "projects" },
                { "label": "Other",        "icon": "MoreHorizontal",  "href": "/projects?type=bitget-other",      "pluginSlug": "projects" },
                { "label": "Mystery Box",  "icon": "Gamepad2",        "href": "/projects?type=bitget-mysterybox", "pluginSlug": "projects" }
              ]
            },
            {
              "label": "Kucoin",
              "icon": "Building2",
              "children": [
                { "label": "Overview",       "icon": "LayoutDashboard", "href": "/projects?rollup=Exchange:Kucoin", "pluginSlug": "projects" },
                {
                  "label": "Trading",
                  "icon": "TrendingUp",
                  "children": [
                    { "label": "Overview", "icon": "LayoutDashboard", "href": "/projects?type=kucoin-trading",        "pluginSlug": "projects" },
                    { "label": "Gempool",  "icon": "Gem",             "href": "/projects?type=kucoin-trading-gempool", "pluginSlug": "projects" },
                    { "label": "Volume",   "icon": "BarChart3",       "href": "/projects?type=kucoin-trading-volume",  "pluginSlug": "projects" },
                    { "label": "PnL",      "icon": "LineChart",       "href": "/projects?type=kucoin-trading-pnl",     "pluginSlug": "projects" }
                  ]
                },
                { "label": "Refer",          "icon": "Share2",          "href": "/projects?type=kucoin-refer",      "pluginSlug": "projects" },
                { "label": "Learn to Earn",  "icon": "Rocket",          "href": "/projects?type=kucoin-learn2earn", "pluginSlug": "projects" },
                { "label": "Other",          "icon": "MoreHorizontal",  "href": "/projects?type=kucoin-other",      "pluginSlug": "projects" }
              ]
            },
            {
              "label": "Bybit",
              "icon": "Building2",
              "children": [
                { "label": "Overview",   "icon": "LayoutDashboard", "href": "/projects?rollup=Exchange:Bybit", "pluginSlug": "projects" },
                { "label": "Hold",       "icon": "Lock",            "href": "/projects?type=bybit-hold",       "pluginSlug": "projects" },
                { "label": "Wednesday",  "icon": "Timer",           "href": "/projects?type=bybit-wednesday",  "pluginSlug": "projects" },
                { "label": "Refer",      "icon": "Share2",          "href": "/projects?type=bybit-refer",      "pluginSlug": "projects" },
                { "label": "Other",      "icon": "MoreHorizontal",  "href": "/projects?type=bybit-other",      "pluginSlug": "projects" }
              ]
            },
            { "label": "Other", "icon": "MoreHorizontal", "href": "/projects?type=exchange-other", "pluginSlug": "projects" }
          ]
        },
        {
          "label": "Web3",
          "icon": "Globe",
          "children": [
            { "label": "Overview", "icon": "LayoutDashboard", "href": "/projects?rollup=Web3",   "pluginSlug": "projects" },
            { "label": "Dex",      "icon": "ArrowLeftRight",  "href": "/projects?type=web3-dex", "pluginSlug": "projects" },
            { "label": "Dapp",     "icon": "AppWindow",       "href": "/projects?type=web3-dapp","pluginSlug": "projects" },
            { "label": "Other",    "icon": "MoreHorizontal",  "href": "/projects?type=web3-other","pluginSlug": "projects" }
          ]
        },
        {
          "label": "Social",
          "icon": "Megaphone",
          "children": [
            { "label": "Overview", "icon": "LayoutDashboard", "href": "/projects?rollup=Social",        "pluginSlug": "projects" },
            { "label": "Twitter",  "icon": "Rss",             "href": "/projects?type=social-twitter",  "pluginSlug": "projects" },
            { "label": "Warpcast", "icon": "Cast",            "href": "/projects?type=social-warpcast", "pluginSlug": "projects" }
          ]
        },
        {
          "label": "App",
          "icon": "AppWindow",
          "children": [
            { "label": "Overview", "icon": "LayoutDashboard", "href": "/projects?rollup=App",      "pluginSlug": "projects" },
            { "label": "Wallet",   "icon": "Wallet",          "href": "/projects?type=app-wallet", "pluginSlug": "projects" },
            { "label": "Mining",   "icon": "Cpu",             "href": "/projects?type=app-mining", "pluginSlug": "projects" },
            { "label": "Refer",    "icon": "Share2",          "href": "/projects?type=app-refer",  "pluginSlug": "projects" }
          ]
        },
        {
          "label": "Task",
          "icon": "CheckSquare",
          "href": "/tasks",
          "pluginSlug": "tasks"
        }
      ]
    },
    {
      "label": "Vault",
      "icon": "Vault",
      "items": [
        {
          "label": "Vault",
          "icon": "Vault",
          "href": "/vault"
        }
      ]
    },
    {
      "label": "Market",
      "icon": "Store",
      "items": [
        {
          "label": "AZN Market",
          "icon": "Zap",
          "href": "/marketplace/azn"
        },
        {
          "label": "NFT Market",
          "icon": "Image",
          "href": "/marketplace/nft"
        }
      ]
    },
    {
      "label": "Earn",
      "icon": "DollarSign",
      "items": [
        {
          "label": "Earn Center",
          "icon": "DollarSign",
          "href": "/earn"
        },
        {
          "label": "Operators",
          "icon": "Trophy",
          "href": "/leaderboard",
          "pluginSlug": "leaderboard"
        },
        {
          "label": "Referrals",
          "icon": "Share2",
          "href": "/referrals",
          "pluginSlug": "referrals"
        }
      ]
    },
    {
      "label": "Social",
      "icon": "MessageCircle",
      "items": [
        {
          "label": "Messages",
          "icon": "MessageCircle",
          "href": "/inbox"
        },
        {
          "label": "My Profile",
          "icon": "UserCircle",
          "href": "/profile"
        },
        {
          "label": "Support",
          "icon": "HelpCircle",
          "href": "/support",
          "pluginSlug": "support"
        }
      ]
    },
    {
      "label": "System",
      "icon": "Settings",
      "items": [
        {
          "label": "Subscription",
          "icon": "Star",
          "href": "/subscription"
        },
        {
          "label": "My Wallet",
          "icon": "Wallet",
          "href": "/wallet"
        },
        {
          "label": "Settings",
          "icon": "Settings",
          "href": "/settings"
        },
        {
          "label": "Security",
          "icon": "ShieldCheck",
          "href": "/security"
        }
      ]
    }
  ],
  "user": [
    {
      "label": "Command",
      "icon": "LayoutDashboard",
      "items": [
        {
          "label": "Home",
          "icon": "Home",
          "href": "/dashboard"
        },
        {
          "label": "Overview",
          "icon": "LayoutDashboard",
          "children": [
            {
              "label": "Daily Check-in",
              "icon": "Flame",
              "href": "/checkin"
            },
            {
              "label": "Activity Log",
              "icon": "History",
              "href": "/history"
            },
            {
              "label": "Dashboard",
              "icon": "LayoutDashboard",
              "href": "/dashboard"
            }
          ]
        }
      ]
    },
    {
      "label": "Protocols",
      "icon": "FolderGit2",
      "items": [
        {
          "label": "Project",
          "icon": "FolderGit2",
          "href": "/projects",
          "pluginSlug": "projects"
        },
        {
          "label": "Onchain",
          "icon": "Boxes",
          "children": [
            { "label": "Overview", "icon": "LayoutDashboard", "href": "/projects?rollup=Onchain",       "pluginSlug": "projects" },
            { "label": "Mainnet",  "icon": "Network",         "href": "/projects?type=onchain-mainnet", "pluginSlug": "projects" },
            { "label": "Testnet",  "icon": "FlaskConical",    "href": "/projects?type=onchain-testnet", "pluginSlug": "projects" }
          ]
        },
        {
          "label": "Exchange",
          "icon": "ArrowLeftRight",
          "children": [
            { "label": "Overview", "icon": "LayoutDashboard", "href": "/projects?rollup=Exchange", "pluginSlug": "projects" },
            {
              "label": "Binance",
              "icon": "Building2",
              "children": [
                { "label": "Overview", "icon": "LayoutDashboard", "href": "/projects?rollup=Exchange:Binance", "pluginSlug": "projects" },
                {
                  "label": "Trading",
                  "icon": "TrendingUp",
                  "children": [
                    { "label": "Overview",    "icon": "LayoutDashboard", "href": "/projects?type=binance-trading",         "pluginSlug": "projects" },
                    { "label": "Volume",      "icon": "BarChart3",       "href": "/projects?type=binance-trading-volume",      "pluginSlug": "projects" },
                    { "label": "Competition", "icon": "Trophy",          "href": "/projects?type=binance-trading-competition", "pluginSlug": "projects" },
                    { "label": "Alpha",       "icon": "Sparkles",        "href": "/projects?type=binance-trading-alpha",       "pluginSlug": "projects" }
                  ]
                },
                {
                  "label": "Instant",
                  "icon": "Zap",
                  "children": [
                    { "label": "Overview",      "icon": "LayoutDashboard", "href": "/projects?type=binance-instant",            "pluginSlug": "projects" },
                    { "label": "Reward Hub",    "icon": "Gift",            "href": "/projects?type=binance-instant-rewardhub",  "pluginSlug": "projects" },
                    { "label": "Red Packet",    "icon": "Package",         "href": "/projects?type=binance-instant-redpacket",  "pluginSlug": "projects" },
                    { "label": "Live",          "icon": "Radio",           "href": "/projects?type=binance-instant-live",       "pluginSlug": "projects" },
                    { "label": "Learn to Earn", "icon": "Rocket",          "href": "/projects?type=binance-instant-learn2earn", "pluginSlug": "projects" }
                  ]
                },
                {
                  "label": "Web3",
                  "icon": "Globe",
                  "children": [
                    { "label": "Overview", "icon": "LayoutDashboard", "href": "/projects?type=binance-web3",         "pluginSlug": "projects" },
                    { "label": "Booster",  "icon": "Rocket",          "href": "/projects?type=binance-web3-booster", "pluginSlug": "projects" },
                    { "label": "Alpha",    "icon": "Sparkles",        "href": "/projects?type=binance-web3-alpha",   "pluginSlug": "projects" }
                  ]
                },
                { "label": "Refer",    "icon": "Share2",          "href": "/projects?type=binance-refer",      "pluginSlug": "projects" },
                { "label": "Other",    "icon": "MoreHorizontal",  "href": "/projects?type=binance-other",      "pluginSlug": "projects" }
              ]
            },
            {
              "label": "Bitget",
              "icon": "Building2",
              "children": [
                { "label": "Overview",     "icon": "LayoutDashboard", "href": "/projects?rollup=Exchange:Bitget", "pluginSlug": "projects" },
                { "label": "CandyBomb",    "icon": "Zap",             "href": "/projects?type=bitget-candybomb",  "pluginSlug": "projects" },
                { "label": "Hold",         "icon": "Lock",            "href": "/projects?type=bitget-hold",       "pluginSlug": "projects" },
                { "label": "Refer",        "icon": "Share2",          "href": "/projects?type=bitget-refer",      "pluginSlug": "projects" },
                { "label": "Other",        "icon": "MoreHorizontal",  "href": "/projects?type=bitget-other",      "pluginSlug": "projects" },
                { "label": "Mystery Box",  "icon": "Gamepad2",        "href": "/projects?type=bitget-mysterybox", "pluginSlug": "projects" }
              ]
            },
            {
              "label": "Kucoin",
              "icon": "Building2",
              "children": [
                { "label": "Overview",       "icon": "LayoutDashboard", "href": "/projects?rollup=Exchange:Kucoin", "pluginSlug": "projects" },
                {
                  "label": "Trading",
                  "icon": "TrendingUp",
                  "children": [
                    { "label": "Overview", "icon": "LayoutDashboard", "href": "/projects?type=kucoin-trading",        "pluginSlug": "projects" },
                    { "label": "Gempool",  "icon": "Gem",             "href": "/projects?type=kucoin-trading-gempool", "pluginSlug": "projects" },
                    { "label": "Volume",   "icon": "BarChart3",       "href": "/projects?type=kucoin-trading-volume",  "pluginSlug": "projects" },
                    { "label": "PnL",      "icon": "LineChart",       "href": "/projects?type=kucoin-trading-pnl",     "pluginSlug": "projects" }
                  ]
                },
                { "label": "Refer",          "icon": "Share2",          "href": "/projects?type=kucoin-refer",      "pluginSlug": "projects" },
                { "label": "Learn to Earn",  "icon": "Rocket",          "href": "/projects?type=kucoin-learn2earn", "pluginSlug": "projects" },
                { "label": "Other",          "icon": "MoreHorizontal",  "href": "/projects?type=kucoin-other",      "pluginSlug": "projects" }
              ]
            },
            {
              "label": "Bybit",
              "icon": "Building2",
              "children": [
                { "label": "Overview",   "icon": "LayoutDashboard", "href": "/projects?rollup=Exchange:Bybit", "pluginSlug": "projects" },
                { "label": "Hold",       "icon": "Lock",            "href": "/projects?type=bybit-hold",       "pluginSlug": "projects" },
                { "label": "Wednesday",  "icon": "Timer",           "href": "/projects?type=bybit-wednesday",  "pluginSlug": "projects" },
                { "label": "Refer",      "icon": "Share2",          "href": "/projects?type=bybit-refer",      "pluginSlug": "projects" },
                { "label": "Other",      "icon": "MoreHorizontal",  "href": "/projects?type=bybit-other",      "pluginSlug": "projects" }
              ]
            },
            { "label": "Other", "icon": "MoreHorizontal", "href": "/projects?type=exchange-other", "pluginSlug": "projects" }
          ]
        },
        {
          "label": "Web3",
          "icon": "Globe",
          "children": [
            { "label": "Overview", "icon": "LayoutDashboard", "href": "/projects?rollup=Web3",   "pluginSlug": "projects" },
            { "label": "Dex",      "icon": "ArrowLeftRight",  "href": "/projects?type=web3-dex", "pluginSlug": "projects" },
            { "label": "Dapp",     "icon": "AppWindow",       "href": "/projects?type=web3-dapp","pluginSlug": "projects" },
            { "label": "Other",    "icon": "MoreHorizontal",  "href": "/projects?type=web3-other","pluginSlug": "projects" }
          ]
        },
        {
          "label": "Social",
          "icon": "Megaphone",
          "children": [
            { "label": "Overview", "icon": "LayoutDashboard", "href": "/projects?rollup=Social",        "pluginSlug": "projects" },
            { "label": "Twitter",  "icon": "Rss",             "href": "/projects?type=social-twitter",  "pluginSlug": "projects" },
            { "label": "Warpcast", "icon": "Cast",            "href": "/projects?type=social-warpcast", "pluginSlug": "projects" }
          ]
        },
        {
          "label": "App",
          "icon": "AppWindow",
          "children": [
            { "label": "Overview", "icon": "LayoutDashboard", "href": "/projects?rollup=App",      "pluginSlug": "projects" },
            { "label": "Wallet",   "icon": "Wallet",          "href": "/projects?type=app-wallet", "pluginSlug": "projects" },
            { "label": "Mining",   "icon": "Cpu",             "href": "/projects?type=app-mining", "pluginSlug": "projects" },
            { "label": "Refer",    "icon": "Share2",          "href": "/projects?type=app-refer",  "pluginSlug": "projects" }
          ]
        },
        {
          "label": "Task",
          "icon": "CheckSquare",
          "href": "/tasks",
          "pluginSlug": "tasks"
        },
        {
          "label": "Content",
          "icon": "Bot",
          "href": "/content"
        }
      ]
    },

    {
      "label": "Teams",
      "icon": "Users",
      "items": [
        {
          "label": "Overview",
          "icon": "LayoutDashboard",
          "href": "/teams"
        },
        {
          "label": "Members",
          "icon": "Users",
          "href": "/teams?tab=members"
        },
        {
          "label": "Chat",
          "icon": "MessageSquare",
          "href": "/teams?tab=chat"
        },
        {
          "label": "Vault",
          "icon": "Vault",
          "href": "/teams?tab=vault"
        },
        {
          "label": "Tasks",
          "icon": "ListTodo",
          "href": "/teams?tab=tasks"
        },
        {
          "label": "Missions",
          "icon": "Swords",
          "href": "/teams?tab=missions"
        },
        {
          "label": "Leaderboard",
          "icon": "Trophy",
          "href": "/teams?tab=leaderboard"
        },
        {
          "label": "Projects",
          "icon": "FolderGit2",
          "href": "/teams?tab=projects"
        },
        {
          "label": "Browse Teams",
          "icon": "Search",
          "href": "/teams?tab=browse"
        },
        {
          "label": "Invite Link",
          "icon": "Link2",
          "href": "/teams?tab=invite"
        },
        {
          "label": "Panel",
          "icon": "Settings",
          "href": "/teams?tab=panel"
        }
      ]
    },
    {
      "label": "Vault",
      "icon": "Vault",
      "items": [
        {
          "label": "Vault",
          "icon": "Vault",
          "href": "/vault"
        }
      ]
    },
    {
      "label": "Market",
      "icon": "Store",
      "items": [
        {
          "label": "Market Wallet",
          "icon": "Wallet",
          "href": "/marketplace/wallet"
        },
        {
          "label": "AZN Market",
          "icon": "Zap",
          "href": "/marketplace/azn"
        },
        {
          "label": "NFT Market",
          "icon": "Image",
          "href": "/marketplace/nft"
        },
        {
          "label": "Vault Market",
          "icon": "Vault",
          "href": "/marketplace/vault",
          "pluginSlug": "vault"
        },
        {
          "label": "P2P Market",
          "icon": "Handshake",
          "href": "/marketplace/p2p"
        },
        {
          "label": "Polymarket",
          "icon": "LineChart",
          "children": [
            {
              "label": "Wallet",
              "icon": "Wallet",
              "href": "/marketplace/polymarket?tab=wallet"
            },
            {
              "label": "Overview",
              "icon": "LayoutDashboard",
              "href": "/marketplace/polymarket?tab=overview"
            },
            {
              "label": "AI Agent",
              "icon": "BotIcon",
              "href": "/marketplace/polymarket?tab=ai-agent"
            },
            {
              "label": "Market",
              "icon": "Store",
              "href": "/marketplace/polymarket?tab=market"
            },
            {
              "label": "Order History",
              "icon": "History",
              "href": "/marketplace/polymarket?tab=order-history"
            }
          ]
        },
        {
          "label": "Order History",
          "icon": "History",
          "href": "/marketplace/order-history"
        }
      ]
    },
    {
      "label": "Wallet",
      "icon": "Wallet",
      "items": [
        {
          "label": "My Wallet",
          "icon": "Wallet",
          "href": "/wallet"
        },
        {
          "label": "AZN & Credits",
          "icon": "Coins",
          "href": "/credits"
        }
      ]
    },
    {
      "label": "Earn",
      "icon": "DollarSign",
      "items": [
        {
          "label": "Earn Center",
          "icon": "DollarSign",
          "children": [
            {
              "label": "Link to Earn",
              "icon": "Link2",
              "href": "/earn?tab=link-to-earn"
            },
            {
              "label": "Watch Ads",
              "icon": "PlayCircle",
              "href": "/earn?tab=watch-ads"
            }
          ]
        },
        {
          "label": "Referral",
          "icon": "Share2",
          "href": "/referrals",
          "pluginSlug": "referrals"
        }
      ]
    },
    {
      "label": "Social",
      "icon": "MessageCircle",
      "items": [
        {
          "label": "Message",
          "icon": "MessageCircle",
          "href": "/inbox"
        },
        {
          "label": "Operators",
          "icon": "Trophy",
          "href": "/leaderboard",
          "pluginSlug": "leaderboard"
        },
        {
          "label": "Profile",
          "icon": "UserCircle",
          "href": "/profile"
        },
        {
          "label": "Support",
          "icon": "HelpCircle",
          "href": "/support",
          "pluginSlug": "support"
        }
      ]
    },
    {
      "label": "System",
      "icon": "Settings",
      "items": [
        {
          "label": "Subscription",
          "icon": "Star",
          "href": "/subscription"
        },
        {
          "label": "Settings",
          "icon": "Settings",
          "href": "/settings"
        },
        {
          "label": "Security",
          "icon": "ShieldCheck",
          "href": "/security"
        }
      ]
    }
  ]
};
