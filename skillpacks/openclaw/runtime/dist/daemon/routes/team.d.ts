/**
 * /api/team/* routes — the remote team Bot registry (`metabot team *` CLI
 * surface over HTTP, trust tiers P5). `list` is the read verb (GET);
 * add/remove are POST writes, guarded like the sibling write routes. All
 * responses are MetabotCommandResult JSON bodies with HTTP 200.
 */
import type { RouteHandler } from './types';
export declare const handleTeamRoutes: RouteHandler;
