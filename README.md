# Faroswap Automation Bot

Automated multi-wallet, proxy-ready token farming and airdrop tool for the Pharos blockchain.  
Performs randomized swaps, reverse swaps, and airdrop-style PHRS sending, with robust error handling and full logs.

---

## Features

- **Multi-Wallet Automation:**  
  Handles any number of wallets, each optionally using its own HTTP/SOCKS proxy.
- **Randomized PHRS Swaps:**  
  Swaps a random amount (between `0.0001` and `0.01`) PHRS to WBTC, WETH, USDC, USDT, and WPHRS for each wallet.
- **Reverse Swaps:**  
  Swaps 90% of all WBTC, WETH, USDC, USDT, WPHRS balances back to PHRS.
- **Final Swap:**  
  Performs one more random PHRS to WPHRS swap per wallet.
- **PHRS Airdrop:**  
  Sends a random amount (0.0001–0.01) PHRS to every address in `recipients.txt` from each wallet.
- **Proxy Support:**  
  Full support for HTTP/SOCKS proxies on a per-wallet basis (optional).
- **Automated Loop:**  
  Runs through all wallets every 4 hours, endlessly, with a brief pause between wallets.
- **Resilient & Reliable:**  
  - Retries all API/RPC/network calls up to 10 times.
  - Robust, manual polling for transaction receipts (handles overloaded/busy nodes).
  - Skips retry on smart contract/on-chain errors (to save gas and time).
- **Full Logging:**  
  Logs every step, error, and retry to both the terminal and `faroswap.log` for complete auditing.

---

## Quickstart

## 1. **Copy the Repository**
```bash
git clone https://github.com/R1ghTsS/faroswap-bot.git
```

### 2. **Install Dependencies**

```bash
npm install node-fetch abort-controller ethers https-proxy-agent
```

### 3. **Prepare Files**

- **wallets.txt**  
  List each wallet/private key, and optional proxy, one per line:  
  ```
  0xPRIVATEKEY1,http://proxyuser:proxypass@proxyhost:proxyport
  0xPRIVATEKEY2,
  0xPRIVATEKEY3,http://proxyhost:proxyport
  ```

- **recipients.txt**  
  List recipient addresses, one per line:  
  ```
  0xRecipientAddress1
  0xRecipientAddress2
  ```

- **auto_swap_utilities.js**  
  This must be present in the same directory and provide the `ERC20_ABI` used by the script.

### 4. **Run**

```bash
node main.js
```

### 5. **Monitor**

- All actions, errors, and retries are printed to the terminal and saved in `faroswap.log` for full history.

---

## How It Works

For each wallet:

1. **Swaps a random amount (0.0001–0.01 PHRS) to WBTC, WETH, USDC, USDT, WPHRS.**
2. **Fetches balances for all tokens.**
3. **Swaps 90% of WBTC, WETH, USDC, USDT, WPHRS balances back to PHRS.**
4. **Swaps a random amount of PHRS to WPHRS.**
5. **Sends a random amount (0.0001–0.01) PHRS to all recipients.**
6. **Pauses 2 seconds, moves to the next wallet.**
7. **Repeats the above process for all wallets, then sleeps 4 hours before next run.**

---

## Error Handling

- **Network/RPC/API issues:** Retries up to 10 times per step.
- **Transaction confirmation:**  
  Uses manual polling, up to 20 times, for transaction receipts to survive overloaded RPCs.
- **Smart contract errors (on-chain reverts):**  
  Skips further retries and logs the failure.
- **All errors and retry attempts are written to the log.**

---

## Use Cases

- Automated farming, airdrop eligibility, or on-chain volume activity with multiple wallets.
- Respects anti-sybil measures with proxy support.
- Great for testnet or mainnet stress testing and incentive campaigns.
