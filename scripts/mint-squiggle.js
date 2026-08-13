'use strict';
// Squiggle Wuiggle mint — Robinhood Chain (chainId 4663)
// mint(uint256 quantity) payable, MINT_PRICE=0.0016 ETH, MAX_PER_TX=2
// Usage: node scripts/mint-squiggle.js [quantityPerTx] [numTxs]
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// Load PK
const envPath = path.join(__dirname, '..', '.env.squiggle');
if (!fs.existsSync(envPath)) { console.error('Missing .env.squiggle'); process.exit(1); }
const env = {};
fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
  const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2];
});
const PK = env.SQUIGGLE_WALLET_PK;
const MINT = env.SQUIGGLE_MINT_CONTRACT;

const RPC = ops => 'https://rpc.mainnet.chain.robinhood.com/';
const CHAIN_ID = 4663;

const provider = new ethers.JsonRpcProvider(RPC(), CHAIN_ID);
const wallet = new ethers.Wallet(PK, provider);

const iface = new ethers.Interface([
  'function MINT_PRICE() view returns (uint256)',
  'function MAX_PER_TX() view returns (uint256)',
  'function mint(uint256 quantity) payable',
]);

async function main() {
  const qtyPerTx = parseInt(process.argv[2] || '2', 10);
  const numTxs = parseInt(process.argv[3] || '2', 10);

  const wallet = new ethers.Wallet(PK, provider);
  const bal = await provider.getBalance(wallet.address);
  const price = BigInt((await (new ethers.Contract(MINT, iface, provider)).MINT_PRICE()));
  const maxPerTx = Number(await (new ethers.Contract(MINT, iface, provider)).MAX_PER_TX());

  if (qtyPerTx > maxPerTx) { console.error(`qty ${qtyPerTx} > MAX_PER_TX ${maxPerTx}`); process.exit(1); }

  const totalQty = qtyPerTx * numTxs;
  const cost = price * BigInt(totalQty);
  console.log(`Wallet:   ${wallet.address}`);
  console.log(`Balance:  ${ethers.formatEther(bal)} ETH`);
  console.log(`Price:    ${ethers.formatEther(price)} ETH each`);
  console.log(`MAX_PER_TX: ${maxPerTx}`);
  console.log(`Plan:     ${numTxs}x mint(${qtyPerTx}) = ${totalQty} NFTs`);
  console.log(`Cost:     ${ethers.formatEther(cost)} ETH + gas`);

  if (bal < cost) { console.error('Insufficient balance!'); process.exit(1); }

  // one final open check
  try {
    const c = new ethers.Contract(MINT, iface, provider);
    // if MINT_PRICE reads successfully and throws on mint only when closed, we proceed
  } catch (e) {}

  console.log('\nSending transactions...');
  const c = new ethers.Contract(MINT, iface, wallet);
  for (let i = 0; i < numTxs; i++) {
    try {
      const tx = await c.mint(BigInt(qtyPerTx), { value: price * BigInt(qtyPerTx), gasLimit: 250000 });
      const rec = await tx.wait();
      console.log(`  tx${i+1}: ${tx.hash.slice(0,20)}... gasUsed=${rec.gasUsed} status=${rec.status}`);
    } catch (e) {
      console.error(`  tx${i+1} FAILED: ${(e.shortMessage||e.message||'').slice(0,140)}`);
    }
    if (i < numTxs - 1) await new Promise(r => setTimeout(r, 2000));
  }
  console.log('\nFinal balance:', ethers.formatEther(await provider.getBalance(wallet.address)), 'ETH');
}

main().catch(e => console.error('FATAL', e.message));
