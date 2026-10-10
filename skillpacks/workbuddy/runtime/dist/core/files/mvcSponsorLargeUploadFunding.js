"use strict";
/**
 * Sponsored (traffic-mode / quota, 代付) MVC large-upload merge funding.
 * Mirrors mvcSponsorDirectUpload.ts semantics onto the MetaFS chunked path:
 * the merge-transaction draft anchors on a single wallet UTXO whose full value
 * returns as change, while the sponsor funds the chunk/index pre-funding
 * outputs, so the on-chain cost lands on the traffic account (or the legacy
 * quota) instead of the bot wallet — same billing model as a sponsored direct
 * upload, where the sponsor's contribution is proportional to the upload.
 *
 * Fallback contract: every failure BEFORE commitSponsor throws a
 * MvcSponsorLargeUploadFallbackError (reason/stage recorded) so the caller can
 * fall back to the wallet-funded path. After commit the merge transaction is
 * on-chain and the anchor UTXO is spent, so later failures throw coded errors
 * without any fallback (a wallet retry could double-spend the anchor). This
 * deliberately widens the direct-upload fallback set (which hard-fails on
 * pre_rejected) because merge-shaped drafts are a newer sponsor payload; in
 * the worst case the uploader keeps today's wallet behavior.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isMvcSponsorLargeUploadFallbackError = isMvcSponsorLargeUploadFallbackError;
exports.sponsorMvcLargeUploadFunding = sponsorMvcLargeUploadFunding;
const meta_contract_1 = require("meta-contract");
const mvcSigningIdentity_1 = require("../chain/mvcSigningIdentity");
const mvcLargeUploadFunding_1 = require("../chain/mvcLargeUploadFunding");
const mvcFileInscriptionDraft_1 = require("../chain/mvcFileInscriptionDraft");
const mvcMessageSigning_1 = require("../subsidy/mvcMessageSigning");
const feeAssist_1 = require("../subsidy/feeAssist");
const NET = 'livenet';
function isMvcSponsorLargeUploadFallbackError(error) {
    return error instanceof Error
        && typeof error.sponsorFallback === 'object'
        && error.sponsorFallback !== null;
}
function sponsorFallbackError(input) {
    const error = new Error(input.message);
    error.sponsorFallback = {
        reason: input.reason,
        stage: input.stage,
        quotaBefore: input.quotaBefore,
        advisoryFeeEstimate: input.advisoryFeeEstimate,
    };
    return error;
}
function codedError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}
function normalizeText(value) {
    return typeof value === 'string' ? value.trim() : '';
}
function readPositiveNumber(name, value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        throw new Error(`${name} must be a positive number.`);
    }
    return numeric;
}
function readPositiveInteger(name, value) {
    const numeric = readPositiveNumber(name, value);
    if (!Number.isInteger(numeric)) {
        throw new Error(`${name} must be a positive integer.`);
    }
    return numeric;
}
function pickAnchorUtxo(utxos, address) {
    const usable = utxos.filter((utxo) => (normalizeText(utxo.address) === address
        && Number.isInteger(utxo.outputIndex)
        && utxo.outputIndex >= 0
        && Number.isInteger(utxo.satoshis)
        && utxo.satoshis >= 600));
    // The anchor's full value returns as change, so any usable UTXO works;
    // prefer confirmed, then the largest, to anchor on the most reliable input.
    usable.sort((a, b) => (Number(b.height > 0) - Number(a.height > 0)) || (b.satoshis - a.satoshis));
    return usable[0] ?? null;
}
function locateFundingOutputs(input) {
    const tx = new meta_contract_1.mvc.Transaction(input.txHex);
    let chunkOutputIndex = -1;
    let indexOutputIndex = -1;
    tx.outputs.forEach((output, outputIndex) => {
        let outputAddress = '';
        try {
            const resolved = output.script?.toAddress?.(NET);
            outputAddress = normalizeText(resolved == null ? '' : String(resolved));
        }
        catch {
            outputAddress = '';
        }
        if (outputAddress !== input.address)
            return;
        const satoshis = Number(output.satoshis ?? 0);
        // Ordered matching: the draft appends the chunk output before the index
        // output, so the first amount match is the chunk funding output.
        if (chunkOutputIndex < 0 && satoshis === input.chunkPreTxOutputAmount) {
            chunkOutputIndex = outputIndex;
        }
        else if (indexOutputIndex < 0 && satoshis === input.indexPreTxOutputAmount) {
            indexOutputIndex = outputIndex;
        }
    });
    if (chunkOutputIndex < 0 || indexOutputIndex < 0) {
        throw codedError('large_file_upload_funding_failed', 'Sponsored merge transaction did not preserve the chunk/index funding outputs.');
    }
    return { chunkOutputIndex, indexOutputIndex };
}
async function sponsorMvcLargeUploadFunding(input) {
    const feeRate = readPositiveNumber('feeRate', input.feeRate);
    const chunkPreTxFee = readPositiveInteger('chunkPreTxFee', input.chunkPreTxFee);
    const indexPreTxFee = readPositiveInteger('indexPreTxFee', input.indexPreTxFee);
    const signingIdentity = (0, mvcSigningIdentity_1.buildMvcSigningIdentity)({
        mnemonic: input.identity.mnemonic,
        path: input.identity.path,
    });
    const address = normalizeText(signingIdentity.address);
    if (!address || (normalizeText(input.address) && normalizeText(input.address) !== address)) {
        throw new Error('MVC funding address does not match derived MVC address.');
    }
    // Keep output sizing identical to buildMvcLargeUploadFunding so sponsored
    // and wallet-funded chunked uploads cost the same on chain.
    const chunkPreTxOutputAmount = chunkPreTxFee + Math.ceil((200 + 150) * feeRate);
    const indexPreTxOutputAmount = indexPreTxFee + Math.ceil((200 + 150) * feeRate);
    const advisoryFeeEstimate = chunkPreTxOutputAmount + indexPreTxOutputAmount;
    const anchor = pickAnchorUtxo(input.utxos, address);
    if (!anchor) {
        throw sponsorFallbackError({
            message: 'No spendable MVC UTXO is available to anchor the sponsored large upload.',
            reason: 'no_user_utxo',
            stage: 'address_info',
            advisoryFeeEstimate,
        });
    }
    let quotaBefore;
    try {
        quotaBefore = await input.sponsorClient.getAddressInfo({ address });
    }
    catch (error) {
        throw sponsorFallbackError({
            message: error instanceof Error ? error.message : 'Sponsor address info failed.',
            reason: 'service_unavailable',
            stage: 'address_info',
            advisoryFeeEstimate,
        });
    }
    if (quotaBefore.availableAmount < advisoryFeeEstimate) {
        throw sponsorFallbackError({
            message: 'Sponsor quota is insufficient for the large upload funding outputs.',
            reason: 'insufficient_quota',
            stage: 'address_info',
            quotaBefore,
            advisoryFeeEstimate,
        });
    }
    let challenge;
    try {
        challenge = await input.sponsorClient.getChallenge();
    }
    catch (error) {
        throw sponsorFallbackError({
            message: error instanceof Error ? error.message : 'Sponsor challenge failed.',
            reason: (0, feeAssist_1.normalizeSponsorReason)(error.reason, 'service_unavailable'),
            stage: 'challenge',
            quotaBefore,
            advisoryFeeEstimate,
        });
    }
    const challengeSignature = await (0, mvcMessageSigning_1.signMvcAddressMessage)({
        mnemonic: input.identity.mnemonic,
        path: input.identity.path,
        message: challenge.message,
    });
    // Traffic-account billing (流量): attached by the daemon wiring only in
    // traffic mode; undefined keeps the legacy quota flow.
    const trafficAccount = await input.sponsorClient.traffic?.resolveTrafficAccount({
        botAddress: address,
        challengeId: challenge.challengeId,
        botMnemonic: input.identity.mnemonic,
        botWalletPath: input.identity.path,
    });
    // Merge draft: anchor input in, both funding outputs plus the anchor's full
    // value back as change out. The user's net contribution is zero and the
    // sponsor funds the gap (funding outputs + merge miner fee), exactly like a
    // sponsored direct upload where the sponsor covers the data-driven fee.
    const addressObject = new meta_contract_1.mvc.Address(address, meta_contract_1.mvc.Networks.livenet);
    const mergeComposer = new meta_contract_1.TxComposer();
    mergeComposer.appendP2PKHOutput({ address: addressObject, satoshis: chunkPreTxOutputAmount });
    mergeComposer.appendP2PKHOutput({ address: addressObject, satoshis: indexPreTxOutputAmount });
    mergeComposer.appendP2PKHOutput({ address: addressObject, satoshis: anchor.satoshis });
    mergeComposer.appendP2PKHInput({
        address: addressObject,
        txId: anchor.txId,
        outputIndex: anchor.outputIndex,
        satoshis: anchor.satoshis,
    });
    const unsignedMergeTxHex = mergeComposer.getRawHex();
    let pre;
    try {
        pre = await input.sponsorClient.preSponsor({
            address,
            txHex: unsignedMergeTxHex,
            challengeId: challenge.challengeId,
            publicKey: challengeSignature.publicKey,
            signature: challengeSignature.signature,
            ...(trafficAccount ? { trafficAccount } : {}),
        });
    }
    catch (error) {
        throw sponsorFallbackError({
            message: error instanceof Error ? error.message : 'Sponsor pre failed.',
            reason: (0, feeAssist_1.normalizeSponsorReason)(error.reason, 'pre_rejected'),
            stage: 'pre',
            quotaBefore,
            advisoryFeeEstimate,
        });
    }
    let signedMergeTxHex;
    try {
        signedMergeTxHex = (await (0, mvcFileInscriptionDraft_1.signMvcPreparedUserInputs)({
            identity: input.identity,
            preparedTxHex: pre.preparedTxHex,
            userInputs: [anchor],
            userInputIndexes: pre.userInputIndexes,
        })).txHex;
    }
    catch (error) {
        throw sponsorFallbackError({
            message: error instanceof Error ? error.message : 'Signing the sponsored merge transaction failed.',
            reason: 'pre_rejected',
            stage: 'commit',
            quotaBefore,
            advisoryFeeEstimate,
        });
    }
    const signedMergeTxHash = new meta_contract_1.mvc.Transaction(signedMergeTxHex).id;
    const commitMessage = `assist-sponsor-commit:${pre.orderId}:${signedMergeTxHash}`;
    const commitSignature = await (0, mvcMessageSigning_1.signMvcAddressMessage)({
        mnemonic: input.identity.mnemonic,
        path: input.identity.path,
        message: commitMessage,
    });
    let commit;
    try {
        commit = await input.sponsorClient.commitSponsor({
            orderId: pre.orderId,
            signedTxHex: signedMergeTxHex,
            publicKey: commitSignature.publicKey,
            signature: commitSignature.signature,
            message: commitMessage,
        });
    }
    catch (error) {
        throw sponsorFallbackError({
            message: error instanceof Error ? error.message : 'Sponsor commit failed.',
            reason: (0, feeAssist_1.normalizeSponsorReason)(error.reason, 'commit_failed'),
            stage: 'commit',
            quotaBefore,
            advisoryFeeEstimate,
        });
    }
    const mergeTxId = normalizeText(commit.txId);
    if (!mergeTxId) {
        throw codedError('large_file_upload_funding_failed', 'Sponsor commit did not return a merge txId.');
    }
    // Terminal from here on: the merge transaction is broadcast and the anchor
    // UTXO is spent, so the caller must not fall back to the wallet path.
    const { chunkOutputIndex, indexOutputIndex } = locateFundingOutputs({
        txHex: signedMergeTxHex,
        address,
        chunkPreTxOutputAmount,
        indexPreTxOutputAmount,
    });
    const privateKey = signingIdentity.privateKey;
    const chunkPreTxHex = (0, mvcLargeUploadFunding_1.buildMvcLargeUploadPreTx)({
        mergeTxId,
        outputIndex: chunkOutputIndex,
        satoshis: chunkPreTxOutputAmount,
        address,
        privateKey,
    });
    const indexPreTxHex = (0, mvcLargeUploadFunding_1.buildMvcLargeUploadPreTx)({
        mergeTxId,
        outputIndex: indexOutputIndex,
        satoshis: indexPreTxOutputAmount,
        address,
        privateKey,
    });
    const sponsoredMinerFee = commit.minerFee ?? pre.minerFee;
    const billedBy = trafficAccount ? 'traffic' : 'quota';
    // Local spend journal + traffic balance-cache deduction (best-effort).
    await input.sponsorClient.traffic?.recordSpend({
        txId: mergeTxId,
        botAddress: address,
        orderId: pre.orderId,
        txSize: commit.txSize ?? 0,
        sponsoredMinerFee,
        savedFee: sponsoredMinerFee,
        billedBy,
        kind: '/file',
    }).catch(() => undefined);
    let quotaAfter;
    try {
        quotaAfter = await input.sponsorClient.getAddressInfo({ address });
    }
    catch {
        quotaAfter = undefined;
    }
    return {
        mergeTxHex: signedMergeTxHex,
        mergeTxId,
        chunkPreTxHex,
        indexPreTxHex,
        chunkPreTxOutputAmount,
        indexPreTxOutputAmount,
        spentUtxos: [anchor],
        createdUtxos: (0, mvcFileInscriptionDraft_1.extractOwnedOutputsFromPreparedMvcTx)({
            txHex: signedMergeTxHex,
            txId: mergeTxId,
            address,
        }),
        sponsoredMinerFee,
        orderId: pre.orderId,
        quotaBefore,
        quotaAfter,
        billedBy,
        feeAssist: {
            attempted: true,
            used: true,
            mode: 'mvc_sponsor_v2',
            sponsor: 'mvc_sponsor_v2',
            stage: 'done',
            orderId: pre.orderId,
            quotaBefore,
            quotaAfter,
            advisoryFeeEstimate,
            sponsoredMinerFee,
            savedFee: sponsoredMinerFee,
            billedBy,
            txSize: commit.txSize,
        },
    };
}
