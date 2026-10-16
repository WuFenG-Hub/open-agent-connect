/**
 * /api/trust/* routes — the on-chain owner trust grants (`metabot trust *`
 * CLI surface over HTTP, trust tiers P2). `list` is the read verb (GET);
 * grant/revoke are POST writes, guarded like the sibling write routes. All
 * responses are MetabotCommandResult JSON bodies with HTTP 200, matching the
 * owner route style.
 */
import type { RouteHandler } from './types';
export declare const handleTrustRoutes: RouteHandler;
