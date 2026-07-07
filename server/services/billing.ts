import { all } from "../db.js";

export type BillingSource = {
  studentId: number;
  enrollmentId: number | null;
  planId: number | null;
  durationPeriods: number | null;
  tuitionAmount: number | null;
  billingStartDate?: string | null;
  enrolledAt: string | null;
};

export type PaymentRecord = {
  id: number;
  student_id: number;
  enrollment_id: number | null;
  plan_id: number | null;
  folio: string;
  amount: number;
  paid_at: string;
  payment_method: string | null;
  concept: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type BillingSummary = {
  tuitionAmount: number;
  expectedPayments: number;
  expectedAmount: number;
  paidAmount: number;
  balance: number;
  paidInstallments: number;
  pendingInstallments: number;
};

export type TuitionScheduleItem = {
  period: number;
  dueDate: string | null;
  expectedAmount: number;
  paidAmount: number;
  pendingAmount: number;
  status: "paid" | "partial" | "pending";
};

function money(value: number) {
  return Number(value.toFixed(2));
}

function addMonths(dateText: string | null, months: number) {
  if (!dateText) return null;
  const date = new Date(`${dateText.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  date.setMonth(date.getMonth() + months);
  return date.toISOString().slice(0, 10);
}

export function listStudentPayments(source: BillingSource): PaymentRecord[] {
  return all<PaymentRecord>(
    `SELECT id, student_id, enrollment_id, plan_id, folio, amount, paid_at, payment_method, concept,
     notes, created_at, updated_at
     FROM student_payments
     WHERE student_id = ? AND (? IS NULL OR plan_id = ? OR plan_id IS NULL)
     ORDER BY paid_at DESC, id DESC`,
    source.studentId,
    source.planId,
    source.planId
  );
}

export function summarizeBilling(source: BillingSource, payments: PaymentRecord[]) {
  const tuitionAmount = Math.max(0, Number(source.tuitionAmount ?? 0));
  const expectedPayments = Math.max(0, Math.trunc(Number(source.durationPeriods ?? 0)));
  const expectedAmount = money(tuitionAmount * expectedPayments);
  const paidAmount = money(payments.reduce((sum, payment) => sum + Number(payment.amount), 0));
  const balance = money(Math.max(0, expectedAmount - paidAmount));
  const paidInstallments = tuitionAmount > 0
    ? Math.min(expectedPayments, Math.floor(paidAmount / tuitionAmount))
    : 0;
  return {
    tuitionAmount,
    expectedPayments,
    expectedAmount,
    paidAmount,
    balance,
    paidInstallments,
    pendingInstallments: Math.max(0, expectedPayments - paidInstallments)
  } satisfies BillingSummary;
}

export function buildTuitionSchedule(source: BillingSource, summary: BillingSummary) {
  if (!summary.expectedPayments || !summary.tuitionAmount) return [] satisfies TuitionScheduleItem[];
  let remainingPaid = summary.paidAmount;
  const startDate = source.billingStartDate ?? source.enrolledAt;
  return Array.from({ length: summary.expectedPayments }, (_, index) => {
    const period = index + 1;
    const paidAmount = money(Math.min(summary.tuitionAmount, Math.max(0, remainingPaid)));
    remainingPaid = money(Math.max(0, remainingPaid - summary.tuitionAmount));
    const pendingAmount = money(Math.max(0, summary.tuitionAmount - paidAmount));
    return {
      period,
      dueDate: addMonths(startDate, index),
      expectedAmount: summary.tuitionAmount,
      paidAmount,
      pendingAmount,
      status: pendingAmount <= 0 ? "paid" : paidAmount > 0 ? "partial" : "pending"
    };
  });
}

export function buildBilling(source: BillingSource) {
  const payments = listStudentPayments(source);
  const summary = summarizeBilling(source, payments);
  return {
    summary,
    payments,
    schedule: buildTuitionSchedule(source, summary)
  };
}
