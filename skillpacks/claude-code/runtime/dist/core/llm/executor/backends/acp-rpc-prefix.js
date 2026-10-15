"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.classifyAcpRecordPrefix = classifyAcpRecordPrefix;
function readJsonStringEnd(value, start) {
    if (value[start] !== '"')
        return null;
    let escaped = false;
    for (let index = start + 1; index < value.length; index += 1) {
        const character = value[index];
        if (escaped) {
            escaped = false;
        }
        else if (character === '\\') {
            escaped = true;
        }
        else if (character === '"') {
            return index + 1;
        }
    }
    return null;
}
function skipJsonContainer(value, start) {
    const opening = value[start];
    const closing = opening === '{' ? '}' : opening === '[' ? ']' : null;
    if (!closing)
        return null;
    const stack = [closing];
    let escaped = false;
    let inString = false;
    for (let index = start + 1; index < value.length; index += 1) {
        const character = value[index];
        if (inString) {
            if (escaped) {
                escaped = false;
            }
            else if (character === '\\') {
                escaped = true;
            }
            else if (character === '"') {
                inString = false;
            }
            continue;
        }
        if (character === '"') {
            inString = true;
        }
        else if (character === '{') {
            stack.push('}');
        }
        else if (character === '[') {
            stack.push(']');
        }
        else if (character === stack.at(-1)) {
            stack.pop();
            if (stack.length === 0)
                return index + 1;
        }
    }
    return null;
}
/**
 * Reads the leading top-level object properties of a JSON prefix. Only
 * complete properties are inspected: scanning arbitrary quoted keys would let
 * a nested `result`/`params` object impersonate top-level JSON-RPC fields.
 */
function leadingJsonRpcProperties(prefix) {
    const properties = [];
    let cursor = 0;
    const skipWhitespace = () => {
        while (/\s/.test(prefix[cursor] ?? ''))
            cursor += 1;
    };
    skipWhitespace();
    if (prefix[cursor] !== '{')
        return properties;
    cursor += 1;
    while (properties.length < 8) {
        skipWhitespace();
        const keyEnd = readJsonStringEnd(prefix, cursor);
        if (keyEnd === null)
            break;
        let key;
        try {
            key = JSON.parse(prefix.slice(cursor, keyEnd));
        }
        catch {
            break;
        }
        cursor = keyEnd;
        skipWhitespace();
        if (prefix[cursor] !== ':')
            break;
        cursor += 1;
        skipWhitespace();
        if (prefix[cursor] === '{' || prefix[cursor] === '[') {
            properties.push({ key: String(key) });
            const valueEnd = skipJsonContainer(prefix, cursor);
            if (valueEnd === null)
                break;
            cursor = valueEnd;
        }
        else if (prefix[cursor] === '"') {
            const stringEnd = readJsonStringEnd(prefix, cursor);
            if (stringEnd === null)
                break;
            try {
                properties.push({ key: String(key), value: JSON.parse(prefix.slice(cursor, stringEnd)) });
            }
            catch {
                break;
            }
            cursor = stringEnd;
        }
        else {
            const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*))/.exec(prefix.slice(cursor));
            if (!literal)
                break;
            const value = literal[0];
            properties.push({ key: String(key), value: value === 'true' || value === 'false' ? undefined : value === 'null' ? undefined : Number(value) });
            cursor += value.length;
        }
        skipWhitespace();
        if (prefix[cursor] !== ',')
            break;
        cursor += 1;
    }
    return properties;
}
function classifyAcpRecordPrefix(prefix) {
    const properties = leadingJsonRpcProperties(prefix);
    const method = properties.find((property) => property.key === 'method')?.value;
    const id = properties.find((property) => property.key === 'id')?.value;
    if (typeof method === 'string' && (typeof id === 'number' || typeof id === 'string')) {
        return { kind: 'agent-request', id, method };
    }
    if (typeof id === 'number'
        && properties.some((property) => property.key === 'result' || property.key === 'error')) {
        return { kind: 'response', id };
    }
    if (typeof id === 'number') {
        return { kind: 'response-unknown' };
    }
    if (typeof method === 'string') {
        return { kind: 'notification', method };
    }
    return { kind: 'unknown' };
}
