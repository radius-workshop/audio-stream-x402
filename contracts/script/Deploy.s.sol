// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {SessionEscrow} from "../src/SessionEscrow.sol";

contract DeployScript is Script {
    function run() external {
        address sbc = vm.envAddress("SBC_TOKEN");
        uint256 pk = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(pk);
        SessionEscrow escrow = new SessionEscrow(sbc);
        vm.stopBroadcast();

        console2.log("SessionEscrow deployed at:", address(escrow));
        console2.log("DOMAIN_SEPARATOR:");
        console2.logBytes32(escrow.DOMAIN_SEPARATOR());
    }
}
