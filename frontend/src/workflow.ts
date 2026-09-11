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

import type { AlignerIntake, OrderKind, OrderStatus, OrderSummary } from "./api";

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

/* A case that came in with its own scan was never quoted, so it has no quote
   stage to show. Leaving the aligner list alone for it drew a stage the case
   will never enter and a rail that could never fill. */
const ALIGNER_SCAN_DIRECT: Stage[] = [
  { key: "scan", label: "Scan", statuses: ["DRAFT", "AWAITING_SCAN", "SCAN_SUBMITTED"] },
  { key: "plan", label: "Treatment plan", statuses: ["IN_PLANNING", "PLAN_SHARED"] },
  {
    key: "fit",
    label: "Training aligner",
    statuses: ["TRAINING_ALIGNER_PRODUCTION", "TRAINING_ALIGNER_SHIPPED", "FIT_REVIEW", "FIT_ISSUE"],
  },
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

export function stagesFor(kind: OrderKind, intake: AlignerIntake = "QUOTE_FIRST"): Stage[] {
  if (kind === "ACCESSORY") return ACCESSORY;
  if (kind === "PRODUCT") return PRODUCT;
  if (intake === "SCAN_DIRECT") return ALIGNER_SCAN_DIRECT;
  return ALIGNER;
}

/** Which stage a status sits in, or -1 for the terminal ones that sit outside
    the journey entirely. */
export function stageIndex(
  kind: OrderKind,
  status: OrderStatus,
  intake: AlignerIntake = "QUOTE_FIRST",
): number {
  return stagesFor(kind, intake).findIndex((stage) => stage.statuses.includes(status));
}

/** What the clinic is being asked for, in the words they would use — singular
    and plural. A status name says where a case is; this says what it wants.
    Shared, so the home page and the case list can never phrase the same case
    two different ways. */
export const ASK: Partial<Record<OrderStatus, [string, string]>> = {
  DRAFT: ["Finish and send 1 draft case", "Finish and send {n} draft cases"],
  RECORDS_REQUESTED: ["Add better records to 1 case", "Add better records to {n} cases"],
  QUOTED: ["Review 1 quote", "Review {n} quotes"],
  AWAITING_SCAN: ["Send 1 intraoral scan", "Send {n} intraoral scans"],
  PLAN_SHARED: ["Review 1 treatment plan", "Review {n} treatment plans"],
  FIT_REVIEW: ["Confirm 1 training aligner fit", "Confirm {n} training aligner fits"],
};

/** The same ask against a single case, where a count would be noise. */
export const ASK_ONE: Partial<Record<OrderStatus, string>> = {
  DRAFT: "Finish and send it",
  RECORDS_REQUESTED: "Add better records",
  QUOTED: "Review the quote",
  AWAITING_SCAN: "Send the intraoral scan",
  PLAN_SHARED: "Review the treatment plan",
  FIT_REVIEW: "Confirm the fit",
};

/** The order they should be worked in — a draft the clinic has not sent is not
    as pressing as a lab waiting on a fit report. */
export const URGENCY: OrderStatus[] = [
  "RECORDS_REQUESTED",
  "FIT_REVIEW",
  "PLAN_SHARED",
  "QUOTED",
  "AWAITING_SCAN",
  "DRAFT",
];

/** Stages that mean the case has stalled rather than progressed. */
export const STUCK: Partial<Record<OrderStatus, true>> = {
  RECORDS_REQUESTED: true,
  FIT_ISSUE: true,
};

/** The lab's side of the same journey: what 3D Align has to do next, singular
    and plural. The clinic's asks say what the lab is waiting for; these say
    what the lab is holding up. */
export const LAB_ASK: Partial<Record<OrderStatus, [string, string]>> = {
  FIT_ISSUE: ["Resolve 1 fit issue", "Resolve {n} fit issues"],
  SCAN_SUBMITTED: ["Check 1 scan", "Check {n} scans"],
  SUBMITTED: ["Review 1 new submission", "Review {n} new submissions"],
  UNDER_REVIEW: ["Quote 1 case", "Quote {n} cases"],
  PHASE_REVIEW: ["Read 1 set of progress photos", "Read {n} sets of progress photos"],
  IN_PLANNING: ["Plan 1 case", "Plan {n} cases"],
  DISPATCHING: ["Dispatch 1 parcel", "Dispatch {n} parcels"],
  TRAINING_ALIGNER_PRODUCTION: ["Make 1 training aligner", "Make {n} training aligners"],
  ALIGNER_PRODUCTION: ["Produce 1 aligner phase", "Produce {n} aligner phases"],
  PRODUCT_FABRICATION: ["Make or pack 1 order", "Make or pack {n} orders"],
};

/** The same, against a single case. */
export const LAB_ASK_ONE: Partial<Record<OrderStatus, string>> = {
  FIT_ISSUE: "Resolve the fit issue",
  SCAN_SUBMITTED: "Check the scan",
  SUBMITTED: "Review the submission",
  UNDER_REVIEW: "Send the quote",
  PHASE_REVIEW: "Read the progress photos",
  IN_PLANNING: "Plan the case",
  DISPATCHING: "Dispatch it",
  TRAINING_ALIGNER_PRODUCTION: "Make the training aligner",
  ALIGNER_PRODUCTION: "Produce the phase",
  PRODUCT_FABRICATION: "Make or pack it",
};

/** The order the lab should work them in: a fitting that failed and a scan
    that may need retaking hold a patient up more than a parcel does. */
export const LAB_URGENCY: OrderStatus[] = [
  "FIT_ISSUE",
  "SCAN_SUBMITTED",
  "SUBMITTED",
  "UNDER_REVIEW",
  "PHASE_REVIEW",
  "IN_PLANNING",
  "DISPATCHING",
  "TRAINING_ALIGNER_PRODUCTION",
  "ALIGNER_PRODUCTION",
  "PRODUCT_FABRICATION",
];

/** Whether a case is on the lab's desk: open, not waiting on the clinic, and
    at a stage where 3D Align is the one who acts. */
export function onLabDesk(order: OrderSummary): boolean {
  if (order.status === "COMPLETED" || order.status === "CANCELLED") return false;
  return !order.needs_doctor_action && Boolean(LAB_ASK[order.status]);
}

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
