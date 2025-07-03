import fetch from 'node-fetch';
import AbortController from 'abort-controller';
import { ethers } from 'ethers';
import { buildFallbackProvider, ERC20_ABI } from './auto_swap_utilities.js';
import fs from 'fs';

const TOKENS = {
  PHRS: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  WBTC: '0x8275c526d1bCEc59a31d673929d3cE8d108fF5c7',
  WETH: '0x4E28826d32F1C398DED160DC16Ac6873357d048f',
  USDC: '0x72df0bcd7276f2dFbAc900D1CE63c272C4BCcCED',
  USDT: '0xD4071393f8716661958F766DF660033b3d35fD29',
  WPHRS: '0x3019B247381c850ab53Dc0EE53bCe7A07Ea9155f'
};
const TOKEN_LIST = ['WBTC', 'WETH', 'USDC', 'USDT', 'WPHRS'];
const PHAROS_CHAIN_ID = 688688;
const PHAROS_RPC_URLS = [
  'https://testnet.dplabs-internal.com'
];
const LOG_FILE = 'faroswap.log';

function now() {
  return new Date().toISOString();
}
function log(msg, fileOnly = false) {
  fs.appendFileSync(LOG_FILE, `[${now()}] ${msg}\n`);
  if (!fileOnly) console.log(msg);
}
function randomPHRSAmount() {
  // 0.000100 to 0.010000, 6 decimals
  return (Math.random() * (0.01 - 0.0001) + 0.0001).toFixed(6);
}
async function retryAsync(fn, tries = 10, delayMs = 1200, label = '') {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      log(`${label} Retry ${i} failed: ${err.message}`, true);
      if (i < tries) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

function loadWallets(path = 'wallets.txt') {
  const lines = fs.readFileSync(path, 'utf8').split(/\r?\n/);
  return lines
    .map(l => l.trim())
    .filter(Boolean)
    .map(line => {
      const [privateKey, proxy] = line.split(',');
      return { privateKey: privateKey.trim(), proxy: (proxy || '').trim() };
    });
}
function loadRecipients(path = 'recipients.txt') {
  try {
    const data = fs.readFileSync(path, 'utf8');
    return data.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  } catch (e) {
    log(`❌ Failed to read ${path}: ${e.message}`);
    return [];
  }
}
function createProvider(proxy) {
  return new ethers.JsonRpcProvider(PHAROS_RPC_URLS[0], { chainId: PHAROS_CHAIN_ID, name: 'pharos' });
}

async function fetchWithTimeoutAndProxy(url, timeout = 10000, proxy = '') {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  let options = { signal: controller.signal };
  if (proxy) {
    const HttpsProxyAgent = (await import('https-proxy-agent')).HttpsProxyAgent;
    options.agent = new HttpsProxyAgent(proxy);
  }
  try {
    const res = await fetch(url, options);
    clearTimeout(id);
    return res;
  } catch (err) {
    throw new Error('Timeout or network error');
  }
}
async function robustFetchDodoRoute(url, proxy) {
  return retryAsync(async () => {
    const res = await fetchWithTimeoutAndProxy(url, 10000, proxy);
    const data = await res.json();
    if (data.status !== -1) return data;
    throw new Error('DODO API status -1');
  }, 10, 1200, 'DODO API');
}
async function fetchDodoRoute(fromAddr, toAddr, userAddr, amountWei, proxy) {
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const url = `https://api.dodoex.io/route-service/v2/widget/getdodoroute?chainId=${PHAROS_CHAIN_ID}&deadLine=${deadline}&apikey=a37546505892e1a952&slippage=3.225&source=dodoV2AndMixWasm&toTokenAddress=${toAddr}&fromTokenAddress=${fromAddr}&userAddr=${userAddr}&estimateGas=true&fromAmount=${amountWei}`;
  try {
    log(`DODO API: ${url}`, true);
    const result = await robustFetchDodoRoute(url, proxy);
    return result.data;
  } catch (err) {
    log(`❌ DODO API fetch failed: ${err.message}`);
    throw err;
  }
}

// --- Robust manual receipt polling ---
async function waitForReceiptWithRetry(tx, tries = 20, delayMs = 4000) {
  let lastErr;
  let provider = tx.provider;
  for (let i = 1; i <= tries; i++) {
    try {
      const receipt = await provider.getTransactionReceipt(tx.hash);
      if (receipt) return receipt;
    } catch (e) {
      lastErr = e;
      log(`[${tx.hash}] Manual receipt poll retry ${i} failed: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, delayMs));
  }
  if (lastErr) throw lastErr;
  throw new Error(`Timeout waiting for receipt for ${tx.hash}`);
}

async function executeSwap(wallet, routeData, label) {
  let tries = 0;
  let lastError = null;
  while (++tries <= 10) {
    try {
      const tx = await wallet.sendTransaction({
        to: routeData.to,
        data: routeData.data,
        value: BigInt(routeData.value),
        gasLimit: BigInt(routeData.gasLimit || 300000)
      });
      log(`[${wallet.address}] 🚀 ${label} Swap TX sent: ${tx.hash}`);
      let receipt;
      try {
        receipt = await waitForReceiptWithRetry(tx, 20, 4000);
      } catch (waitErr) {
        log(`[${wallet.address}] ❌ Failed to get receipt after 20 tries: ${waitErr.message}`);
        break;
      }
      if (receipt.status === 0) {
        log(`[${wallet.address}] ❌ TX reverted on-chain (status 0), not retrying: ${tx.hash}`);
        break;
      }
      log(`[${wallet.address}] ✅ TX confirmed: ${tx.hash}`);
      return;
    } catch (e) {
      if (
        e.code === 'CALL_EXCEPTION' ||
        (e.error && typeof e.error.message === 'string' && e.error.message.toLowerCase().includes('revert')) ||
        (e.message && e.message.toLowerCase().includes('revert'))
      ) {
        log(`[${wallet.address}] ❌ Swap failed (on-chain revert, not retrying): ${e.message}`);
        break;
      }
      lastError = e;
      log(`[${wallet.address}] Swap TX Retry ${tries} failed: ${e.message}`);
      if (tries < 10) await new Promise(r => setTimeout(r, 1200));
    }
  }
  if (lastError) log(`[${wallet.address}] ❌ Swap final error: ${lastError.message}`);
}

async function getNativeBalance(address, provider) {
  return await retryAsync(() => provider.getBalance(address), 10, 1200, 'Native Balance');
}
async function getERC20Balance(contract, address, symbol) {
  return await retryAsync(() => contract.balanceOf(address), 10, 1200, `${symbol} ERC20 Balance`);
}
async function getERC20Decimals(contract, symbol) {
  return await retryAsync(() => contract.decimals(), 10, 1200, `${symbol} ERC20 Decimals`);
}

async function getAllBalances(address, provider) {
  const result = {};
  try {
    result['PHRS'] = await getNativeBalance(address, provider);
    log(`[${address}] PHRS balance: ${ethers.formatEther(result['PHRS'])}`);
  } catch { result['PHRS'] = 0n; log(`[${address}] PHRS balance: Error fetching`); }
  for (const symbol of TOKEN_LIST) {
    const contract = new ethers.Contract(TOKENS[symbol], ERC20_ABI, provider);
    try {
      const [balance, decimals] = await Promise.all([
        getERC20Balance(contract, address, symbol),
        getERC20Decimals(contract, symbol)
      ]);
      result[symbol] = { balance, decimals };
      log(`[${address}] ${symbol} balance: ${ethers.formatUnits(balance, decimals)}`);
    } catch (e) {
      result[symbol] = { balance: 0n, decimals: 18 };
      log(`[${address}] ${symbol} balance/decimals error: ${e.message}`);
    }
  }
  return result;
}

async function swap(wallet, from, to, amount, proxy, decimals = 18, label = '') {
  try {
    let amt = ethers.parseUnits(amount, decimals);
    if (typeof amount === 'bigint') amt = amount;
    const data = await fetchDodoRoute(from, to, wallet.address, amt, proxy);
    await executeSwap(wallet, data, label);
    await new Promise(r => setTimeout(r, 1000));
  } catch (e) {
    log(`[${wallet.address}] ❌ Swap error (${label}): ${e.message}`);
  }
}
async function swap90(wallet, fromSymbol, toSymbol, balanceObj, proxy) {
  const { balance, decimals } = balanceObj;
  if (balance === 0n) {
    log(`[${wallet.address}] Skip swap90: ${fromSymbol} balance is 0`);
    return;
  }
  const amt = balance * 90n / 100n;
  if (amt === 0n) {
    log(`[${wallet.address}] Skip swap90: ${fromSymbol} 90% amount is 0`);
    return;
  }
  try {
    const data = await fetchDodoRoute(TOKENS[fromSymbol], TOKENS[toSymbol], wallet.address, amt, proxy);
    await executeSwap(wallet, data, `90% ${fromSymbol}→${toSymbol}`);
    await new Promise(r => setTimeout(r, 1000));
  } catch (e) {
    log(`[${wallet.address}] ❌ 90% Swap ${fromSymbol}->${toSymbol} error: ${e.message}`);
  }
}
async function sendNative(wallet, recipients) {
  for (const to of recipients) {
    const randomAmount = randomPHRSAmount();
    const amountWei = ethers.parseEther(randomAmount);
    await retryAsync(async () => {
      const tx = await wallet.sendTransaction({ to, value: amountWei });
      log(`[${wallet.address}] Sent ${randomAmount} PHRS to ${to} | TX: ${tx.hash}`);
      await waitForReceiptWithRetry(tx, 20, 4000);
      await new Promise(r => setTimeout(r, 1000));
    }, 10, 1200, 'Send PHRS');
  }
}

async function runForWallet(wallet, proxy, recipients) {
  log(`---- Wallet start: ${wallet.address} ----`);
  // 1. PHRS -> [WBTC, WETH, USDC, USDT, WPHRS]
  for (const symbol of TOKEN_LIST) {
    const randomAmount = randomPHRSAmount();
    log(`[${wallet.address}] Swapping ${randomAmount} PHRS to ${symbol}`);
    await swap(wallet, TOKENS.PHRS, TOKENS[symbol], randomAmount, proxy, 18, `PHRS→${symbol}`);
  }
  // 2. Fetch balances
  const balances = await getAllBalances(wallet.address, wallet.provider);
  // 3. [WBTC,WETH,USDC,USDT,WPHRS] -> PHRS (90%)
  for (const symbol of TOKEN_LIST) {
    log(`[${wallet.address}] Swapping 90% ${symbol} to PHRS`);
    await swap90(wallet, symbol, 'PHRS', balances[symbol], proxy);
  }
  // 4. PHRS->WPHRS random
  const randomAmount2 = randomPHRSAmount();
  log(`[${wallet.address}] Swapping ${randomAmount2} PHRS to WPHRS`);
  await swap(wallet, TOKENS.PHRS, TOKENS.WPHRS, randomAmount2, proxy, 18, `PHRS→WPHRS`);
  // 5. Send random PHRS to all recipients
  log(`[${wallet.address}] Sending random PHRS (0.0001-0.01) to all recipients`);
  await sendNative(wallet, recipients);
  log(`---- Wallet finished: ${wallet.address} ----\n`);
}

async function mainLoop() {
  fs.writeFileSync(LOG_FILE, '=== Faroswap Automated Log Start ===\n');
  const wallets = loadWallets();
  if (!wallets.length) {
    log('❌ No wallets found in wallets.txt');
    process.exit(1);
  }
  const recipients = loadRecipients();
  if (!recipients.length) {
    log('❌ No recipients in recipients.txt');
    process.exit(1);
  }
  while (true) {
    log(`========== New run at ${now()} ==========\n`);
    for (let idx = 0; idx < wallets.length; idx++) {
      const { privateKey, proxy } = wallets[idx];
      const provider = createProvider(proxy);
      const wallet = new ethers.Wallet(privateKey, provider);
      log(`\n===============================`);
      log(`Wallet #${idx + 1}:`);
      log(` - Address: ${wallet.address}`);
      log(proxy ? ` - Proxy: ${proxy}` : ' - Proxy: (none)');
      log('===============================');
      try {
        await runForWallet(wallet, proxy, recipients);
      } catch (e) {
        log(`[${wallet.address}] ERROR: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 2000)); // brief pause
    }
    log('✅ All wallets completed. Sleeping 4 hours...');
    await new Promise(r => setTimeout(r, 4 * 60 * 60 * 1000)); // 4 hours
  }
}

mainLoop();