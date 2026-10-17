// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../AgentPay.sol";

/**
 * @title ReentrantReceiver
 * @dev Malicious test recipient that re-enters AgentPay from receive().
 * Used only in tests to prove re-entrant calls fail.
 */
contract ReentrantReceiver {
    address payable public immutable agentpay;
    address public owner;

    constructor(address payable _agentpay) {
        agentpay = _agentpay;
        owner = msg.sender;
    }

    /// @notice Re-enter AgentPay.agentPay while it is already executing.
    receive() external payable {
        AgentPay(agentpay).agentPay(address(0), owner, 1, "reentrancy");
    }

    /// @notice Re-enter AgentPay.approveRequest while it is already executing.
    function attackApproveRequest(uint256 id) external {
        AgentPay(agentpay).approveRequest(id);
    }
}
