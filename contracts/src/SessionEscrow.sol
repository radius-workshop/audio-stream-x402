// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IERC20Permit is IERC20 {
    function permit(
        address owner, address spender, uint256 value, uint256 deadline,
        uint8 v, bytes32 r, bytes32 s
    ) external;
}

/// @notice Minimal MPP-style session escrow for Radius + SBC (EIP-2612).
/// @dev Two onchain txs per session: `open` (pulls funds via permit) and `close`
/// (submits the final cumulative voucher signed by the payer offchain).
contract SessionEscrow {
    IERC20Permit public immutable TOKEN;

    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 public constant VOUCHER_TYPEHASH = keccak256(
        "Voucher(bytes32 sessionId,uint256 cumulativeAmount,uint256 nonce)"
    );

    struct Session {
        address payer;
        address payee;
        uint128 deposited;
        uint128 spent;
        uint64  expiry;
        bool    closed;
    }
    mapping(bytes32 => Session) public sessions;

    event SessionOpened(bytes32 indexed sessionId, address indexed payer, address indexed payee, uint128 amount, uint64 expiry);
    event SessionClosed(bytes32 indexed sessionId, uint128 paid, uint128 refunded);
    event SessionReclaimed(bytes32 indexed sessionId, uint128 amount);

    constructor(address _token) {
        TOKEN = IERC20Permit(_token);
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes("SessionEscrow")),
            keccak256(bytes("1")),
            block.chainid,
            address(this)
        ));
    }

    function open(
        bytes32 sessionId,
        address payee,
        uint128 amount,
        uint64  duration,
        uint256 permitDeadline, uint8 pv, bytes32 pr, bytes32 ps
    ) external {
        require(sessions[sessionId].payer == address(0), "session exists");
        require(amount > 0 && duration > 0, "bad params");

        TOKEN.permit(msg.sender, address(this), amount, permitDeadline, pv, pr, ps);
        require(TOKEN.transferFrom(msg.sender, address(this), amount), "pull failed");

        uint64 expiry = uint64(block.timestamp) + duration;
        sessions[sessionId] = Session({
            payer: msg.sender,
            payee: payee,
            deposited: amount,
            spent: 0,
            expiry: expiry,
            closed: false
        });
        emit SessionOpened(sessionId, msg.sender, payee, amount, expiry);
    }

    function close(
        bytes32 sessionId,
        uint256 cumulativeAmount,
        uint256 nonce,
        uint8 v, bytes32 r, bytes32 s
    ) external {
        Session storage S = sessions[sessionId];
        require(!S.closed, "closed");
        require(msg.sender == S.payee, "not payee");
        require(cumulativeAmount <= S.deposited, "overspent");

        bytes32 structHash = keccak256(abi.encode(VOUCHER_TYPEHASH, sessionId, cumulativeAmount, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        address signer = ecrecover(digest, v, r, s);
        require(signer == S.payer && signer != address(0), "bad signature");

        // Safe because cumulativeAmount is bounded by S.deposited, a uint128.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint128 paid = uint128(cumulativeAmount);
        S.spent = paid;
        S.closed = true;

        if (cumulativeAmount > 0) {
            require(TOKEN.transfer(S.payee, cumulativeAmount), "pay failed");
        }
        uint128 refund = S.deposited - paid;
        if (refund > 0) {
            require(TOKEN.transfer(S.payer, refund), "refund failed");
        }
        emit SessionClosed(sessionId, paid, refund);
    }

    /// @notice Liveness escape: payer reclaims full deposit if payee never closes.
    function reclaim(bytes32 sessionId) external {
        Session storage S = sessions[sessionId];
        require(!S.closed, "closed");
        require(msg.sender == S.payer, "not payer");
        require(block.timestamp >= S.expiry, "not expired");

        uint128 amount = S.deposited - S.spent;
        S.closed = true;
        require(TOKEN.transfer(S.payer, amount), "refund failed");
        emit SessionReclaimed(sessionId, amount);
    }
}
