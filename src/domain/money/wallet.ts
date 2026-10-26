import { DomainError } from "../errors/domain-error";
import type { Money } from "./money";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry";

export interface WalletState {
	id: string;
	playerId: string;
	currency: string;
	balance: Money;
	version: number;
	createdAt: Date;
	updatedAt: Date;
}

export interface OpenWalletProps {
	id: string;
	playerId: string;
	initialBalance: Money;
	now: Date;
}

export interface WalletMovement {
	money: Money;
	entryId: string;
	transactionId: string;
	at: Date;
}

export class Wallet {
	private constructor(
		public readonly id: string,
		public readonly playerId: string,
		public readonly currency: string,
		private _balance: Money,
		private _version: number,
		public readonly createdAt: Date,
		private _updatedAt: Date,
	) {}

	static open(props: OpenWalletProps): Wallet {
		if (props.initialBalance.isNegative()) {
			throw new DomainError(
				"INVALID_INITIAL_BALANCE",
				"o saldo inicial não pode ser negativo",
			);
		}
		return new Wallet(
			props.id,
			props.playerId,
			props.initialBalance.currency,
			props.initialBalance,
			1,
			props.now,
			props.now,
		);
	}

	static rehydrate(state: WalletState): Wallet {
		return new Wallet(
			state.id,
			state.playerId,
			state.currency,
			state.balance,
			state.version,
			state.createdAt,
			state.updatedAt,
		);
	}

	get balance(): Money {
		return this._balance;
	}

	get version(): number {
		return this._version;
	}

	get updatedAt(): Date {
		return this._updatedAt;
	}

	debit(movement: WalletMovement): WalletLedgerEntry {
		return this.apply(LedgerDirection.Debit, movement);
	}

	credit(movement: WalletMovement): WalletLedgerEntry {
		return this.apply(LedgerDirection.Credit, movement);
	}

	private apply(
		direction: LedgerDirection,
		movement: WalletMovement,
	): WalletLedgerEntry {
		this.assertSameCurrency(movement.money);
		if (!movement.money.isPositive()) {
			throw new DomainError(
				"INVALID_MOVEMENT_AMOUNT",
				"o valor da movimentação deve ser maior que zero",
			);
		}

		const before = this._balance;
		const after =
			direction === LedgerDirection.Debit
				? before.subtract(movement.money)
				: before.add(movement.money);

		if (after.isNegative()) {
			throw new DomainError(
				"INSUFFICIENT_FUNDS",
				`saldo ${before.toString()} insuficiente para debitar ${movement.money.toString()}`,
			);
		}

		const entry = WalletLedgerEntry.create({
			id: movement.entryId,
			walletId: this.id,
			transactionId: movement.transactionId,
			direction,
			money: movement.money,
			balanceBefore: before,
			balanceAfter: after,
			createdAt: movement.at,
		});

		this._balance = after;
		this._version += 1;
		this._updatedAt = movement.at;
		return entry;
	}

	private assertSameCurrency(money: Money): void {
		if (money.currency !== this.currency) {
			throw new DomainError(
				"CURRENCY_MISMATCH",
				`a wallet é ${this.currency}, mas a operação é ${money.currency}`,
			);
		}
	}
}
