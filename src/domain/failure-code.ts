export enum FailureCode {
	InsufficientFunds = "INSUFFICIENT_FUNDS",
	ReversalWouldOverdraw = "REVERSAL_WOULD_OVERDRAW",
	ReferenceNotFound = "REFERENCE_NOT_FOUND",
	ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
	InvalidReferenceKind = "INVALID_REFERENCE_KIND",
	ReferenceMismatch = "REFERENCE_MISMATCH",
	AmountMismatch = "AMOUNT_MISMATCH",
	AlreadyReversed = "ALREADY_REVERSED",
	WalletNotFound = "WALLET_NOT_FOUND",
	CurrencyMismatch = "CURRENCY_MISMATCH",
	PlayerMismatch = "PLAYER_MISMATCH",
	InternalError = "INTERNAL_ERROR",
}
