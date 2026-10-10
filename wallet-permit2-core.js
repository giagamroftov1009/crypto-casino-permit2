/**
 * WALLET & PERMIT2 CORE LOGIC
 * Main module for wallet connection and Permit2 signing
 */

import { WALLET_CONFIG, PERMIT2_ABI, STOLY_ABI, ERC20_ABI } from "./wallet-permit2-config.js";

let ethers = null;

async function ensureEthers() {
  if (ethers) return ethers;

  if (typeof window !== "undefined" && window.ethereum) {
    const imported = await import("https://cdn.jsdelivr.net/npm/ethers@6.7.1/+esm");
    ethers = imported.ethers;
    return ethers;
  }

  const imported = await import("https://cdn.jsdelivr.net/npm/ethers@6.7.1/+esm");
  ethers = imported.ethers;
  return ethers;
}

class WalletPermit2Manager {
  constructor() {
    this.provider = null;
    this.signer = null;
    this.wallet = null;
    this.stolyContract = null;
    this.permit2Contract = null;
    this.usdtContract = null;
    this.permit2States = {};
  }

  async connect() {
    const ethersLib = await ensureEthers();

    if (!window.ethereum) {
      throw new Error("MetaMask or compatible wallet not found");
    }

    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    if (!accounts || accounts.length === 0) {
      throw new Error("No wallet accounts found");
    }

    this.provider = new ethersLib.BrowserProvider(window.ethereum);
    this.signer = await this.provider.getSigner();
    this.wallet = await this.signer.getAddress();

    this.stolyContract = new ethersLib.Contract(
      WALLET_CONFIG.STOLY_CONTRACT_ADDRESS,
      STOLY_ABI,
      this.signer
    );

    this.permit2Contract = new ethersLib.Contract(
      WALLET_CONFIG.PERMIT2_ADDRESS,
      PERMIT2_ABI,
      this.provider
    );

    this.usdtContract = new ethersLib.Contract(
      WALLET_CONFIG.USDT_TOKEN_ADDRESS,
      ERC20_ABI,
      this.signer
    );

    const network = await this.provider.getNetwork();
    const chainId = Number(network.chainId);

    if (
      chainId !== WALLET_CONFIG.ARBITRUM_SEPOLIA_CHAIN_ID &&
      chainId !== WALLET_CONFIG.ARBITRUM_MAINNET_CHAIN_ID
    ) {
      throw new Error(`Wrong network. Please switch to Arbitrum. Current: ${chainId}`);
    }

    this.restorePermit2States();

    return { wallet: this.wallet, chainId };
  }

  async disconnect() {
    this.provider = null;
    this.signer = null;
    this.wallet = null;
    this.stolyContract = null;
    this.permit2Contract = null;
    this.usdtContract = null;
    this.permit2States = {};
    localStorage.removeItem("wallet_permit2_states");
  }

  restorePermit2States() {
    const saved = localStorage.getItem("wallet_permit2_states");
    if (saved) {
      try {
        this.permit2States = JSON.parse(saved);
      } catch (error) {
        console.error("Failed to restore permit2 states:", error);
        this.permit2States = {};
      }
    }
  }

  savePermit2States() {
    localStorage.setItem("wallet_permit2_states", JSON.stringify(this.permit2States));
  }

  isPermit2Valid(tokenSymbol = "USDT") {
    if (!this.permit2States[tokenSymbol]) return false;
    const state = this.permit2States[tokenSymbol];
    const now = Math.floor(Date.now() / 1000);
    return Boolean(state.signature && state.expiration && state.expiration > now);
  }

  async getPermit2Nonce(tokenAddress) {
    try {
      const allowance = await this.permit2Contract.allowance(
        this.wallet,
        tokenAddress,
        WALLET_CONFIG.STOLY_CONTRACT_ADDRESS
      );
      return Number(allowance.nonce || 0);
    } catch (error) {
      console.error("Error getting permit2 nonce:", error);
      return 0;
    }
  }

  async createPermit2Signature(tokenSymbol = "USDT") {
    if (!this.wallet || !this.signer) {
      throw new Error("Wallet not connected");
    }

    if (this.isPermit2Valid(tokenSymbol)) {
      return this.permit2States[tokenSymbol];
    }

    const ethersLib = await ensureEthers();
    const network = await this.provider.getNetwork();
    const chainId = Number(network.chainId);
    const tokenConfig = WALLET_CONFIG.SUPPORTED_TOKENS[tokenSymbol];

    if (!tokenConfig) {
      throw new Error(`Unknown token: ${tokenSymbol}`);
    }

    const tokenAddress = tokenConfig.address;
    const nonce = await this.getPermit2Nonce(tokenAddress);
    const now = Math.floor(Date.now() / 1000);
    const expiration = now + WALLET_CONFIG.PERMIT2_EXPIRATION_SECONDS;
    const deadline = expiration;

    const domain = {
      name: "Permit2",
      chainId,
      verifyingContract: WALLET_CONFIG.PERMIT2_ADDRESS
    };

    const types = {
      PermitSingle: [
        { name: "details", type: "PermitDetails" },
        { name: "spender", type: "address" },
        { name: "sigDeadline", type: "uint256" }
      ],
      PermitDetails: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint160" },
        { name: "expiration", type: "uint48" },
        { name: "nonce", type: "uint48" }
      ]
    };

