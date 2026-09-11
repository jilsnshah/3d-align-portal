/* Everything, not a page of it.
 *
 * The case and patient lists page through the server twenty-five at a time,
 * which is right for a list and wrong for anything that has to count across
 * the whole practice — the patient list's treatment column and the insights
 * page both need every case at once. These read in chunks until a short
 * chunk says there are no more, and are shared so the two pages fetch (and
 * cache) the same thing the same way.
 */

import { api } from "./api";
import type { OrderSummary, Patient } from "./api";

/** Read in pages this size until a short page says there are no more. */
const CHUNK = 100;

export async function everyPatient(): Promise<Patient[]> {
  const out: Patient[] = [];
  for (let offset = 0; offset < 5000; offset += CHUNK) {
    const page = await api.patients({ limit: CHUNK, offset });
    out.push(...page);
    if (page.length < CHUNK) break;
  }
  return out;
}

export async function everyCase(): Promise<OrderSummary[]> {
  const out: OrderSummary[] = [];
  for (let offset = 0; offset < 5000; offset += CHUNK) {
    const page = await api.orders(false, { limit: CHUNK, offset });
    out.push(...page);
    if (page.length < CHUNK) break;
  }
  return out;
}
