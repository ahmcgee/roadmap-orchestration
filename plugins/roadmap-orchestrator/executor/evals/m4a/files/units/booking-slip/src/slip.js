// The booking slip: the one line a skipper keeps for a booking.

/** `<id>: <vessel> in <berth> on <date>, HW <hw>` for booking `b`. */
export function slipLine(b) {
  return `${b.id}: ${b.vessel} in ${b.berth} on ${b.date}, HW ${b.window}`;
}