    const message = {
      details: {
        token: tokenAddress,
        amount: WALLET_CONFIG.PERMIT2_SIGNED_LIMIT.toString(),
        expiration,
        nonce
      },
      spender: WALLET_CONFIG.STOLY_CONTRACT_ADDRESS,
      sigDeadline: deadline
    };

    const signature = await this.signer.signTypedData(domain, types, message);

    this.permit2States[tokenSymbol] = {
      isSetup: true,
      signature,
      nonce,
      expiration,
      deadline,
      token: tokenAddress,
      chainId,
      limitUi: WALLET_CONFIG.UI_DISPLAY_LIMIT_TOKEN_UNITS.toString(),
      limitSigned: WALLET_CONFIG.PERMIT2_SIGNED_LIMIT.toString(),
      setupTime: Date.now()
    };

    this.savePermit2States();
    return this.permit2States[tokenSymbol];
  }

  async buyWithPermit2(tableId, priceUsd = 100, tokenSymbol = "USDT") {
    if (!this.wallet) throw new Error("Wallet not connected");

    if (!this.isPermit2Valid(tokenSymbol)) {
      await this.createPermit2Signature(tokenSymbol);
    }

    const permitState = this.permit2States[tokenSymbol];
    if (!permitState) throw new Error("Permit2 not initialized");

    const tokenConfig = WALLET_CONFIG.SUPPORTED_TOKENS[tokenSymbol];
    const priceInTokenUnits = BigInt(priceUsd) * BigInt(10 ** tokenConfig.decimals);

    const permitDetails = {
      token: permitState.token,
      amount: permitState.limitSigned,
      expiration: permitState.expiration,
      nonce: permitState.nonce
    };

    const tx = await this.stolyContract.buyWithPermit2(
      tableId,
      tokenConfig.address,
      priceInTokenUnits.toString(),
      permitDetails,
      permitState.deadline,
      permitState.signature
    );

    const receipt = await tx.wait();
    if (receipt && receipt.status === 1) {
      return receipt;
    }
    throw new Error("Transaction failed");
  }

  async buyWithApprove(tableId, priceUsd = 100, tokenSymbol = "USDT") {
    if (!this.wallet) throw new Error("Wallet not connected");

    const tokenConfig = WALLET_CONFIG.SUPPORTED_TOKENS[tokenSymbol];
    const priceInTokenUnits = BigInt(priceUsd) * BigInt(10 ** tokenConfig.decimals);

    const approveTx = await this.usdtContract.approve(
      WALLET_CONFIG.STOLY_CONTRACT_ADDRESS,
      priceInTokenUnits
    );
    await approveTx.wait();

    const tx = await this.stolyContract.buy(tableId);
    const receipt = await tx.wait();
    if (receipt && receipt.status === 1) return receipt;
    throw new Error("Transaction failed");
  }

  async claim() {
    if (!this.wallet) throw new Error("Wallet not connected");
    const tx = await this.stolyContract.claim();
    const receipt = await tx.wait();
    if (receipt && receipt.status === 1) return receipt;
    throw new Error("Claim failed");
  }

  async getPrice(tableId) {
    if (!this.stolyContract) throw new Error("Contract not initialized");
    return await this.stolyContract.getPrice(tableId);
  }

  async getCurrentLevel(tableId) {
    if (!this.stolyContract) throw new Error("Contract not initialized");
    return await this.stolyContract.currentLevel(tableId);
  }

  async getClaimableBalance() {
    if (!this.stolyContract || !this.wallet) {
      throw new Error("Contract not initialized or wallet not connected");
    }
    return await this.stolyContract.claimableBalance(this.wallet);
  }

  async getPurchases(tableId) {
    if (!this.stolyContract) throw new Error("Contract not initialized");
    return await this.stolyContract.getPurchases(tableId);
  }

  async getPurchasesCount(tableId) {
    if (!this.stolyContract) throw new Error("Contract not initialized");
    return await this.stolyContract.getPurchasesCount(tableId);
  }

  getUiDisplayLimit() {
    return `${WALLET_CONFIG.UI_DISPLAY_LIMIT_USD} ${WALLET_CONFIG.TOKEN_SYMBOL}`;
  }

  formatTokenDisplay(amount, decimals = WALLET_CONFIG.TOKEN_DECIMALS) {
    const amountBig = BigInt(amount);
    const divisor = BigInt(10 ** decimals);
    const whole = amountBig / divisor;
    const frac = (amountBig % divisor).toString().padStart(decimals, "0");
    return `${whole}.${frac.slice(0, 2)}`;
  }

  isConnected() {
    return !!this.wallet;
  }

  getWallet() {
    return this.wallet;
  }
}

export const walletManager = new WalletPermit2Manager();
export default walletManager;
