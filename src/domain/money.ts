import { DomainError } from "./errors/domain-error";

export interface MoneyProps {
	amount: string;
	currency: string;
}

const AMOUNT_PATTERN = /^(\d{1,17})\.(\d{2})$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class Money {
	private constructor(
		private readonly cents: bigint,
		public readonly currency: string,
	) {}

	static from(props: MoneyProps): Money {
		const currency = Money.parseCurrency(props.currency);
		const cents = Money.parseAmount(props.amount);
		return new Money(cents, currency);
	}

	static zero(currency: string): Money {
		return new Money(0n, Money.parseCurrency(currency));
	}

	add(other: Money): Money {
		this.assertSameCurrency(other);
		return new Money(this.cents + other.cents, this.currency);
	}

	subtract(other: Money): Money {
		this.assertSameCurrency(other);
		return new Money(this.cents - other.cents, this.currency);
	}

	negate(): Money {
		return new Money(-this.cents, this.currency);
	}

	isZero(): boolean {
		return this.cents === 0n;
	}

	isPositive(): boolean {
		return this.cents > 0n;
	}

	isNegative(): boolean {
		return this.cents < 0n;
	}

	isLessThan(other: Money): boolean {
		this.assertSameCurrency(other);
		return this.cents < other.cents;
	}

	equals(other: Money): boolean {
		return this.currency === other.currency && this.cents === other.cents;
	}

	toJSON(): MoneyProps {
		return { amount: this.formatAmount(), currency: this.currency };
	}

	toString(): string {
		return `${this.formatAmount()} ${this.currency}`;
	}

	private assertSameCurrency(other: Money): void {
		if (this.currency !== other.currency) {
			throw new DomainError(
				"CURRENCY_MISMATCH",
				`operação entre moedas diferentes: ${this.currency} e ${other.currency}`,
			);
		}
	}

	private formatAmount(): string {
		const negative = this.cents < 0n;
		const abs = negative ? -this.cents : this.cents;
		const whole = abs / 100n;
		const fraction = (abs % 100n).toString().padStart(2, "0");
		return `${negative ? "-" : ""}${whole}.${fraction}`;
	}

	private static parseAmount(amount: unknown): bigint {
		if (typeof amount !== "string") {
			throw new DomainError(
				"INVALID_MONEY_AMOUNT",
				"amount deve ser uma string decimal",
			);
		}
		const match = AMOUNT_PATTERN.exec(amount);
		const whole = match?.[1];
		const fraction = match?.[2];
		if (whole === undefined || fraction === undefined) {
			throw new DomainError(
				"INVALID_MONEY_AMOUNT",
				`amount inválido: ${JSON.stringify(amount)}`,
			);
		}
		return BigInt(whole) * 100n + BigInt(fraction);
	}

	private static parseCurrency(currency: unknown): string {
		if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
			throw new DomainError(
				"INVALID_CURRENCY",
				`moeda inválida: ${JSON.stringify(currency)}`,
			);
		}
		return currency;
	}
}
