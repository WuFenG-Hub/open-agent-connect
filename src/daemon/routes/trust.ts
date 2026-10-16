/**
 * /api/trust/* routes — the on-chain owner trust grants (`metabot trust *`
 * CLI surface over HTTP, trust tiers P2). `list` is the read verb (GET);
 * grant/revoke are POST writes, guarded like the sibling write routes. All
 * responses are MetabotCommandResult JSON bodies with HTTP 200, matching the
 * owner route style.
 */

import { commandFailed } from '../../core/contracts/commandResult';
import type { MetabotDaemonHttpHandlers, RouteHandler } from './types';

type TrustHandlerGroup = NonNullable<MetabotDaemonHttpHandlers['trust']>;
type TrustVerb = keyof TrustHandlerGroup;

const POST_VERBS: Record<string, TrustVerb> = {
  '/api/trust/grant': 'grant',
  '/api/trust/revoke': 'revoke',
};

function validateInput(verb: TrustVerb, input: Record<string, unknown>): void | { code: string; message: string } {
  const trimmed = (key: string): string => (typeof input[key] === 'string' ? input[key].trim() : '');
  if (verb === 'grant' && !trimmed('trustedOwner')) {
    return { code: 'missing_trusted_owner', message: 'trustedOwner is required.' };
  }
  if (verb === 'revoke' && !trimmed('target')) {
    return { code: 'missing_revoke_target', message: 'target (owner GlobalMetaID or grant pinId) is required.' };
  }
  return undefined;
}

export const handleTrustRoutes: RouteHandler = async (context) => {
  const { req, url, handlers } = context;
  if (!url.pathname.startsWith('/api/trust/')) {
    return false;
  }

  // GET /api/trust/list — the local owner's effective trust set.
  if (url.pathname === '/api/trust/list') {
    if (req.method !== 'GET') {
      context.sendMethodNotAllowed(['GET']);
      return true;
    }
    const handler = handlers.trust?.list;
    if (!handler) {
      context.sendJson(501, commandFailed('not_implemented', 'Trust list handler is not configured.'));
      return true;
    }
    context.sendJson(200, await handler());
    return true;
  }

  const verb = POST_VERBS[url.pathname];
  if (!verb) {
    context.sendJson(404, commandFailed('not_found', `No route matched ${url.pathname}.`));
    return true;
  }
  if (req.method !== 'POST') {
    context.sendMethodNotAllowed(['POST']);
    return true;
  }
  const handler = handlers.trust?.[verb];
  if (!handler) {
    context.sendJson(501, {
      ok: false,
      code: 'not_implemented',
      message: `Trust handler is not configured: ${String(verb)}`,
    });
    return true;
  }

  const input = await context.readJsonBody();
  const invalid = validateInput(verb, input);
  if (invalid) {
    context.sendJson(200, commandFailed(invalid.code, invalid.message));
    return true;
  }
  const dispatch = handler as (rawInput: Record<string, unknown>) => Promise<unknown>;
  context.sendJson(200, await dispatch(input));
  return true;
};
