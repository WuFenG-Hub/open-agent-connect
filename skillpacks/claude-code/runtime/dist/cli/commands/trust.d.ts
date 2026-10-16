import { type MetabotCommandResult } from '../../core/contracts/commandResult';
import type { CliRuntimeContext } from '../types';
/**
 * The on-chain owner trust grants (trust tiers P2): the local root owner
 * publishes append-only /protocols/simpletrust pins. grant/revoke publish
 * (daemon-side, they need the owner signer); list resolves the effective
 * set (grants minus revokes) from chain through the daemon.
 */
export declare function runTrustCommand(args: string[], context: CliRuntimeContext): Promise<MetabotCommandResult<unknown>>;
