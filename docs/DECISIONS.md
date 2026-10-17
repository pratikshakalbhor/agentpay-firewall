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

## Honest claims

- We limit damage from a compromised AGENT key only.
- A compromised OWNER key is only partially mitigated (guardian + delay on loosening).
- The AI agent in `agent/agent.ts` is a simulation (no real LLM).
- No "100% secure", "unhackable", or ERC-4337 claims are made.
