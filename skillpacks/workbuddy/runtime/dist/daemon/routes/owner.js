"use strict";
/**
 * /api/owner/* routes — the root Owner Identity (the `metabot owner *` CLI
 * surface over HTTP, trust tiers P1), additive next to the device-identity
 * /api/user/* routes. `who` is the read verb (GET); every write is POST, so
 * the local-daemon cross-site boundary guards them exactly like the sibling
 * write routes. All responses are MetabotCommandResult JSON bodies with
 * HTTP 200, matching the user route style.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleOwnerRoutes = void 0;
const commandResult_1 = require("../../core/contracts/commandResult");
const POST_VERBS = {
    '/api/owner/create': 'create',
    '/api/owner/import': 'import',
    '/api/owner/rename': 'rename',
    '/api/owner/bind-device': 'bindDevice',
};
function validateInput(verb, input) {
    const trimmed = (key) => (typeof input[key] === 'string' ? input[key].trim() : '');
    if (verb === 'import' && !trimmed('mnemonic')) {
        return { code: 'missing_mnemonic', message: 'mnemonic is required.' };
    }
    if (verb === 'rename' && !trimmed('name')) {
        return { code: 'missing_name', message: 'name is required.' };
    }
    return undefined;
}
const handleOwnerRoutes = async (context) => {
    const { req, url, handlers } = context;
    if (!url.pathname.startsWith('/api/owner/')) {
        return false;
    }
    // GET /api/owner/who — the root owner identity read (public fields only).
    if (url.pathname === '/api/owner/who') {
        if (req.method !== 'GET') {
            context.sendMethodNotAllowed(['GET']);
            return true;
        }
        const handler = handlers.owner?.who;
        if (!handler) {
            context.sendJson(501, (0, commandResult_1.commandFailed)('not_implemented', 'Owner who handler is not configured.'));
            return true;
        }
        context.sendJson(200, await handler());
        return true;
    }
    const verb = POST_VERBS[url.pathname];
    if (!verb) {
        context.sendJson(404, (0, commandResult_1.commandFailed)('not_found', `No route matched ${url.pathname}.`));
        return true;
    }
    if (req.method !== 'POST') {
        context.sendMethodNotAllowed(['POST']);
        return true;
    }
    const handler = handlers.owner?.[verb];
    if (!handler) {
        context.sendJson(501, {
            ok: false,
            code: 'not_implemented',
            message: `Owner handler is not configured: ${String(verb)}`,
        });
        return true;
    }
    const input = await context.readJsonBody();
    const invalid = validateInput(verb, input);
    if (invalid) {
        context.sendJson(200, (0, commandResult_1.commandFailed)(invalid.code, invalid.message));
        return true;
    }
    const dispatch = handler;
    context.sendJson(200, await dispatch(input));
    return true;
};
exports.handleOwnerRoutes = handleOwnerRoutes;
