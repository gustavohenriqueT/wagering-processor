import {
	Body,
	Controller,
	Get,
	Headers,
	Inject,
	Param,
	Post,
	Res,
} from "@nestjs/common";
import { ProcessWagerTransaction } from "../application/process-wager-transaction";
import type { QueryPort, TransactionView } from "../application/queries";
import { WagerTransactionStatus } from "../domain/wager-transaction";
import { NotFoundError } from "./errors";
import type { HttpResponse } from "./http";
import { Metrics } from "./metrics";
import { parseSubmitTransaction, parseUuid } from "./parsers";
import { QUERIES } from "./tokens";

/** PROCESSED -> 200, aceito mas pendente -> 202, rejeição de negócio -> 422. */
const STATUS_BY_RESULT: Record<WagerTransactionStatus, number> = {
	[WagerTransactionStatus.Processed]: 200,
	[WagerTransactionStatus.PendingReference]: 202,
	[WagerTransactionStatus.Pending]: 202,
	[WagerTransactionStatus.Rejected]: 422,
	[WagerTransactionStatus.Failed]: 422,
};

@Controller()
export class TransactionsController {
	constructor(
    @Inject(ProcessWagerTransaction) private readonly processTransaction: ProcessWagerTransaction,
    @Inject(QUERIES) private readonly queries: QueryPort,
    @Inject(Metrics) private readonly metrics: Metrics,
  ) {}

	@Post("wagering/transactions")
	async submit(
		@Body() body: unknown,
		@Headers('idempotency-key') idempotencyKey: string | undefined,
		@Headers('x-correlation-id') correlationHeader: string | undefined,
		@Res({ passthrough: true }) response: HttpResponse,
	) {
		const correlationId =
			correlationHeader !== undefined && correlationHeader.trim() !== ""
				? correlationHeader
				: crypto.randomUUID();
		response.setHeader("X-Correlation-Id", correlationId);

		const command = parseSubmitTransaction(body, idempotencyKey, correlationId);
		const result = await this.processTransaction.execute(command);

		this.metrics.inc("wager_transactions_total", {
			kind: command.kind,
			status: result.status,
			replay: String(result.idempotentReplay),
		});
		response.status(STATUS_BY_RESULT[result.status]);
		return {
			transactionId: result.transactionId,
			status: result.status,
			...(result.failureCode === undefined
				? {}
				: { failureCode: result.failureCode }),
			balance: result.balance.toJSON(),
			idempotentReplay: result.idempotentReplay,
		};
	}

	@Get('wagering/transactions/:transactionId')
  async getById(@Param('transactionId') transactionId: string): Promise<TransactionView> {
    const view = await this.queries.findTransactionById(parseUuid(transactionId, 'transactionId'));
    if (view === undefined) {
      throw new NotFoundError('TRANSACTION_NOT_FOUND', `transação ${transactionId} não encontrada`);
    }
    return view;
  }

	@Get("providers/:providerId/wagering/transactions/:externalTransactionId")
	async getByExternalId(
		@Param('providerId') providerId: string,
		@Param('externalTransactionId') externalTransactionId: string,
	): Promise<TransactionView> {
		const view = await this.queries.findTransactionByExternalId(
			providerId,
			externalTransactionId,
		);
		if (view === undefined) {
			throw new NotFoundError(
				"TRANSACTION_NOT_FOUND",
				`transação ${externalTransactionId} do provedor ${providerId} não encontrada`,
			);
		}
		return view;
	}
}
