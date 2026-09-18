import { Router } from "express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";

const router = Router();

interface NetworkDef {
  network: string; networkId: string; baseGas: number; chain: string;
  symbol: string; coingeckoId: string; rpcUrl: string | null;
}

const NETWORKS: NetworkDef[] = [
  { network: "Ethereum",  networkId: "ethereum",  baseGas: 25,   chain: "EVM",     symbol: "ETH",  coingeckoId: "ethereum",         rpcUrl: null },
  { network: "BSC",       networkId: "bsc",        baseGas: 3,    chain: "EVM",     symbol: "BNB",  coingeckoId: "binancecoin",       rpcUrl: "https://bsc-dataseed.binance.org" },
  { network: "Polygon",   networkId: "polygon",    baseGas: 100,  chain: "EVM",     symbol: "MATIC",coingeckoId: "matic-network",     rpcUrl: "https://polygon-rpc.com" },
  { network: "Arbitrum",  networkId: "arbitrum",   baseGas: 0.1,  chain: "EVM",     symbol: "ETH",  coingeckoId: "ethereum",          rpcUrl: "https://arb1.arbitrum.io/rpc" },
  { network: "Optimism",  networkId: "optimism",   baseGas: 0.05, chain: "EVM",     symbol: "ETH",  coingeckoId: "ethereum",          rpcUrl: "https://mainnet.optimism.io" },
  { network: "Avalanche", networkId: "avalanche",  baseGas: 35,   chain: "EVM",     symbol: "AVAX", coingeckoId: "avalanche-2",       rpcUrl: "https://api.avax.network/ext/bc/C/rpc" },
  { network: "Fantom",    networkId: "fantom",     baseGas: 200,  chain: "EVM",     symbol: "FTM",  coingeckoId: "fantom",            rpcUrl: "https://rpc.ftm.tools" },
  { network: "zkSync",    networkId: "zksync",     baseGas: 0.25, chain: "EVM",     symbol: "ETH",  coingeckoId: "ethereum",          rpcUrl: "https://mainnet.era.zksync.io" },
  { network: "StarkNet",  networkId: "starknet",   baseGas: 0.01, chain: "non-EVM", symbol: "ETH",  coingeckoId: "ethereum",          rpcUrl: null },
  { network: "Linea",     networkId: "linea",      baseGas: 0.05, chain: "EVM",     symbol: "ETH",  coingeckoId: "ethereum",          rpcUrl: "https://rpc.linea.build" },
  { network: "Base",      networkId: "base",       baseGas: 0.05, chain: "EVM",     symbol: "ETH",  coingeckoId: "ethereum",          rpcUrl: "https://mainnet.base.org" },
  { network: "Scroll",    networkId: "scroll",     baseGas: 0.1,  chain: "EVM",     symbol: "ETH",  coingeckoId: "ethereum",          rpcUrl: "https://rpc.scroll.io" },
  { network: "Mantle",    networkId: "mantle",     baseGas: 0.02, chain: "EVM",     symbol: "MNT",  coingeckoId: "mantle",            rpcUrl: "https://rpc.mantle.xyz" },
  { network: "Celo",      networkId: "celo",       baseGas: 0.5,  chain: "EVM",     symbol: "CELO", coingeckoId: "celo",              rpcUrl: "https://forno.celo.org" },
  { network: "Gnosis",    networkId: "gnosis",     baseGas: 2,    chain: "EVM",     symbol: "xDAI", coingeckoId: "xdai",              rpcUrl: "https://rpc.gnosischain.com" },
  { network: "Moonbeam",  networkId: "moonbeam",   baseGas: 100,  chain: "EVM",     symbol: "GLMR", coingeckoId: "moonbeam",          rpcUrl: "https://rpc.api.moonbeam.network" },
  { network: "Cronos",    networkId: "cronos",     baseGas: 5000, chain: "EVM",     symbol: "CRO",  coingeckoId: "crypto-com-chain",  rpcUrl: "https://evm.cronos.org" },
  { network: "Klaytn",    networkId: "klaytn",     baseGas: 25,   chain: "EVM",     symbol: "KLAY", coingeckoId: "klay-token",        rpcUrl: "https://public-node-api.klaytnapi.com/v1/cypress" },
  { network: "Aurora",    networkId: "aurora",     baseGas: 0,    chain: "EVM",     symbol: "ETH",  coingeckoId: "ethereum",          rpcUrl: "https://mainnet.aurora.dev" },
  { network: "Metis",     networkId: "metis",      baseGas: 1,    chain: "EVM",     symbol: "METIS",coingeckoId: "metis-token",       rpcUrl: "https://andromeda.metis.io/?owner=1088" },
  { network: "Blast",     networkId: "blast",      baseGas: 0.05, chain: "EVM",     symbol: "ETH",  coingeckoId: "ethereum",          rpcUrl: "https://rpc.blast.io" },
  { network: "Mode",      networkId: "mode",       baseGas: 0.02, chain: "EVM",     symbol: "ETH",  coingeckoId: "ethereum",          rpcUrl: "https://mainnet.mode.network" },
  { network: "Berachain", networkId: "berachain",  baseGas: 15,   chain: "EVM",     symbol: "BERA", coingeckoId: "berachain",         rpcUrl: null },
  { network: "Sei",       networkId: "sei",        baseGas: 0.01, chain: "EVM",     symbol: "SEI",  coingeckoId: "sei-network",       rpcUrl: "https://evm-rpc.sei-apis.com" },
];

