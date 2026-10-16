"use strict";
/**
 * /api/block/* routes — the device-level blocklist (`metabot block *` CLI
 * surface over HTTP, trust tiers P2). `list` is the read verb (GET);
 * add/remove are POST writes, guarded like the sibling write routes. All
 * responses are MetabotCommandResult JSON bodies with HTTP 200.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleBlockRoutes = void 0;
const commandResult_1 = require("../../core/contracts/commandResult");
const POST_VERBS = {
    '/api/block/add': 'add',
    '/api/block/remove': 'remove',
};
function validateInput(verb, input) {
    const trimmed = (key) => (typeof input[key] === 'string' ? input[key].trim() : '');
    if ((verb === 'add' || verb === 'remove') && !trimmed('globalMetaId')) {
        return { code: 'missing_global_meta_id', message: 'globalMetaId is required.' };
    }
    return undefined;
}
const handleBlockRoutes = async (context) => {
    const { req, url, handlers } = context;
    if (!url.pathname.startsWith('/api/block/')) {
        return false;
    }
    // GET /api/block/list — the device-level blocklist + explicit contacts.
    if (url.pathname === '/api/block/list') {
        if (req.method !== 'GET') {
            context.sendMethodNotAllowed(['GET']);
            return true;
        }
        const handler = handlers.block?.list;
        if (!handler) {
            context.sendJson(501, (0, commandResult_1.commandFailed)('not_implemented', 'Block list handler is not configured.'));
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
    const handler = handlers.block?.[verb];
    if (!handler) {
        context.sendJson(501, {
            ok: false,
            code: 'not_implemented',
            message: `Block handler is not configured: ${String(verb)}`,
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
exports.handleBlockRoutes = handleBlockRoutes;
