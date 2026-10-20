// scripts/check-activity.mjs
// Read-only check of the frontend's data reads against the RPC in frontend/deployment.json.
// Prints contract state + activity events found. Never reads or prints any private key.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(readFileSync(path.join(root, "frontend", "deployment.json"), "utf8"));
const abi = JSON.parse(readFileSync(path.join(root, "frontend", "abi.json"), "utf8"));

// public fields only — demoAgentKey_TESTNET_ONLY is deliberately never touched
const { chainId, network, rpc, agentPay, owner, guardian, agent, merchant, attacker, deployBlock } = cfg;

const provider = new ethers.JsonRpcProvider(rpc);
const read = new ethers.Contract(agentPay, abi, provider);
// fallback used only to backfill log ranges the primary RPC has pruned
const LOG_BACKFILL_RPC = "https://sepolia.gateway.tenderly.co";
const readLogs = new ethers.Contract(agentPay, abi, new ethers.JsonRpcProvider(LOG_BACKFILL_RPC));

console.log(`network: ${network} (chainId ${chainId})`);
console.log(`rpc: ${rpc}`);
console.log(`contract: ${agentPay}`);
const latest = await provider.getBlockNumber();
console.log(`latest block: ${latest}`);

// ---------- state reads (same reads the UI performs) ----------
const [onChainOwner, onChainGuardian, delay] = await Promise.all([
  read.owner(), read.guardian(), read.changeDelay(),
]);
console.log(`\nowner:    ${onChainOwner} (matches deployment.json: ${onChainOwner.toLowerCase() === owner.toLowerCase()})`);
console.log(`guardian: ${onChainGuardian} (matches deployment.json: ${onChainGuardian.toLowerCase() === guardian.toLowerCase()})`);
console.log(`changeDelay: ${delay}s`);
const vault = await provider.getBalance(agentPay);
console.log(`vault balance: ${ethers.formatEther(vault)} ETH`);

const pol = await read.policies(agent, ethers.ZeroAddress);
console.log(`policy(ETH): active=${pol.active} perTxCap=${ethers.formatEther(pol.perTxCap)} ` +
  `dailyBudget=${ethers.formatEther(pol.dailyBudget)} spent=${ethers.formatEther(pol.spent)} ` +
  `windowStart=${pol.windowStart}`);
const [merchantOk, attackerOk] = await Promise.all([
  read.allowlist(agent, merchant), read.allowlist(agent, attacker),
]);
console.log(`allowlist: merchant=${merchantOk} attacker=${attackerOk}`);

// ---------- static-call probe (what the frontend buttons do before sending) ----------
const probeData = read.interface.encodeFunctionData(
  "agentPay", [ethers.ZeroAddress, merchant, ethers.parseEther("0.001"), "probe"]);
async function probe(label, from) {
  try {
    await provider.call(from ? { to: agentPay, data: probeData, from } : { to: agentPay, data: probeData });
    console.log(`staticCall ${label}: would succeed`);
  } catch (e) {
    console.log(`staticCall ${label}: reverts (${e.shortMessage || e.message})`);
  }
}
await probe("without from", null);
await probe("with from=agent", agent);

// ---------- activity events, 5000-block chunks, per-chunk error catch ----------
const wanted = ["PaymentExecuted", "PaymentRequested", "RequestApproved", "AgentFrozen", "GlobalFrozen"];
const abiEvents = new Set(abi.filter(x => x.type === "event").map(x => x.name));
const eventNames = wanted.filter(n => abiEvents.has(n));
const missing = wanted.filter(n => !abiEvents.has(n));
if (missing.length) {
  console.log(`\nevents not in deployed ABI (skipped): ${missing.join(", ")} — ` +
    `approveRequest emits PaymentExecuted instead of RequestApproved`);
}

const fromBlock = deployBlock !== null && deployBlock !== undefined
  ? Math.max(Number(deployBlock), 0)
  : Math.max(0, latest - 50000);
console.log(`\nquery range: block ${fromBlock} .. ${latest} in 5000-block chunks`);

const found = [];
let failures = 0;
let pruned = 0;
let backfilled = 0;
function isPruned(e) {
  const text = [e && e.message, e && e.error && e.error.message, e && e.info && e.info.error && e.info.error.message]
    .filter(Boolean).join(" ");
  return /pruned history|history unavailable|missing trie|unknown block/i.test(text);
}
for (let cur = fromBlock; cur <= latest; cur += 5000) {
  const end = Math.min(cur + 4999, latest);
  const perChunk = await Promise.all(eventNames.map(async (n) => {
    try {
      return await read.queryFilter(read.filters[n](), cur, end);
    } catch (e) {
      if (isPruned(e)) {
        // primary RPC pruned this range: retry once on the archival gateway
        try {
          const logs = await readLogs.queryFilter(readLogs.filters[n](), cur, end);
          backfilled++;
          return logs;
        } catch (e2) {
          pruned++;
          return [];
        }
      }
      failures++;
      console.log(`  chunk fail ${n} ${cur}-${end}: ${e.shortMessage || e.message}`);
      return [];
    }
  }));
  for (const logs of perChunk) found.push(...logs);
}
found.sort((a, b) => (a.blockNumber || 0) - (b.blockNumber || 0));

if (pruned || backfilled) {
  console.log(`\nlog availability: ${backfilled} range query(ies) served by the fallback RPC, ${pruned} unavailable everywhere, primary RPC prunes old logs.`);
}
console.log(`\n${found.length} activity event(s) found, ${failures} real failure(s), ${pruned} unavailable range(s):`);
for (const ev of found) {
  const a = ev.args || {};
  let desc = ev.eventName;
  if (ev.eventName === "PaymentExecuted") {
    desc = `PaymentExecuted agent=${a.agent} -> ${a.to} ${ethers.formatEther(a.amount)} ETH reason="${a.reason}"`;
  } else if (ev.eventName === "PaymentRequested") {
    desc = `PaymentRequested #${a.id} agent=${a.agent} -> ${a.to} ${ethers.formatEther(a.amount)} ETH reason="${a.reason}"`;
  } else if (ev.eventName === "RequestApproved") {
    desc = `RequestApproved #${a.id}`;
  } else if (ev.eventName === "AgentFrozen") {
    desc = `AgentFrozen agent=${a.agent} frozen=${a.frozen}`;
  } else if (ev.eventName === "GlobalFrozen") {
    desc = `GlobalFrozen frozen=${a.frozen}`;
  }
  console.log(`  block ${ev.blockNumber} tx ${ev.transactionHash} ${desc}`);
}
console.log("\ncheck-activity: done");
process.exit(failures > 0 ? 1 : 0);