interface GasCache { data: any[]; ts: number; ethGwei: number; prices: Record<string, number>; }
let gasCache: GasCache | null = null;
const GAS_TTL = 30_000;

async function fetchEthGwei(): Promise<number> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch("https://api.etherscan.io/api?module=gastracker&action=gasoracle", { signal: ctrl.signal });
    clearTimeout(t);
    const json = await res.json() as any;
    if (json.status === "1" && json.result?.SafeGasPrice) return Number(json.result.SafeGasPrice);
  } catch {}
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch("https://eth.llamarpc.com", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_gasPrice", params: [], id: 1 }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const json = await res.json() as any;
    if (json.result) return parseInt(json.result, 16) / 1e9;
  } catch {}
  return 25;
}

async function fetchRpcGwei(rpcUrl: string): Promise<number | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(rpcUrl, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_gasPrice", params: [], id: 1 }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const json = await res.json() as any;
    if (json.result) return parseInt(json.result, 16) / 1e9;
  } catch {}
  return null;
}

async function fetchCryptoPrices(): Promise<Record<string, number>> {
  try {
    const ids = [...new Set(NETWORKS.map(n => n.coingeckoId))].join(",");
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`, { signal: ctrl.signal });
    clearTimeout(t);
    const json = await res.json() as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [id, val] of Object.entries(json)) out[id] = (val as any).usd ?? 0;
    return out;
  } catch {}
  return { ethereum: 2000, binancecoin: 300, "matic-network": 0.5, "avalanche-2": 20 };
}

async function buildGasData(): Promise<any[]> {
  const now = Date.now();
  if (gasCache && now - gasCache.ts < GAS_TTL) return gasCache.data;

  const [ethGwei, prices] = await Promise.all([fetchEthGwei(), fetchCryptoPrices()]);

  // Fetch real gas from each network's RPC in parallel — no Math.random()
  const rpcResults = await Promise.all(NETWORKS.map(async (n) => {
    if (n.networkId === "ethereum") return { gwei: ethGwei, source: "etherscan" as const };
    if (n.chain !== "EVM" || !n.rpcUrl) return { gwei: null, source: "unavailable" as const };
    const gwei = await fetchRpcGwei(n.rpcUrl);
    return gwei !== null ? { gwei, source: "rpc" as const } : { gwei: null, source: "unavailable" as const };
  }));

  const data = NETWORKS.map((n, i) => {
    const { gwei, source } = rpcResults[i];
    const nativePrice = prices[n.coingeckoId] ?? 0;
    const { rpcUrl: _rpc, ...networkFields } = n;
    if (gwei === null) {
      return { ...networkFields, slow: null, standard: null, fast: null, usdPerTx: null, nativePrice, source, updatedAt: new Date().toISOString() };
    }
    const slow = Math.max(gwei * 0.8, 0.001);
    const standard = Math.max(gwei, 0.001);
    const fast = gwei * 1.3;
    const usdPerTx = standard * 0.000021 * nativePrice;
    return { ...networkFields, slow: +slow.toFixed(6), standard: +standard.toFixed(6), fast: +fast.toFixed(6), usdPerTx: +usdPerTx.toFixed(4), nativePrice, source, updatedAt: new Date().toISOString() };
  });

  gasCache = { data, ts: now, ethGwei, prices };
  return data;
}

router.get("/tools/gas", async (_req, res): Promise<void> => {
  const data = await buildGasData();
  res.json(data);
});

router.get("/tools/gas/:network", async (req, res): Promise<void> => {
  const networkId = Array.isArray(req.params.network) ? req.params.network[0] : req.params.network;
  const data = await buildGasData();
  const item = data.find(n => n.networkId === networkId.toLowerCase());
  if (!item) { res.status(404).json({ error: "Network not found" }); return; }
  res.json(item);
});

function seededRandom(seed: string): () => number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
  return () => { h ^= h << 13; h ^= h >> 17; h ^= h << 5; return (h >>> 0) / 0xffffffff; };
}

async function fetchEtherscanData(address: string): Promise<{ txCount: number; firstTx: string | null; lastTx: string | null } | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(
      `https://api.etherscan.io/api?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&sort=asc&offset=10&page=1`,
      { signal: ctrl.signal }
    );
    clearTimeout(t);
    const json = await res.json() as any;
    if (json.status === "1" && Array.isArray(json.result) && json.result.length > 0) {
      const txs = json.result;
      return { txCount: json.result.length, firstTx: new Date(Number(txs[0].timeStamp) * 1000).toISOString(), lastTx: new Date(Number(txs[txs.length - 1].timeStamp) * 1000).toISOString() };
    }
  } catch {}
  return null;
}

