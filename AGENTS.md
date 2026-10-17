
# AgentPay Firewall: project context

## What we are building
An on-chain policy vault that lets AI agents spend crypto under hard, deterministic limits.
The owner funds the vault. Agents get a restricted spending role. The contract enforces
per-agent limits so a hacked, confused or prompt-injected agent can only lose a bounded amount.
This is for a solo university hackathon on the Ethereum blockchain. Quality, correctness and a clear live demo matter most.

## Hackathon requirements (must all be met)
- A complete, WORKING project: not just an idea, slides or a UI prototype.
- Smart contracts deployed and demonstrated on an ETHEREUM testnet: Sepolia (chainId 11155111). Do NOT use Base or other L2 testnets.
- A frontend that interacts with the deployed contracts and shows the core functionality (real wallet via MetaMask, not only scripts).
- Judging (each /10): Working/Functionality, Idea/Innovation, Presentation, Smart Contract Execution, UI/UX Design.
  Judges may not be security experts: the UI and demo must be understandable in seconds, in plain language.

## Environment
- Developer machine: Windows with PowerShell. Use cross-platform npm scripts only (cross-env, rimraf, Node scripts instead of
  Unix commands like rm, export, find, cp). Use path.join for paths. Any command shown to the user must work in PowerShell.

## Honest claim (never overclaim)
We LIMIT damage from a compromised/misbehaving AGENT key. We do NOT protect against a
compromised OWNER key, except partially via guardian + delay on loosening changes.
The AI agent in the demo is a simulation of agent behaviour (not a real LLM); say so plainly. The contract works for any agent key.
Never write "100% secure", "unhackable", "ERC-4337 compatible", "HTLC", or similar claims in code,
comments or README. Document limitations plainly.

## Stack
- Solidity ^0.8.24, OpenZeppelin Contracts v5 (Ownable2Step, ReentrancyGuard, SafeERC20)
- Hardhat 2 + ethers v6 + TypeScript, hardhat-toolbox, chai tests
- Node 18+ scripts (ts-node/tsx), plain static HTML + ethers v6 ESM for the UI (no build step)
- Networks: local hardhat node for development, Ethereum Sepolia for the final demo and submission.
  Contracts must be verified on Etherscan (sepolia.etherscan.io).
- .env keys: PRIVATE_KEY, SEPOLIA_RPC_URL, ETHERSCAN_API_KEY, CHANGE_DELAY_SECONDS

## Actors
- owner: funds the vault, sets policy, approves requests. (Ownable2Step)
- guardian: one optional address. Can ONLY freeze (globally or per agent) and cancel pending proposals.
  Can NOT unfreeze, move funds, or change policy.
- agent: any number of agent addresses, each with its own policy. Can ONLY call agentPay / requestPayment.

## Contract: AgentPay.sol (single main contract)
Tokens: ETH (token == address(0)) and ERC-20 (via SafeERC20). Fee-on-transfer tokens are unsupported (document it).

Per (agent, token) policy:
  struct Policy { bool active; uint128 perTxCap; uint128 dailyBudget; uint128 spent; uint64 windowStart; }
Per agent: `frozen` flag, and allowlist mapping(agent => mapping(recipient => bool)).
Global: `globalFrozen`. Window is a fixed 24h window starting at the first spend after the previous window ends.

Core functions:
- receive() / depositETH(), depositToken(token, amount): anyone may deposit.
- withdraw(token, to, amount): owner only. (Guardian cannot.)
- agentPay(token, to, amount, reason) : onlyActiveAgent, nonReentrant. Check order:
  caller is agent with active policy -> !globalFrozen && !agent.frozen -> recipient allowlisted for that agent
  -> amount <= perTxCap -> reset window if elapsed -> spent + amount <= dailyBudget
  -> update state -> transfer -> emit PaymentExecuted(agent, token, to, amount, reason).
- requestPayment(token, to, amount, reason): agent only. For allowlisted recipient and amount > perTxCap only.
  Creates a pending request (expires after 24h). No funds move.
- approveRequest(id): owner only. Executes the transfer. It bypasses perTxCap ONLY; recipient must still be allowlisted
  and dailyBudget still applies. rejectRequest(id): owner or guardian.
- freezeAgent(agent), freezeAll(): owner or guardian, instant.  unfreezeAgent(agent), unfreezeAll(): owner only.

Policy changes (the "loosening delay" rule):
- Tightening is instant: lower perTxCap/dailyBudget, remove allowlist entry, deactivate agent, freeze.
- Loosening is queued with a delay (`changeDelay`, set in constructor, immutable; 10 minutes for demo deployments):
  raising caps/budget, adding allowlist entries, adding/activating an agent, changing guardian.
  proposeX(...) stores a proposal with eta. executeProposal(id) works only after eta. cancelProposal(id): owner or guardian.
  This gives the guardian a window to cancel a malicious change made with a stolen owner key.

Custom errors (no revert strings): NotAgent, Frozen, NotAllowlisted, ExceedsPerTxCap, ExceedsDailyBudget,
ZeroAmount, InsufficientVaultBalance, RequestExpired, RequestNotPending, ProposalNotReady, NotAuthorized, TransferFailed.
Events for every state change, with indexed agent/token/recipient where useful.
Pattern: checks-effects-interactions, ReentrancyGuard on all fund-moving functions, ETH via call with success check.

## Repo layout
contracts/AgentPay.sol, contracts/mocks/MockUSDC.sol (6 decimals), contracts/demo/UnprotectedAgentWallet.sol
test/*.ts, scripts/deploy.ts, scripts/demo-before.ts, scripts/demo-after.ts, agent/agent.ts,
frontend/index.html (+ frontend/abi.json, frontend/deployment.json), docs/, README.md

## Working rules for the AI
- Work in small steps. After each step run the compiler/tests and show the result.
- Never weaken or delete a test to make it pass. Fix the code.
- Never hardcode private keys. Use .env (gitignored) and .env.example. Demo keys on testnets are throwaway and labelled as such.
- Keep gas and code simple and readable. Natspec on all external functions.
- If a requirement is ambiguous, pick the safer option, note it in docs/DECISIONS.md, and continue.