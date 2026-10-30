import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useThemeColors } from '../../hooks/useThemeColors';
import { apiClient } from '../../services/api';
import {
  autoCalculateFromSource,
  computeReceiptTotal,
  discoverCapturedExtras,
  editorLineToCalc,
  extraClearPayload,
  extrasToSavePayload,
  formatMoney,
  parseMoney,
  parseOptionalMoney,
  remainderFromSource,
  printedTotalFromSource,
  RECEIPT_CALC_META,
  type ReceiptCapturedExtra,
} from '../../utils/receiptTotalCalculation';
import ClientsButton from '../clients/ClientsButton';
import { FeedbackTouchable } from '../FeedbackTouchable';
import MinimizableBottomSheet from '../MinimizableBottomSheet';

const RECEIPT_CATEGORIES = [
  'Uncategorized',
  'Advertising',
  'Supplies',
  'Professional Services',
  'Personal',
  'Rent and Lease',
  'Education and Training',
  'Cars and Truck',
  'Travel',
  'Office Expenses',
  'Meals and Entertainment',
  'Contractors',
  'Employee Benefit',
  'Banking',
  'Other Expenses',
];

const DATE_PICKER_MIN = (() => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 20);
  return d;
})();
const DATE_PICKER_MAX = (() => {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 5);
  return d;
})();

export type ReceiptLineItem = {
  key: string;
  quantity: string;
  name: string;
  price: string;
  taxAmount?: string;
  useExtended?: boolean;
};

type ExtraEdit = Omit<ReceiptCapturedExtra, 'amount'> & { amount: string };

function strTrim(v: unknown): string {
  if (v == null) return '';
  return String(v).trim();
}

function formatDateLocal(date: Date): string {
  if (Number.isNaN(date.getTime())) return '';
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function parseLocalDateString(str: string): Date | null {
  if (!str || typeof str !== 'string') return null;
  const parts = str.trim().split('-');
  if (parts.length !== 3) return null;
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10) - 1;
  const day = parseInt(parts[2], 10);
  if (Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(day)) return null;
  const d = new Date(y, m, day);
  return Number.isNaN(d.getTime()) ? null : d;
}

function safeToDateString(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'string') {
    if (raw.includes('T')) {
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) return formatDateLocal(d);
      return '';
    }
    return raw.slice(0, 10);
  }
  const d = new Date(raw as string | number);
  return Number.isNaN(d.getTime()) ? '' : formatDateLocal(d);
}

function isEpochOrEmptyDate(s: string): boolean {
  return !s || s === '1969-12-31' || s === '1970-01-01';
}

function localDateStringToUTCISO(str: string): string {
  const d = parseLocalDateString(str);
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : str;
}

function getValidDate(d: Date | undefined): Date {
  if (d != null && !Number.isNaN(d.getTime())) return d;
  return new Date();
}

