"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runCommentCommand = runCommentCommand;
const commandResult_1 = require("../../core/contracts/commandResult");
const helpers_1 = require("./helpers");
async function runCommentCommand(args, context) {
    if (args[0] !== 'pin') {
        return (0, helpers_1.commandUnknownSubcommand)(`comment ${(0, helpers_1.redactSensitiveArgs)(args).join(' ')}`.trim());
    }
    const requestFile = (0, helpers_1.readFlagValue)(args, '--request-file');
    if (!requestFile) {
        return (0, helpers_1.commandMissingFlag)('--request-file');
    }
    const from = (0, helpers_1.readFromFlag)(args);
    const chainFlag = (0, helpers_1.readChainWriteFlag)(args);
    if (chainFlag.error) {
        return chainFlag.error;
    }
    const handler = context.dependencies.comment?.pin;
    if (!handler) {
        return (0, commandResult_1.commandFailed)('not_implemented', 'Comment pin handler is not configured.');
    }
    const request = await (0, helpers_1.readJsonFile)(context, requestFile);
    return handler({
        ...request,
        ...(chainFlag.chain ? { network: chainFlag.chain } : {}),
        ...(from ? { from } : {}),
    });
}
