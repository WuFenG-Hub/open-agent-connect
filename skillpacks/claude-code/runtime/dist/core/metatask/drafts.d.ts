/**
 * Participation drafts (UI reference F13): the prefilled, mode-aware prompt a
 * human hands to a bot session to join a task. The templates are the IDBots
 * `metatask.participateDraft` / `participateDraftCompetitive` copy ported
 * verbatim with one permitted change (UI ref §8): IDBots tool names are
 * spelled as `metabot metatask …` CLI verbs, in both languages. The UIs never
 * write — they only hand the user this draft.
 */
import type { MetaTaskTaskProjection } from './engine/types';
export interface ParticipateDraft {
    lang: 'en' | 'zh';
    mode: 'tree' | 'competitive';
    /** The suggested node the hint names, null when nothing is open. */
    node: string | null;
    text: string;
}
/**
 * Suggested first node: among the nodes a participant can actually join, prefer
 * entry nodes (deps: []) with the fewest competing candidates, then the fewest
 * deps, then id order; when nothing is joinable the draft carries no hint.
 *
 * Joinable is MODE-AWARE. Tree mode takes only `open` nodes: a `claimed` one is
 * locked by someone else and the claim guard refuses it (writer.ts), so
 * suggesting it would hand the human a command that cannot succeed. Competitive
 * mode has no node lock, so any non-verified node qualifies.
 */
export declare const suggestParticipateNode: (projection: MetaTaskTaskProjection) => string | null;
export declare function buildParticipateDraft(projection: MetaTaskTaskProjection, options?: {
    lang?: 'en' | 'zh';
    node?: string | null;
}): ParticipateDraft;
