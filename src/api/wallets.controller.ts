import {
    Body,
    Controller,
    Get,
    Headers,
    HttpCode,
    Inject,
    Param,
    Post,
    Query,
    Res,
} from "@nestjs/common";
import { CreateWallet } from "../application/create-wallet";
import type {
    LedgerPage,
    QueryPort,
    ReconciliationView,
    WalletView,
} from "../application/queries";
import type { Logger } from "../observability/logger";
import { NotFoundError } from "./errors";
import type { HttpResponse } from "./http";
import { Metrics } from "./metrics";
import {
    decodeCursor,
    encodeCursor,
    parseCreateWallet,
    parseLimit,
    parseUuid,
} from "./parsers";
import { LOGGER, QUERIES } from "./tokens";

function correlationIdOf(
    header: string | undefined,
    response: HttpResponse,
): string {
    const correlationId =
        header !== undefined && header.trim() !== ""
            ? header
            : crypto.randomUUID();
    response.setHeader("X-Correlation-Id", correlationId);
    return correlationId;
}

@Controller("wallets")
export class WalletsController {
    constructor(
        @Inject(CreateWallet) private readonly createWallet: CreateWallet,
        @Inject(QUERIES) private readonly queries: QueryPort,
        @Inject(Metrics) private readonly metrics: Metrics,
        @Inject(LOGGER) private readonly logger: Logger,
    ) {}

    @Post()
    @HttpCode(201)
    async create(
        @Body() body: unknown,
        @Headers("x-correlation-id") correlationHeader: string | undefined,
        @Res({ passthrough: true }) response: HttpResponse,
    ): Promise<WalletView> {
        const correlationId = correlationIdOf(correlationHeader, response);
        const wallet = await this.createWallet.execute(
            parseCreateWallet(body, correlationId),
        );
        return {
            id: wallet.id,
            playerId: wallet.playerId,
            balance: wallet.balance.toJSON(),
            version: wallet.version,
        };
    }

    @Get(":walletId")
    async get(@Param("walletId") walletId: string): Promise<WalletView> {
        const wallet = await this.queries.findWallet(
            parseUuid(walletId, "walletId"),
        );
        if (wallet === undefined) {
            throw new NotFoundError(
                "WALLET_NOT_FOUND",
                `wallet ${walletId} não encontrada`,
            );
        }
        return wallet;
    }

    @Get(":walletId/ledger")
    async ledger(
        @Param("walletId") walletId: string,
        @Query("cursor") cursor: string | undefined,
        @Query("limit") limit: string | undefined,
    ): Promise<{ entries: LedgerPage["entries"]; nextCursor?: string }> {
        const page = await this.queries.listLedger(
            parseUuid(walletId, "walletId"),
            decodeCursor(cursor),
            parseLimit(limit),
        );
        if (page === undefined) {
            throw new NotFoundError(
                "WALLET_NOT_FOUND",
                `wallet ${walletId} não encontrada`,
            );
        }
        return {
            entries: page.entries,
            ...(page.nextCursor === undefined
                ? {}
                : { nextCursor: encodeCursor(page.nextCursor) }),
        };
    }

    @Post(":walletId/reconciliation")
    @HttpCode(200)
    async reconcile(
        @Param("walletId") walletId: string,
    ): Promise<ReconciliationView> {
        const result = await this.queries.reconcile(
            parseUuid(walletId, "walletId"),
        );
        if (result === undefined) {
            throw new NotFoundError(
                "WALLET_NOT_FOUND",
                `wallet ${walletId} não encontrada`,
            );
        }
        this.metrics.inc("reconciliations_total", {
            consistent: String(result.consistent),
        });
        if (!result.consistent) {
            this.metrics.inc("reconciliation_divergences_total");
            this.logger.log("warn", "reconciliation_divergence", {
                walletId: result.walletId,
                storedBalance: result.storedBalance.amount,
                calculatedBalance: result.calculatedBalance.amount,
                difference: result.difference.amount,
                currency: result.difference.currency,
                checkedEntries: result.checkedEntries,
            });
        }
        return result;
    }
}
