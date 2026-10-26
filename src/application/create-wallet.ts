import { Money } from "../domain/money";
import {
	WagerTransaction,
	WagerTransactionKind,
} from "../domain/wager-transaction";
import { Wallet } from "../domain/wallet";
import {
	LedgerDirection,
	WalletLedgerEntry,
} from "../domain/wallet-ledger-entry";
import { uniqueViolation } from "./db-errors";
import { WalletAlreadyExistsError } from "./errors";
import { WalletBalanceChanged } from "./events/wager-events";
import type { UnitOfWork } from "./ports";

export interface CreateWalletCommand {
	playerId: string;
	initialBalance: Money;
	correlationId: string;
}

const OPENING_PROVIDER = "internal";

export class CreateWallet {
	constructor(
		private readonly uow: UnitOfWork,
		private readonly clock: () => Date = () => new Date(),
		private readonly newId: () => string = () => crypto.randomUUID(),
	) {}

	async execute(command: CreateWalletCommand): Promise<Wallet> {
		const currency = command.initialBalance.currency;
		try {
			return await this.uow.run(
				async ({ wallets, transactions, ledger, outbox }) => {
					const now = this.clock();
					const wallet = Wallet.open({
						id: this.newId(),
						playerId: command.playerId,
						initialBalance: command.initialBalance,
						now,
					});
					await wallets.insert(wallet);

					if (command.initialBalance.isPositive()) {
						// Saldo inicial vira uma transação interna OPENING + lançamento CREDIT, na MESMA transação SQL.
						const opening = WagerTransaction.create({
							id: this.newId(),
							providerId: OPENING_PROVIDER,
							externalTransactionId: `opening:${wallet.id}`,
							idempotencyKey: `${OPENING_PROVIDER}:opening:${wallet.id}`,
							payloadHash: "opening",
							walletId: wallet.id,
							playerId: wallet.playerId,
							roundId: "opening",
							gameId: "opening",
							kind: WagerTransactionKind.Opening,
							money: command.initialBalance,
							createdAt: now,
						});
						opening.markProcessed(undefined, now);
						await transactions.insert(opening, wallet.balance);

						await ledger.insert(
							WalletLedgerEntry.create({
								id: this.newId(),
								walletId: wallet.id,
								transactionId: opening.id,
								direction: LedgerDirection.Credit,
								money: command.initialBalance,
								balanceBefore: Money.zero(currency),
								balanceAfter: wallet.balance,
								createdAt: now,
							}),
						);

						await outbox.add(
							new WalletBalanceChanged({
								eventId: this.newId(),
								aggregateId: wallet.id,
								correlationId: command.correlationId,
								occurredAt: now,
								data: {
									walletId: wallet.id,
									transactionId: opening.id,
									direction: LedgerDirection.Credit,
									money: command.initialBalance.toJSON(),
									balanceBefore: Money.zero(currency).toJSON(),
									balanceAfter: wallet.balance.toJSON(),
									walletVersion: wallet.version,
								},
							}),
						);
					}
					return wallet;
				},
			);
		} catch (error) {
			if (uniqueViolation(error)?.constraint === "uq_wallets_player_currency") {
				throw new WalletAlreadyExistsError(command.playerId, currency);
			}
			throw error;
		}
	}
}
