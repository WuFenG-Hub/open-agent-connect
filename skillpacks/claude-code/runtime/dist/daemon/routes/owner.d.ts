/**
 * /api/owner/* routes — the root Owner Identity (the `metabot owner *` CLI
 * surface over HTTP, trust tiers P1), additive next to the device-identity
 * /api/user/* routes. `who` is the read verb (GET); every write is POST, so
 * the local-daemon cross-site boundary guards them exactly like the sibling
 * write routes. All responses are MetabotCommandResult JSON bodies with
 * HTTP 200, matching the user route style.
 */
import type { RouteHandler } from './types';
export declare const handleOwnerRoutes: RouteHandler;
