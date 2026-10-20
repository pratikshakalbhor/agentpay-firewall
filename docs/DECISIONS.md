# DECISIONS

## Bootstrap of the "loosening delay" (changeDelay)

AgentPay has no instant bootstrap path: every loosening change (add agent, raise caps,
add allowlist entries, change guardian) is queued behind `changeDelay` and only becomes
effective after `eta`. `scripts/deploy.ts` therefore bootstraps the demo policy by:

1. `proposeAddAgent`, `proposeSetPerTxCap`, `proposeSetDailyBudget`, `proposeAddAllowlist`
   (all loosening -> each stored with `eta = block.timestamp + changeDelay`).
2. Waiting past `changeDelay`:
   - on `localhost`: `evm_increaseTime(changeDelay + 1)` + `evm_mine` (instant).
   - on `sepolia`: real-time sleep of `changeDelay` seconds (600s for demo).
3. `executeProposal(id)` for every queued proposal.

This keeps the initial onboarding consistent with the contract's security model (no
special-casing that would weaken the delay) while remaining usable in a local demo where
waiting 10 minutes is impractical. The same proposal-then-execute flow is what a real
owner would follow on Sepolia.

## UnprotectedAgentWallet

`contracts/demo/UnprotectedAgentWallet.sol` is intentionally insecure (DEMO ONLY). It
models "we just gave the AI agent a hot wallet": the agent key can send any amount to any
address with no caps, budgets, allowlist, freeze, or guardian. It is the "before" half of
the before/after demo and must not be used in production.

## Tooling restoration (Oct 2026)

The repository arrived with an effectively empty `package.json` (`scripts: {}`, no
dependencies) and a nearly empty `node_modules`, so nothing could run. Decisions taken:

- Rebuilt `package.json` with the full dependency set (hardhat 2 + toolbox, ethers 6,
  OpenZeppelin 5, chai, ts-node, typescript 5.x — pinned away from TS 7) and
  cross‑platform npm scripts (`cross-env`/`rimraf` style, no Unix‑only commands) so every
  command works in PowerShell, per AGENTS.md.
- Replaced the stale `import "hardhat-coverage"` with `import "solidity-coverage"` in
  `hardhat.config.ts` (the old sc‑forks package predates Hardhat 2 toolbox and drags in an
  obsolete web3/mocha stack).
- Added `hardhat.config.ts` and `typechain-types` to `tsconfig.json` `include` so the
  toolbox's type augmentations are visible to `tsc`/`ts-node`.

## Type‑level fixes only (no test logic changes)

`npx tsc --noEmit` reported 257 errors. All fixes are type‑level and behavioural
equivalence was verified by running the suite (54 passing before and after):

- `test/fixture.ts` interfaces now extend `BaseContract` (avoids the TS2411 index‑signature
  clash on computed properties such as `["owner"]`), with `props` widened to
  `ReadonlyArray<unknown>`; contract params widened to `BigNumberish` / `string | Addressable`;
  signers typed as `HardhatEthersSigner`; missing members (`owner`, `pendingOwner`,
  `transferOwnership`, `acceptOwnership`, `proposals`) added to the read interface.
- `scripts/deploy.ts` / `scripts/demo-after.ts` use `import type` aliases to disambiguate
  typechain‑gen `Contract` from ethers `Contract`, plus `"url" in network.config` narrowing.
- No assertions, thresholds, or expected values were changed.

## Shared revert decoder (`scripts/lib/revert.ts`)

`agent/agent.ts`, `scripts/demo-after.ts` and `scripts/deploy.ts` each carried their own
copy of the revert‑message decoder, and the agent's copy crashed on any custom error with
bigint arguments (`JSON.stringify` throws on BigInt). They now share one decoder:

- `describeRevert()` walks structured error objects first (Hardhat's provider surfaces
  `e.data = { message, data: "0x..." }`), then falls back to hex in the message — both the
  ethers v6 string form and the Hardhat object form decode correctly.
- bigint‑safe `JSON.stringify` replacer for future error arguments (current AgentPay errors
  take none, so this is hardening).
- Regression‑tested in `test/revert-decoder.test.ts` so demo messages stay human‑readable.

## Frontend story restructure (Oct 2026)

`frontend/index.html` was restructured around a 3-step judge narrative (hero + stepper,
"the rules" tiles, agent/owner two-column, live activity, before/after). The previous
version is preserved at `frontend/index.backup.html` (a tracked backup that already
existed there was byte-identical to `HEAD`'s `index.html`, so it is still recoverable
from git). Contract calls, deploy scripts and `deployment.json` were not changed.
Decisions taken while keeping the existing logic:

- **`staticCall` now sends `from`.** The pre-flight `eth_call` probes did not set a
  sender, so `agentPay` reverted `NotAgent` for every probe and the "Normal purchase"
  button would have shown BLOCKED. Verified against Sepolia: probe without `from`
  reverts, probe with `from = agent` succeeds. Same call, correct sender.
- **`RequestApproved` is queried but does not exist in the deployed ABI.** The contract's
  `approveRequest` emits `PaymentExecuted` (AgentPay.sol), so approvals appear in the feed
  as payments. The event list is filtered against the loaded ABI instead of assuming
  availability, so the query never crashes on a missing event.
- **Feed errors are classified, not all red.** The configured RPC (publicnode) prunes
  `eth_getLogs` history older than ~10k blocks (JSON-RPC error `4444 "pruned history
  unavailable"`), and the whole contract history sits partly inside that window. Real
  query failures show the red error line + Retry; pruned ranges are retried once against
  a public archival gateway (`https://sepolia.gateway.tenderly.co`, CORS `*`, used ONLY
  for backfilling log ranges), and whatever is still unavailable shows an amber note +
  Retry. All state reads/writes keep using `config.rpc`.
- **Feed visibility bug fix:** the old code set `feed.style.display = "none"` and never
  restored it, so the timeline could never render; likewise an inline
  `demoResult.style.display = "none"` overrode the `.show` class. Both inline overrides
  removed — this was the actual cause of the "empty feed" beyond the log queries.
- **Session actions are appended locally** (`pushSessionActivity`) the moment a button is
  used, then merged with queried events (deduped by tx hash), so the timeline is never
  empty during a demo even before the log query returns.
- `scripts/check-activity.mjs` (new, read-only) exercises the same data reads against the
  Sepolia RPC and prints the activity events found. It never reads or prints any key
  (`demoAgentKey_TESTNET_ONLY` is deliberately not destructured).

## Honest claims

- We limit damage from a compromised AGENT key only.
- A compromised OWNER key is only partially mitigated (guardian + delay on loosening).
- The AI agent in `agent/agent.ts` is a simulation (no real LLM).
- No "100% secure", "unhackable", or ERC-4337 claims are made.
