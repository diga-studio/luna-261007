export class ReservationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ReservationError";
    this.code = code;
  }
}

export class ShiftNotFoundError extends ReservationError {
  constructor(shiftId: string) {
    super("SHIFT_NOT_FOUND", `shift not found: ${shiftId}`);
  }
}

export class ShiftAlreadyExistsError extends ReservationError {
  constructor(shiftId: string) {
    super("SHIFT_ALREADY_EXISTS", `shift already exists: ${shiftId}`);
  }
}

export class ReservationNotFoundError extends ReservationError {
  constructor(reservationId: string) {
    super("RESERVATION_NOT_FOUND", `reservation not found: ${reservationId}`);
  }
}

export class DuplicateOrderError extends ReservationError {
  constructor(orderId: string) {
    super("DUPLICATE_ORDER", `reservation already exists for order: ${orderId}`);
  }
}

export class InvalidSlotsError extends ReservationError {
  constructor(slots: number) {
    super("INVALID_SLOTS", `slots must be a positive integer, got: ${slots}`);
  }
}

export class CapacityExceededError extends ReservationError {
  constructor(shiftId: string) {
    super("CAPACITY_EXCEEDED", `shift capacity exceeded: ${shiftId}`);
  }
}

export class ReservationNotActiveError extends ReservationError {
  constructor(reservationId: string) {
    super("RESERVATION_NOT_ACTIVE", `reservation is cancelled, picked up or expired: ${reservationId}`);
  }
}

export class ShiftExpiredError extends ReservationError {
  constructor(shiftId: string) {
    super("SHIFT_EXPIRED", `shift has passed its pickup deadline: ${shiftId}`);
  }
}

export class PickupNotStartedError extends ReservationError {
  constructor(shiftId: string) {
    super("PICKUP_NOT_STARTED", `shift pickup has not started yet: ${shiftId}`);
  }
}
