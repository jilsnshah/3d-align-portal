/* Everything, not a page of it.
 *
 * The case and patient lists page through the server twenty-five at a time,
 * which is right for a list and wrong for anything that has to count across
 * the whole practice — the patient list's treatment column and the insights
 * page both need every case at once. These read in chunks until a short
 * chunk says there are no more, and are shared so the pages fetch (and cache)
 * the same thing the same way.
 */

import { api } from "./api";
import type { OrderSummary, Patient, PendingDoctor } from "./api";

/** Read in pages this size until a short page says there are no more. */
const CHUNK = 100;

async function drain<T>(page: (offset: number) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; offset < 5000; offset += CHUNK) {
    const rows = await page(offset);
    out.push(...rows);
    if (rows.length < CHUNK) break;
  }
  return out;
}

export function everyPatient(): Promise<Patient[]> {
  return drain((offset) => api.patients({ limit: CHUNK, offset }));
}

export function everyCase(): Promise<OrderSummary[]> {
  return drain((offset) => api.orders(false, { limit: CHUNK, offset }));
}

/** Every case the lab account may see, across every practice and series. */
export function everyStaffCase(): Promise<OrderSummary[]> {
  return drain((offset) => api.staffOrders({}, { limit: CHUNK, offset }));
}

/** Every doctor who has signed up, verified or not. */
export function everyDoctor(): Promise<PendingDoctor[]> {
  return drain((offset) => api.staffDoctors(false, { limit: CHUNK, offset }));
}
