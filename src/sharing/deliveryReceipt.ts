export interface ObservationReceipt {
  readonly sourceId: string
  readonly sequence: number
  readonly capturedAt: number
}

export interface DeliveryReceiptState {
  readonly pending: readonly ObservationReceipt[]
  readonly lastConfirmedAt: number | null
  readonly lastConfirmed?: ObservationReceipt
}

const sameObservation = (left: ObservationReceipt, right: ObservationReceipt): boolean =>
  left.sourceId === right.sourceId &&
  left.sequence === right.sequence &&
  left.capturedAt === right.capturedAt

export const recordSentObservation = (
  state: DeliveryReceiptState,
  observation: ObservationReceipt,
): DeliveryReceiptState => ({
  ...state,
  pending: [...state.pending, observation].slice(-16),
})

export const acknowledgeObservation = (
  state: DeliveryReceiptState,
  receipt: ObservationReceipt,
  receivedAt: number,
): DeliveryReceiptState => {
  const index = state.pending.findIndex((observation) => sameObservation(observation, receipt))
  if (index < 0 || !Number.isFinite(receivedAt) || receivedAt < 0) return state
  return {
    pending: state.pending.slice(index + 1),
    lastConfirmed: receipt,
    lastConfirmedAt: receivedAt,
  }
}
