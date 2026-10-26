import { DomainError } from "./errors/domain-error";

export interface ReceiveInboxProps {
	messageId: string;
	consumerName: string;
	payloadHash: string;
	receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
	processedAt?: Date;
}

export class InboxMessage {
	private constructor(
		public readonly messageId: string,
		public readonly consumerName: string,
		public readonly payloadHash: string,
		public readonly receivedAt: Date,
		private _processedAt?: Date,
	) {}

	static receive(props: ReceiveInboxProps): InboxMessage {
		for (const [field, value] of Object.entries({
			messageId: props.messageId,
			consumerName: props.consumerName,
			payloadHash: props.payloadHash,
		})) {
			if (value.trim() === "") {
				throw new DomainError(
					"INVALID_INBOX_MESSAGE",
					`${field} é obrigatório`,
				);
			}
		}
		return new InboxMessage(
			props.messageId,
			props.consumerName,
			props.payloadHash,
			props.receivedAt,
		);
	}

	static rehydrate(state: InboxMessageState): InboxMessage {
		return new InboxMessage(
			state.messageId,
			state.consumerName,
			state.payloadHash,
			state.receivedAt,
			state.processedAt,
		);
	}

	get processedAt(): Date | undefined {
		return this._processedAt;
	}

	isProcessed(): boolean {
		return this._processedAt !== undefined;
	}

	markProcessed(at: Date): void {
		if (this.isProcessed()) {
			throw new DomainError(
				"INBOX_ALREADY_PROCESSED",
				`a mensagem ${this.messageId} já foi processada`,
			);
		}
		if (at.getTime() < this.receivedAt.getTime()) {
			throw new DomainError(
				"INBOX_INVALID_PROCESSING_TIME",
				"o processamento não pode anteceder o recebimento",
			);
		}
		this._processedAt = at;
	}
}
