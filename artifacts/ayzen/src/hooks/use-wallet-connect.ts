import { useState, useCallback } from "react";

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: any[] }) => Promise<any>;
      on: (event: string, handler: (...args: any[]) => void) => void;
      removeListener: (event: string, handler: (...args: any[]) => void) => void;
      isMetaMask?: boolean;
      selectedAddress?: string | null;
    };
  }
}

export type WalletConnectState = {
  address: string | null;
  chainId: number | null;
  isConnecting: boolean;
  isConnected: boolean;
  error: string | null;
};

export function useWalletConnect() {
  const [state, setState] = useState<WalletConnectState>({
    address: null,
    chainId: null,
    isConnecting: false,
    isConnected: false,
    error: null,
  });

  const hasMetaMask = typeof window !== "undefined" && !!window.ethereum;

  const connect = useCallback(async () => {
    if (!window.ethereum) {
      setState(s => ({ ...s, error: "No wallet detected. Install MetaMask or another Web3 wallet." }));
      return null;
    }
    setState(s => ({ ...s, isConnecting: true, error: null }));
    try {
      const accounts: string[] = await window.ethereum.request({ method: "eth_requestAccounts" });
      const chainIdHex: string = await window.ethereum.request({ method: "eth_chainId" });
      const chainId = parseInt(chainIdHex, 16);
      const address = accounts[0] ?? null;
      setState({ address, chainId, isConnecting: false, isConnected: !!address, error: null });
      return address;
    } catch (err: any) {
      setState(s => ({ ...s, isConnecting: false, error: err?.message ?? "Connection rejected" }));
      return null;
    }
  }, []);

  const disconnect = useCallback(() => {
    setState({ address: null, chainId: null, isConnecting: false, isConnected: false, error: null });
  }, []);

  const switchChain = useCallback(async (chainId: number) => {
    if (!window.ethereum) return false;
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: `0x${chainId.toString(16)}` }],
      });
      setState(s => ({ ...s, chainId }));
      return true;
    } catch { return false; }
  }, []);

  const sendTransaction = useCallback(async (to: string, amountEth: string, fromAddress: string): Promise<string | null> => {
    if (!window.ethereum) return null;
    try {
      const amountWei = BigInt(Math.round(parseFloat(amountEth) * 1e18)).toString(16);
      const txHash: string = await window.ethereum.request({
        method: "eth_sendTransaction",
        params: [{
          from: fromAddress,
          to,
          value: `0x${amountWei}`,
          gas: "0x5208",
        }],
      });
      return txHash;
    } catch (err: any) {
      return null;
    }
  }, []);

  // ERC-20 transfer(address,uint256) call, for tokens like USDT/ARB — no
  // ethers dependency needed on the frontend, just raw calldata encoding.
  // Native sends (ETH/BNB/POL/XPL) use sendTransaction() above instead.
  const sendTokenTransaction = useCallback(async (
    tokenContract: string, to: string, amount: string, decimals: number, fromAddress: string
  ): Promise<string | null> => {
    if (!window.ethereum) return null;
    try {
      const selector = "a9059cbb"; // transfer(address,uint256)
      const toPadded = to.replace(/^0x/, "").toLowerCase().padStart(64, "0");
      const [whole, frac = ""] = amount.split(".");
      const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
      const raw = BigInt(whole || "0") * (10n ** BigInt(decimals)) + BigInt(fracPadded || "0");
      const data = `0x${selector}${toPadded}${raw.toString(16).padStart(64, "0")}`;
      const txHash: string = await window.ethereum.request({
        method: "eth_sendTransaction",
        params: [{ from: fromAddress, to: tokenContract, data, value: "0x0", gas: "0x186a0" }],
      });
      return txHash;
    } catch (err: any) {
      return null;
    }
  }, []);

  return { state, connect, disconnect, switchChain, sendTransaction, sendTokenTransaction, hasMetaMask };
}
