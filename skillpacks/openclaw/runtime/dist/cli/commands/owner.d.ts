import { type MetabotCommandResult } from '../../core/contracts/commandResult';
import type { CliRuntimeContext } from '../types';
/**
 * The root Owner Identity commands (trust tiers P1): the human's portable,
 * machine-wide identity one layer above the Device Identity (`metabot user *`).
 * CRUD is local; `bind-device` publishes the on-chain device→owner binding
 * and therefore runs daemon-side (it needs the chain signer + sponsor hook).
 */
export declare function runOwnerCommand(args: string[], context: CliRuntimeContext): Promise<MetabotCommandResult<unknown>>;