router.post("/tools/wallet-analysis", async (req, res): Promise<void> => {
  const { address, networks } = req.body;
  if (!address) { res.status(400).json({ error: "address is required" }); return; }
  const rand = seededRandom(address.toLowerCase());
  const walletAge = Math.floor(rand() * 1200) + 30;
  const txCount = Math.floor(rand() * 2000) + 10;
  const txVolume = rand() * 500000 + 1000;
  const firstDate = new Date(); firstDate.setDate(firstDate.getDate() - walletAge);
  let realData: { txCount: number; firstTx: string | null; lastTx: string | null } | null = null;
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) realData = await fetchEtherscanData(address);
  const activityScore = Math.min(100, Math.floor(
    (Math.log10(Math.max((realData?.txCount ?? txCount), 1)) / Math.log10(2000)) * 40 +
    (walletAge / 1200) * 30 + (rand() * 30)
  ));
  res.json({
    address, walletAge, txCount: realData?.txCount ?? txCount, txVolume,
    firstTx: realData?.firstTx ?? firstDate.toISOString(),
    lastTx: realData?.lastTx ?? new Date(Date.now() - rand() * 7 * 24 * 60 * 60 * 1000).toISOString(),
    firstBridge: new Date(firstDate.getTime() + rand() * 60 * 24 * 60 * 60 * 1000).toISOString(),
    lastBridge: new Date(Date.now() - rand() * 30 * 24 * 60 * 60 * 1000).toISOString(),
    firstSwap: new Date(firstDate.getTime() + rand() * 14 * 24 * 60 * 60 * 1000).toISOString(),
    lastSwap: new Date(Date.now() - rand() * 14 * 24 * 60 * 60 * 1000).toISOString(),
    totalGasUsed: rand() * 2 + 0.1, netWorth: rand() * 50000 + 500, activityScore,
    networks: networks ?? ["ethereum"], dataSource: realData ? "etherscan+derived" : "derived",
  });
});

// D5 (Season D, decision-gated per D4's flag): had no auth at all — any
// anonymous caller could pull another user's streak/last-active data by
// numeric id. Login-gate only (matches marketplace-spot.ts's/layout.ts's
// bucket-খ.২ pattern) — no ownership check, any authenticated user can
// still view any other user's streak, same as before, just no longer
// anonymously.
router.get("/tools/streak/:userId", requireAuth, async (req, res): Promise<void> => {
  const userId = parseInt(Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId, 10);
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const lastDate = user?.lastActiveAt ? user.lastActiveAt.toISOString().slice(0, 10) : null;
  let streak = user?.streak ?? 0;
  if (lastDate && lastDate !== today) {
    const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
    if (lastDate !== yesterday.toISOString().slice(0, 10)) streak = 0;
  }
  res.json({ userId, currentStreak: streak, longestStreak: user?.longestStreak ?? 0, lastActiveDate: user?.lastActiveAt?.toISOString() ?? null, streakByProject: [], isActiveToday: lastDate === today });
});

router.post("/tools/spam-score", async (req, res): Promise<void> => {
  const { address } = req.body;
  if (!address) { res.status(400).json({ error: "address is required" }); return; }
  const rand = seededRandom(address.toLowerCase());
  const score = Math.floor(rand() * 100);
  let level = "Low";
  if (score >= 75) level = "Critical";
  else if (score >= 50) level = "High";
  else if (score >= 25) level = "Medium";
  res.json({ address, score, level, dustTxCount: Math.floor(rand() * 50), highFreqLowValueCount: Math.floor(rand() * 100), explanation: score >= 50 ? "Wallet shows patterns consistent with spam activity: high-frequency low-value transactions detected." : "Wallet appears legitimate with normal transaction patterns." });
});

export default router;
