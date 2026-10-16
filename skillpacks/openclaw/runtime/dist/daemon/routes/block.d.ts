/**
 * /api/block/* routes — the device-level blocklist (`metabot block *` CLI
 * surface over HTTP, trust tiers P2). `list` is the read verb (GET);
 * add/remove are POST writes, guarded like the sibling write routes. All
 * responses are MetabotCommandResult JSON bodies with HTTP 200.
 */
import type { RouteHandler } from './types';
export declare const handleBlockRoutes: RouteHandler;
