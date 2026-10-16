import { type MetabotCommandResult } from '../../core/contracts/commandResult';
import type { CliRuntimeContext } from '../types';
/**
 * The device-level blocklist (trust tiers P2, M1): pure local state at
 * `~/.metabot/owner/trust-local.json` — no daemon required. add/remove also
 * drop the peer's cached trust resolution (blockGmid/unblockGmid), so the
 * next tier check re-resolves. On-chain `simpleblock` replaces/merges this
 * in M2.
 */
export declare function runBlockCommand(args: string[], context: CliRuntimeContext): Promise<MetabotCommandResult<unknown>>;
