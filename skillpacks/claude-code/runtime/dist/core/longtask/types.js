"use strict";
/**
 * Long-term task board — the shared contract. Ported from IDBots
 * `renderer/types/longTermTask` plus the store's CHECK constraints.
 *
 * A long-term task is a FIRST-CLASS entity, not a projection of the delegation
 * ledger: group tasks, scheduled tasks and one-shot delegations never appear
 * here. The column and the progress are DERIVED read-time (see derive.ts) and
 * are deliberately never stored — a stored copy could disagree with the
 * sub-tasks it summarises.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LONG_TERM_COLUMN_ORDER = void 0;
/** Board columns, in display order. */
exports.LONG_TERM_COLUMN_ORDER = [
    'waiting_owner',
    'in_progress',
    'waiting_external',
    'defining',
    'paused',
    'done',
];
