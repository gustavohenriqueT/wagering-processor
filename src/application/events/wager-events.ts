import type { FailureCode } from "../../domain/failure-code";
import type { MoneyProps } from "../../domain/money";
import type { WagerTransactionKind } from "../../domain/wager-transaction";
import type { LedgerDirection } from "../../domain/wallet-ledger-entry";
import {
	IntegrationEvent,
	type IntegrationEventProps,
} from "./integration-event";

interface WagerTransactionRefs {
	transactionId: string;
	walletId: string;
	providerId: string;
	externalTransactionId: string;
	kind: WagerTransactionKind;
	money: MoneyProps;
}

export interface WagerTransactionProcessedData extends WagerTransactionRefs {
	/** Saldo da wallet após a transação (igual ao anterior quando não há efeito, como em LOSS). */
	balance: MoneyProps;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
	readonly eventType = "WagerTransactionProcessed";
	readonly version = 1;

	constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
		super(props);
	}
}

export interface WagerTransactionRejectedData extends WagerTransactionRefs {
	failureCode: FailureCode;
	balance: MoneyProps;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
	readonly eventType = "WagerTransactionRejected";
	readonly version = 1;

	constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
		super(props);
	}
}

export interface WagerTransactionPendingReferenceData
	extends WagerTransactionRefs {
	referenceExternalTransactionId: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
	readonly eventType = "WagerTransactionPendingReference";
	readonly version = 1;

	constructor(
		props: IntegrationEventProps<WagerTransactionPendingReferenceData>,
	) {
		super(props);
	}
}

export interface WalletBalanceChangedData {
	walletId: string;
	transactionId: string;
	direction: LedgerDirection;
	money: MoneyProps;
	balanceBefore: MoneyProps;
	balanceAfter: MoneyProps;
	walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
	readonly eventType = "WalletBalanceChanged";
	readonly version = 1;

	constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
		super(props);
	}
}
