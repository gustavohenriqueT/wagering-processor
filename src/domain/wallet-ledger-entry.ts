import { DomainError } from "./errors/domain-error";
import type { Money } from "./money/money";

export enum LedgerDirection {
	Debit = "DEBIT",
	Credit = "CREDIT",
}

export interface LedgerEntryState {
	id: string;
	walletId: string;
	transactionId: string;
	direction: LedgerDirection;
	money: Money;
	balanceBefore: Money;
	balanceAfter: Money;
	createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

export class WalletLedgerEntry {
	private constructor(
		public readonly id: string,
		public readonly walletId: string,
		public readonly transactionId: string,
		public readonly direction: LedgerDirection,
		public readonly money: Money,
		public readonly balanceBefore: Money,
		public readonly balanceAfter: Money,
		public readonly createdAt: Date,
	) {
		Object.freeze(this);
	}

	static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
		if (!props.money.isPositive()) {
			throw new DomainError(
				"LEDGER_AMOUNT_NOT_POSITIVE",
				"o valor de um lançamento deve ser maior que zero",
			);
		}
		if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
			throw new DomainError(
				"LEDGER_NEGATIVE_BALANCE",
				"o saldo antes e depois do lançamento não pode ser negativo",
			);
		}

		const entry = WalletLedgerEntry.build(props);
		if (!entry.isBalanced()) {
			throw new DomainError(
				"LEDGER_ENTRY_UNBALANCED",
				"balanceBefore ± money não é igual a balanceAfter",
			);
		}
		return entry;
	}

	static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
		return WalletLedgerEntry.build(state);
	}

	isBalanced(): boolean {
		const expected =
			this.direction === LedgerDirection.Debit
				? this.balanceBefore.subtract(this.money)
				: this.balanceBefore.add(this.money);
		return expected.equals(this.balanceAfter);
	}

	private static build(state: LedgerEntryState): WalletLedgerEntry {
		return new WalletLedgerEntry(
			state.id,
			state.walletId,
			state.transactionId,
			state.direction,
			state.money,
			state.balanceBefore,
			state.balanceAfter,
			state.createdAt,
		);
	}
}
