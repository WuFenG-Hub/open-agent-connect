"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestMvcGasSubsidy = requestMvcGasSubsidy;
require("../compat/nodeLocalStorage");
const deriveIdentity_1 = require("../identity/deriveIdentity");
const mvcMessageSigning_1 = require("./mvcMessageSigning");
const DEFAULT_ADDRESS_INIT_URL = 'https://www.metaso.network/assist-open-api/v1/assist/gas/mvc/address-init';
const DEFAULT_ADDRESS_REWARD_URL = 'https://www.metaso.network/assist-open-api/v1/assist/gas/mvc/address-reward';
const DEFAULT_REWARD_CHALLENGE_URL = 'https://www.metaso.network/assist-open-api/v2/assist/gas/mvc/reward-challenge';
const DEFAULT_SUBSIDY_WAIT_MS = 5_000;
const CREDENTIAL_MESSAGE = 'metaso.network';
function readServiceResponse(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : null;
}
function readServiceCode(value) {
    const response = readServiceResponse(value);
    const code = typeof response?.code === 'number'
        ? response.code
        : typeof response?.code === 'string' && response.code.trim()
            ? Number(response.code)
            : Number.NaN;
    return Number.isFinite(code) ? code : null;
}
function readServiceMessage(value) {
    const response = readServiceResponse(value);
    for (const key of ['message', 'msg', 'error']) {
        const message = response?.[key];
        if (typeof message === 'string' && message.trim()) {
            return message.trim();
        }
    }
    return '';
}
function isAcceptedServiceResult(value, acceptedDuplicate) {
    const code = readServiceCode(value);
    if (code === 0)
        return true;
    return code !== null && acceptedDuplicate.test(readServiceMessage(value));
}
function readProcessingTime(value) {
    const response = readServiceResponse(value);
    const time = response?.processingTime;
    return typeof time === 'number' && Number.isFinite(time) ? time : null;
}
function formatServiceFailure(stage, value, http, request) {
    const message = readServiceMessage(value);
    const code = readServiceCode(value);
    const processingTime = readProcessingTime(value);
    const headline = message
        ? `${stage} failed: ${message}`
        : code !== null
            ? `${stage} failed: service code ${code}`
            : `${stage} failed: invalid service response`;
    const extras = [];
    if (http) {
        const statusText = http.statusText.trim();
        extras.push(statusText ? `HTTP ${http.status} ${statusText}` : `HTTP ${http.status}`);
    }
    if (message && code !== null) {
        extras.push(`service code ${code}`);
    }
    if (processingTime !== null) {
        extras.push(`processingTime ${processingTime}ms`);
    }
    let text = extras.length ? `${headline} (${extras.join(', ')})` : headline;
    if (request?.url || request?.address) {
        const url = request.url ? ` ${request.url}` : '';
        const address = request.address ? ` address ${request.address}` : '';
        text += `. Request${url}${address} gasChain mvc. No mnemonic or signature is included.`;
    }
    if (processingTime !== null
        && processingTime >= 20_000
        && /invalid connection/i.test(message)) {
        text += ' The assist service held the request and returned data null, so this is an upstream connection failure, not a rejected local address.';
    }
    return text;
}
async function readSubsidyBody(response) {
    if (typeof response.text === 'function') {
        const text = await response.text();
        if (!text.trim()) {
            return { message: 'empty body' };
        }
        try {
            return JSON.parse(text);
        }
        catch {
            return { message: text.trim().slice(0, 300) };
        }
    }
    if (typeof response.json === 'function') {
        try {
            return await response.json();
        }
        catch (error) {
            return { message: error instanceof Error ? error.message : 'unreadable body' };
        }
    }
    return { message: 'unreadable body' };
}
function readChallengePayload(value) {
    const response = readServiceResponse(value);
    const data = response?.data;
    if (!data || typeof data !== 'object' || Array.isArray(data))
        return null;
    const record = data;
    const challengeId = typeof record.challengeId === 'string' ? record.challengeId.trim() : '';
    const message = typeof record.message === 'string' ? record.message.trim() : '';
    if (!challengeId || !message)
        return null;
    return { challengeId, message };
}
function isMissingRoute(status) {
    return status === 404 || status === 405;
}
async function postJson(fetchImpl, url, body, headers = {}) {
    const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            ...headers,
        },
        body,
    });
    return { response, body: await readSubsidyBody(response) };
}
async function claimMvcRewardWithChallenge(input) {
    let challenge;
    try {
        challenge = await postJson(input.fetchImpl, input.rewardChallengeUrl, JSON.stringify({ address: input.mvcAddress, gasChain: 'mvc' }));
    }
    catch {
        return null;
    }
    if (isMissingRoute(challenge.response.status))
        return null;
    const challengeHttp = {
        status: challenge.response.status,
        statusText: challenge.response.statusText,
    };
    if (!challenge.response.ok) {
        return {
            success: false,
            step1: challenge.body,
            error: formatServiceFailure('reward-challenge', challenge.body, challengeHttp),
        };
    }
    if (readServiceCode(challenge.body) !== 0
        && isAcceptedServiceResult(challenge.body, /^address already rewarded$/i)) {
        return { success: true, step1: challenge.body };
    }
    if (readServiceCode(challenge.body) !== 0) {
        return {
            success: false,
            step1: challenge.body,
            error: formatServiceFailure('reward-challenge', challenge.body, challengeHttp),
        };
    }
    const payload = readChallengePayload(challenge.body);
    if (!payload) {
        return {
            success: false,
            step1: challenge.body,
            error: formatServiceFailure('reward-challenge', challenge.body, challengeHttp),
        };
    }
    const credential = await (0, mvcMessageSigning_1.signMvcAddressMessage)({
        mnemonic: input.mnemonic,
        path: input.derivationPath,
        message: CREDENTIAL_MESSAGE,
    });
    const challengeSignature = await (0, mvcMessageSigning_1.signMvcAddressMessage)({
        mnemonic: input.mnemonic,
        path: input.derivationPath,
        message: payload.message,
    });
    const reward = await postJson(input.fetchImpl, input.addressRewardUrl, JSON.stringify({
        address: input.mvcAddress,
        gasChain: 'mvc',
        challengeId: payload.challengeId,
        publicKey: challengeSignature.publicKey,
        signature: challengeSignature.signature,
    }), {
        'X-Signature': credential.signature,
        'X-Public-Key': credential.publicKey,
    });
    const rewardHttp = { status: reward.response.status, statusText: reward.response.statusText };
    if (!reward.response.ok || !isAcceptedServiceResult(reward.body, /^address already rewarded$/i)) {
        return {
            success: false,
            step1: challenge.body,
            step2: reward.body,
            error: formatServiceFailure('address-reward', reward.body, rewardHttp),
        };
    }
    if (readServiceCode(reward.body) === 0 && input.waitMs > 0) {
        await input.wait(input.waitMs);
    }
    return {
        success: true,
        step1: challenge.body,
        step2: reward.body,
    };
}
async function requestMvcGasSubsidy(options, dependencies = {}) {
    const mvcAddress = typeof options.mvcAddress === 'string' ? options.mvcAddress.trim() : '';
    const mnemonic = typeof options.mnemonic === 'string' ? options.mnemonic.trim() : '';
    const derivationPath = typeof options.path === 'string' && options.path.trim()
        ? options.path.trim()
        : deriveIdentity_1.DEFAULT_DERIVATION_PATH;
    if (!mvcAddress) {
        return {
            success: false,
            error: 'mvcAddress is required',
        };
    }
    const fetchImpl = dependencies.fetchImpl ?? fetch;
    const wait = dependencies.wait ?? (async (ms) => {
        await new Promise((resolve) => setTimeout(resolve, ms));
    });
    const addressInitUrl = dependencies.addressInitUrl ?? DEFAULT_ADDRESS_INIT_URL;
    const addressRewardUrl = dependencies.addressRewardUrl ?? DEFAULT_ADDRESS_REWARD_URL;
    const rewardChallengeUrl = dependencies.rewardChallengeUrl ?? DEFAULT_REWARD_CHALLENGE_URL;
    const waitMs = dependencies.waitMs ?? DEFAULT_SUBSIDY_WAIT_MS;
    const requestBody = JSON.stringify({
        address: mvcAddress,
        gasChain: 'mvc',
    });
    try {
        if (mnemonic) {
            const challenged = await claimMvcRewardWithChallenge({
                fetchImpl,
                rewardChallengeUrl,
                addressRewardUrl,
                mvcAddress,
                mnemonic,
                derivationPath,
                wait,
                waitMs,
            });
            if (challenged)
                return challenged;
        }
        const initRequest = { url: addressInitUrl, address: mvcAddress };
        const step1Response = await fetchImpl(addressInitUrl, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: requestBody,
        });
        const step1 = await readSubsidyBody(step1Response);
        const initAccepted = step1Response.ok && isAcceptedServiceResult(step1, /^address already init(?:ialized)?$/i);
        if (!initAccepted) {
            return {
                success: false,
                step1,
                error: formatServiceFailure('address-init', step1, {
                    status: step1Response.status,
                    statusText: step1Response.statusText,
                }, initRequest),
            };
        }
        if (!mnemonic) {
            return { success: true, step1 };
        }
        await wait(waitMs);
        const { signature, publicKey } = await (0, mvcMessageSigning_1.signMvcAddressMessage)({
            mnemonic,
            path: derivationPath,
            message: CREDENTIAL_MESSAGE,
        });
        const step2Response = await fetchImpl(addressRewardUrl, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'X-Signature': signature,
                'X-Public-Key': publicKey,
            },
            body: requestBody,
        });
        const step2 = await readSubsidyBody(step2Response);
        const step2Http = { status: step2Response.status, statusText: step2Response.statusText };
        if (!step2Response.ok || !isAcceptedServiceResult(step2, /^address already rewarded$/i)) {
            return {
                success: false,
                step1,
                step2,
                error: formatServiceFailure('address-reward', step2, step2Http),
            };
        }
        return { success: true, step1, step2 };
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
