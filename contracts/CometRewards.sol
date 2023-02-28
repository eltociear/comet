// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

import "./CometInterface.sol";
import "./ERC20.sol";

/**
 * @title Compound's CometRewards Contract
 * @notice Hold and claim token rewards
 * @author Compound
 */
contract CometRewards {
    struct RewardConfig {
        address token;
        uint64 rescaleFactor;
        bool shouldUpscale;
    }

    struct RewardOwed {
        address token;
        uint owed;
    }

    /// @notice The governor address which controls the contract
    address public governor;

    /// @notice Reward token address per Comet instance
    mapping(address => RewardConfig) public rewardConfig;

    /// @notice Rewards claimed per Comet instance and user account
    mapping(address => mapping(address => uint)) public rewardsClaimed;


    /// @dev The scale for factors
    uint256 internal constant FACTOR_SCALE = 1e18;

    /** Custom events **/

    event GovernorTransferred(address indexed oldGovernor, address indexed newGovernor);
    event RewardClaimed(address indexed src, address indexed recipient, address indexed token, uint256 amount);

    /** Custom errors **/

    error AlreadyConfigured(address);
    error InvalidUInt64(uint);
    error NotPermitted(address);
    error NotSupported(address);
    error TransferOutFailed(address, uint);

    /**
     * @notice Construct a new rewards pool
     * @param governor_ The governor who will control the contract
     */
    constructor(address governor_) {
        governor = governor_;
    }

    /**
     * @notice Set the reward token for a Comet instance
     * @param comet The protocol instance
     * @param token The reward token address
     * @param multiplier The multiplier to apply to convert a unit of accrued tracking to a unit of the reward token
     */
    function setRewardConfigWithMultiplier(address comet, address token, uint256 multiplier) public {
        if (msg.sender != governor) revert NotPermitted(msg.sender);
        if (rewardConfig[comet].token != address(0)) revert AlreadyConfigured(comet);

        uint64 accrualScale = CometInterface(comet).baseAccrualScale();
        uint8 tokenDecimals = ERC20(token).decimals();
        uint64 tokenScale = safe64(10 ** tokenDecimals);
        uint64 rescaleFactor;
        if (accrualScale > tokenScale) {
            rescaleFactor = accrualScale / tokenScale;
            // Flip from downscale to upscale if the multiplier is greater than the rescale factor
            if (rescaleFactor * FACTOR_SCALE < multiplier) {
                rescaleFactor = safe64(multiplier / uint256(rescaleFactor) / FACTOR_SCALE);
                rewardConfig[comet] = RewardConfig({
                    token: token,
                    rescaleFactor: rescaleFactor,
                    shouldUpscale: true
                });
            } else {
                rescaleFactor = safe64(uint256(rescaleFactor) * FACTOR_SCALE / multiplier);
                rewardConfig[comet] = RewardConfig({
                    token: token,
                    rescaleFactor: rescaleFactor,
                    shouldUpscale: false
                });
            }
        } else {
            rescaleFactor = tokenScale / accrualScale;
            // Flip from upscale to downscale if 1 / multiplier is greater than the rescale factor
            if (FACTOR_SCALE / multiplier > rescaleFactor) {
                rescaleFactor = safe64(FACTOR_SCALE / multiplier / uint256(rescaleFactor));
                rewardConfig[comet] = RewardConfig({
                    token: token,
                    rescaleFactor: rescaleFactor,
                    shouldUpscale: false
                });
            } else {
                rescaleFactor = safe64(uint256(rescaleFactor) * multiplier / FACTOR_SCALE);
                rewardConfig[comet] = RewardConfig({
                    token: token,
                    rescaleFactor: rescaleFactor,
                    shouldUpscale: true
                });
            }
        }
    }

    /**
     * @notice Set the reward token for a Comet instance
     * @param comet The protocol instance
     * @param token The reward token address
     */
    function setRewardConfig(address comet, address token) external {
        setRewardConfigWithMultiplier(comet, token, FACTOR_SCALE);
    }

    /**
     * @notice Withdraw tokens from the contract
     * @param token The reward token address
     * @param to Where to send the tokens
     * @param amount The number of tokens to withdraw
     */
    function withdrawToken(address token, address to, uint amount) external {
        if (msg.sender != governor) revert NotPermitted(msg.sender);

        doTransferOut(token, to, amount);
    }

    /**
     * @notice Transfers the governor rights to a new address
     * @param newGovernor The address of the new governor
     */
    function transferGovernor(address newGovernor) external {
        if (msg.sender != governor) revert NotPermitted(msg.sender);

        address oldGovernor = governor;
        governor = newGovernor;
        emit GovernorTransferred(oldGovernor, newGovernor);
    }

    /**
     * @notice Calculates the amount of a reward token owed to an account
     * @param comet The protocol instance
     * @param account The account to check rewards for
     */
    function getRewardOwed(address comet, address account) external returns (RewardOwed memory) {
        RewardConfig memory config = rewardConfig[comet];
        if (config.token == address(0)) revert NotSupported(comet);

        CometInterface(comet).accrueAccount(account);

        uint claimed = rewardsClaimed[comet][account];
        uint accrued = getRewardAccrued(comet, account, config);

        uint owed = accrued > claimed ? accrued - claimed : 0;
        return RewardOwed(config.token, owed);
    }

    /**
     * @notice Claim rewards of token type from a comet instance to owner address
     * @param comet The protocol instance
     * @param src The owner to claim for
     * @param shouldAccrue Whether or not to call accrue first
     */
    function claim(address comet, address src, bool shouldAccrue) external {
        claimInternal(comet, src, src, shouldAccrue);
    }

    /**
     * @notice Claim rewards of token type from a comet instance to a target address
     * @param comet The protocol instance
     * @param src The owner to claim for
     * @param to The address to receive the rewards
     */
    function claimTo(address comet, address src, address to, bool shouldAccrue) external {
        if (!CometInterface(comet).hasPermission(src, msg.sender)) revert NotPermitted(msg.sender);

        claimInternal(comet, src, to, shouldAccrue);
    }

    /**
     * @dev Claim to, assuming permitted
     */
    function claimInternal(address comet, address src, address to, bool shouldAccrue) internal {
        RewardConfig memory config = rewardConfig[comet];
        if (config.token == address(0)) revert NotSupported(comet);

        if (shouldAccrue) {
            CometInterface(comet).accrueAccount(src);
        }

        uint claimed = rewardsClaimed[comet][src];
        uint accrued = getRewardAccrued(comet, src, config);

        if (accrued > claimed) {
            uint owed = accrued - claimed;
            rewardsClaimed[comet][src] = accrued;
            doTransferOut(config.token, to, owed);

            emit RewardClaimed(src, to, config.token, owed);
        }
    }

    /**
     * @dev Calculates the reward accrued for an account on a Comet deployment
     */
    function getRewardAccrued(address comet, address account, RewardConfig memory config) internal view returns (uint) {
        uint accrued = CometInterface(comet).baseTrackingAccrued(account);

        if (config.shouldUpscale) {
            accrued *= config.rescaleFactor;
        } else {
            accrued /= config.rescaleFactor;
        }
        return accrued;
    }

    /**
     * @dev Safe ERC20 transfer out
     */
    function doTransferOut(address token, address to, uint amount) internal {
        bool success = ERC20(token).transfer(to, amount);
        if (!success) revert TransferOutFailed(to, amount);
    }

    /**
     * @dev Safe cast to uint64
     */
    function safe64(uint n) internal pure returns (uint64) {
        if (n > type(uint64).max) revert InvalidUInt64(n);
        return uint64(n);
    }
}