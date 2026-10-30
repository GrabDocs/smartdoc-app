import {
  adjustManualTotal,
  buildOriginalCapture,
  computeReceiptTotal,
  discoverCapturedExtras,
  extraClearPayload,
  lineContribution,
  lineMerchandiseAmount,
  originalCaptureFromSource,
  parseMoney,
  printedTotalFromSource,
} from '../receiptTotalCalculation';

describe('receipt total calculation', () => {
  test('tax-free receipt stays tax-free', () => {
    const extras = discoverCapturedExtras({
      items: [{ name: 'Coffee', price: 4.5 }],
      total_amount: 4.5,
    });
    const result = computeReceiptTotal({
      items: [{ name: 'Coffee', quantity: 1, price: 4.5 }],
      extras,
      printedTotal: 4.5,
      includeRemainder: true,
    });
    expect(extras).toEqual([]);
    expect(result.itemTax).toBe(0);
    expect(result.extrasTotal).toBe(0);
    expect(result.remainder).toBe(0);
    expect(result.displayTotal).toBe(4.5);
  });

  test('mixed-tax receipts include only captured item tax', () => {
    const result = computeReceiptTotal({
      items: [
        { name: 'Food', quantity: 1, price: 10, tax_amount: 0.8 },
        { name: 'Water', quantity: 1, price: 2 },
      ],
      extras: [],
      printedTotal: 12.8,
      includeRemainder: true,
    });
    expect(result.itemsSubtotal).toBe(12);
    expect(result.itemTax).toBe(0.8);
    expect(result.displayTotal).toBe(12.8);
  });

  test('qty 1 uses captured price as the line amount', () => {
    expect(lineMerchandiseAmount({ quantity: 1, price: 9.99 })).toBe(9.99);
    expect(lineMerchandiseAmount({ price: 9.99 })).toBe(9.99);
  });

  test('qty > 1 with line_total uses the extended amount once', () => {
    expect(
      lineMerchandiseAmount({ quantity: 3, price: 5, unit_price: 5, line_total: 15 })
    ).toBe(15);
  });

  test('explicit unit price multiplies by quantity', () => {
    expect(lineMerchandiseAmount({ quantity: 3, unit_price: 5 })).toBe(15);
  });

  test('receipt extras are included only when present and monetary', () => {
    const extras = discoverCapturedExtras({
      tax: 1.2,
      tip: '3.00',
      tax_rate: '6%',
      cash_tendered: 20,
      change: 2.8,
      payment_method: 'cash',
      subtotal: 15,
      total: 19.2,
      balance: 0,
    });
    expect(extras.map((e) => e.label).sort()).toEqual(['Tax', 'Tip']);
    expect(extras.find((e) => e.label === 'Tax')?.amount).toBe(1.2);
    expect(extras.find((e) => e.label === 'Tip')?.amount).toBe(3);
  });

  test('uses tax amount when both a rate and amount exist', () => {
    const extras = discoverCapturedExtras({ tax_rate: 0.06, tax_amount: 1.5 });
    expect(extras).toEqual([
      expect.objectContaining({ label: 'Tax', amount: 1.5 }),
    ]);
  });

  test('discounts and refunds subtract, without double-negating', () => {
    const extras = discoverCapturedExtras({ discount: 2, refund: -1.5 });
    const result = computeReceiptTotal({
      items: [{ name: 'Item', quantity: 1, price: 10 }],
      extras,
      printedTotal: 6.5,
      includeRemainder: true,
    });
    expect(extras.find((e) => e.label === 'Discount')?.amount).toBe(-2);
    expect(extras.find((e) => e.label === 'Refund')?.amount).toBe(-1.5);
    expect(result.displayTotal).toBe(6.5);
  });

  test('never adds subtotal or printed total as extras', () => {
    const extras = discoverCapturedExtras({
      items: [{ name: 'A', price: 10 }],
      subtotal: 10,
      total: 11,
      total_amount: 11,
      tax: 1,
    });
    expect(extras.map((e) => e.label)).toEqual(['Tax']);
  });

  test('skips receipt-level tax when item tax is already present', () => {
    const extras = discoverCapturedExtras({ tax: 1.5 });
    const result = computeReceiptTotal({
      items: [{ name: 'A', quantity: 1, price: 10, tax_amount: 0.8 }],
      extras,
      printedTotal: 10.8,
      includeRemainder: true,
    });
    expect(result.itemTax).toBe(0.8);
    expect(result.extrasTotal).toBe(0);
    expect(result.displayTotal).toBe(10.8);
  });

  test('remainder is printed total minus calculated total before remainder', () => {
    const result = computeReceiptTotal({
      items: [{ name: 'A', quantity: 1, price: 10 }],
      extras: [{ key: 'tax', label: 'Tax', group: 'tax', amount: 0.8 }],
      printedTotal: 12.5,
      includeRemainder: true,
    });
    expect(result.calculatedBeforeRemainder).toBe(10.8);
    expect(result.remainder).toBe(1.7);
    expect(result.displayTotal).toBe(12.5);
    expect(result.rows.some((row) => row.label === 'Unclassified' && row.amount === 1.7)).toBe(true);
  });

  test('does not invent a remainder when printed total is missing', () => {
    const result = computeReceiptTotal({
      items: [{ name: 'A', quantity: 1, price: 10 }],
      extras: [],
      printedTotal: null,
      includeRemainder: false,
    });
    expect(result.remainder).toBeNull();
    expect(result.displayTotal).toBe(10);
  });

  test('does not add a previous remainder as another captured extra', () => {
    const extras = discoverCapturedExtras({
      tax: 1,
      unclassified_remainder: 4,
      calculated_total: 11,
      printed_total: 15,
    });
    const first = computeReceiptTotal({
      items: [{ name: 'A', quantity: 1, price: 10 }],
      extras,
      printedTotal: 15,
      includeRemainder: true,
    });
    expect(first.remainder).toBe(4);
    const afterItemEdit = computeReceiptTotal({
      items: [{ name: 'A', quantity: 1, price: 11 }],
      extras,
      printedTotal: 15,
      includeRemainder: true,
    });
    expect(afterItemEdit.calculatedBeforeRemainder).toBe(12);
    expect(afterItemEdit.remainder).toBe(3);
    expect(afterItemEdit.displayTotal).toBe(15);
  });

  test('user remainder override is not mixed into extras', () => {
    const extras = discoverCapturedExtras({ tax: 1, unclassified_remainder: 2 });
    const result = computeReceiptTotal({
      items: [{ name: 'A', quantity: 1, price: 10 }],
      extras,
      printedTotal: 13,
      includeRemainder: true,
      remainderOverride: 0,
    });
    expect(result.extrasTotal).toBe(1);
    expect(result.remainder).toBe(0);
    expect(result.displayTotal).toBe(11);
  });

  test('printed total prefers preserved printed_total over later total_amount', () => {
    expect(
      printedTotalFromSource({
        printed_total: 19.47,
        total_amount: 18.0,
        tax: 1.47,
      })
    ).toBe(19.47);
  });

  test('removed extras are cleared by original alias keys', () => {
    const payload = extraClearPayload({ tax_amount: 1.2, tip: 3 }, []);
    expect(payload).toEqual({ tax_amount: '', tip: '' });
  });

  test('parseMoney ignores non-monetary identity fields by never being asked for them', () => {
    const extras = discoverCapturedExtras({
      store_name: '12 Store',
      receipt_number: '100.00',
      cash: 20,
      change_due: 5,
    });
    expect(extras).toEqual([]);
    expect(parseMoney('$12.50')).toBe(12.5);
  });

  test('manual mode subtracts an item contribution without touching extras', () => {
    const tax = discoverCapturedExtras({ tax: 3 })[0];
    const before = computeReceiptTotal({
      items: [
        { name: 'A', quantity: 1, price: 20 },
        { name: 'B', quantity: 1, price: 30 },
      ],
      extras: [tax],
      printedTotal: 53,
      includeRemainder: true,
    });
    expect(before.displayTotal).toBe(53);
    expect(lineContribution({ name: 'B', quantity: 1, price: 30 })).toBe(30);
    expect(adjustManualTotal('53.00', -30)).toBe('23.00');
    expect(adjustManualTotal('53.00', 15)).toBe('68.00');
  });

  test('item-specific tax is included in the incremental contribution', () => {
    expect(lineContribution({ name: 'A', quantity: 1, price: 10, tax_amount: 0.8 })).toBe(10.8);
    expect(adjustManualTotal('20.00', -10.8)).toBe('9.20');
  });

  test('editing price or quantity adjusts by the contribution difference', () => {
    const oldAmount = lineContribution({ name: 'A', quantity: 1, price: 10 });
    const newPrice = lineContribution({ name: 'A', quantity: 1, price: 12 });
    const newQty = lineContribution({ name: 'A', quantity: 2, price: 10 });
    expect(adjustManualTotal('13.00', newPrice - oldAmount)).toBe('15.00');
    expect(adjustManualTotal('13.00', newQty - oldAmount)).toBe('23.00');
  });

  test('original capture snapshot is restored as stored, never overwritten by later totals', () => {
    const source = {
      original_capture: {
        items: [{ name: 'A', price: 20 }],
        extras: [{ key: 'tax', label: 'Tax', group: 'tax', amount: 3 }],
        printed_total: 53,
        total_amount: '53.00',
        store_name: 'Cafe',
        date: '2026-10-01',
        category: 'Meals and Entertainment',
        auto_calculate: false,
      },
      total_amount: '75.00',
      items: [{ name: 'A', price: 40 }],
    };
    const snap = originalCaptureFromSource(source);
    expect(snap?.total_amount).toBe('53.00');
    expect(snap?.printed_total).toBe(53);
    expect(snap?.items).toEqual([{ name: 'A', price: 20 }]);
    const rebuilt = buildOriginalCapture(snap!);
    expect(rebuilt.total_amount).toBe('53.00');
    expect(rebuilt.auto_calculate).toBe(false);
  });
});
