// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title UnprotectedAgentWallet
 * @dev INTENTIONALLY INSECURE — DEMO ONLY.
 *
 * This models the naive pattern of "we just gave the AI agent a hot wallet":
 * the owner deposits ETH, and the agent key can send ANY amount to ANY address.
 * There are no per-transaction caps, no daily budgets, no recipient allowlist,
 * no freeze, and no guardian. A compromised or prompt-injected agent can drain
 * the entire wallet in a single transaction.
 *
 * This is the "before" half of the before/after demo. It exists only to show
 * why AgentPay's limits matter. DO NOT use in production.
 */
contract UnprotectedAgentWallet {
    address public immutable owner;
    address public agent;

    event Deposit(address indexed from, uint256 amount);
    event TransferSent(address indexed to, uint256 amount);
    event OwnerWithdrawal(address indexed to, uint256 amount);

    constructor() {
        owner = msg.sender;
    }

    /// @notice Owner designates the agent (hot wallet) key.
    function setAgent(address _agent) external {
        if (msg.sender != owner) revert OnlyOwner();
        agent = _agent;
    }

    /// @notice Anyone may deposit ETH into the wallet.
    function deposit() external payable {
        emit Deposit(msg.sender, msg.value);
    }

    receive() external payable {
        emit Deposit(msg.sender, msg.value);
    }

    /**
     * @notice Agent sends ANY amount to ANY address. INSECURE: no limits at all.
     * A compromised agent can drain the whole wallet to any recipient.
     */
    function agentSend(address to, uint256 amount) external {
        if (msg.sender != agent) revert OnlyAgent();
        if (amount == 0) revert ZeroAmount();
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit TransferSent(to, amount);
    }

    /// @notice Owner withdraws ETH from the wallet.
    function withdraw(address to, uint256 amount) external {
        if (msg.sender != owner) revert OnlyOwner();
        if (amount == 0) revert ZeroAmount();
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit OwnerWithdrawal(to, amount);
    }

    error OnlyOwner();
    error OnlyAgent();
    error ZeroAmount();
    error TransferFailed();
}