function newItemKey(): string {
  return `item-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function emptyLineItem(): ReceiptLineItem {
  return { key: newItemKey(), quantity: '1', name: '', price: '0.00' };
}

function normalizeLineItems(raw: unknown): ReceiptLineItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item: any) => {
    const qtyRaw = item?.quantity ?? item?.qty ?? 1;
    const qty = parseMoney(qtyRaw) || 1;
    const name = item?.name ?? item?.description ?? item?.item ?? '';
    const unit = item?.unit_price ?? item?.unitPrice;
    const extended = item?.line_total ?? item?.lineTotal;
    const useExtended = extended != null && extended !== '' && qty > 1;
    const price = useExtended
      ? extended
      : (item?.price ?? item?.amount ?? item?.total ?? unit ?? 0);
    const taxRaw = item?.tax_amount ?? item?.taxAmount ?? item?.tax;
    return {
      key: newItemKey(),
      quantity: String(qtyRaw === '' || qtyRaw == null ? 1 : qtyRaw),
      name: strTrim(name),
      price: formatMoney(parseMoney(price)),
      taxAmount: taxRaw == null || taxRaw === '' ? undefined : formatMoney(parseMoney(taxRaw)),
      useExtended,
    };
  });
}

function extractLineItems(file: any): ReceiptLineItem[] {
  const j = file?.json_data;
  const nested =
    j?.receipt_data != null && typeof j.receipt_data === 'object'
      ? j.receipt_data
      : j?.invoice_data != null && typeof j.invoice_data === 'object'
        ? j.invoice_data
        : null;
  const raw =
    j?.items ||
    j?.line_items ||
    j?.lineItems ||
    j?.JSON?.items ||
    nested?.items ||
    nested?.line_items ||
    file?.items ||
    [];
  return normalizeLineItems(raw);
}

function getStoreName(file: any, type: 'receipt' | 'invoice'): string {
  const j = file?.json_data;
  const nested =
    type === 'invoice'
      ? (j?.invoice_data != null && typeof j.invoice_data === 'object' ? j.invoice_data : null)
      : (j?.receipt_data != null && typeof j.receipt_data === 'object' ? j.receipt_data : null);
  const candidates =
    type === 'invoice'
      ? [
          file?.vendor_name,
          j?.vendor_name,
          j?.business_name,
          j?.store_name,
          nested?.vendor_name,
          nested?.business_name,
          nested?.store_name,
        ]
      : [
          file?.store_name,
          file?.business_name,
          file?.merchant_name,
          file?.vendor_name,
          j?.store_name,
          j?.business_name,
          j?.merchant_name,
          j?.vendor_name,
          nested?.store_name,
          nested?.business_name,
          nested?.merchant_name,
          nested?.vendor_name,
        ];
  for (const c of candidates) {
    const s = strTrim(c);
    if (s) return s;
  }
  return '';
}

function getAmountString(file: any): string {
  const j = file?.json_data;
  const amount = j?.total_amount ?? j?.amount ?? j?.total ?? file?.total_amount ?? file?.amount ?? 0;
  const numericAmount = parseMoney(amount);
  if (numericAmount > 0) return formatMoney(numericAmount);
  return typeof amount === 'string' ? amount : '';
}

function getCategory(file: any): string {
  return (
    file?.category ||
    file?.json_data?.category ||
    file?.receipt_category ||
    file?.invoice_category ||
    file?.json_data?.receipt_category ||
    file?.json_data?.invoice_category ||
    'Uncategorized'
  );
}

function getEditDateString(file: any, type: 'receipt' | 'invoice'): string {
  let s = '';
  if (type === 'invoice') {
    const tx = file?.json_data?.due_date ?? file?.json_data?.invoice_date ?? file?.json_data?.date;
    s = safeToDateString(tx);
    if (!s) s = safeToDateString(file?.created_at);
  } else {
    const tx = file?.json_data?.date ?? file?.json_data?.receipt_data?.date;
    s = safeToDateString(tx);
    if (!s) s = safeToDateString(file?.created_at);
  }
  return isEpochOrEmptyDate(s) ? '' : s;
}

export interface ReceiptEditSheetProps {
  visible: boolean;
  fileId: number | null;
  fileKind?: 'receipt' | 'invoice';
  workspaceId?: number;
  onClose: () => void;
  onSaved?: () => void;
}

export default function ReceiptEditSheet({
  visible,
  fileId,
  fileKind = 'receipt',
  workspaceId,
  onClose,
  onSaved,
}: ReceiptEditSheetProps) {
  const colors = useThemeColors();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editType, setEditType] = useState<'receipt' | 'invoice'>(fileKind);
  const [form, setForm] = useState({
    store_name: '',
    total_amount: '',
    date: '',
    category: 'Uncategorized',
  });
  const [items, setItems] = useState<ReceiptLineItem[]>([]);
  const [extras, setExtras] = useState<ExtraEdit[]>([]);
  const [extrasSource, setExtrasSource] = useState<unknown>(null);
  const [printedTotal, setPrintedTotal] = useState('');
  const [remainderOverride, setRemainderOverride] = useState<number | null>(null);
  const [itemsExpanded, setItemsExpanded] = useState(false);
  const [autoCalculate, setAutoCalculate] = useState(false);
  const [datePickerValue, setDatePickerValue] = useState(new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);

  const extrasForCalc: ReceiptCapturedExtra[] = useMemo(
    () => extras.map((extra) => ({ ...extra, amount: parseMoney(extra.amount) })),
    [extras]
  );
  const printedTotalNum = parseOptionalMoney(printedTotal);
  const calc = useMemo(
    () =>
      computeReceiptTotal({
        items: items.map(editorLineToCalc),
        extras: extrasForCalc,
        printedTotal: printedTotalNum,
        includeRemainder: printedTotalNum != null,
        remainderOverride,
      }),
    [items, extrasForCalc, printedTotalNum, remainderOverride]
  );

  useEffect(() => {
    if (!autoCalculate) return;
    const next = formatMoney(calc.displayTotal);
    setForm((f) => (f.total_amount === next ? f : { ...f, total_amount: next }));
  }, [autoCalculate, calc.displayTotal]);

  const applyItems = useCallback((nextItems: ReceiptLineItem[]) => {
    setItems(nextItems);
    setRemainderOverride(null);
  }, []);

  const applyExtras = useCallback((nextExtras: ExtraEdit[]) => {
    setExtras(nextExtras);
    setRemainderOverride(null);
  }, []);

  const hydrate = useCallback((file: any, type: 'receipt' | 'invoice') => {
    const dateStr = getEditDateString(file, type);
    const source = file?.json_data ?? file;
    const capturedPrinted = printedTotalFromSource(source);
    setForm({
      store_name: getStoreName(file, type),
      total_amount: getAmountString(file),
      date: dateStr,
      category: getCategory(file) || 'Uncategorized',
    });
    setItems(extractLineItems(file));
    setExtras(
      discoverCapturedExtras(source).map((extra) => ({ ...extra, amount: formatMoney(extra.amount) }))
    );
    setExtrasSource(source);
    setPrintedTotal(capturedPrinted == null ? '' : formatMoney(capturedPrinted));
    setRemainderOverride(remainderFromSource(source));
    setItemsExpanded(false);
    setAutoCalculate(autoCalculateFromSource(source));
    const parsed = dateStr ? parseLocalDateString(dateStr) : null;
    setDatePickerValue(parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date());
  }, []);

  useEffect(() => {
    if (!visible || fileId == null) return;
    let cancelled = false;
    const type: 'receipt' | 'invoice' = fileKind === 'invoice' ? 'invoice' : 'receipt';
    setEditType(type);
    setShowDatePicker(false);
    setLoading(true);
    (async () => {
      try {
        const meta: any = await apiClient.getFileById(fileId, workspaceId);
        if (cancelled) return;
        const file = meta?.file || meta?.data || meta;
        hydrate(file, type);
      } catch {
        if (!cancelled) Alert.alert('Error', 'Failed to load receipt details');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, fileId, fileKind, workspaceId, hydrate]);

  const handleClose = () => {
    setShowDatePicker(false);
    onClose();
  };

  const handleSave = async () => {
    if (fileId == null) {
      Alert.alert('Error', 'Cannot save: file ID not found.');
      return;
    }
    setSaving(true);
    try {
      const persistedItems = items
        .filter((item) => item.name.trim() || parseMoney(item.price) !== 0)
        .map((item) => {
          const row: Record<string, unknown> = {
            quantity: parseMoney(item.quantity) || 1,
            name: item.name.trim(),
            price: parseMoney(item.price),
          };
          if (item.useExtended) row.line_total = parseMoney(item.price);
          if (item.taxAmount != null && item.taxAmount !== '') {
            row.tax_amount = parseMoney(item.taxAmount);
          }
          return row;
        });
      const totalAmount = autoCalculate ? formatMoney(calc.displayTotal) : form.total_amount;
      const correctionData: Record<string, unknown> = {
        file_kind: editType,
        category: form.category || 'Uncategorized',
        items: persistedItems,
        total_amount: totalAmount || undefined,
        ...extraClearPayload(extrasSource, extrasForCalc),
        ...extrasToSavePayload(extrasForCalc),
        [RECEIPT_CALC_META.printedTotal]: printedTotalNum,
        [RECEIPT_CALC_META.calculatedTotal]: calc.calculatedBeforeRemainder,
        [RECEIPT_CALC_META.remainder]: calc.remainder,
        [RECEIPT_CALC_META.autoCalculate]: autoCalculate,
      };
      if (editType === 'receipt') {
        correctionData.store_name = form.store_name || undefined;
        correctionData.date = form.date ? localDateStringToUTCISO(form.date) : undefined;
      } else {
        correctionData.vendor_name = form.store_name || undefined;
        correctionData.due_date = form.date ? localDateStringToUTCISO(form.date) : undefined;
      }
      const response = await apiClient.correctFileData(fileId, correctionData);
      if (response.success) {
        Alert.alert('Success', 'Saved successfully');
        onSaved?.();
        handleClose();
      } else {
        Alert.alert('Error', response.message || 'Failed to save');
      }
    } catch {
      Alert.alert('Error', 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const confirmSave = () => {
    Alert.alert('Save changes?', 'Are you sure you want to save these changes?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Save', onPress: () => void handleSave() },
    ]);
  };

  const handleDateChange = (_event: any, selectedDate?: Date) => {
    if (Platform.OS === 'android') {
      setShowDatePicker(false);
      if (_event?.type === 'set' && selectedDate) {
        setDatePickerValue(selectedDate);
        setForm((f) => ({ ...f, date: formatDateLocal(selectedDate) }));
      }
      return;
    }
    if (selectedDate) {
      setDatePickerValue(selectedDate);
      setForm((f) => ({ ...f, date: formatDateLocal(selectedDate) }));
    }
  };

  const updateItem = (key: string, field: keyof Omit<ReceiptLineItem, 'key'>, value: string) => {
    applyItems(items.map((item) => (item.key === key ? { ...item, [field]: value } : item)));
  };

  const sheetVisible = visible && !showDatePicker;
  const inputColors = {
    borderColor: colors.border,
    color: colors.text,
    backgroundColor: colors.inputBackground,
  };

  return (
    <>
      <MinimizableBottomSheet
        visible={sheetVisible}
        onClose={handleClose}
        title={editType === 'invoice' ? 'Edit Invoice' : 'Edit Receipt'}
        heightRatio={0.85}
      >
        {loading ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator size="large" color={colors.primary} />
          </View>
        ) : (
          <>
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.scrollContent}
              keyboardShouldPersistTaps="handled"
              bounces
            >
              {fileId != null ? (
                <View style={[styles.row, styles.clientsRow]}>
                  <Text style={[styles.label, { color: colors.text, marginBottom: 0 }]}>Clients</Text>
                  <ClientsButton itemType="file" itemId={fileId} allowCreate compact />
                </View>
              ) : null}
              <View style={styles.row}>
                <Text style={[styles.label, { color: colors.text }]}>
                  {editType === 'invoice' ? 'Vendor name' : 'Store name'}
                </Text>
                <TextInput
                  style={[styles.input, inputColors]}
                  value={form.store_name}
                  onChangeText={(t) => setForm((f) => ({ ...f, store_name: t }))}
                  placeholder={editType === 'invoice' ? 'Vendor name' : 'Store name'}
                  placeholderTextColor={colors.textLight}
                />
              </View>

              <View style={styles.row}>
                <View style={styles.itemsHeader}>
                  <TouchableOpacity
                    style={styles.itemsToggle}
                    onPress={() => setItemsExpanded((open) => !open)}
                    accessibilityRole="button"
                    accessibilityLabel={itemsExpanded ? 'Collapse items' : 'Expand items'}
                  >
                    <Ionicons
                      name={itemsExpanded ? 'chevron-down' : 'chevron-forward'}
                      size={18}
                      color={colors.text}
                    />
                    <Text style={[styles.itemsToggleText, { color: colors.text }]}>
                      Items{items.length ? ` (${items.length})` : ''}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => {
                      setItemsExpanded(true);
                      applyItems([...items, emptyLineItem()]);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Add item"
                    style={styles.addItemBtn}
                  >
                    <Ionicons name="add" size={22} color={colors.primary} />
                  </TouchableOpacity>
                </View>
                {itemsExpanded ? (
                  <View style={[styles.itemsBody, { borderColor: colors.border }]}>
                    <View style={styles.autoCalcRow}>
                      <Text style={[styles.autoCalcLabel, { color: colors.text }]}>Auto-calculate</Text>
                      <Switch
                        value={autoCalculate}
                        onValueChange={(on) => {
                          setAutoCalculate(on);
                          if (on) {
                            setForm((f) => ({ ...f, total_amount: formatMoney(calc.displayTotal) }));
                          }
                        }}
                        trackColor={{ false: colors.switchTrackOff, true: colors.switchTrackOn }}
                        thumbColor={colors.switchThumbAndroid(autoCalculate)}
                        ios_backgroundColor={colors.switchTrackOff}
                      />
                    </View>
                    {items.length === 0 ? (
                      <Text style={[styles.emptyItems, { color: colors.textLight }]}>No line items captured</Text>
                    ) : (
                      items.map((item) => (
                        <View key={item.key} style={styles.itemBlock}>
                          <View style={styles.itemRow}>
                            <TextInput
                              style={[styles.input, styles.qtyInput, inputColors]}
                              value={item.quantity}
                              onChangeText={(t) => updateItem(item.key, 'quantity', t)}
                              keyboardType="decimal-pad"
                              placeholder="1"
                              placeholderTextColor={colors.textLight}
                            />
                            <TextInput
                              style={[styles.input, styles.nameInput, inputColors]}
                              value={item.name}
                              onChangeText={(t) => updateItem(item.key, 'name', t)}
                              placeholder="Item"
                              placeholderTextColor={colors.textLight}
                            />
                            <TextInput
                              style={[styles.input, styles.priceInput, inputColors]}
                              value={item.price}
                              onChangeText={(t) => updateItem(item.key, 'price', t)}
                              keyboardType="decimal-pad"
                              placeholder="0.00"
                              placeholderTextColor={colors.textLight}
                            />
                            <TouchableOpacity
                              onPress={() => applyItems(items.filter((row) => row.key !== item.key))}
                              accessibilityRole="button"
                              accessibilityLabel="Remove item"
                              style={styles.removeItemBtn}
                            >
                              <Ionicons name="close" size={18} color="#EF4444" />
                            </TouchableOpacity>
                          </View>
                          {item.taxAmount != null ? (
                            <View style={styles.itemTaxRow}>
                              <Text style={[styles.extraLabel, { color: colors.textSecondary }]}>Item tax</Text>
                              <TextInput
                                style={[styles.input, styles.extraAmountInput, inputColors]}
                                value={item.taxAmount}
                                onChangeText={(t) => updateItem(item.key, 'taxAmount', t)}
                                keyboardType="decimal-pad"
                                placeholder="0.00"
                                placeholderTextColor={colors.textLight}
                              />
                            </View>
                          ) : null}
                        </View>
                      ))
                    )}
                  </View>
                ) : null}
              </View>

              {extras.length || (calc.remainder != null && calc.remainder !== 0) ? (
                <View style={styles.row}>
                  {extras.map((extra) => (
                    <View key={extra.key} style={styles.extraRow}>
                      <Text style={[styles.extraLabel, { color: colors.text }]}>{extra.label}</Text>
                      <TextInput
                        style={[styles.input, styles.extraAmountInput, inputColors]}
                        value={extra.amount}
                        onChangeText={(t) => {
                          applyExtras(
                            extras.map((row) =>
                              row.key === extra.key ? { ...row, amount: t } : row
                            )
                          );
                        }}
                        keyboardType="decimal-pad"
                        placeholder="0.00"
                        placeholderTextColor={colors.textLight}
                      />
                      <TouchableOpacity
                        onPress={() => applyExtras(extras.filter((row) => row.key !== extra.key))}
                        accessibilityRole="button"
                        accessibilityLabel={`Remove ${extra.label}`}
                        style={styles.removeItemBtn}
                      >
                        <Ionicons name="close" size={18} color="#EF4444" />
                      </TouchableOpacity>
                    </View>
                  ))}
                  {calc.remainder != null && calc.remainder !== 0 ? (
                    <View style={styles.extraRow}>
                      <Text style={[styles.extraLabel, { color: colors.text }]}>Unclassified</Text>
                      <TextInput
                        style={[styles.input, styles.extraAmountInput, inputColors]}
                        value={
                          remainderOverride != null
                            ? String(remainderOverride)
                            : formatMoney(calc.remainder)
                        }
                        onChangeText={(t) => setRemainderOverride(parseMoney(t))}
                        keyboardType="decimal-pad"
                        placeholder="0.00"
                        placeholderTextColor={colors.textLight}
                      />
                      <TouchableOpacity
                        onPress={() => setRemainderOverride(0)}
                        accessibilityRole="button"
                        accessibilityLabel="Remove unclassified amount"
                        style={styles.removeItemBtn}
                      >
                        <Ionicons name="close" size={18} color="#EF4444" />
                      </TouchableOpacity>
                    </View>
                  ) : null}
                </View>
              ) : null}

              <View style={styles.rowDateAmount}>
                <View style={[styles.row, { flex: 1, paddingHorizontal: 0 }]}>
                  <Text style={[styles.label, { color: colors.text }]}>Date</Text>
                  <TouchableOpacity
                    style={[styles.input, styles.dateTouchable, inputColors]}
                    activeOpacity={0.7}
                    onPress={() => {
                      const useToday = isEpochOrEmptyDate(form.date);
                      const d = !useToday && form.date ? parseLocalDateString(form.date) : null;
                      setDatePickerValue(useToday || !d || Number.isNaN(d.getTime()) ? new Date() : d);
                      setShowDatePicker(true);
                    }}
                  >
                    <View style={styles.dateTextWrap}>
                      <Text
                        style={[
                          styles.dateText,
                          { color: form.date ? colors.text : colors.textLight },
                        ]}
                        numberOfLines={1}
                      >
                        {form.date || 'Select date'}
                      </Text>
                    </View>
                    <Ionicons name="calendar-outline" size={20} color={colors.textSecondary} />
                  </TouchableOpacity>
                </View>
                <View style={[styles.row, { flex: 1, paddingHorizontal: 0 }]}>
                  <Text style={[styles.label, { color: colors.text }]}>Total</Text>
                  <TextInput
                    style={[
                      styles.input,
                      inputColors,
                      autoCalculate ? { backgroundColor: colors.surface, color: colors.textSecondary } : null,
                    ]}
                    value={form.total_amount}
                    onChangeText={(t) => setForm((f) => ({ ...f, total_amount: t }))}
                    placeholder="0.00"
                    placeholderTextColor={colors.textLight}
                    keyboardType="decimal-pad"
                    editable={!autoCalculate}
                  />
                </View>
              </View>
              <View style={styles.row}>
                <Text style={[styles.label, { color: colors.text }]}>Printed total</Text>
                <TextInput
                  style={[styles.input, inputColors]}
                  value={printedTotal}
                  onChangeText={(t) => {
                    setPrintedTotal(t);
                    setRemainderOverride(null);
                  }}
                  placeholder="None"
                  placeholderTextColor={colors.textLight}
                  keyboardType="decimal-pad"
                />
              </View>
              <View style={styles.row}>
                <Text style={[styles.label, { color: colors.text }]}>Category</Text>
                <View style={styles.categoryList}>
                  {RECEIPT_CATEGORIES.map((cat) => {
                    const selected = form.category === cat;
                    return (
                      <TouchableOpacity
                        key={cat}
                        style={[
                          styles.categoryChip,
                          { backgroundColor: selected ? '#007AFF' : colors.surface },
                        ]}
                        onPress={() => setForm((f) => ({ ...f, category: cat }))}
                      >
                        <Text
                          style={[
                            styles.categoryChipText,
                            { color: selected ? '#fff' : colors.text },
                          ]}
                        >
                          {cat}
                        </Text>
                        {selected ? <Ionicons name="checkmark" size={18} color="#fff" /> : null}
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            </ScrollView>
            <View style={[styles.actions, { borderTopColor: colors.borderLight }]}>
              <TouchableOpacity
                style={[styles.button, { backgroundColor: colors.surface }]}
                onPress={handleClose}
                disabled={saving}
              >
                <Text style={[styles.buttonText, { color: colors.text }]}>Cancel</Text>
              </TouchableOpacity>
              <FeedbackTouchable
                style={[styles.button, styles.saveButton]}
                onPress={confirmSave}
                disabled={saving}
                loading={saving}
                spinnerColor="#fff"
              >
                <Text style={[styles.buttonText, { color: '#fff' }]}>Save</Text>
              </FeedbackTouchable>
            </View>
          </>
        )}
      </MinimizableBottomSheet>

      {showDatePicker && Platform.OS === 'ios' && (
        <MinimizableBottomSheet
          visible={showDatePicker}
          onClose={() => setShowDatePicker(false)}
          title="Select date"
          sheetHeight={320}
          headerRight={() => (
            <TouchableOpacity onPress={() => setShowDatePicker(false)}>
              <Text style={{ color: colors.primary, fontSize: 16, fontWeight: '600' }}>Done</Text>
            </TouchableOpacity>
          )}
        >
          <DateTimePicker
            value={getValidDate(datePickerValue)}
            mode="date"
            display="spinner"
            minimumDate={DATE_PICKER_MIN}
            maximumDate={DATE_PICKER_MAX}
            onChange={handleDateChange}
            style={{ alignSelf: 'stretch' }}
            textColor={colors.text}
            accentColor={colors.primary}
          />
        </MinimizableBottomSheet>
      )}
      {showDatePicker && Platform.OS !== 'ios' ? (
        <DateTimePicker
          value={getValidDate(datePickerValue)}
          mode="date"
          display="default"
          minimumDate={DATE_PICKER_MIN}
          maximumDate={DATE_PICKER_MAX}
          onChange={handleDateChange}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  loadingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    paddingBottom: 24,
  },
  row: {
    paddingHorizontal: 16,
    marginBottom: 16,
  },
  clientsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  rowDateAmount: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    marginBottom: 16,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  dateTouchable: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  dateTextWrap: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
  },
  dateText: {
    fontSize: 16,
  },
  itemsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  itemsToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    flex: 1,
    paddingVertical: 4,
  },
  itemsToggleText: {
    fontSize: 14,
    fontWeight: '600',
  },
  addItemBtn: {
    padding: 4,
  },
  itemsBody: {
    marginTop: 8,
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
  },
  autoCalcRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  autoCalcLabel: {
    fontSize: 13,
    fontWeight: '500',
  },
  emptyItems: {
    fontSize: 13,
    paddingVertical: 8,
  },
  itemBlock: {
    marginBottom: 8,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  itemTaxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
    paddingLeft: 54,
  },
  extraRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  extraLabel: {
    flex: 1,
    fontSize: 13,
    fontWeight: '500',
  },
  extraAmountInput: {
    width: 88,
    paddingHorizontal: 8,
    fontSize: 14,
  },
  qtyInput: {
    width: 48,
    paddingHorizontal: 6,
    fontSize: 14,
  },
  nameInput: {
    flex: 1,
    paddingHorizontal: 8,
    fontSize: 14,
  },
  priceInput: {
    width: 72,
    paddingHorizontal: 6,
    fontSize: 14,
  },
  removeItemBtn: {
    padding: 4,
  },
  categoryList: {
    marginTop: 4,
  },
  categoryChip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    marginBottom: 8,
  },
  categoryChipText: {
    fontSize: 14,
  },
  actions: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 16,
    paddingBottom: 24,
    borderTopWidth: 1,
  },
  button: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveButton: {
    backgroundColor: '#007AFF',
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
  },
});
