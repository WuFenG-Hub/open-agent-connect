/**
 * Batch pin read for the MetaWeb tools: POST /api/metaweb/pins:batch — up to
 * 50 pins in one round trip (OAC port of the IDBots R2 batch client plus the
 * budget-capped batch renderer). Per-pin failures are isolated server-side
 * ({pinId, error} entries) and stay isolated in the render; upstream `text`
 * is capped at 8000 runes per pin while `payload` is never truncated.
 *
 * Rendering is budget-capped (two-pass): pass 1 renders every requested
 * entry's meta-only skeleton (complete for every pin, whatever happens
 * later); pass 2 splits the leftover budget across bodies — water-filling,
 * short bodies render whole first — trimming or omitting with a per-pin
 * label so the model always knows which bodies it did NOT get. The receipt
 * carries a machine-readable one-line summary whose bytes_written is solved
 * to a fixed point (the marker's own digits change the length it reports).
 */
import { type MetawebPin, type MetawebPinServiceOptions } from './pinRead';
export declare const METAWEB_PINS_BATCH_MAX = 50;
export type MetawebBatchPin = MetawebPin & {
    version: {
        latest: string;
        count: number | null;
    };
};
/** Per-pin failure entries are isolated server-side: {pinId, error}. */
export type MetawebBatchEntry = MetawebBatchPin | {
    pinId: string;
    error: string;
};
export declare const isBatchErrorEntry: (entry: MetawebBatchEntry) => entry is {
    pinId: string;
    error: string;
};
/**
 * Read up to 50 pins in one round trip. The response is a map keyed by the
 * requested pinId; entries are full pin objects (same shape as
 * GET /api/metaweb/pin/:id plus version info) or isolated {error} entries.
 */
export declare function metawebPinsBatch(pinIds: string[], options?: MetawebPinServiceOptions): Promise<Record<string, MetawebBatchEntry>>;
/** Total char budget the rendered batch must fit under (IDBots host budget port). */
export declare const METAWEB_BATCH_RESULT_CHAR_BUDGET = 18000;
/**
 * Bodies whose equal share of the batch budget falls below this render as a
 * labeled pointer instead of a token sliver — a 40-char body is noise.
 */
export declare const METAWEB_BATCH_BODY_FLOOR_CHARS = 240;
/** Cap on the id/point lists in the machine-readable line; counts stay exact. */
export declare const METAWEB_BATCH_RECEIPT_MAX_LIST = 12;
export declare const METAWEB_BATCH_RECEIPT_MARKER = "- RECEIPT read_metaweb_pins_batch: ";
/** Reading caliber (口径) tag: names the upstream endpoint, its 8000-rune text cap, and this renderer's char budget. */
export declare const METAWEB_BATCH_READ_CALIBER = "api/metaweb/pins:batch;text-cap=8000runes;host-budget=18000chars";
export type MetawebBatchTruncationPoint = {
    pin_id: string;
    reason: 'trimmed' | 'omitted' | 'server_cap';
    /** Body chars delivered in this output, counted in `unit` (0 for a whole-body omission). */
    kept_chars: number;
    /** The full body's UTF-16 chars; null when only the upstream-capped text is known (server_cap). */
    total_chars: number | null;
    /** UTF-8 byte offset into the full body where delivery stopped (0 for a whole-body omission). */
    cut_at_bytes: number;
    /** The full body's UTF-8 bytes; null when only the capped text is known (server_cap). */
    total_bytes: number | null;
    /** Unit of kept_chars/total_chars: UTF-16 units for host cuts, runes for the upstream cap. */
    unit: 'utf16-char' | 'rune';
};
export type MetawebBatchReadReceipt = {
    /** pinIds asked for in this call. */
    requested: number;
    /** Pins whose upstream fetch returned a body — the header's first number. */
    readable_upstream: number;
    /** Bodies actually present in the delivered receipt (whole + trimmed). */
    returned: number;
    /** True when any body was cut or dropped. */
    truncated: boolean;
    /** UTF-8 byte length of the delivered receipt text, THIS marker line included. */
    bytes_written: number;
    /** Readable pins whose whole body was dropped to fit the render budget (exact count). */
    omitted: number;
    /** Omitted pin ids, capped at METAWEB_BATCH_RECEIPT_MAX_LIST — `omitted` stays exact. */
    omitted_ids: string[];
    /** Requested ids that produced no usable body at all (error / no entry / encrypted-or-empty); exact count. */
    unreadable: number;
    /** Unreadable ids, capped like the omitted list. */
    unreadable_ids: string[];
    /** Exact number of cuts (trimmed + omitted + upstream-capped); `truncation_points` is capped. */
    truncation_point_count: number;
    /** Per-cut detail, capped at METAWEB_BATCH_RECEIPT_MAX_LIST. */
    truncation_points: MetawebBatchTruncationPoint[];
    caliber: string;
};
/** Degenerate batch: even meta-only skeletons bust the budget — fail loudly with a split size. */
export declare class MetawebBatchTooLargeError extends Error {
    constructor(message: string);
}
/**
 * Assemble the batch receipt with its machine-readable marker line and solve
 * `bytes_written` to a fixed point: the marker's own digits change the text
 * length it reports, so the value is measured on the assembled receipt and
 * re-embedded until stable.
 */
export declare function buildMetawebBatchReadReceipt(args: {
    header: string;
    sections: string[];
    receipt: Omit<MetawebBatchReadReceipt, 'bytes_written'>;
}): string;
export type RenderMetawebPinsBatchResult = {
    text: string;
    receipt: MetawebBatchReadReceipt;
    /** Pins whose body actually rendered (whole + trimmed) — for read-ledger recording. */
    deliveredPins: MetawebBatchPin[];
};
/**
 * Render a batch read under the result budget (two-pass water-filling, exact
 * OAC port of the IDBots renderer). Throws MetawebBatchTooLargeError for
 * degenerate batches that cannot render within the budget even without
 * bodies — the caller surfaces that as a split-and-retry error, never as a
 * silently beheaded result.
 */
export declare function renderMetawebPinsBatch(pinIds: string[], entries: Record<string, MetawebBatchEntry>): RenderMetawebPinsBatchResult;
