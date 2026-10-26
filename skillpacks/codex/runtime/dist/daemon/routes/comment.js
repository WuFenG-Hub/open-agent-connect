"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleCommentRoutes = void 0;
const commandResult_1 = require("../../core/contracts/commandResult");
const handleCommentRoutes = async (context) => {
    const { req, url, handlers } = context;
    if (url.pathname !== '/api/comment/pin') {
        return false;
    }
    if (req.method !== 'POST') {
        context.sendMethodNotAllowed(['POST']);
        return true;
    }
    const input = await context.readJsonBody();
    const result = handlers.comment?.pin
        ? await handlers.comment.pin(input)
        : (0, commandResult_1.commandFailed)('not_implemented', 'Comment pin handler is not configured.');
    context.sendJson(200, result);
    return true;
};
exports.handleCommentRoutes = handleCommentRoutes;
