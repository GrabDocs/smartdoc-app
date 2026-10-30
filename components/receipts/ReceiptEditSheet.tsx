import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useThemeColors } from '../../hooks/useThemeColors';
import { apiClient } from '../../services/api';
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
  const numericAmount =
    typeof amount === 'number'
      ? amount
      : typeof amount === 'string'
        ? parseFloat(amount.replace(/[^0-9.-]/g, '')) || 0
        : 0;
  if (numericAmount > 0) return String(numericAmount);
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
  const [datePickerValue, setDatePickerValue] = useState(new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);

  const hydrate = useCallback((file: any, type: 'receipt' | 'invoice') => {
    const dateStr = getEditDateString(file, type);
    setForm({
      store_name: getStoreName(file, type),
      total_amount: getAmountString(file),
      date: dateStr,
      category: getCategory(file) || 'Uncategorized',
    });
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
      const correctionData: Record<string, unknown> = {
        file_kind: editType,
        category: form.category || 'Uncategorized',
      };
      if (editType === 'receipt') {
        correctionData.store_name = form.store_name || undefined;
        correctionData.total_amount = form.total_amount || undefined;
        correctionData.date = form.date ? localDateStringToUTCISO(form.date) : undefined;
      } else {
        correctionData.vendor_name = form.store_name || undefined;
        correctionData.total_amount = form.total_amount || undefined;
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

  const sheetVisible = visible && !showDatePicker;

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
                  style={[
                    styles.input,
                    {
                      borderColor: colors.border,
                      color: colors.text,
                      backgroundColor: colors.inputBackground,
                    },
                  ]}
                  value={form.store_name}
                  onChangeText={(t) => setForm((f) => ({ ...f, store_name: t }))}
                  placeholder={editType === 'invoice' ? 'Vendor name' : 'Store name'}
                  placeholderTextColor={colors.textLight}
                />
              </View>
              <View style={styles.rowDateAmount}>
                <View style={[styles.row, { flex: 1, paddingHorizontal: 0 }]}>
                  <Text style={[styles.label, { color: colors.text }]}>Date</Text>
                  <TouchableOpacity
                    style={[
                      styles.input,
                      styles.dateTouchable,
                      {
                        borderColor: colors.border,
                        backgroundColor: colors.inputBackground,
                      },
                    ]}
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
                      {
                        borderColor: colors.border,
                        color: colors.text,
                        backgroundColor: colors.inputBackground,
                      },
                    ]}
                    value={form.total_amount}
                    onChangeText={(t) => setForm((f) => ({ ...f, total_amount: t }))}
                    placeholder="0.00"
                    placeholderTextColor={colors.textLight}
                    keyboardType="decimal-pad"
                  />
                </View>
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
