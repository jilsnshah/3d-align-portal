/* What each kind of order actually goes through.
 *
 * The three products do not share a journey. An aligner case is read, quoted,
 * scanned, planned, fitted and then delivered in phases. A by-product is
 * ordered at a catalogue price and made from a scan. An accessory is picked off
 * a shelf. Showing all three the aligner's six stages told a clinic ordering a
 * retainer that it was waiting on a treatment plan.
 *
 * One definition, read by both the case page's rail and the boards' progress
 * bar. They held separate copies of the aligner journey before this and had
 * already drifted: neither listed PRODUCT_FABRICATION, so every by-product and
 * accessory rendered a blank rail stuck at nought per cent.
 *
 * This is a stopgap in one honest respect — the backend owns the real state
 * machine and this mirrors it. The next step is for the order payload to carry
 * its own stages so there is one source of truth rather than two that agree.
 */

import type { OrderKind, OrderStatus } from "./api";

export type Stage = { key: string; label: string; statuses: OrderStatus[] };

const ALIGNER: Stage[] = [
  { key: "records", label: "Records", statuses: ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "RECORDS_REQUESTED"] },
  { key: "quote", label: "Quote", statuses: ["QUOTED"] },
  { key: "scan", label: "Scan", statuses: ["AWAITING_SCAN", "SCAN_SUBMITTED"] },
  { key: "plan", label: "Treatment plan", statuses: ["IN_PLANNING", "PLAN_SHARED"] },
  {
    key: "fit",
    label: "Training aligner",
    statuses: ["TRAINING_ALIGNER_PRODUCTION", "TRAINING_ALIGNER_SHIPPED", "FIT_REVIEW", "FIT_ISSUE"],
  },
  // PHASE_REVIEW belongs here and was missing from both old copies, so a case
  // waiting on the lab to read its progress photographs showed no stage at all.
  { key: "delivery", label: "Delivery", statuses: ["ALIGNER_PRODUCTION", "DISPATCHING", "PHASE_REVIEW"] },
];

const PRODUCT: Stage[] = [
  { key: "ordered", label: "Ordered", statuses: ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "QUOTED", "RECORDS_REQUESTED"] },
  { key: "scan", label: "Scan", statuses: ["AWAITING_SCAN", "SCAN_SUBMITTED"] },
  { key: "make", label: "Fabrication", statuses: ["PRODUCT_FABRICATION"] },
  { key: "delivery", label: "Delivery", statuses: ["DISPATCHING"] },
];

const ACCESSORY: Stage[] = [
  { key: "ordered", label: "Ordered", statuses: ["DRAFT", "SUBMITTED"] },
  { key: "pack", label: "Packing", statuses: ["PRODUCT_FABRICATION"] },
  { key: "delivery", label: "Delivery", statuses: ["DISPATCHING"] },
];

/** Which files were gathered at each stage, so looking back at one shows what
    was actually collected there rather than the whole cabinet. */
const STAGE_FILES: Record<string, string[]> = {
  records: ["RECORD_PHOTO", "OPG", "LATERAL_CEPH", "CBCT", "OTHER"],
  ordered: ["RECORD_PHOTO", "OPG", "LATERAL_CEPH", "CBCT", "OTHER"],
  scan: ["INTRAORAL_SCAN"],
  plan: ["TREATMENT_PLAN", "SIMULATION_MODEL"],
  fit: ["FIT_ISSUE_PHOTO"],
  delivery: ["PROGRESS_PHOTO", "PHASE_FIT_PHOTO"],
};

export function filesForStage(stageKey: string): string[] {
  return STAGE_FILES[stageKey] ?? [];
}

export function stagesFor(kind: OrderKind): Stage[] {
  if (kind === "ACCESSORY") return ACCESSORY;
  if (kind === "PRODUCT") return PRODUCT;
  return ALIGNER;
}

/** Which stage a status sits in, or -1 for the terminal ones that sit outside
    the journey entirely. */
export function stageIndex(kind: OrderKind, status: OrderStatus): number {
  return stagesFor(kind).findIndex((stage) => stage.statuses.includes(status));
}

/** Stages that mean the case has stalled rather than progressed. */
export const STUCK: Partial<Record<OrderStatus, true>> = {
  RECORDS_REQUESTED: true,
  FIT_ISSUE: true,
};

/** What "finished" reads as. An accessory order is not a case, and a box of
    retainer cases has no aligners in it. */
export function completedCopy(kind: OrderKind): string {
  if (kind === "ACCESSORY") return "Order complete. Everything has been delivered.";
  if (kind === "PRODUCT") return "Order complete. Your appliance has been delivered.";
  return "Case complete. All aligners have been delivered.";
}

/** What the clinic is told while the lab has it and there is nothing for them
    to do. Falls back to the caller's own copy when this kind has nothing
    specific to say. */
export function waitingCopyFor(kind: OrderKind, status: OrderStatus): string | null {
  if (kind === "ACCESSORY") {
    if (status === "PRODUCT_FABRICATION") return "Your order is being packed.";
    if (status === "DISPATCHING") return "Your order is on its way. Tracking appears above.";
  }
  if (kind === "PRODUCT") {
    if (status === "PRODUCT_FABRICATION") return "Your appliance is being made.";
    if (status === "SCAN_SUBMITTED") return "Your scan is with the lab. They will confirm it is usable and begin work.";
    if (status === "DISPATCHING") return "Your appliance is on its way. Tracking appears above.";
  }
  return null;
}
