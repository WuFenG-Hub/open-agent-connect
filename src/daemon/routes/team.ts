/**
 * /api/team/* routes — the remote team Bot registry (`metabot team *` CLI
 * surface over HTTP, trust tiers P5). `list` is the read verb (GET);
 * add/remove are POST writes, guarded like the sibling write routes. All
 * responses are MetabotCommandResult JSON bodies with HTTP 200.
 */

import { commandFailed } from '../../core/contracts/commandResult';
import type { MetabotDaemonHttpHandlers, RouteHandler } from './types';

type TeamHandlerGroup = NonNullable<MetabotDaemonHttpHandlers['team']>;
type TeamVerb = keyof TeamHandlerGroup;

const POST_VERBS: Record<string, TeamVerb> = {
  '/api/team/add': 'add',
  '/api/team/remove': 'remove',
};

export const handleTeamRoutes: RouteHandler = async (context) => {
  const { req, url, handlers } = context;
  if (!url.pathname.startsWith('/api/team/')) {
    return false;
  }

  // GET /api/team/list — local profiles plus registry entries.
  if (url.pathname === '/api/team/list') {
    if (req.method !== 'GET') {
      context.sendMethodNotAllowed(['GET']);
      return true;
    }
    const handler = handlers.team?.list;
    if (!handler) {
      context.sendJson(501, commandFailed('not_implemented', 'Team list handler is not configured.'));
      return true;
    }
    context.sendJson(200, await handler({}));
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
  const handler = handlers.team?.[verb];
  if (!handler) {
    context.sendJson(501, {
      ok: false,
      code: 'not_implemented',
      message: `Team handler is not configured: ${String(verb)}`,
    });
    return true;
  }

  const input = await context.readJsonBody();
  const dispatch = handler as (rawInput: Record<string, unknown>) => Promise<unknown>;
  context.sendJson(200, await dispatch(input));
  return true;
};
