import { DomainError } from "./errors/domain-error";

export interface EnqueuableEvent {
	readonly eventId: string;
	readonly aggregateId: string;
	readonly eventType: string;
	readonly occurredAt: Date;
	toJSON(): object;
}

export interface OutboxMessageState {
	id: string;
	aggregateId: string;
	eventType: string;
	payload: Readonly<Record<string, unknown>>;
	occurredAt: Date;
	attempts: number;
	nextAttemptAt?: Date;
	publishedAt?: Date;
}

export interface OutboxBackoff {
	baseMs: number;
	maxMs: number;
}

export const DEFAULT_OUTBOX_BACKOFF: OutboxBackoff = {
	baseMs: 1_000,
	maxMs: 60_000,
};

export class OutboxMessage {
	private constructor(
		public readonly id: string,
		public readonly aggregateId: string,
		public readonly eventType: string,
		public readonly payload: Readonly<Record<string, unknown>>,
		public readonly occurredAt: Date,
		private _attempts: number,
		private _nextAttemptAt?: Date,
		private _publishedAt?: Date,
	) {}

	static enqueue(event: EnqueuableEvent): OutboxMessage {
		const payload = JSON.parse(JSON.stringify(event.toJSON())) as Record<
			string,
			unknown
		>;
		return new OutboxMessage(
			event.eventId,
			event.aggregateId,
			event.eventType,
			Object.freeze(payload),
			event.occurredAt,
			0,
		);
	}

	static rehydrate(state: OutboxMessageState): OutboxMessage {
		return new OutboxMessage(
			state.id,
			state.aggregateId,
			state.eventType,
			state.payload,
			state.occurredAt,
			state.attempts,
			state.nextAttemptAt,
			state.publishedAt,
		);
	}

	get attempts(): number {
		return this._attempts;
	}

	get nextAttemptAt(): Date | undefined {
		return this._nextAttemptAt;
	}

	get publishedAt(): Date | undefined {
		return this._publishedAt;
	}

	isPending(): boolean {
		return this._publishedAt === undefined;
	}

	isDue(now: Date): boolean {
		return (
			this.isPending() &&
			(this._nextAttemptAt === undefined ||
				this._nextAttemptAt.getTime() <= now.getTime())
		);
	}

	markPublished(at: Date): void {
		this.assertPending();
		this._publishedAt = at;
		this._attempts += 1;
		this._nextAttemptAt = undefined;
	}

	scheduleRetry(
		now: Date,
		backoff: OutboxBackoff = DEFAULT_OUTBOX_BACKOFF,
	): void {
		this.assertPending();
		const delayMs = Math.min(
			backoff.baseMs * 2 ** this._attempts,
			backoff.maxMs,
		);
		this._attempts += 1;
		this._nextAttemptAt = new Date(now.getTime() + delayMs);
	}

	private assertPending(): void {
		if (!this.isPending()) {
			throw new DomainError(
				"OUTBOX_ALREADY_PUBLISHED",
				`o evento ${this.id} já foi publicado`,
			);
		}
	}
}
