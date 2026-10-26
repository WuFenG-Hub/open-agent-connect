/**
 * Model-readable output formatting for the MetaWeb tools — OAC port of the
 * IDBots metawebLearningAgentTools formatting half. Shared by the CLI verbs,
 * the DSH native tools, and the skillpack so every surface renders the same
 * citation-shaped output (clickable MetaWeb URI links, never Web2 URLs).
 */
import type { MetawebSearchItem } from './search';
import type { MetawebPin as Pin } from './pinRead';
/** On-chain fields are arbitrary third-party text: flatten whitespace so a crafted \n cannot forge fake result lines in the tool output. */
export declare function flattenInline(value: string): string;
/** Ready-to-scan markdown bullets for search candidates; titles are clickable MetaWeb URI links. */
export declare function formatMetawebSearchBullets(items: MetawebSearchItem[]): string;
export declare function metawebProtocolFollowupHint(protocol: string): string | null;
/**
 * Human-readable sheet for a pin read; the creator line keeps a ready-to-quote metaid:// link.
 * opts (batch budget rendering): bodyCharCap caps the rendered body at that
 * many UTF-16 chars with a per-pin trim label; omitBody renders no body at
 * all, only a labeled pointer.
 */
export declare function formatMetawebPinDetail(pin: Pin, opts?: {
    /** Cap the rendered body at this many UTF-16 chars; the cut is labeled per-pin (batch budget rendering). */
    bodyCharCap?: number;
    /** Render no body at all, only a labeled pointer (batch budget rendering). */
    omitBody?: boolean;
}): string;
