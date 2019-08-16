import {Query} from "./generated/Query_pb";
import {decodePrivateKey} from "./Keys";

import {grpc} from "@improbable-eng/grpc-web";

import {CryptoService} from "./generated/CryptoService_pb_service";
import {CryptoGetAccountBalanceQuery} from "./generated/CryptoGetAccountBalance_pb";
import {QueryHeader} from "./generated/QueryHeader_pb";

import {getMyAccountId, getProtoAccountId, handleQueryPrecheck, reqDefined} from "./util";
import {ProtobufMessage} from "@improbable-eng/grpc-web/dist/typings/message";
import AccountCreateTransaction from "./account/AccountCreateTransaction";
import CryptoTransferTransaction from "./account/CryptoTransferTransaction";

import * as nacl from 'tweetnacl';
import UnaryMethodDefinition = grpc.UnaryMethodDefinition;
import Code = grpc.Code;

export type AccountId = { shard: number, realm: number, account: number };

export type TransactionId = {
    account: AccountId,
    validStartSeconds: number,
    validStartNanos: number,
};

export type Signer = (msg: Uint8Array) => Uint8Array | Promise<Uint8Array>;

export type PrivateKey = { privateKey: string };
export type PubKeyAndSigner = {
    publicKey: Uint8Array,
    signer: Signer,
};

export type SigningOpts = PrivateKey | PubKeyAndSigner;

export type Operator = { account: AccountId } & SigningOpts;

export const nodeAccountID = { shard: 0, realm: 0, account: 3 };
const maxTxnFee = 10_000_000; // new testnet charges about 8M

export class Client {
    public readonly operator: Operator;
    private operatorAcct: AccountId;
    public readonly operatorSigner: Signer;
    public readonly operatorPublicKey: Uint8Array;

    // TODO: figure out how to switch this with the real proxy
    private readonly host: string = "http://localhost:11205";

    constructor(operator: Operator) {
        this.operator = operator;
        this.operatorAcct = operator.account;

        if ((operator as PrivateKey).privateKey) {
            const { privateKey, publicKey } = decodePrivateKey((operator as PrivateKey).privateKey);
            this.operatorSigner = (msg) => nacl.sign(msg, privateKey);
            this.operatorPublicKey = publicKey;
        } else {
            ({ publicKey: this.operatorPublicKey, signer: this.operatorSigner } =
                (operator as PubKeyAndSigner));
        }
    }

    createAccount(publicKey: Uint8Array, initialBalance = 100_000): Promise<{ account: AccountId }> {
        return new AccountCreateTransaction(this)
            .setKey(publicKey)
            .setInitialBalance(initialBalance)
            .build()
            .executeForReceipt()
            .then((receipt) => ({
                account: getMyAccountId(
                    reqDefined(receipt.getAccountid(),
                        'missing account ID from receipt: ' + receipt)),
            }));
    }

    /**
     * Transfer the given amount from the operator account to the given recipient.
     *
     * Note that `number` can only represent exact integers in the range`[-2^53, 2^53)`.
     * To represent exact values higher than this you should use the ESNext type `BigInt` instead.
     *
     * @param recipient
     * @param amount
     */
    transferCryptoTo(recipient: AccountId, amount: number | BigInt): Promise<TransactionId> {
        const txn = new CryptoTransferTransaction(this)
            .addSender(this.operatorAcct, amount)
            .addRecipient(recipient, amount)
            .setTransactionFee(1_000_000)
            .build();

        return txn.executeForReceipt().then(() => txn.getTransactionId());
    }

    getAccountBalance(): Promise<BigInt> {
        const balanceQuery = new CryptoGetAccountBalanceQuery();
        balanceQuery.setAccountid(getProtoAccountId(this.operatorAcct));

        const paymentTxn = new CryptoTransferTransaction(this)
            .addSender(this.operatorAcct, 0)
            .addRecipient(nodeAccountID, 0)
            .setTransactionFee(9)
            .build();

        const queryHeader = new QueryHeader();
        queryHeader.setPayment(paymentTxn.toProto());
        balanceQuery.setHeader(queryHeader);

        const query = new Query();
        query.setCryptogetaccountbalance(balanceQuery);

        return this.unaryCall(query, CryptoService.cryptoGetBalance)
            .then(handleQueryPrecheck((resp) => resp.getCryptogetaccountbalance()))
            .then((response) => BigInt(response.getBalance()));
    }

    public unaryCall<Rq extends ProtobufMessage, Rs extends ProtobufMessage>(request: Rq, method: UnaryMethodDefinition<Rq, Rs>): Promise<Rs> {
        return new Promise((resolve, reject) => grpc.unary(method, {
            host: this.host,
            request,
            onEnd: (response) => {
                if (response.status === Code.OK) {
                    // @ts-ignore TS thinks `response.message` is a generic `ProtobufMessage`
                    resolve(response.message);
                } else {
                    reject(new Error(response.statusMessage));
                }
            }
        }));
    }
}
