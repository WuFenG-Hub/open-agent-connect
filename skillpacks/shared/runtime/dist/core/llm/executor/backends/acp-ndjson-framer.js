"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ACP_REJECTED_LINE_PREFIX_MAX_BYTES = exports.ACP_NDJSON_MAX_LINE_BYTES = void 0;
exports.createBoundedNdjsonFramer = createBoundedNdjsonFramer;
/**
 * Bounded NDJSON framing for the ACP stdio peer, with the semantics a
 * turn-based client needs: lines above `maxLineBytes` are rejected (not
 * buffered into memory), a bounded prefix of each rejected line is retained
 * for classification, and invalid JSON lines are surfaced instead of thrown
 * away. Modeled after the framing layer long-lived ACP orchestrators use,
 * minus their pause/resume queueing (this framer is consumed eagerly).
 */
exports.ACP_NDJSON_MAX_LINE_BYTES = 16 * 1024 * 1024;
exports.ACP_REJECTED_LINE_PREFIX_MAX_BYTES = 64 * 1024;
function createBoundedNdjsonFramer(onRecord, onRejected, options = {}) {
    const maxLineBytes = Math.max(1, options.maxLineBytes ?? exports.ACP_NDJSON_MAX_LINE_BYTES);
    let lineSegments = [];
    let lineBytes = 0;
    let prefixSegments = [];
    let prefixBytes = 0;
    let discardingOversizedLine = false;
    const clearLine = () => {
        lineSegments = [];
        lineBytes = 0;
        prefixSegments = [];
        prefixBytes = 0;
    };
    const rememberPrefix = (segment, segmentBytes) => {
        const remainingBytes = exports.ACP_REJECTED_LINE_PREFIX_MAX_BYTES - prefixBytes;
        if (remainingBytes <= 0 || segment.length === 0)
            return;
        const prefix = segmentBytes <= remainingBytes ? segment : boundedUtf8Prefix(segment, remainingBytes);
        prefixSegments.push(prefix);
        prefixBytes += prefix === segment ? segmentBytes : Buffer.byteLength(prefix, 'utf8');
    };
    const feed = (chunk) => {
        let cursor = 0;
        while (cursor < chunk.length) {
            const newlineIndex = chunk.indexOf('\n', cursor);
            const hasNewline = newlineIndex !== -1;
            const end = hasNewline ? newlineIndex : chunk.length;
            const segment = chunk.slice(cursor, end);
            cursor = hasNewline ? end + 1 : end;
            if (discardingOversizedLine) {
                if (hasNewline) {
                    discardingOversizedLine = false;
                    clearLine();
                }
                else {
                    return;
                }
            }
            else {
                const segmentBytes = Buffer.byteLength(segment, 'utf8');
                const nextLineBytes = lineBytes + segmentBytes;
                rememberPrefix(segment, segmentBytes);
                if (nextLineBytes > maxLineBytes) {
                    onRejected({
                        kind: 'line-too-long',
                        maxLineBytes,
                        observedBytes: nextLineBytes,
                        prefix: prefixSegments.join(''),
                    });
                    clearLine();
                    discardingOversizedLine = !hasNewline;
                }
                else if (!hasNewline) {
                    lineSegments.push(segment);
                    lineBytes = nextLineBytes;
                    return;
                }
                else {
                    lineSegments.push(segment);
                    const line = lineSegments.length === 1 ? lineSegments[0] : lineSegments.join('');
                    clearLine();
                    if (!/^\s*$/.test(line)) {
                        try {
                            onRecord(JSON.parse(line), line);
                        }
                        catch (error) {
                            onRejected({ kind: 'invalid-json', line, error: error instanceof Error ? error : new Error(String(error)) });
                        }
                    }
                }
            }
        }
    };
    return {
        feed,
        reset() {
            clearLine();
            discardingOversizedLine = false;
        },
    };
}
function boundedUtf8Prefix(value, maxBytes) {
    if (Buffer.byteLength(value, 'utf8') <= maxBytes)
        return value;
    let low = 0;
    let high = Math.min(value.length, maxBytes);
    while (low < high) {
        const midpoint = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(value.slice(0, midpoint), 'utf8') <= maxBytes) {
            low = midpoint;
        }
        else {
            high = midpoint - 1;
        }
    }
    return value.slice(0, low);
}
