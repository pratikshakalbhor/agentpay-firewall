// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title AgentPay
 * @dev Policy vault that bounds how much each agent can spend.
 *
 * The owner funds the vault and sets spending policy per (agent, token).
 * Agents may spend only via agentPay (bounded by a per-transaction cap and a
 * daily budget) or requestPayment (above-cap amounts that need owner approval).
 *
 * Security model (honest): we LIMIT damage from a compromised AGENT key.
 * A compromised OWNER key is only partially mitigated: the guardian can freeze
 * and cancel pending proposals, and loosening changes are delayed. We do NOT
 * protect against a compromised owner key beyond that.
 *
 * Fee-on-transfer tokens are unsupported.
 *
 * @dev Ownership uses the two-step pattern of OpenZeppelin's Ownable2Step
 * (transferOwnership + acceptOwnership) layered on top of Ownable, because
 * Ownable2Step's base constructor cannot accept arguments via the inheritance
 * list with this toolchain. The external behavior is identical.
 */
contract AgentPay is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Delay in seconds before a loosening (policy-relaxing) proposal may execute
    uint64 public immutable changeDelay;
    /// @notice Optional guardian: may freeze and cancel proposals, but cannot unfreeze, move funds or change policy directly
    address public guardian;
    /// @notice Global freeze, toggled by freezeAll / unfreezeAll
    bool public globalFrozen;

    /// @notice Id of the next payment request to be created
    uint256 public requestCount;

    struct Policy {
        bool active;
        uint128 perTxCap;
        uint128 dailyBudget;
        uint128 spent;
        uint64 windowStart;
    }

    mapping(address => mapping(address => Policy)) public policies;
    mapping(address => bool) public frozen;
    mapping(address => mapping(address => bool)) public allowlist;
    mapping(address => bool) public isAgent;

    enum ProposalKind {
        SetCap,
        SetBudget,
        AddAllowlist,
        AddAgent,
        ChangeGuardian
    }

    struct Proposal {
        ProposalKind kind;
        address agent;
        address token;
        address recipient;
        uint128 value;
        address newGuardian;
        uint64 eta;
        bool executed;
        bool cancelled;
    }
    Proposal[] public proposals;

    struct PaymentRequest {
        address agent;
        address token;
        address to;
        uint256 amount;
        string reason;
        uint64 createdAt;
        bool executed;
        bool cancelled;
    }
    mapping(uint256 => PaymentRequest) public requests;

    /// @dev One fixed 24h spending window per (agent, token)
    uint256 internal constant WINDOW = 86400;

    // Two-step ownership (mirrors OpenZeppelin's Ownable2Step)
    address private _pendingOwner;

    /**
     * @dev Returns the address of the pending owner.
     */
    function pendingOwner() public view virtual returns (address) {
        return _pendingOwner;
    }

    /**
     * @dev Starts the ownership transfer of the contract to a new account.
     * Can only be called by the current owner.
     */
    function transferOwnership(address newOwner) public virtual override onlyOwner {
        if (newOwner == address(0)) revert OwnableInvalidOwner(address(0));
        _pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner(), newOwner);
    }

    /**
     * @dev Transfers ownership of the contract to a new account (`newOwner`) and deletes any pending owner.
     * Internal function without access restriction.
     */
    function _transferOwnership(address newOwner) internal virtual override {
        delete _pendingOwner;
        super._transferOwnership(newOwner);
    }

    /**
     * @dev The new owner accepts the ownership transfer.
     */
    function acceptOwnership() public virtual {
        address sender = _msgSender();
        if (pendingOwner() != sender) revert OwnableUnauthorizedAccount(sender);
        _transferOwnership(sender);
    }

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);

    error NotAgent();
    error Frozen();
    error NotAllowlisted();
    error ExceedsPerTxCap();
    error ExceedsDailyBudget();
    error ZeroAmount();
    error InsufficientVaultBalance();
    error RequestExpired();
    error RequestNotPending();
    error ProposalNotReady();
    error NotAuthorized();
    error TransferFailed();

    event PaymentExecuted(address indexed agent, address indexed token, address indexed to, uint256 amount, string reason);
    event PaymentRequested(uint256 indexed id, address indexed agent, address indexed token, address to, uint256 amount, string reason);
    event RequestRejected(uint256 indexed id);
    event PolicyUpdated(address indexed agent, address indexed token, uint128 perTxCap, uint128 dailyBudget);
    event AllowlistUpdated(address indexed agent, address indexed recipient, bool allowed);
    event AgentFrozen(address indexed agent, bool frozen);
    event GlobalFrozen(bool frozen);
    event ProposalCreated(uint256 indexed id, address indexed agent, address indexed token, uint128 value, uint64 eta);
    event ProposalExecuted(uint256 indexed id);
    event ProposalCancelled(uint256 indexed id);
    event GuardianChanged(address indexed oldGuardian, address indexed newGuardian);
    event DepositETH(address indexed from, uint256 amount);
    event DepositToken(address indexed from, address indexed token, uint256 amount);
    event Withdrawal(address indexed to, address indexed token, uint256 amount);

    /**
     * @param _guardian optional guardian address (may be address(0))
     * @param _changeDelay delay in seconds before a loosening proposal may execute
     */
    constructor(address _guardian, uint64 _changeDelay) Ownable(msg.sender) {
        guardian = _guardian;
        changeDelay = _changeDelay;
    }

    /// @notice Deposit ETH into the vault. Anyone may deposit.
    function depositETH() external payable {
        emit DepositETH(msg.sender, msg.value);
    }

    /// @notice Receive plain ETH transfers. Anyone may deposit.
    receive() external payable {
        emit DepositETH(msg.sender, msg.value);
    }

    /// @notice Deposit ERC-20 tokens into the vault. Anyone may deposit.
    function depositToken(address token, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit DepositToken(msg.sender, token, amount);
    }

    /// @notice Withdraw funds from the vault. Owner only.
    function withdraw(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (token == address(0)) {
            if (address(this).balance < amount) revert InsufficientVaultBalance();
            (bool ok, ) = payable(to).call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            if (IERC20(token).balanceOf(address(this)) < amount) revert InsufficientVaultBalance();
            IERC20(token).safeTransfer(to, amount);
        }
        emit Withdrawal(to, token, amount);
    }

    /**
     * @notice Agent pays an allowlisted recipient within per-tx cap and daily budget.
     * Check order: active agent -> not frozen -> allowlisted -> within perTxCap ->
     * window reset if elapsed -> within dailyBudget -> update state -> transfer -> emit.
     */
    function agentPay(address token, address to, uint256 amount, string calldata reason) external nonReentrant {
        if (!isAgent[msg.sender] || !policies[msg.sender][token].active) revert NotAgent();
        if (globalFrozen || frozen[msg.sender]) revert Frozen();
        if (!allowlist[msg.sender][to]) revert NotAllowlisted();
        if (amount == 0) revert ZeroAmount();

        Policy storage p = policies[msg.sender][token];
        if (amount > p.perTxCap) revert ExceedsPerTxCap();
        if (block.timestamp >= p.windowStart + WINDOW) {
            p.windowStart = uint64(block.timestamp);
            p.spent = 0;
        }
        if (p.spent + amount > p.dailyBudget) revert ExceedsDailyBudget();
        p.spent = uint128(p.spent + amount);

        if (token == address(0)) {
            (bool ok, ) = payable(to).call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }

        emit PaymentExecuted(msg.sender, token, to, amount, reason);
    }

    /**
     * @notice Agent requests an above-cap payment to an allowlisted recipient.
     * Creates a pending request (expires after 24h). No funds move.
     */
    function requestPayment(address token, address to, uint256 amount, string calldata reason) external {
        if (!isAgent[msg.sender] || !policies[msg.sender][token].active) revert NotAgent();
        if (amount == 0) revert ZeroAmount();
        if (!allowlist[msg.sender][to]) revert NotAllowlisted();
        Policy storage p = policies[msg.sender][token];
        if (amount <= p.perTxCap) revert ExceedsPerTxCap();

        uint256 id = requestCount++;
        requests[id] = PaymentRequest({
            agent: msg.sender,
            token: token,
            to: to,
            amount: amount,
            reason: reason,
            createdAt: uint64(block.timestamp),
            executed: false,
            cancelled: false
        });
        emit PaymentRequested(id, msg.sender, token, to, amount, reason);
    }

    /**
     * @notice Owner executes a pending payment request.
     * Bypasses the per-tx cap only; the recipient must still be allowlisted and the daily budget still applies.
     */
    function approveRequest(uint256 id) external onlyOwner nonReentrant {
        PaymentRequest storage r = requests[id];
        if (r.executed || r.cancelled) revert RequestNotPending();
        if (block.timestamp >= r.createdAt + WINDOW) revert RequestExpired();
        if (!isAgent[r.agent] || !policies[r.agent][r.token].active) revert NotAgent();
        if (globalFrozen || frozen[r.agent]) revert Frozen();
        if (!allowlist[r.agent][r.to]) revert NotAllowlisted();

        Policy storage p = policies[r.agent][r.token];
        if (block.timestamp >= p.windowStart + WINDOW) {
            p.windowStart = uint64(block.timestamp);
            p.spent = 0;
        }
        if (p.spent + r.amount > p.dailyBudget) revert ExceedsDailyBudget();

        p.spent = uint128(p.spent + r.amount);
        r.executed = true;

        if (r.token == address(0)) {
            (bool ok, ) = payable(r.to).call{value: r.amount}("");
            if (!ok) revert TransferFailed();
        } else {
            IERC20(r.token).safeTransfer(r.to, r.amount);
        }

        emit PaymentExecuted(r.agent, r.token, r.to, r.amount, r.reason);
    }

    /// @notice Reject (cancel) a pending payment request. Owner or guardian.
    function rejectRequest(uint256 id) external onlyOwnerOrGuardian {
        PaymentRequest storage r = requests[id];
        if (r.executed || r.cancelled) revert RequestNotPending();
        r.cancelled = true;
        emit RequestRejected(id);
    }

    /// @notice Freeze a single agent. Owner or guardian. Instant.
    function freezeAgent(address agent) external onlyOwnerOrGuardian {
        frozen[agent] = true;
        emit AgentFrozen(agent, true);
    }

    /// @notice Freeze all agents globally. Owner or guardian. Instant.
    function freezeAll() external onlyOwnerOrGuardian {
        globalFrozen = true;
        emit GlobalFrozen(true);
    }

    /// @notice Unfreeze a single agent. Owner only. Instant.
    function unfreezeAgent(address agent) external onlyOwner {
        frozen[agent] = false;
        emit AgentFrozen(agent, false);
    }

    /// @notice Unfreeze all agents globally. Owner only. Instant.
    function unfreezeAll() external onlyOwner {
        globalFrozen = false;
        emit GlobalFrozen(false);
    }

    /// @notice Number of proposals stored
    function proposalCount() public view returns (uint256) {
        return proposals.length;
    }

    /**
     * @notice Tighten a cap instantly, or queue a raise behind changeDelay.
     * Lowering (or equal) takes effect immediately; raising is a proposal.
     */
    function proposeSetPerTxCap(address agent, address token, uint128 newCap) external onlyOwner {
        Policy storage p = policies[agent][token];
        if (newCap < p.perTxCap) {
            p.perTxCap = newCap;
            emit PolicyUpdated(agent, token, newCap, p.dailyBudget);
            return;
        }
        if (newCap == p.perTxCap) return;
        uint256 id = proposals.length;
        proposals.push(
            Proposal({
                kind: ProposalKind.SetCap,
                agent: agent,
                token: token,
                recipient: address(0),
                value: newCap,
                newGuardian: address(0),
                eta: uint64(block.timestamp + changeDelay),
                executed: false,
                cancelled: false
            })
        );
        emit ProposalCreated(id, agent, token, newCap, uint64(block.timestamp + changeDelay));
    }

    /**
     * @notice Tighten a daily budget instantly, or queue a raise behind changeDelay.
     */
    function proposeSetDailyBudget(address agent, address token, uint128 newBudget) external onlyOwner {
        Policy storage p = policies[agent][token];
        if (newBudget < p.dailyBudget) {
            p.dailyBudget = newBudget;
            emit PolicyUpdated(agent, token, p.perTxCap, newBudget);
            return;
        }
        if (newBudget == p.dailyBudget) return;
        uint256 id = proposals.length;
        proposals.push(
            Proposal({
                kind: ProposalKind.SetBudget,
                agent: agent,
                token: token,
                recipient: address(0),
                value: newBudget,
                newGuardian: address(0),
                eta: uint64(block.timestamp + changeDelay),
                executed: false,
                cancelled: false
            })
        );
        emit ProposalCreated(id, agent, token, newBudget, uint64(block.timestamp + changeDelay));
    }

    /// @notice Queue adding a recipient to an agent's allowlist (removal is instant).
    function proposeAddAllowlist(address agent, address recipient) external onlyOwner {
        if (allowlist[agent][recipient]) return;
        uint256 id = proposals.length;
        proposals.push(
            Proposal({
                kind: ProposalKind.AddAllowlist,
                agent: agent,
                token: address(0),
                recipient: recipient,
                value: 0,
                newGuardian: address(0),
                eta: uint64(block.timestamp + changeDelay),
                executed: false,
                cancelled: false
            })
        );
        emit ProposalCreated(id, agent, address(0), 0, uint64(block.timestamp + changeDelay));
    }

    /// @notice Queue activating an agent (deactivation is instant).
    function proposeAddAgent(address agent) external onlyOwner {
        if (isAgent[agent]) return;
        uint256 id = proposals.length;
        proposals.push(
            Proposal({
                kind: ProposalKind.AddAgent,
                agent: agent,
                token: address(0),
                recipient: address(0),
                value: 0,
                newGuardian: address(0),
                eta: uint64(block.timestamp + changeDelay),
                executed: false,
                cancelled: false
            })
        );
        emit ProposalCreated(id, agent, address(0), 0, uint64(block.timestamp + changeDelay));
    }

    /// @notice Queue changing the guardian.
    function proposeChangeGuardian(address newGuardian) external onlyOwner {
        if (newGuardian == guardian) return;
        uint256 id = proposals.length;
        proposals.push(
            Proposal({
                kind: ProposalKind.ChangeGuardian,
                agent: address(0),
                token: address(0),
                recipient: address(0),
                value: 0,
                newGuardian: newGuardian,
                eta: uint64(block.timestamp + changeDelay),
                executed: false,
                cancelled: false
            })
        );
        emit ProposalCreated(id, address(0), address(0), 0, uint64(block.timestamp + changeDelay));
    }

    /// @notice Execute a proposal after its eta. Anyone may call it.
    function executeProposal(uint256 id) external {
        Proposal storage p = proposals[id];
        if (p.executed || p.cancelled) revert ProposalNotReady();
        if (block.timestamp < p.eta) revert ProposalNotReady();

        if (p.kind == ProposalKind.SetCap) {
            Policy storage pol = policies[p.agent][p.token];
            pol.perTxCap = p.value;
            if (p.value > 0) pol.active = true;
            emit PolicyUpdated(p.agent, p.token, p.value, pol.dailyBudget);
        } else if (p.kind == ProposalKind.SetBudget) {
            Policy storage pol = policies[p.agent][p.token];
            pol.dailyBudget = p.value;
            if (p.value > 0) pol.active = true;
            emit PolicyUpdated(p.agent, p.token, pol.perTxCap, p.value);
        } else if (p.kind == ProposalKind.AddAllowlist) {
            allowlist[p.agent][p.recipient] = true;
            emit AllowlistUpdated(p.agent, p.recipient, true);
        } else if (p.kind == ProposalKind.AddAgent) {
            isAgent[p.agent] = true;
        } else if (p.kind == ProposalKind.ChangeGuardian) {
            emit GuardianChanged(guardian, p.newGuardian);
            guardian = p.newGuardian;
        }

        p.executed = true;
        emit ProposalExecuted(id);
    }

    /// @notice Cancel a pending proposal. Owner or guardian.
    function cancelProposal(uint256 id) external onlyOwnerOrGuardian {
        Proposal storage p = proposals[id];
        if (p.executed || p.cancelled) revert ProposalNotReady();
        p.cancelled = true;
        emit ProposalCancelled(id);
    }

    modifier onlyOwnerOrGuardian() {
        if (msg.sender != owner() && msg.sender != guardian) revert NotAuthorized();
        _;
    }
}
