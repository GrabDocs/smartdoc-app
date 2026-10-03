import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import * as FileSystem from 'expo-file-system/legacy';
import { useFocusEffect, useRouter } from 'expo-router';
import * as Sharing from 'expo-sharing';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Dimensions,
    Keyboard,
    KeyboardAvoidingView,
    Platform,
    RefreshControl,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import AdaptiveListPickerModal from '../../components/AdaptiveListPickerModal';
import ClientsButton from '../../components/clients/ClientsButton';
import DocumentViewer from '../../components/DocumentViewer';
import { FeedbackTouchable } from '../../components/FeedbackTouchable';
import MinimizableBottomSheet from '../../components/MinimizableBottomSheet';
import { useMinimizableSheet } from '../../hooks/useMinimizableSheet';
import { useThemeColors } from '../../hooks/useThemeColors';
import { apiClient, type WebAnalysisDownloadReportBody } from '../../services/api';
import { useFileStore } from '../../stores/fileStore';
import { UploadOptionsModal } from '../components/UploadOptionsModal';
import { useAuth } from '../context/auth';

import AppBackButton from '../../components/AppBackButton';
import AppHeaderTitle from '../../components/AppHeaderTitle';

/** Rows shown initially in Recent Receipts / Recent Invoices; full lists stay in state for charts & summaries. */
const FINANCIALS_LIST_PAGE_SIZE = 10;
/** When analytics has no receipt/invoice rows, mobile files fallback still pulls a single page (not unbounded). */
const FINANCIALS_FALLBACK_FETCH_SIZE = 50;
/** Auto-expand list when user scrolls near bottom (pixels). */
const FINANCIALS_AUTO_LOAD_THRESHOLD_PX = 120;

interface ComprehensiveAnalytics {
  receipts: {
    summary: {
      total_receipts: number;
      total_amount: number;
      average_amount: number;
      period_days: number;
      total_tax?: number;
      recent_30d?: number;
      recent_90d?: number;
    };
    categories: Array<{
      category: string;
      count: number;
      total_amount: number;
      percentage: number;
    }>;
    timeline: Array<{
      month: string;
      count: number;
      total_amount: number;
    }>;
    payment_methods: Array<{
      method: string;
      count: number;
      total_amount: number;
    }>;
    top_businesses: Array<{
      business: string;
      count: number;
      total_amount: number;
    }>;
  };
  files: {
    types: Array<{
      type: string;
      count: number;
      percentage: number;
    }>;
    upload_trends: Array<{
      date: string;
      count: number;
    }>;
  };
  workspaces: {
    total_workspaces: number;
    workspace_details: Array<{
      name: string;
      file_count: number;
      member_count: number;
    }>;
  };
  forms: {
    total_forms: number;
    total_responses: number;
    form_details: Array<{
      name: string;
      response_count: number;
    }>;
  };
  summary: {
    period: string;
    period_days: number;
    total_files: number;
    total_documents?: number;
    total_chats?: number;
    total_size_mb: number;
    total_receipts: number;
    total_spending: number;
    total_workspaces: number;
    total_forms: number;
    total_invoices?: number;
    total_invoice_amount?: number;
  };
  invoices?: {
    overview: {
      total_invoices: number;
      total_amount: number;
      paid_amount: number;
      unpaid_amount: number;
      partial_amount: number;
      avg_invoice_amount: number;
      paid_count: number;
      unpaid_count: number;
      partial_count: number;
      overdue_count: number;
      overdue_amount: number;
    };
    payment_distribution: Array<{status: string; count: number; total_amount: number; percentage: number}>;
    category_distribution: Array<{category: string; count: number; total_amount: number; avg_amount: number; percentage: number}>;
    monthly_trends: Array<{month: string; month_key: string; count: number; total_amount: number; paid_count: number; unpaid_count: number}>;
    top_vendors: Array<{vendor_name: string; count: number; total_amount: number; avg_amount: number}>;
    aging_buckets: {
      '0-30': {count: number; amount: number};
      '31-60': {count: number; amount: number};
      '61-90': {count: number; amount: number};
      '90+': {count: number; amount: number};
    };
  };
  recentActivity?: string[];
}

const { width } = Dimensions.get('window');

/** Get numeric total amount from a receipt or invoice item (file or analytics shape). Returns 0 if missing/invalid. */
function getAmount(item: any): number {
  const data = item?.json_data ?? item;
  const amount = data?.total_amount ?? data?.amount ?? data?.invoice_amount ?? data?.total ?? item?.amount ?? item?.total_amount ?? 0;
  if (typeof amount === 'number') return amount;
  if (typeof amount === 'string') return parseFloat(amount.replace(/[^0-9.-]/g, '')) || 0;
  return 0;
}

function strTrim(v: unknown): string {
  if (v == null) return '';
  const s = String(v).trim();
  return s;
}

/** Store / merchant from structured fields only (matches web + mobile file shapes; excludes filename). */
function getReceiptPrimaryStoreName(receipt: any): string {
  const j = receipt?.json_data;
  const rd =
    j?.receipt_data != null && typeof j.receipt_data === 'object'
      ? (j.receipt_data as Record<string, unknown>)
      : null;
  const candidates = [
    receipt?.store_name,
    receipt?.business_name,
    receipt?.merchant_name,
    receipt?.vendor_name,
    j?.store_name,
    j?.business_name,
    j?.merchant_name,
    j?.vendor_name,
    rd?.store_name,
    rd?.business_name,
    rd?.merchant_name,
    rd?.vendor_name,
  ];
  for (const c of candidates) {
    const s = strTrim(c);
    if (s) return s;
  }
  return '';
}

/** Title for receipt rows: primary store name, else file name, else placeholder. */
function getReceiptListTitle(receipt: any, index: number): string {
  const primary = getReceiptPrimaryStoreName(receipt);
  if (primary) return primary;
  for (const c of [receipt?.original_filename, receipt?.filename, receipt?.name]) {
    const s = strTrim(c);
    if (s) return s;
  }
  return `Receipt ${index + 1}`;
}

/** Payment + location snippet for subtitle (optional second line). */
function getReceiptSecondaryMetaLine(receipt: any): string | null {
  const j = receipt?.json_data;
  const rd =
    j?.receipt_data != null && typeof j.receipt_data === 'object'
      ? (j.receipt_data as Record<string, unknown>)
      : null;
  const payment =
    strTrim(j?.payment_method) ||
    strTrim(j?.payment_type) ||
    strTrim(receipt?.payment_method) ||
    (rd ? strTrim(rd.payment_method) || strTrim(rd.payment_type) : '');
  const addr =
    strTrim(j?.store_address) ||
    strTrim(j?.address) ||
    strTrim(j?.city) ||
    (rd ? strTrim(rd.store_address) || strTrim(rd.address) || strTrim(rd.city) : '');
  const addrDisplay = addr.length > 40 ? `${addr.slice(0, 37)}…` : addr;
  const bits = [payment, addrDisplay].filter(Boolean);
  if (bits.length === 0) return null;
  return bits.join(' · ');
}

export default function AnalyticsDashboard() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const colors = useThemeColors();

  const themeStyles = useMemo(
    () =>
      StyleSheet.create({
        content: { backgroundColor: colors.background },
        section: { backgroundColor: colors.card },
        timePeriodContainer: { backgroundColor: colors.card },
        timePeriodButton: { backgroundColor: colors.surface },
        timePeriodButtonActive: { backgroundColor: colors.primary },
        timePeriodButtonText: { color: colors.textSecondary },
        timePeriodButtonLabelActive: { color: '#fff' },
        categoryFilterContainer: { backgroundColor: colors.surface },
        categoryDropdown: {
          backgroundColor: colors.inputBackground,
          borderColor: colors.border,
        },
        categoryDropdownText: { color: colors.text },
        categoryFilterLabel: { color: colors.text },
        categoryFilterNote: { color: colors.textSecondary },
        statCard: { backgroundColor: colors.surface },
        statCardTitle: { color: colors.textSecondary },
        statCardValue: { color: colors.text },
        statCardSubtitle: { color: colors.textSecondary },
        sectionTitle: { color: colors.text },
        subsectionTitle: { color: colors.text },
        categoryBarTitle: { color: colors.text },
        categoryBarContainer: { backgroundColor: colors.borderLight },
        categoryBarPercentage: { color: colors.textSecondary },
        donutLegendText: { color: colors.text },
        categoryBreakdownList: { borderTopColor: colors.border },
        categoryBreakdownTitle: { color: colors.text },
        categoryBreakdownItem: { borderBottomColor: colors.borderLight },
        categoryBreakdownName: { color: colors.text },
        categoryBreakdownPercent: { color: colors.textSecondary },
        categoryBreakdownCount: { color: colors.textLight },
        categoryProgressBar: { backgroundColor: colors.border },
        compactListItem: { backgroundColor: colors.surface },
        compactListName: { color: colors.text },
        compactListSubtext: { color: colors.textSecondary },
        compactListMeta: { color: colors.textLight },
        compactListAmount: { color: colors.text },
        compactChartLabel: { color: colors.text },
        compactChartBar: { backgroundColor: colors.borderLight },
        compactChartAmount: { color: colors.text },
        compactChartCount: { color: colors.textSecondary },
        trendBarLabel: { color: colors.textSecondary },
        trendValueAmount: { color: colors.text },
        trendValueCount: { color: colors.textSecondary },
        sizeDistributionLabel: { color: colors.text },
        sizeDistributionBar: { backgroundColor: colors.borderLight },
        sizeDistributionCount: { color: colors.textSecondary },
        emptyText: { color: colors.textSecondary },
        emptySubtext: { color: colors.textLight },
        tabText: { color: colors.textSecondary },
        tabTextActive: { color: colors.primary },
        tabActive: { borderBottomColor: colors.primary },
        modalContent: { backgroundColor: colors.card },
        modalHeader: { borderBottomColor: colors.borderLight },
        modalTitle: { color: colors.text },
        categoryModalItem: { borderBottomColor: colors.borderLight },
        categoryItemText: { color: colors.text },
        modalLoading: {
          backgroundColor: colors.isDark ? 'rgba(0,0,0,0.75)' : 'rgba(255, 255, 255, 0.9)',
        },
        editFormActions: { borderTopColor: colors.borderLight },
        editFormButtonCancel: { backgroundColor: colors.surface },
        editFormLabel: { color: colors.text },
        editFormInput: {
          borderColor: colors.border,
          color: colors.text,
          backgroundColor: colors.inputBackground,
        },
        editFormDateText: { color: colors.text },
        editFormDatePlaceholder: { color: colors.textLight },
        editCategoryChip: { backgroundColor: colors.surface },
        editCategoryChipText: { color: colors.text },
        editFormButtonTextCancel: { color: colors.text },
        filterModalContentBox: { backgroundColor: colors.card },
        filterSectionTitle: { color: colors.text },
        filterOptionButton: { backgroundColor: colors.surface },
        filterOptionText: { color: colors.text },
        filterLabel: { color: colors.textSecondary },
        filterInputLabel: { color: colors.textSecondary },
        filterDatePickerContainer: {
          backgroundColor: colors.inputBackground,
          borderColor: colors.border,
        },
        filterDatePickerLabel: { color: colors.text },
        filterDatePickerPlaceholder: { color: colors.textSecondary },
        dateInput: {
          backgroundColor: colors.inputBackground,
          borderColor: colors.border,
        },
        dateInputText: { color: colors.text },
        dateInputPlaceholder: { color: colors.textLight },
        datePickerModalContent: { backgroundColor: colors.card },
        pickerModalContainer: { backgroundColor: colors.card },
        pickerModalHeader: {
          backgroundColor: colors.card,
          borderBottomColor: colors.border,
        },
        pickerModalContent: { backgroundColor: colors.card },
        pickerModalTitle: { color: colors.text },
        pickerModalCancelButton: { color: colors.textSecondary },
        doneButton: { color: colors.primary },
        amountInput: {
          backgroundColor: colors.inputBackground,
          borderColor: colors.border,
          color: colors.text,
        },
        textInput: {
          backgroundColor: colors.inputBackground,
          borderColor: colors.border,
          color: colors.text,
        },
        filterButtonSecondary: {
          backgroundColor: colors.surface,
          borderColor: colors.border,
        },
        filterButtonTextSecondary: { color: colors.textSecondary },
        loadingText: { color: colors.textSecondary },
        errorText: { color: colors.textSecondary },
        errorSubtext: { color: colors.textLight },
        businessItem: { borderBottomColor: colors.borderLight },
        businessName: { color: colors.text },
        businessStats: { color: colors.textSecondary },
        fileTypeName: { color: colors.text },
        fileTypeCount: { color: colors.textSecondary },
        workspaceItem: { borderBottomColor: colors.borderLight },
        workspaceName: { color: colors.text },
        workspaceStats: { color: colors.textSecondary },
        activityText: { color: colors.text },
        activeFiltersText: { color: colors.primary },
      }),
    [colors]
  );

  const [analytics, setAnalytics] = useState<ComprehensiveAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  /** Default window: last 12 months from today (matches common “1 year” financial view). */
  const [timePeriod, setTimePeriod] = useState('365');
  const [selectedCategory, setSelectedCategory] = useState('All'); // Category filter for receipts
  const [selectedInvoiceCategory, setSelectedInvoiceCategory] = useState('All'); // Category filter for invoices
  const [activeTab, setActiveTab] = useState<'receipts' | 'invoices'>('receipts');
  const [recentReceipts, setRecentReceipts] = useState<any[]>([]);
  const [recentInvoices, setRecentInvoices] = useState<any[]>([]);
  const [receiptListDisplayLimit, setReceiptListDisplayLimit] = useState(FINANCIALS_LIST_PAGE_SIZE);
  const [invoiceListDisplayLimit, setInvoiceListDisplayLimit] = useState(FINANCIALS_LIST_PAGE_SIZE);
  const lastAutoLoadAtRef = useRef(0);

  const { uploadFromGallery, uploadFromDocuments } = useFileStore();
  const uploadSheet = useMinimizableSheet();
  const [isUploading, setIsUploading] = useState(false);
  const [uploadTimeout, setUploadTimeout] = useState<number | null>(null);
  const [isOpeningPicker, setIsOpeningPicker] = useState(false);
  
  // Advanced filter states
  const [showAdvancedFilterModal, setShowAdvancedFilterModal] = useState(false);
  const [customDateFrom, setCustomDateFrom] = useState<string>('');
  const [customDateTo, setCustomDateTo] = useState<string>('');
  const [showDateFromPicker, setShowDateFromPicker] = useState(false);
  const [showDateToPicker, setShowDateToPicker] = useState(false);
  const [dateFromPickerValue, setDateFromPickerValue] = useState<Date>(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return d;
  });
  const [dateToPickerValue, setDateToPickerValue] = useState<Date>(() => new Date());
  const [amountMin, setAmountMin] = useState<string>('');
  const [amountMax, setAmountMax] = useState<string>('');
  const [storeVendorName, setStoreVendorName] = useState<string>('');
  const [useCustomFilters, setUseCustomFilters] = useState(false);
  /** Draft values in Advanced Filter modal; only applied on "Apply Filters" so typing doesn't refresh. */
  const [draftStoreVendorName, setDraftStoreVendorName] = useState<string>('');
  const [draftAmountMin, setDraftAmountMin] = useState<string>('');
  const [draftAmountMax, setDraftAmountMax] = useState<string>('');
  const [draftCustomDateFrom, setDraftCustomDateFrom] = useState<string>('');
  const [draftCustomDateTo, setDraftCustomDateTo] = useState<string>('');
  /** When opening date picker from Advanced Filter modal, update draft instead of applied. */
  const datePickerEditingDraftRef = useRef<'from' | 'to' | null>(null);
  /** iOS: commit draft only on Done; ref true = From/To picker was opened from Advanced Filter. */
  const fromPickerForDraftRef = useRef(false);
  const toPickerForDraftRef = useRef(false);
  /** iOS: reopen Advanced Filter modal after date picker closes (avoids two modals = freeze) */
  const [reopenAdvancedFilterAfterDatePicker, setReopenAdvancedFilterAfterDatePicker] = useState(false);
  /** True when we're reopening the Advanced Filter modal after iOS date picker; skip overwriting draft dates in sync. */
  const reopeningAfterDatePickerRef = useRef(false);

  /** Draft 1yr preset in Advanced Filter; applied only when user taps Apply Filters. */
  const [draftUseOneYear, setDraftUseOneYear] = useState(false);

  /** When Advanced Filter modal opens, sync draft from current applied values so typing doesn't refresh until Apply. */
  useEffect(() => {
    if (showAdvancedFilterModal) {
      if (reopeningAfterDatePickerRef.current) {
        reopeningAfterDatePickerRef.current = false;
        // Don't overwrite draft dates - they were just set by the date picker handler
        setDraftStoreVendorName(storeVendorName);
        setDraftAmountMin(amountMin);
        setDraftAmountMax(amountMax);
        setDraftUseOneYear(!useCustomFilters && timePeriod === '365');
      } else {
        setDraftStoreVendorName(storeVendorName);
        setDraftAmountMin(amountMin);
        setDraftAmountMax(amountMax);
        setDraftCustomDateFrom(customDateFrom);
        setDraftCustomDateTo(customDateTo);
        setDraftUseOneYear(!useCustomFilters && timePeriod === '365');
      }
    }
  }, [showAdvancedFilterModal]);

  /** Format a Date as YYYY-MM-DD in local time (user's calendar date). Use when saving so the selected date is stored correctly. */
  const formatDateLocal = (date: Date): string => {
    if (Number.isNaN(date.getTime())) return '';
    const y = date.getFullYear();
    const m = date.getMonth() + 1;
    const d = date.getDate();
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };

  /** Parse YYYY-MM-DD to a Date at local midnight. Use when loading so the picker shows the correct calendar date. */
  const parseLocalDateString = (str: string): Date | null => {
    if (!str || typeof str !== 'string') return null;
    const parts = str.trim().split('-');
    if (parts.length !== 3) return null;
    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10) - 1;
    const day = parseInt(parts[2], 10);
    if (Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(day)) return null;
    const d = new Date(y, m, day);
    if (Number.isNaN(d.getTime())) return null;
    return d;
  };

  /** Safely convert a value from backend to YYYY-MM-DD in local time for display. Handles ISO (UTC) and date-only strings. */
  const safeToDateString = (raw: unknown): string => {
    if (raw == null) return '';
    if (typeof raw === 'string') {
      if (raw.includes('T')) {
        const d = new Date(raw);
        if (!Number.isNaN(d.getTime())) return formatDateLocal(d);
        return '';
      }
      return raw.slice(0, 10); // date-only: treat as calendar date, keep as-is
    }
    const d = new Date(raw as string | number);
    if (!Number.isNaN(d.getTime())) return formatDateLocal(d);
    return '';
  };

  /** Format date from picker for saving: use local calendar date (YYYY-MM-DD) so no off-by-one. */
  const formatDateForInput = (date: Date) => (Number.isNaN(date.getTime()) ? '' : formatDateLocal(date));

  /** Convert local YYYY-MM-DD to UTC ISO (start of that day in user TZ). Use when sending date/due_date to API. */
  const localDateStringToUTCISO = (str: string): string => {
    const d = parseLocalDateString(str);
    return d && !Number.isNaN(d.getTime()) ? d.toISOString() : str;
  };

  /** Convert local YYYY-MM-DD to UTC ISO (end of that day in user TZ). Use for filter date_to so range is inclusive. */
  const localDateStringToEndOfDayUTCISO = (str: string): string => {
    const d = parseLocalDateString(str);
    if (!d || Number.isNaN(d.getTime())) return str;
    const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
    return end.toISOString();
  };

  /** Get [from, to] as YYYY-MM-DD for "last N days" (inclusive). */
  const getLastNDaysRange = (n: number): { from: string; to: string } => {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - n);
    return { from: formatDateLocal(from), to: formatDateLocal(to) };
  };

  /** Human-readable period label: "last 7d" / "last 1yr" or "Jan 15 – Feb 12, 2025" for custom range. */
  const getPeriodLabel = (days: string, fromStr: string, toStr: string, useCustom: boolean): string => {
    if (useCustom && fromStr && toStr) {
      const fromDate = parseLocalDateString(fromStr);
      const toDate = parseLocalDateString(toStr);
      if (fromDate && toDate && !Number.isNaN(fromDate.getTime()) && !Number.isNaN(toDate.getTime())) {
        const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        return `${fmt(fromDate)} – ${fmt(toDate)}`;
      }
    }
    const n = days === '365' ? 365 : parseInt(String(days || '365'), 10) || 365;
    if (n === 7) return 'last 7d';
    if (n === 30) return 'last 30d';
    if (n === 90) return 'last 90d';
    if (n === 365) return 'last 1yr';
    return `last ${n}d`;
  };

  /** True if date (Date or ISO string) falls within [from, to] (local YYYY-MM-DD inclusive). Missing/invalid date is treated as in range (include). */
  const isDateInFilterRange = (itemDate: Date | string | undefined, from: string, to: string): boolean => {
    if (!from && !to) return true;
    const d = itemDate instanceof Date ? itemDate : (typeof itemDate === 'string' ? new Date(itemDate) : undefined);
    if (!d || Number.isNaN(d.getTime())) return true;
    const t = d.getTime();
    if (from) {
      const start = parseLocalDateString(from);
      if (start && !Number.isNaN(start.getTime()) && t < start.getTime()) return false;
    }
    if (to) {
      const toDate = parseLocalDateString(to);
      if (toDate && !Number.isNaN(toDate.getTime())) {
        const end = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate(), 23, 59, 59, 999);
        if (t > end.getTime()) return false;
      }
    }
    return true;
  };

  /** Get item date for filter: document date (top-level or in json_data) or created_at. */
  const getItemDateForFilter = (item: any, isReceipt: boolean): Date | string | undefined => {
    const tx = isReceipt
      ? (item?.date ?? item?.json_data?.date ?? item?.json_data?.receipt_data?.date)
      : (item?.invoice_date ?? item?.date ?? item?.json_data?.date ?? item?.json_data?.invoice_date);
    if (tx) return tx;
    return item?.created_at;
  };

  /** True if receipt store name or invoice vendor name matches search (case-insensitive). */
  const matchesStoreVendorFilter = (item: any, isReceipt: boolean): boolean => {
    if (!storeVendorName || !storeVendorName.trim()) return true;
    const search = storeVendorName.trim().toLowerCase();
    const name = isReceipt
      ? (getReceiptPrimaryStoreName(item) ||
          strTrim(item?.original_filename) ||
          strTrim(item?.filename) ||
          strTrim(item?.name) ||
          '')
      : (item?.vendor_name || item?.business_name || item?.vendor || item?.json_data?.vendor_name || item?.json_data?.invoice_data?.vendor_name || item?.json_data?.merchant_name || '');
    const nameStr = (typeof name === 'string' ? name : '').toLowerCase();
    return nameStr.includes(search);
  };

  /** Return a valid Date for DateTimePicker; never pass Invalid Date (causes calendar not to display). */
  const getValidDate = (d: Date | undefined): Date => {
    if (d != null && !Number.isNaN(d.getTime())) return d;
    return new Date();
  };

  /** Wide min/max for filter date pickers so the spinner shows all months (not just Jan–Feb). */
  const filterDateMin = (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 20);
    return d;
  })();
  const filterDateMax = (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() + 1);
    return d;
  })();

  const handleDateFromChange = (event: any, selectedDate?: Date) => {
    if (!selectedDate) return;
    const formatted = formatDateForInput(selectedDate);
    const updateDraft = datePickerEditingDraftRef.current === 'from';
    if (Platform.OS === 'android') {
      setShowDateFromPicker(false);
      if (event?.type === 'set') {
        setDateFromPickerValue(selectedDate);
        if (updateDraft) { datePickerEditingDraftRef.current = null; setDraftCustomDateFrom(formatted); }
        else setCustomDateFrom(formatted);
      }
    } else {
      // iOS: only update spinner value; commit to draft/applied when user taps Done
      setDateFromPickerValue(selectedDate);
    }
  };

  const handleDateToChange = (event: any, selectedDate?: Date) => {
    if (!selectedDate) return;
    const formatted = formatDateForInput(selectedDate);
    const updateDraft = datePickerEditingDraftRef.current === 'to';
    if (Platform.OS === 'android') {
      setShowDateToPicker(false);
      if (event?.type === 'set') {
        setDateToPickerValue(selectedDate);
        if (updateDraft) { datePickerEditingDraftRef.current = null; setDraftCustomDateTo(formatted); }
        else setCustomDateTo(formatted);
      }
    } else {
      // iOS: only update spinner value; commit to draft/applied when user taps Done
      setDateToPickerValue(selectedDate);
    }
  };

  /** iOS From date picker Done: commit current dateFromPickerValue to draft or applied, then close. */
  const handleDateFromPickerDone = () => {
    const formatted = formatDateForInput(dateFromPickerValue);
    if (fromPickerForDraftRef.current) {
      fromPickerForDraftRef.current = false;
      datePickerEditingDraftRef.current = null;
      setDraftCustomDateFrom(formatted);
    } else {
      setCustomDateFrom(formatted);
    }
    setShowDateFromPicker(false);
    if (reopenAdvancedFilterAfterDatePicker) {
      reopeningAfterDatePickerRef.current = true;
      setReopenAdvancedFilterAfterDatePicker(false);
      setTimeout(() => setShowAdvancedFilterModal(true), 100);
    }
  };

  /** iOS To date picker Done: commit current dateToPickerValue to draft or applied, then close. */
  const handleDateToPickerDone = () => {
    const formatted = formatDateForInput(dateToPickerValue);
    if (toPickerForDraftRef.current) {
      toPickerForDraftRef.current = false;
      datePickerEditingDraftRef.current = null;
      setDraftCustomDateTo(formatted);
    } else {
      setCustomDateTo(formatted);
    }
    setShowDateToPicker(false);
    if (reopenAdvancedFilterAfterDatePicker) {
      reopeningAfterDatePickerRef.current = true;
      setReopenAdvancedFilterAfterDatePicker(false);
      setTimeout(() => setShowAdvancedFilterModal(true), 100);
    }
  };
  
  // Category selection modal states
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [showReceiptCategoryFilterModal, setShowReceiptCategoryFilterModal] = useState(false);
  const [showInvoiceCategoryFilterModal, setShowInvoiceCategoryFilterModal] = useState(false);
  const [selectedReceipt, setSelectedReceipt] = useState<any>(null);
  const [categorizingReceipt, setCategorizingReceipt] = useState(false);
  
  // Payment status selection modal states
  const [showPaymentStatusModal, setShowPaymentStatusModal] = useState(false);
  const [selectedInvoice, setSelectedInvoice] = useState<any>(null);
  const [updatingPaymentStatus, setUpdatingPaymentStatus] = useState(false);

  // Edit receipt/invoice modal (store name, date, amount, category) - same endpoint as web
  const [showEditModal, setShowEditModal] = useState(false);
  const [editItem, setEditItem] = useState<any>(null);
  const [editType, setEditType] = useState<'receipt' | 'invoice'>('receipt');
  const [editForm, setEditForm] = useState<{ store_name: string; total_amount: string; date: string; category: string }>({
    store_name: '',
    total_amount: '',
    date: '',
    category: 'Uncategorized',
  });
  const [savingEdit, setSavingEdit] = useState(false);
  const [showEditDatePicker, setShowEditDatePicker] = useState(false);
  const [editDatePickerValue, setEditDatePickerValue] = useState<Date>(() => new Date());

  // Document viewer (View opens file; row tap opens edit modal)
  const [showDocumentViewer, setShowDocumentViewer] = useState(false);
  const [selectedFileForView, setSelectedFileForView] = useState<{
    fileId: string;
    fileName: string;
    fileType: string;
    fileCategory?: string;
  } | null>(null);

  /** Derive file type for DocumentViewer from filename extension. */
  const getFileTypeFromFilename = (filename: string | undefined) => {
    const name = (filename || '').toLowerCase();
    const ext = name.split('.').pop() || '';
    if (['pdf'].includes(ext)) return 'pdf';
    if (['doc', 'docx'].includes(ext)) return ext;
    if (['xls', 'xlsx'].includes(ext)) return ext;
    if (['ppt', 'pptx'].includes(ext)) return ext;
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif'].includes(ext)) return 'image';
    if (['txt', 'csv', 'json'].includes(ext)) return 'text';
    return ext || 'document';
  };

  /** Get file ID for API calls (analytics items may have id or file_id). */
  const getFileId = (item: any): number | null => {
    if (item?.id != null) {
      const n = Number(item.id);
      return Number.isNaN(n) ? null : n;
    }
    if (item?.file_id != null) {
      const n = Number(item.file_id);
      return Number.isNaN(n) ? null : n;
    }
    return null;
  };

  const openFileInViewer = (item: any) => {
    const fid = getFileId(item);
    const fileId = fid != null ? String(fid) : '';
    const fileName = item?.original_filename || item?.filename || item?.name || 'Document';
    const fileType = getFileTypeFromFilename(fileName);
    const fileCategory = item?.category || item?.file_kind || undefined;
    if (!fileId) return;
    setSelectedFileForView({ fileId, fileName, fileType, fileCategory });
    setShowDocumentViewer(true);
  };

  console.log('📊 AnalyticsDashboard component loaded', { hasUser: !!user, user: user?.username, authLoading });

  // Track previous authLoading state to detect transition from true to false
  const prevAuthLoadingRef = useRef(authLoading);

  const loadAnalytics = useCallback(async (days = timePeriod) => {
    try {
      setLoading(true);
      console.log('🔍 Loading analytics for', days, 'days');
      console.log('📊 Current state:', { 
        hasUser: !!user, 
        authLoading, 
        loading: true, 
        hasAnalytics: !!analytics,
        recentReceiptsCount: recentReceipts.length
      });
      
      // Wait for auth to finish loading before checking authentication
      if (authLoading) {
        console.log('📊 Auth still loading, waiting...');
        // Don't set loading to false here - wait for auth to finish
        return;
      }
      
      // Match other tabs: gate on useAuth() user (same session as Home/Documents)
      if (!user) {
        console.warn('📊 No user session, cannot load analytics');
        setReceiptListDisplayLimit(FINANCIALS_LIST_PAGE_SIZE);
        setInvoiceListDisplayLimit(FINANCIALS_LIST_PAGE_SIZE);
        const periodLabel = getPeriodLabel(days, customDateFrom, customDateTo, !!(useCustomFilters && customDateFrom && customDateTo));
        const noAuthData = {
          summary: {
            period: periodLabel,
            period_days: parseInt(days) || 365,
            total_files: 0,
            total_size_mb: 0,
            total_receipts: 0,
            total_spending: 0,
            total_workspaces: 0,
            total_forms: 0,
          },
          receipts: {
            summary: {
              total_receipts: 0,
              total_amount: 0,
              average_amount: 0,
              period_days: parseInt(String(days), 10) || 365,
            },
            categories: [],
            timeline: [],
            payment_methods: [],
            top_businesses: [],
          },
          files: {
            types: [],
            upload_trends: [],
          },
          workspaces: {
            total_workspaces: 0,
            workspace_details: [],
          },
          forms: {
            total_forms: 0,
            total_responses: 0,
            form_details: [],
          },
          recentActivity: [],
        };
        setAnalytics(noAuthData);
        setRecentReceipts([]);
        setRecentInvoices([]);
        setLoading(false);
        return;
      }

      setReceiptListDisplayLimit(FINANCIALS_LIST_PAGE_SIZE);
      setInvoiceListDisplayLimit(FINANCIALS_LIST_PAGE_SIZE);
      
      // Use web endpoints for receipt and invoice analytics
      console.log('📊 Loading analytics from web endpoints...');
      
      // Load receipt analytics from web endpoint
      let receiptAnalytics: any = null;
      try {
        const category = selectedCategory !== 'All' ? selectedCategory : undefined;
        // Match web: only use custom date range when BOTH from and to are set; backend requires both
        const hasCustomDateRange = useCustomFilters && customDateFrom && customDateTo;
        const daysParam = hasCustomDateRange ? undefined : (parseInt(days, 10) || 365);
        const dateFrom = hasCustomDateRange ? customDateFrom : undefined;
        const dateTo = hasCustomDateRange ? customDateTo : undefined;
        const search = (useCustomFilters && storeVendorName) ? storeVendorName : undefined;
        const receiptResponse = await apiClient.getReceiptAnalytics(daysParam, category, dateFrom, dateTo, search);
        console.log('📊 Receipt analytics response:', {
          success: receiptResponse?.success,
          hasData: !!receiptResponse?.data,
          dataKeys: receiptResponse?.data ? Object.keys(receiptResponse.data) : [],
          hasOverview: !!receiptResponse?.data?.overview,
          totalReceipts: receiptResponse?.data?.overview?.total_receipts,
          categoriesCount: receiptResponse?.data?.category_distribution?.length || 0,
          hasRecentReceipts: !!receiptResponse?.data?.recent_receipts,
          message: receiptResponse?.message
        });
        if (receiptResponse && receiptResponse.success && receiptResponse.data) {
          // Backend returns: {overview, category_distribution, monthly_spending, recent_receipts, top_businesses}
          // Transform to expected structure: {summary, categories, timeline, payment_methods, top_businesses}
          const totalReceipts = receiptResponse.data.overview?.total_receipts || 0;
          const totalAmount = receiptResponse.data.overview?.total_amount || 0;
          // Calculate average amount if not provided or is 0
          const averageAmount = receiptResponse.data.overview?.average_amount || 
                                (totalReceipts > 0 ? totalAmount / totalReceipts : 0);
          
          receiptAnalytics = {
            summary: {
              total_receipts: totalReceipts,
              total_amount: totalAmount,
              average_amount: averageAmount,
              period_days: parseInt(String(days), 10) || 365,
              recent_30d: receiptResponse.data.overview?.recent_30d || 0,
            },
            categories: receiptResponse.data.category_distribution || [],
            timeline: receiptResponse.data.monthly_spending || [],
            payment_methods: receiptResponse.data.payment_methods || [],
            top_businesses: receiptResponse.data.top_businesses || [],
            recent_receipts: receiptResponse.data.recent_receipts || [],
          };
          console.log('✅ Receipt analytics transformed:', {
            totalReceipts: receiptAnalytics.summary.total_receipts,
            totalAmount: receiptAnalytics.summary.total_amount,
            categoriesCount: receiptAnalytics.categories.length
          });
        } else if (receiptResponse && !receiptResponse.success) {
          // API returned an error response (not an exception)
          console.warn('❌ Receipt analytics endpoint returned error:', receiptResponse.message);
        }
      } catch (error) {
        console.warn('❌ Receipt analytics endpoint failed with exception:', error);
      }
      
      // Load invoice analytics from web endpoint
      let invoiceAnalytics = null;
      try {
        const category = selectedInvoiceCategory !== 'All' ? selectedInvoiceCategory : undefined;
        // Match web: only use custom date range when BOTH from and to are set; backend requires both
        const hasCustomDateRange = useCustomFilters && customDateFrom && customDateTo;
        const daysParam = hasCustomDateRange ? undefined : (parseInt(days, 10) || 365);
        const dateFrom = hasCustomDateRange ? customDateFrom : undefined;
        const dateTo = hasCustomDateRange ? customDateTo : undefined;
        const search = (useCustomFilters && storeVendorName) ? storeVendorName : undefined;
        const invoiceResponse = await apiClient.getInvoiceAnalytics(daysParam, category, dateFrom, dateTo, search);
        if (invoiceResponse && invoiceResponse.success && invoiceResponse.data) {
          invoiceAnalytics = invoiceResponse.data;
          console.log('✅ Invoice analytics loaded from web endpoint');
        } else if (invoiceResponse && !invoiceResponse.success) {
          // API returned an error response (not an exception)
          console.warn('❌ Invoice analytics endpoint returned error:', invoiceResponse.message);
        }
      } catch (error) {
        // This catch block should rarely be hit now since API service returns error response
        console.warn('❌ Invoice analytics endpoint failed with exception:', error);
      }
      
      // Combine receipt and invoice analytics into comprehensive format
      console.log('📊 Building analyticsData with receiptAnalytics:', {
        hasReceiptAnalytics: !!receiptAnalytics,
        hasSummary: !!receiptAnalytics?.summary,
        totalReceipts: receiptAnalytics?.summary?.total_receipts,
        totalAmount: receiptAnalytics?.summary?.total_amount,
        categoriesCount: receiptAnalytics?.categories?.length || 0
      });
      
      const periodLabel = getPeriodLabel(days, customDateFrom, customDateTo, !!(useCustomFilters && customDateFrom && customDateTo));
      const analyticsData: ComprehensiveAnalytics = {
        summary: {
          period: periodLabel,
          period_days: parseInt(days) || 365,
          total_files: 0,
          total_size_mb: 0,
          total_receipts: receiptAnalytics?.summary?.total_receipts || 0,
          total_spending: receiptAnalytics?.summary?.total_amount || 0,
          total_workspaces: 0,
          total_forms: 0,
          total_invoices: invoiceAnalytics?.overview?.total_invoices || 0,
          total_invoice_amount: invoiceAnalytics?.overview?.total_amount || 0,
        },
        receipts: receiptAnalytics || {
          summary: {
            total_receipts: 0,
            total_amount: 0,
            average_amount: 0,
            period_days: parseInt(String(days), 10) || 365,
          },
          categories: [],
          timeline: [],
          payment_methods: [],
          top_businesses: [],
        },
        invoices: invoiceAnalytics || undefined,
        files: {
          types: [],
          upload_trends: [],
        },
        workspaces: {
          total_workspaces: 0,
          workspace_details: [],
        },
        forms: {
          total_forms: 0,
          total_responses: 0,
          form_details: [],
        },
        recentActivity: [],
      };
      
      // Use receipts from web analytics endpoint (same as web analytics page)
      // The web endpoint already returns all receipts with proper filtering (user_id, company_id, case-insensitive file_kind)
      // and includes full receipt data (total_amount, business_name, category, etc.)
      try {
        if (receiptAnalytics?.recent_receipts && receiptAnalytics.recent_receipts.length > 0) {
          console.log(`📊 Using ${receiptAnalytics.recent_receipts.length} receipts from web analytics endpoint`);
          // Sort by date (most recent first) - receipts from web endpoint are already sorted, but ensure consistency
          let sortedReceipts = [...receiptAnalytics.recent_receipts].sort((a: any, b: any) => {
            const dateA = a.created_at ? new Date(a.created_at).getTime() : 0;
            const dateB = b.created_at ? new Date(b.created_at).getTime() : 0;
            return dateB - dateA;
          });
          
          // Apply amount range filter if set
          if (useCustomFilters && (amountMin || amountMax)) {
            sortedReceipts = sortedReceipts.filter((receipt: any) => {
              const amount = receipt.json_data?.total_amount || 
                            receipt.json_data?.amount || 
                            receipt.json_data?.total ||
                            receipt.amount || 
                            receipt.total_amount || 0;
              const numericAmount = typeof amount === 'number' ? amount : 
                                 (typeof amount === 'string' ? parseFloat(amount.replace(/[^0-9.-]/g, '')) || 0 : 0);
              
              if (amountMin && numericAmount < parseFloat(amountMin)) return false;
              if (amountMax && numericAmount > parseFloat(amountMax)) return false;
              return true;
            });
          }
          // Apply date range and store name filter when custom filters are on
          if (useCustomFilters && (customDateFrom || customDateTo || storeVendorName)) {
            sortedReceipts = sortedReceipts.filter((receipt: any) => {
              if (customDateFrom || customDateTo) {
                const itemDate = getItemDateForFilter(receipt, true);
                if (!isDateInFilterRange(itemDate, customDateFrom, customDateTo)) return false;
              }
              if (storeVendorName && !matchesStoreVendorFilter(receipt, true)) return false;
              return true;
            });
          }
          // API already returned receipts filtered by time period and category; no extra client filter
          setRecentReceipts(sortedReceipts);
          console.log('✅ Loaded receipts from web analytics endpoint:', sortedReceipts.length);
        } else {
          console.warn('⚠️ No receipts in analytics response, trying fallback...');
          // Fallback: try mobile files endpoint if analytics didn't return receipts
          try {
            console.log('📊 Fallback: Fetching receipts from mobile files endpoint...');
            // Use reasonable limit (backend caps per_page at 100); paginate if more needed
            const filesResponse = await apiClient.getDocuments(
              1,
              FINANCIALS_FALLBACK_FETCH_SIZE,
              undefined,
              'receipts',
              undefined,
              false,
              false,
              undefined,
              undefined,
              { folderId: null, folderAware: true, scope: 'global' }
            );
            if (filesResponse && filesResponse.success) {
              const allFiles = filesResponse.files || filesResponse.data?.files || filesResponse.data || [];
              let receiptFiles = allFiles
                .filter((file: any) => {
                  const fileKind = (file.file_kind || '').toLowerCase();
                  return !file.file_kind || fileKind === 'receipt' || fileKind === 'receipts';
                })
                .filter((file: any) => getAmount(file) > 0); // Exclude $0 receipts
              if (useCustomFilters && (customDateFrom || customDateTo || storeVendorName || amountMin || amountMax)) {
                if (amountMin || amountMax) {
                  receiptFiles = receiptFiles.filter((file: any) => {
                    const numericAmount = getAmount(file);
                    if (amountMin && numericAmount < parseFloat(amountMin)) return false;
                    if (amountMax && numericAmount > parseFloat(amountMax)) return false;
                    return true;
                  });
                }
                if (customDateFrom || customDateTo || storeVendorName) {
                  receiptFiles = receiptFiles.filter((receipt: any) => {
                    if (customDateFrom || customDateTo) {
                      const itemDate = getItemDateForFilter(receipt, true);
                      if (!isDateInFilterRange(itemDate, customDateFrom, customDateTo)) return false;
                    }
                    if (storeVendorName && !matchesStoreVendorFilter(receipt, true)) return false;
                    return true;
                  });
                }
              }
              let sortedReceipts = [...receiptFiles].sort((a: any, b: any) => {
                const dateA = a.created_at ? new Date(a.created_at).getTime() : 0;
                const dateB = b.created_at ? new Date(b.created_at).getTime() : 0;
                return dateB - dateA;
              });
              // Recent section: obey time period and category
              if (!useCustomFilters && timePeriod) {
                const n = parseInt(timePeriod, 10) || 365;
                const { from, to } = getLastNDaysRange(n);
                sortedReceipts = sortedReceipts.filter((receipt: any) => {
                  const itemDate = getItemDateForFilter(receipt, true);
                  return isDateInFilterRange(itemDate, from, to);
                });
              }
              if (selectedCategory !== 'All') {
                const sel = selectedCategory.toLowerCase();
                sortedReceipts = sortedReceipts.filter((receipt: any) => {
                  const cat = (receipt.category ?? receipt.receipt_category ?? receipt.json_data?.category ?? '').trim().toLowerCase();
                  return !sel || cat.includes(sel) || sel.includes(cat) || (cat === '' && sel === 'uncategorized');
                });
              }
              setRecentReceipts(sortedReceipts);
              console.log(`✅ Fallback: Loaded ${sortedReceipts.length} receipts from mobile files endpoint`);
            } else {
              console.warn('⚠️ Fallback also failed, no receipts available');
              setRecentReceipts([]);
            }
          } catch (fallbackError) {
            console.error('❌ Fallback failed:', fallbackError);
            setRecentReceipts([]);
          }
        }
      } catch (error) {
        console.error('❌ Failed to load receipts:', error);
        setRecentReceipts([]);
      }
      
      if (invoiceAnalytics?.recent_invoices) {
        // The recent_invoices from the analytics endpoint may have file IDs
        // We need to ensure each invoice has an invoice_id (invoice record ID)
        // If not present, we need to fetch invoices separately or transform the data
        console.log('📊 Processing recent invoices from analytics:', {
          count: invoiceAnalytics.recent_invoices.length,
          sampleInvoice: invoiceAnalytics.recent_invoices[0]
        });
        
        // Check if invoices already have invoice record IDs
        const hasInvoiceIds = invoiceAnalytics.recent_invoices.some((inv: any) => inv.invoice_id || inv.id);
        
        if (hasInvoiceIds) {
          // Invoices have IDs, use them directly
          let filteredInvoices = invoiceAnalytics.recent_invoices;
          
          // Apply amount range filter if set
          if (useCustomFilters && (amountMin || amountMax)) {
            filteredInvoices = filteredInvoices.filter((invoice: any) => {
              const amount = invoice.json_data?.total_amount || 
                            invoice.json_data?.amount || 
                            invoice.json_data?.invoice_amount ||
                            invoice.json_data?.total ||
                            invoice.amount || 
                            invoice.total_amount || 0;
              const numericAmount = typeof amount === 'number' ? amount : 
                                 (typeof amount === 'string' ? parseFloat(amount.replace(/[^0-9.-]/g, '')) || 0 : 0);
              
              if (amountMin && numericAmount < parseFloat(amountMin)) return false;
              if (amountMax && numericAmount > parseFloat(amountMax)) return false;
              return true;
            });
          }
          // Apply date range and vendor name filter when custom filters are on
          if (useCustomFilters && (customDateFrom || customDateTo || storeVendorName)) {
            filteredInvoices = filteredInvoices.filter((invoice: any) => {
              if (customDateFrom || customDateTo) {
                const itemDate = getItemDateForFilter(invoice, false);
                if (!isDateInFilterRange(itemDate, customDateFrom, customDateTo)) return false;
              }
              if (storeVendorName && !matchesStoreVendorFilter(invoice, false)) return false;
              return true;
            });
          }
          // API already returned invoices filtered by time period and category; no extra client filter
          setRecentInvoices(filteredInvoices);
        } else {
          // Need to fetch invoice records to get invoice IDs
          try {
            console.log('📊 Fetching invoices from files endpoint to get invoice IDs...');
            // Use reasonable limit (backend caps per_page at 100)
            const invoicesResponse = await apiClient.getDocuments(
              1,
              FINANCIALS_FALLBACK_FETCH_SIZE,
              undefined,
              'invoices',
              undefined,
              false,
              false,
              undefined,
              undefined,
              { folderId: null, folderAware: true, scope: 'global' }
            );
            console.log('📊 Invoices response:', {
              success: invoicesResponse?.success,
              count: invoicesResponse?.files?.length || invoicesResponse?.data?.files?.length || 0
            });
            
            if (invoicesResponse && invoicesResponse.success) {
              const allInvoiceFiles = invoicesResponse.files || invoicesResponse.data?.files || invoicesResponse.data || [];
              console.log(`📊 Total invoice files received: ${allInvoiceFiles.length}`);
              
              // Use files with invoice file_kind and exclude $0 invoices
              let invoiceFiles = allInvoiceFiles
                .filter((file: any) => {
                  const fileKind = (file.file_kind || '').toLowerCase();
                  return fileKind === 'invoice' || fileKind === 'invoices';
                })
                .filter((inv: any) => getAmount(inv) > 0);
              
              // Apply amount range filter if set
              if (useCustomFilters && (amountMin || amountMax)) {
                invoiceFiles = invoiceFiles.filter((invoice: any) => {
                  const amount = invoice.json_data?.total_amount || 
                                invoice.json_data?.amount || 
                                invoice.json_data?.invoice_amount ||
                                invoice.json_data?.total ||
                                invoice.amount || 
                                invoice.total_amount || 0;
                  const numericAmount = typeof amount === 'number' ? amount : 
                                     (typeof amount === 'string' ? parseFloat(amount.replace(/[^0-9.-]/g, '')) || 0 : 0);
                  
                  if (amountMin && numericAmount < parseFloat(amountMin)) return false;
                  if (amountMax && numericAmount > parseFloat(amountMax)) return false;
                  return true;
                });
              }
              // Apply date range and vendor name filter when custom filters are on
              if (useCustomFilters && (customDateFrom || customDateTo || storeVendorName)) {
                invoiceFiles = invoiceFiles.filter((invoice: any) => {
                  if (customDateFrom || customDateTo) {
                    const itemDate = getItemDateForFilter(invoice, false);
                    if (!isDateInFilterRange(itemDate, customDateFrom, customDateTo)) return false;
                  }
                  if (storeVendorName && !matchesStoreVendorFilter(invoice, false)) return false;
                  return true;
                });
              }
              console.log(`📊 Filtered invoice files: ${invoiceFiles.length}`);
              setRecentInvoices(invoiceFiles);
            } else {
              console.warn('⚠️ Failed to fetch invoice files, using analytics data');
              let filteredInvoices = invoiceAnalytics.recent_invoices;
              
              // Apply amount range filter if set
              if (useCustomFilters && (amountMin || amountMax)) {
                filteredInvoices = filteredInvoices.filter((invoice: any) => {
                  const amount = invoice.json_data?.total_amount || 
                                invoice.json_data?.amount || 
                                invoice.json_data?.invoice_amount ||
                                invoice.json_data?.total ||
                                invoice.amount || 
                                invoice.total_amount || 0;
                  const numericAmount = typeof amount === 'number' ? amount : 
                                     (typeof amount === 'string' ? parseFloat(amount.replace(/[^0-9.-]/g, '')) || 0 : 0);
                  
                  if (amountMin && numericAmount < parseFloat(amountMin)) return false;
                  if (amountMax && numericAmount > parseFloat(amountMax)) return false;
                  return true;
                });
              }
              if (useCustomFilters && (customDateFrom || customDateTo || storeVendorName)) {
                filteredInvoices = filteredInvoices.filter((invoice: any) => {
                  if (customDateFrom || customDateTo) {
                    const itemDate = getItemDateForFilter(invoice, false);
                    if (!isDateInFilterRange(itemDate, customDateFrom, customDateTo)) return false;
                  }
                  if (storeVendorName && !matchesStoreVendorFilter(invoice, false)) return false;
                  return true;
                });
              }
              setRecentInvoices(filteredInvoices);
            }
          } catch (error) {
            console.error('❌ Failed to fetch invoices:', error);
            // Fallback to analytics data
            let filteredInvoices = invoiceAnalytics.recent_invoices;
            
            // Apply amount range filter if set
            if (useCustomFilters && (amountMin || amountMax)) {
              filteredInvoices = filteredInvoices.filter((invoice: any) => {
                const amount = invoice.json_data?.total_amount || 
                              invoice.json_data?.amount || 
                              invoice.json_data?.invoice_amount ||
                              invoice.json_data?.total ||
                              invoice.amount || 
                              invoice.total_amount || 0;
                const numericAmount = typeof amount === 'number' ? amount : 
                                   (typeof amount === 'string' ? parseFloat(amount.replace(/[^0-9.-]/g, '')) || 0 : 0);
                
                if (amountMin && numericAmount < parseFloat(amountMin)) return false;
                if (amountMax && numericAmount > parseFloat(amountMax)) return false;
                return true;
              });
            }
            if (useCustomFilters && (customDateFrom || customDateTo || storeVendorName)) {
              filteredInvoices = filteredInvoices.filter((invoice: any) => {
                if (customDateFrom || customDateTo) {
                  const itemDate = getItemDateForFilter(invoice, false);
                  if (!isDateInFilterRange(itemDate, customDateFrom, customDateTo)) return false;
                }
                if (storeVendorName && !matchesStoreVendorFilter(invoice, false)) return false;
                return true;
              });
            }
            setRecentInvoices(filteredInvoices);
          }
        }
      } else {
        setRecentInvoices([]);
      }
      
      setAnalytics(analyticsData);
      console.log('✅ Analytics data set successfully');
      console.log('📊 Final state:', {
        hasAnalytics: !!analyticsData,
        receiptsCount: analyticsData.receipts?.summary?.total_receipts || 0,
        hasTopBusinesses: !!analyticsData.receipts?.top_businesses,
        topBusinessesCount: analyticsData.receipts?.top_businesses?.length || 0,
        hasRecentReceiptsInAnalytics: !!receiptAnalytics?.recent_receipts,
        recentReceiptsInAnalyticsCount: receiptAnalytics?.recent_receipts?.length || 0
      });
      setLoading(false);
      console.log('✅ Loading set to false');
    } catch (error) {
      console.error('❌ Failed to load analytics:', error);
      console.error('❌ Error details:', {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      // Show basic data on error
      console.log('📊 API Error - Showing basic data');
      const periodLabel = getPeriodLabel(days, customDateFrom, customDateTo, !!(useCustomFilters && customDateFrom && customDateTo));
      const basicData = {
        summary: {
          period: periodLabel,
          period_days: parseInt(days) || 365,
          total_files: 0,
          total_size_mb: 0,
          total_receipts: 0,
          total_spending: 0,
          total_workspaces: 0,
          total_forms: 0,
        },
        receipts: {
          summary: {
            total_receipts: 0,
            total_amount: 0,
            average_amount: 0,
            period_days: parseInt(String(days), 10) || 365,
          },
          categories: [],
          timeline: [],
          payment_methods: [],
          top_businesses: [],
        },
        files: {
          types: [],
          upload_trends: [],
        },
        workspaces: {
          total_workspaces: 0,
          workspace_details: [],
        },
        forms: {
          total_forms: 0,
          total_responses: 0,
          form_details: [],
        },
        recentActivity: [],
      };
      setAnalytics(basicData);
      setRecentReceipts([]);
      setRecentInvoices([]);
    } finally {
      console.log('🔚 Finally block - setting loading to false');
      setLoading(false);
    }
  }, [
    timePeriod,
    selectedCategory,
    selectedInvoiceCategory,
    useCustomFilters,
    customDateFrom,
    customDateTo,
    storeVendorName,
    amountMin,
    amountMax,
    user,
    authLoading,
  ]);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadAnalytics();
    setRefreshing(false);
  };

  const setUploadStateWithTimeout = useCallback(
    (uploading: boolean) => {
      setIsUploading(uploading);
      if (uploading) {
        if (uploadTimeout !== null) clearTimeout(uploadTimeout);
        const timeout = setTimeout(() => {
          setIsUploading(false);
          setUploadTimeout(null);
        }, 30000);
        setUploadTimeout(timeout);
      } else if (uploadTimeout !== null) {
        clearTimeout(uploadTimeout);
        setUploadTimeout(null);
      }
    },
    [uploadTimeout]
  );

  const dismissUploadModal = useCallback(() => {
    uploadSheet.close();
    if (isUploading && !isOpeningPicker) {
      setUploadStateWithTimeout(false);
    }
  }, [isUploading, isOpeningPicker, setUploadStateWithTimeout, uploadSheet]);

  const handleFinancialsUploadFromFiles = useCallback(async () => {
    if (isUploading) return;
    setUploadStateWithTimeout(true);
    setIsOpeningPicker(true);
    uploadSheet.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const success = await uploadFromDocuments();
      if (success === true) {
        Alert.alert('Success', 'Files uploaded successfully!');
        await loadAnalytics();
      }
    } catch {
      Alert.alert('Error', 'Failed to upload files. Please try again.');
    } finally {
      setUploadStateWithTimeout(false);
      setIsOpeningPicker(false);
    }
  }, [isUploading, uploadFromDocuments, loadAnalytics, setUploadStateWithTimeout, uploadSheet]);

  const handleFinancialsUploadFromCamera = useCallback(() => {
    uploadSheet.close();
    router.push('/scanner');
  }, [router, uploadSheet]);

  const handleFinancialsUploadByLink = useCallback(() => {
    uploadSheet.close();
    router.push('/upload-by-link-code');
  }, [router, uploadSheet]);

  const handleFinancialsUploadFromGallery = useCallback(async () => {
    if (isUploading) return;
    setUploadStateWithTimeout(true);
    setIsOpeningPicker(true);
    uploadSheet.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const success = await uploadFromGallery();
      if (success === true) {
        Alert.alert('Success', 'Photos uploaded successfully!');
        await loadAnalytics();
      } else if (success === false) {
        Alert.alert('Upload Failed', 'Failed to upload photos. Please try again.');
      }
      // null = cancelled or upload-limit alert already shown
    } catch (error: any) {
      Alert.alert('Error', error?.message || 'Failed to upload photos. Please try again.');
    } finally {
      setUploadStateWithTimeout(false);
      setIsOpeningPicker(false);
    }
  }, [isUploading, uploadFromGallery, loadAnalytics, setUploadStateWithTimeout, uploadSheet]);

  const handleFinancialsScroll = useCallback((event: any) => {
    const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent || {};
    if (!layoutMeasurement || !contentOffset || !contentSize) return;

    const distanceFromBottom =
      contentSize.height - (layoutMeasurement.height + contentOffset.y);
    if (distanceFromBottom > FINANCIALS_AUTO_LOAD_THRESHOLD_PX) return;

    // Throttle to avoid multiple increments for the same momentum frame.
    const now = Date.now();
    if (now - lastAutoLoadAtRef.current < 400) return;

    if (activeTab === 'receipts') {
      if (recentReceipts.length > receiptListDisplayLimit) {
        lastAutoLoadAtRef.current = now;
        setReceiptListDisplayLimit((n) =>
          Math.min(n + FINANCIALS_LIST_PAGE_SIZE, recentReceipts.length)
        );
      }
      return;
    }

    if (recentInvoices.length > invoiceListDisplayLimit) {
      lastAutoLoadAtRef.current = now;
      setInvoiceListDisplayLimit((n) =>
        Math.min(n + FINANCIALS_LIST_PAGE_SIZE, recentInvoices.length)
      );
    }
  }, [
    activeTab,
    recentReceipts.length,
    recentInvoices.length,
    receiptListDisplayLimit,
    invoiceListDisplayLimit,
  ]);
  
  // Receipt categories (must match backend validation)
  const receiptCategories = [
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
    'Other Expenses'
  ];
  
  const handleCategorizeReceipt = (receipt: any) => {
    setSelectedReceipt(receipt);
    setShowCategoryModal(true);
  };

  /** Treat epoch or placeholder dates as "no date" so we show "Select date" and default picker to today. */
  const isEpochOrEmptyDate = (s: string): boolean =>
    !s || s === '1969-12-31' || s === '1970-01-01';

  /** Get raw date string YYYY-MM-DD for receipt (document date) or invoice (due date). Uses safe parsing; falls back to upload date (created_at) when transaction date is missing or invalid. Epoch/empty treated as no date. */
  const getEditDateString = (item: any, type: 'receipt' | 'invoice'): string => {
    let s = '';
    if (type === 'invoice') {
      const tx = item?.json_data?.due_date ?? item?.json_data?.invoice_date ?? item?.json_data?.date;
      s = safeToDateString(tx);
      if (!s) s = safeToDateString(item?.created_at);
    } else {
      const tx = item?.json_data?.date ?? item?.json_data?.receipt_data?.date;
      s = safeToDateString(tx);
      if (!s) s = safeToDateString(item?.created_at);
    }
    return isEpochOrEmptyDate(s) ? '' : s;
  };

  const handleOpenEdit = (item: any, type: 'receipt' | 'invoice') => {
    const amount = item?.json_data?.total_amount ?? item?.json_data?.amount ?? item?.json_data?.total ?? item?.amount ?? item?.total_amount ?? 0;
    const numericAmount = typeof amount === 'number' ? amount : (typeof amount === 'string' ? parseFloat(amount.replace(/[^0-9.-]/g, '')) || 0 : 0);
    const amountStr = numericAmount > 0 ? String(numericAmount) : (typeof amount === 'string' ? amount : '');
    const storeName = type === 'invoice'
      ? (item?.vendor_name ?? item?.json_data?.vendor_name ?? item?.json_data?.business_name ?? item?.json_data?.store_name ?? '')
      : getReceiptPrimaryStoreName(item);
    const category = item?.category ?? item?.json_data?.category ?? item?.receipt_category ?? item?.invoice_category ?? 'Uncategorized';
    setEditItem(item);
    setEditType(type);
    const dateStr = getEditDateString(item, type);
    setEditForm({
      store_name: storeName || '',
      total_amount: amountStr || '',
      date: dateStr,
      category: category || 'Uncategorized',
    });
    const parsed = dateStr ? parseLocalDateString(dateStr) : null;
    setEditDatePickerValue(parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date());
    setShowEditModal(true);
  };

  const handleCloseEdit = () => {
    setShowEditModal(false);
    setShowEditDatePicker(false);
    setEditItem(null);
    setEditForm({ store_name: '', total_amount: '', date: '', category: 'Uncategorized' });
  };

  const handleEditDateChange = (event: any, selectedDate?: Date) => {
    if (Platform.OS === 'android') {
      setShowEditDatePicker(false);
      if (event?.type === 'set' && selectedDate) {
        setEditDatePickerValue(selectedDate);
        setEditForm((f) => ({ ...f, date: formatDateForInput(selectedDate) }));
      }
      setTimeout(() => setShowEditModal(true), 0);
    } else {
      // iOS spinner: update state as user scrolls; modal closes via Done/Cancel
      if (selectedDate) {
        setEditDatePickerValue(selectedDate);
        setEditForm((f) => ({ ...f, date: formatDateForInput(selectedDate) }));
      }
    }
  };

  const handleEditDatePickerDone = () => {
    setShowEditDatePicker(false);
    setTimeout(() => setShowEditModal(true), 0);
  };

  const handleConfirmSave = () => {
    Alert.alert(
      'Save changes?',
      'Are you sure you want to save these changes?',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Save', onPress: handleSaveEdit },
      ]
    );
  };

  const handleSaveEdit = async () => {
    const fileId = getFileId(editItem);
    if (fileId == null) {
      Alert.alert('Error', 'Cannot save: file ID not found.');
      return;
    }
    setSavingEdit(true);
    try {
      const correctionData: Record<string, unknown> = {
        file_kind: editType,
        category: editForm.category || 'Uncategorized',
      };
      if (editType === 'receipt') {
        correctionData.store_name = editForm.store_name || undefined;
        correctionData.total_amount = editForm.total_amount || undefined;
        correctionData.date = editForm.date ? localDateStringToUTCISO(editForm.date) : undefined;
      } else {
        correctionData.vendor_name = editForm.store_name || undefined;
        correctionData.total_amount = editForm.total_amount || undefined;
        correctionData.due_date = editForm.date ? localDateStringToUTCISO(editForm.date) : undefined;
      }
      const response = await apiClient.correctFileData(fileId, correctionData);
      if (response.success) {
        Alert.alert('Success', 'Saved successfully');
        handleCloseEdit();
        await loadAnalytics();
      } else {
        Alert.alert('Error', response.message || 'Failed to save');
      }
    } catch (error) {
      console.error('Error saving correction:', error);
      Alert.alert('Error', 'Failed to save');
    } finally {
      setSavingEdit(false);
    }
  };
  
  const handleSelectCategory = async (category: string) => {
    if (!selectedReceipt) return;
    const fileId = getFileId(selectedReceipt);
    if (fileId == null) {
      Alert.alert('Error', 'Cannot categorize: file ID not found.');
      return;
    }
    setCategorizingReceipt(true);
    try {
      const response = await apiClient.categorizeReceipt(fileId, category);
      if (response.success) {
        Alert.alert('Success', `Receipt categorized as "${category}"`);
        // Update the receipt in the local state
        setRecentReceipts(prev => prev.map(r => 
          getFileId(r) === fileId ? { ...r, category } : r
        ));
        setShowCategoryModal(false);
        setSelectedReceipt(null);
      } else {
        Alert.alert('Error', response.message || 'Failed to categorize receipt');
      }
    } catch (error) {
      console.error('Error categorizing receipt:', error);
      Alert.alert('Error', 'Failed to categorize receipt');
    } finally {
      setCategorizingReceipt(false);
    }
  };
  
  // Invoice payment statuses (must match backend validation)
  const paymentStatuses = [
    'Paid',
    'Unpaid',
    'Partial'
  ];
  
  const handleUpdatePaymentStatus = (invoice: any) => {
    setSelectedInvoice(invoice);
    setShowPaymentStatusModal(true);
  };
  
  const handleSelectPaymentStatus = async (paymentStatus: string) => {
    if (!selectedInvoice) return;
    
    setUpdatingPaymentStatus(true);
    try {
      // The invoice object from recent_invoices has a file ID
      // The new endpoint /api/v1/web/files/{file_id}/payment-status accepts file ID
      const fileId = getFileId(selectedInvoice);
      
      console.log('💳 Updating payment status:', {
        fileId,
        paymentStatus,
        invoiceObject: selectedInvoice,
      });
      
      if (fileId == null) {
        Alert.alert('Error', 'File ID not found. Cannot update payment status.');
        setUpdatingPaymentStatus(false);
        return;
      }
      
      const response = await apiClient.updateInvoicePaymentStatus(fileId, paymentStatus);
      if (response.success) {
        Alert.alert('Success', `Invoice payment status updated to "${paymentStatus}"`);
        // Update the invoice in the local state
        setRecentInvoices(prev => prev.map(inv => {
          if (getFileId(inv) === fileId) {
            const updated = { ...inv };
            updated.payment_status = paymentStatus;
            if (updated.json_data) {
              updated.json_data.payment_status = paymentStatus.toLowerCase();
            } else {
              updated.json_data = { payment_status: paymentStatus.toLowerCase() };
            }
            return updated;
          }
          return inv;
        }));
        setShowPaymentStatusModal(false);
        setSelectedInvoice(null);
        // Reload analytics to get updated data
        loadAnalytics();
      } else {
        // Show error message
        const errorMsg = response.message || 'Failed to update payment status';
        Alert.alert('Error', errorMsg);
      }
    } catch (error) {
      console.error('Error updating payment status:', error);
      Alert.alert('Error', 'Failed to update payment status');
    } finally {
      setUpdatingPaymentStatus(false);
    }
  };

  /** Send/export the downloaded report file. Not an access change. */
  const handleShareReport = async () => {
    try {
      const reportType = activeTab === 'receipts' ? 'receipts' : 'invoices';
      console.log(`📊 Sharing ${reportType} report...`);

      // Get cache directory
      const cacheDir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
      if (!cacheDir) {
        throw new Error('Unable to access file system directories');
      }

      // Same JSON body shape as web `analysis.tsx` (handleDownloadReceiptReport / handleDownloadInvoiceReport).
      const hasCustomDateRange = useCustomFilters && !!customDateFrom && !!customDateTo;
      const daysParsed = parseInt(timePeriod, 10);
      const body: WebAnalysisDownloadReportBody = {
        category: reportType === 'receipts' ? selectedCategory : selectedInvoiceCategory,
        days: hasCustomDateRange ? null : Number.isNaN(daysParsed) ? 365 : daysParsed,
        date_from: hasCustomDateRange ? customDateFrom : null,
        date_to: hasCustomDateRange ? customDateTo : null,
        search: storeVendorName.trim() || null,
        amount_min:
          amountMin.trim() && !Number.isNaN(parseFloat(amountMin.trim())) ? parseFloat(amountMin.trim()) : null,
        amount_max:
          amountMax.trim() && !Number.isNaN(parseFloat(amountMax.trim())) ? parseFloat(amountMax.trim()) : null,
      };

      console.log(`📊 POST /api/v1/web/analysis/${reportType}/download-report`, body);

      const { arrayBuffer, filename: headerFilename } = await apiClient.postWebAnalysisDownloadReport(
        reportType,
        body
      );

      const dateStr = new Date().toISOString().split('T')[0];
      const defaultBase = reportType === 'receipts' ? 'Receipt_Report' : 'Invoice_Report';
      const safeName = (headerFilename || `${defaultBase}_${dateStr}.docx`).replace(/[/\\?%*:|"<>]/g, '_');
      const fileUri = `${cacheDir}${safeName}`;

      const bytes = new Uint8Array(arrayBuffer);
      const base64Data =
        typeof Buffer !== 'undefined'
          ? Buffer.from(bytes).toString('base64')
          : (() => {
              const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
              let binary = '';
              for (let i = 0; i < bytes.length; i++) {
                binary += String.fromCharCode(bytes[i]);
              }
              let result = '';
              let i = 0;
              while (i < binary.length) {
                const a = binary.charCodeAt(i++);
                const b = i < binary.length ? binary.charCodeAt(i++) : 0;
                const c = i < binary.length ? binary.charCodeAt(i++) : 0;
                const bitmap = (a << 16) | (b << 8) | c;
                result +=
                  chars.charAt((bitmap >> 18) & 63) +
                  chars.charAt((bitmap >> 12) & 63) +
                  (i - 2 < binary.length ? chars.charAt((bitmap >> 6) & 63) : '=') +
                  (i - 1 < binary.length ? chars.charAt(bitmap & 63) : '=');
              }
              return result;
            })();

      await FileSystem.writeAsStringAsync(fileUri, base64Data, {
        encoding: FileSystem.EncodingType.Base64,
      });

      console.log(`📊 Report file saved to: ${fileUri}`);

      // Check if sharing is available
      const isAvailable = await Sharing.isAvailableAsync();

      if (isAvailable) {
        // Share the file (docx MIME type)
        await Sharing.shareAsync(fileUri, {
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          dialogTitle: `Share ${reportType.charAt(0).toUpperCase() + reportType.slice(1)} Report`,
        });
        console.log(`📊 ${reportType} report shared successfully`);
      } else {
        Alert.alert('Share Not Available', 'File sharing is not available on this device.');
      }

      // Clean up file after a delay
      setTimeout(async () => {
        try {
          const fileInfo = await FileSystem.getInfoAsync(fileUri);
          if (fileInfo.exists) {
            await FileSystem.deleteAsync(fileUri, { idempotent: true });
            console.log('📊 Cleaned up report file');
          }
        } catch (error) {
          console.warn('📊 Failed to clean up report file:', error);
        }
      }, 60000); // Delete after 1 minute

    } catch (error: any) {
      console.error(`📊 Error sharing ${activeTab} report:`, error);
      Alert.alert(
        'Share Failed',
        error.message || `Failed to share ${activeTab} report. Please try again.`
      );
    }
  };

  // Watch for authLoading transition from true to false and trigger load
  useEffect(() => {
    const prevAuthLoading = prevAuthLoadingRef.current;
    prevAuthLoadingRef.current = authLoading;
    
    // If auth just finished loading (transitioned from true to false), load analytics
    if (prevAuthLoading && !authLoading) {
      console.log('📊 Auth finished loading, triggering loadAnalytics');
      loadAnalytics();
    }
  }, [authLoading, loadAnalytics]);

  // Refetch when any filter changes so overview, category breakdown, and other displays stay in sync
  const filterDepsRanRef = useRef(false);
  useEffect(() => {
    if (!filterDepsRanRef.current) {
      filterDepsRanRef.current = true;
      return;
    }
    if (authLoading) return;
    loadAnalytics();
  }, [
    selectedCategory,
    selectedInvoiceCategory,
    timePeriod,
    useCustomFilters,
    customDateFrom,
    customDateTo,
    storeVendorName,
    amountMin,
    amountMax,
    loadAnalytics,
    authLoading,
  ]);

  // Use useFocusEffect instead of useEffect to ensure data reloads when screen comes into focus
  // This is critical for Android where useEffect may not re-run when navigating to the screen
  useFocusEffect(
    useCallback(() => {
      console.log('📊 AnalyticsDashboard useFocusEffect triggered', { hasUser: !!user, authLoading, user: user?.username, platform: Platform.OS });
      // Wait for authentication to finish loading before attempting to load analytics
      if (authLoading) {
        console.log('📊 Auth still loading, waiting...');
        return;
      }
      // Once auth has finished loading, load analytics (whether authenticated or not)
      loadAnalytics();
    }, [user, authLoading, loadAnalytics])
  );

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(amount);
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const getActiveFiltersText = () => {
    const filters: string[] = [];
    
    if (useCustomFilters) {
      if (customDateFrom && customDateTo) {
        filters.push(`${customDateFrom} to ${customDateTo}`);
      } else if (timePeriod === '365') {
        filters.push('1yr');
      } else if (timePeriod) {
        filters.push(`${timePeriod === '7' ? '7d' : timePeriod === '30' ? '30d' : '90d'}`);
      }
    } else if (timePeriod) {
      filters.push(`${timePeriod === '7' ? '7d' : timePeriod === '30' ? '30d' : timePeriod === '90' ? '90d' : '1yr'}`);
    }
    
    if (amountMin || amountMax) {
      const amountRange = [];
      if (amountMin) amountRange.push(`$${amountMin}`);
      if (amountMax) amountRange.push(`$${amountMax}`);
      filters.push(`Amount: ${amountRange.join(' - ')}`);
    }
    
    if (storeVendorName) {
      filters.push(`${activeTab === 'receipts' ? 'Store' : 'Vendor'}: ${storeVendorName}`);
    }
    
    return filters.length > 0 ? filters.join(' • ') : '';
  };

  const TimePeriodSelector = () => (
    <View style={[styles.timePeriodContainer, themeStyles.timePeriodContainer]}>
      <View style={styles.timePeriodHeader}>
        <Text style={[styles.sectionTitle, themeStyles.sectionTitle]}>Time Period</Text>
        {getActiveFiltersText() && (
          <Text style={[styles.activeFiltersText, themeStyles.activeFiltersText]}>{getActiveFiltersText()}</Text>
        )}
      </View>
      <View style={[styles.timePeriodButtons, styles.timePeriodButtonsRow]}>
        {(['7', '30', '90', '365'] as const).map((days) => (
          <TouchableOpacity
            key={days}
            style={[
              styles.timePeriodButton,
              themeStyles.timePeriodButton,
              timePeriod === days && !useCustomFilters && styles.timePeriodButtonActive,
              timePeriod === days && !useCustomFilters && themeStyles.timePeriodButtonActive,
            ]}
            onPress={() => {
              setTimePeriod(days);
              setUseCustomFilters(false);
              loadAnalytics(days);
            }}
          >
            <Text
              style={[
                styles.timePeriodButtonText,
                themeStyles.timePeriodButtonText,
                timePeriod === days && !useCustomFilters && styles.timePeriodButtonTextActive,
                timePeriod === days && !useCustomFilters && themeStyles.timePeriodButtonLabelActive,
              ]}
            >
              {days === '7' ? '7d' : days === '30' ? '30d' : days === '90' ? '90d' : '1yr'}
            </Text>
          </TouchableOpacity>
        ))}
        <TouchableOpacity
          style={[
            styles.timePeriodButton,
            themeStyles.timePeriodButton,
            styles.moreButton,
            useCustomFilters && styles.timePeriodButtonActive,
            useCustomFilters && themeStyles.timePeriodButtonActive,
          ]}
          onPress={() => setShowAdvancedFilterModal(true)}
        >
          <Text
            style={[
              styles.timePeriodButtonText,
              themeStyles.timePeriodButtonText,
              useCustomFilters && styles.timePeriodButtonTextActive,
              useCustomFilters && themeStyles.timePeriodButtonLabelActive,
            ]}
          >
            More
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  const receiptCategoryFilterOptions = ['All', ...receiptCategories];

  const CategoryFilter = () => (
    <View style={[styles.categoryFilterContainer, themeStyles.categoryFilterContainer]}>
      <Text style={[styles.sectionTitle, themeStyles.sectionTitle]}>Receipt Category Filter</Text>
      <View style={styles.categoryFilterContent}>
        <Text style={[styles.categoryFilterLabel, themeStyles.categoryFilterLabel]}>Filter by Category:</Text>
        <TouchableOpacity
          style={[styles.categoryDropdown, themeStyles.categoryDropdown]}
          onPress={() => setShowReceiptCategoryFilterModal(true)}
          activeOpacity={0.7}
        >
          <Text style={[styles.categoryDropdownText, themeStyles.categoryDropdownText]}>{selectedCategory}</Text>
          <Ionicons name="chevron-down" size={16} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>
      {selectedCategory !== 'All' && (
        <Text style={[styles.categoryFilterNote, themeStyles.categoryFilterNote]}>
          Showing data for: <Text style={styles.categoryFilterNoteBold}>{selectedCategory}</Text>
        </Text>
      )}
    </View>
  );

  const StatCard = ({ title, value, subtitle, icon, color }: {
    title: string;
    value: string | number;
    subtitle?: string;
    icon: string;
    color: string;
  }) => (
    <View style={[styles.statCard, themeStyles.statCard]}>
      <View style={styles.statCardHeader}>
        <View style={[styles.statCardIcon, { backgroundColor: color }]}>
          <Ionicons name={icon as any} size={20} color="#fff" />
        </View>
        <Text style={[styles.statCardTitle, themeStyles.statCardTitle]}>{title}</Text>
      </View>
      <Text style={[styles.statCardValue, themeStyles.statCardValue]}>{value}</Text>
      {subtitle && <Text style={[styles.statCardSubtitle, themeStyles.statCardSubtitle]}>{subtitle}</Text>}
    </View>
  );

  const CategoryBar = ({ category, amount, percentage, color }: {
    category: string;
    amount: number;
    percentage: number;
    color: string;
  }) => (
    <View style={styles.categoryBar}>
      <View style={styles.categoryBarHeader}>
        <Text style={[styles.categoryBarTitle, themeStyles.categoryBarTitle]}>{category}</Text>
        <Text style={styles.categoryBarAmount}>{formatCurrency(amount)}</Text>
      </View>
      <View style={[styles.categoryBarContainer, themeStyles.categoryBarContainer]}>
        <View style={[styles.categoryBarFill, { width: `${percentage}%`, backgroundColor: color }]} />
      </View>
      <Text style={[styles.categoryBarPercentage, themeStyles.categoryBarPercentage]}>{percentage.toFixed(1)}%</Text>
    </View>
  );

  console.log('📊 AnalyticsDashboard render - loading:', loading, 'analytics:', !!analytics, 'authLoading:', authLoading);

  if (authLoading || loading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={[styles.header, { backgroundColor: colors.headerBackground, borderBottomColor: colors.border }]}>
          <AppBackButton />
          <AppHeaderTitle>Financials</AppHeaderTitle>
          <View style={styles.placeholder} />
        </View>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.primary || '#007AFF'} />
          <Text style={[styles.loadingText, themeStyles.loadingText]}>
            {authLoading ? 'Checking authentication...' : 'Loading receipt analytics...'}
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!analytics) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={[styles.header, { backgroundColor: colors.headerBackground, borderBottomColor: colors.border }]}>
          <AppBackButton />
          <AppHeaderTitle>Financials</AppHeaderTitle>
          <TouchableOpacity style={styles.headerButton} onPress={() => loadAnalytics()}>
            <Ionicons name="refresh" size={28} color={colors.primary || '#007AFF'} />
          </TouchableOpacity>
        </View>
        <View style={styles.errorContainer}>
          <Ionicons name="analytics-outline" size={64} color={colors.textSecondary} />
          <Text style={[styles.errorText, themeStyles.errorText]}>No receipt data available</Text>
          <Text style={[styles.errorSubtext, themeStyles.errorSubtext]}>
            This might be because:{'\n'}
            • Your receipt is still being processed{'\n'}
            • No receipts found for the selected time period{'\n'}
            • Receipt data is not available
          </Text>
          <TouchableOpacity style={styles.retryButton} onPress={() => loadAnalytics()}>
            <Text style={styles.retryButtonText}>Refresh Data</Text>
          </TouchableOpacity>
          {__DEV__ && (
            <TouchableOpacity 
              style={[styles.retryButton, { backgroundColor: '#34C759', marginTop: 8 }]} 
              onPress={() => {
                console.log('🔄 Loading sample data for testing');
                const sampleData = {
                  summary: {
                    period: 'last 7d',
                    period_days: 7,
                    total_files: 1,
                    total_size_mb: 2.5,
                    total_receipts: 1,
                    total_spending: 25.50,
                    total_workspaces: 1,
                    total_forms: 0,
                  },
                  receipts: {
                    summary: {
                      total_receipts: 1,
                      total_amount: 25.50,
                      average_amount: 25.50,
                      period_days: 7,
                    },
                    categories: [
                      { category: 'Meals and Entertainment', count: 1, total_amount: 25.50, percentage: 100.0 },
                    ],
                    timeline: [],
                    payment_methods: [
                      { method: 'Credit Card', count: 1, total_amount: 25.50 },
                    ],
                    top_businesses: [
                      { business: 'Restaurant', count: 1, total_amount: 25.50 },
                    ],
                  },
                  files: {
                    types: [
                      { type: 'Image', count: 1, percentage: 100.0 },
                    ],
                    upload_trends: [],
                  },
                  workspaces: {
                    total_workspaces: 1,
                    workspace_details: [
                      { name: 'Personal Workspace', file_count: 1, member_count: 1 },
                    ],
                  },
                  forms: {
                    total_forms: 0,
                    total_responses: 0,
                    form_details: [],
                  },
                };
                setAnalytics(sampleData);
                setLoading(false);
              }}
            >
              <Text style={styles.retryButtonText}>Load Sample Data (Dev)</Text>
            </TouchableOpacity>
          )}
        </View>
      </SafeAreaView>
    );
  }

  const categoryColors = ['#007AFF', '#34C759', '#FF9500', '#AF52DE', '#FF3B30', '#5856D6'];

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { backgroundColor: colors.headerBackground, borderBottomColor: colors.border }]}>
        <AppBackButton />
        <AppHeaderTitle>Financials</AppHeaderTitle>
        <View style={styles.headerActions}>
          <TouchableOpacity
            style={styles.headerButton}
            onPress={() => uploadSheet.open()}
            accessibilityLabel="Upload document"
            accessibilityRole="button"
          >
            <Ionicons name="cloud-upload-outline" size={28} color={colors.primary || '#007AFF'} />
          </TouchableOpacity>
          <FeedbackTouchable onPress={handleShareReport} style={styles.shareButton} spinnerColor="#10B981">
            <Ionicons name="share-outline" size={28} color="#10B981" />
          </FeedbackTouchable>
          <TouchableOpacity style={styles.headerButton} onPress={onRefresh}>
            <Ionicons name="refresh" size={28} color={colors.primary || '#007AFF'} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Tabs */}
      <View style={[styles.tabsContainer, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'receipts' && styles.tabActive, activeTab === 'receipts' && themeStyles.tabActive]}
          onPress={() => setActiveTab('receipts')}
        >
          <Ionicons 
            name="receipt" 
            size={20} 
            color={activeTab === 'receipts' ? (colors.primary || '#007AFF') : colors.textSecondary} 
          />
          <Text style={[styles.tabText, themeStyles.tabText, activeTab === 'receipts' && styles.tabTextActive, activeTab === 'receipts' && themeStyles.tabTextActive]}>
            Receipts
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'invoices' && styles.tabActive, activeTab === 'invoices' && themeStyles.tabActive]}
          onPress={() => setActiveTab('invoices')}
        >
          <Ionicons 
            name="document-text" 
            size={20} 
            color={activeTab === 'invoices' ? (colors.primary || '#007AFF') : colors.textSecondary} 
          />
          <Text style={[styles.tabText, themeStyles.tabText, activeTab === 'invoices' && styles.tabTextActive, activeTab === 'invoices' && themeStyles.tabTextActive]}>
            Invoices
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        style={[styles.content, themeStyles.content]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        showsVerticalScrollIndicator={false}
        onScroll={handleFinancialsScroll}
        scrollEventThrottle={16}
      >
        <TimePeriodSelector />

        {activeTab === 'receipts' && (
          <>
            {analytics ? (
              <>
                {/* Receipt Overview Stats - Always show, even if zero */}
                <View style={[styles.section, themeStyles.section]}>
                  <Text style={[styles.sectionTitle, themeStyles.sectionTitle]}>Receipt Overview</Text>
                  <View style={styles.statsRow}>
                    <StatCard
                      title="Total Receipts"
                      value={analytics.summary?.total_receipts || analytics.receipts?.summary?.total_receipts || 0}
                      subtitle={formatCurrency(analytics.summary?.total_spending || analytics.receipts?.summary?.total_amount || 0)}
                      icon="receipt"
                      color="#34C759"
                    />
                    <StatCard
                      title="Average Receipt"
                      value={formatCurrency(
                        (analytics.receipts?.summary?.average_amount && analytics.receipts.summary.average_amount > 0)
                          ? analytics.receipts.summary.average_amount
                          : ((analytics.receipts?.summary?.total_receipts || 0) > 0 && (analytics.receipts?.summary?.total_amount || 0) > 0)
                            ? (analytics.receipts.summary.total_amount / analytics.receipts.summary.total_receipts)
                            : 0
                      )}
                      subtitle={`${analytics.receipts?.summary?.recent_30d ?? analytics.receipts?.summary?.total_receipts ?? 0} in ${analytics.summary?.period ?? 'last 1yr'}`}
                      icon="calculator"
                      color="#007AFF"
                    />
                  </View>
                </View>
            
                {/* Category Distribution - Donut Chart + List */}
                <View style={[styles.section, themeStyles.section]}>
                  <Text style={[styles.sectionTitle, themeStyles.sectionTitle]}>Category Distribution</Text>
              {(analytics.receipts?.categories || []).length > 0 ? (
                <View style={styles.categoryChartContainer}>
                  {/* Donut Chart */}
                  <View style={styles.donutChartContainer}>
                    <View style={styles.donutChartWrapper}>
                      {(() => {
                        // Get all categories - don't filter by total_amount, use all categories
                        const allCategories = analytics.receipts?.categories || [];
                        
                        // Filter out only categories with zero or negative amounts
                        const categoriesWithData = allCategories.filter(c => 
                          (c.total_amount && c.total_amount > 0) || 
                          (c.count && c.count > 0) ||
                          (c.percentage && c.percentage > 0)
                        );
                        
                        console.log('📊 Pie chart categories:', {
                          allCategories: allCategories.length,
                          categoriesWithData: categoriesWithData.length,
                          categories: categoriesWithData.map(c => ({
                            category: c.category,
                            total_amount: c.total_amount,
                            percentage: c.percentage,
                            count: c.count
                          }))
                        });
                        
                        if (categoriesWithData.length === 0) {
                          return null;
                        }
                        
                        const size = 120;
                        const center = size / 2;
                        const radius = 45;
                        const innerRadius = 30;
                        const startAngle = -90; // Start from top
                        
                        // Calculate total amount for percentage calculation
                        const totalAmount = categoriesWithData.reduce((sum, c) => sum + (c.total_amount || 0), 0);
                        
                        // Calculate percentages for each category and normalize to sum to 100%
                        const categoryPercentages = categoriesWithData.map(category => {
                          // Use provided percentage or calculate from amount
                          let percentage = category.percentage || 0;
                          if (percentage === 0 && totalAmount > 0 && category.total_amount) {
                            percentage = (category.total_amount / totalAmount) * 100;
                          }
                          return percentage;
                        });
                        
                        // Calculate total percentage
                        const totalPercentage = categoryPercentages.reduce((sum, p) => sum + p, 0);
                        
                        // Normalize percentages to sum to exactly 100%
                        const normalizedPercentages = totalPercentage > 0 
                          ? categoryPercentages.map(p => (p / totalPercentage) * 100)
                          : categoryPercentages;
                        
                        // Verify normalization (should sum to 100)
                        const normalizedTotal = normalizedPercentages.reduce((sum, p) => sum + p, 0);
                        console.log('📊 Pie chart normalization:', {
                          originalTotal: totalPercentage,
                          normalizedTotal: normalizedTotal,
                          categoryCount: categoriesWithData.length
                        });
                        
                        const createArcPath = (startAngleDeg: number, endAngleDeg: number, outerRadius: number, innerRadius: number) => {
                          const start = (startAngleDeg * Math.PI) / 180;
                          const end = (endAngleDeg * Math.PI) / 180;
                          
                          const x1 = center + outerRadius * Math.cos(start);
                          const y1 = center + outerRadius * Math.sin(start);
                          const x2 = center + outerRadius * Math.cos(end);
                          const y2 = center + outerRadius * Math.sin(end);
                          
                          const x3 = center + innerRadius * Math.cos(end);
                          const y3 = center + innerRadius * Math.sin(end);
                          const x4 = center + innerRadius * Math.cos(start);
                          const y4 = center + innerRadius * Math.sin(start);
                          
                          const largeArc = end - start > Math.PI ? 1 : 0;
                          
                          return `M ${x1} ${y1} A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${x2} ${y2} L ${x3} ${y3} A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${x4} ${y4} Z`;
                        };
                        
                        // Build segments with normalized percentages
                        let currentAngle = startAngle;
                        const segments: Array<{category: any; startAngle: number; endAngle: number; color: string; index: number}> = [];
                        
                        categoriesWithData.forEach((category, index) => {
                          const percentage = normalizedPercentages[index];
                          const angle = (percentage / 100) * 360;
                          
                          // Only render segments with meaningful angles
                          if (angle >= 0.1) {
                            const segmentStartAngle = currentAngle;
                            const segmentEndAngle = currentAngle + angle;
                            
                            segments.push({
                              category,
                              startAngle: segmentStartAngle,
                              endAngle: segmentEndAngle,
                              color: categoryColors[index % categoryColors.length],
                              index
                            });
                            
                            currentAngle = segmentEndAngle;
                            
                            console.log(`📊 Category ${category.category}:`, {
                              percentage: percentage.toFixed(2),
                              angle: angle.toFixed(2),
                              startAngle: segmentStartAngle.toFixed(2),
                              endAngle: segmentEndAngle.toFixed(2)
                            });
                          }
                        });
                        
                        // Calculate remaining angle to complete the circle
                        const finalAngle = currentAngle;
                        const expectedEndAngle = startAngle + 360;
                        const remainingAngle = expectedEndAngle - finalAngle;
                        
                        console.log('📊 Pie chart completion:', {
                          startAngle,
                          finalAngle: finalAngle.toFixed(2),
                          expectedEndAngle,
                          remainingAngle: remainingAngle.toFixed(2),
                          segmentsCount: segments.length
                        });
                              
                              return (
                          <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
                            {segments.map((segment) => (
                                <Path
                                key={`segment-${segment.index}-${segment.category.category}`}
                                d={createArcPath(segment.startAngle, segment.endAngle, radius, innerRadius)}
                                fill={segment.color}
                                />
                            ))}
                            {/* Fill remaining space to complete the circle if needed */}
                            {Math.abs(remainingAngle) > 0.1 && (
                              <Path
                                key="remaining-segment"
                                d={createArcPath(finalAngle, expectedEndAngle, radius, innerRadius)}
                                fill={colors.background || '#F5F5F5'}
                                opacity={0.3}
                              />
                            )}
                          </Svg>
                        );
                      })()}
                    </View>
                    
                    {/* Legend */}
                    <View style={styles.donutLegend}>
                      {(analytics.receipts?.categories || []).filter(c => c.total_amount > 0).map((category, index) => {
                        const color = categoryColors[index % categoryColors.length];
                        return (
                          <View key={`legend-${index}-${category.category}`} style={styles.donutLegendItem}>
                            <View style={[styles.donutLegendDot, { backgroundColor: color }]} />
                            <Text style={[styles.donutLegendText, themeStyles.donutLegendText]} numberOfLines={1}>
                              {category.category}
                            </Text>
                          </View>
                        );
                      })}
                    </View>
                  </View>
                  
                  {/* Category Breakdown List - Only categories with content */}
                  <View style={[styles.categoryBreakdownList, themeStyles.categoryBreakdownList]}>
                    <Text style={[styles.categoryBreakdownTitle, themeStyles.categoryBreakdownTitle]}>Category Breakdown</Text>
                    {(analytics.receipts?.categories || []).filter(c => c.total_amount > 0).map((category, index) => {
                      const color = categoryColors[index % categoryColors.length];
                      return (
                        <View key={`breakdown-${index}-${category.category}`} style={[styles.categoryBreakdownItem, themeStyles.categoryBreakdownItem]}>
                          <View style={styles.categoryBreakdownLeft}>
                            <View style={[styles.categoryBreakdownDot, { backgroundColor: color }]} />
                            <Text style={[styles.categoryBreakdownName, themeStyles.categoryBreakdownName]}>{category.category}</Text>
                          </View>
                          <View style={styles.categoryBreakdownRight}>
                            <Text style={styles.categoryBreakdownAmount}>{formatCurrency(category.total_amount)}</Text>
                            <Text style={[styles.categoryBreakdownPercent, themeStyles.categoryBreakdownPercent]}>{category.percentage.toFixed(1)}%</Text>
                            <Text style={[styles.categoryBreakdownCount, themeStyles.categoryBreakdownCount]}>{category.count}</Text>
                          </View>
                        </View>
                      );
                    })}
                  </View>
                </View>
              ) : (
                <Text style={[styles.emptyText, themeStyles.emptyText]}>No receipt categories yet</Text>
              )}
            </View>

                {/* Monthly Spending Trends */}
                {(analytics.receipts?.timeline || []).length > 0 && (
                  <View style={[styles.section, themeStyles.section]}>
                    <Text style={[styles.sectionTitle, themeStyles.sectionTitle]}>Monthly Spending Trends</Text>
                    <View style={styles.trendsContainer}>
                      <View style={styles.trendsBars}>
                        {(analytics.receipts.timeline || []).map((month, index) => {
                          const maxAmount = Math.max(...(analytics.receipts.timeline || []).map(m => m.total_amount));
                          const height = maxAmount > 0 ? (month.total_amount / maxAmount) * 100 : 0;
                          return (
                            <View key={`trend-${index}-${month.month}`} style={styles.trendBar}>
                              <View 
                                style={[
                                  styles.trendBarFill, 
                                  { height: `${Math.max(height, 2)}%` }
                                ]} 
                              />
                              <Text style={[styles.trendBarLabel, themeStyles.trendBarLabel]} numberOfLines={1}>
                                {month.month.length > 6 ? month.month.substring(0, 3) : month.month}
                              </Text>
                            </View>
                          );
                        })}
                      </View>
                      <View style={styles.trendsValues}>
                        {(analytics.receipts.timeline || []).map((month, index) => (
                          <View key={`value-${index}-${month.month}`} style={styles.trendValue}>
                            <Text style={[styles.trendValueAmount, themeStyles.trendValueAmount]}>{formatCurrency(month.total_amount)}</Text>
                            <Text style={[styles.trendValueCount, themeStyles.trendValueCount]}>{month.count}</Text>
                          </View>
                        ))}
                      </View>
                    </View>
                  </View>
                )}

                {/* Receipt Size Distribution */}
                {recentReceipts.length > 0 && (
                  <View style={[styles.section, themeStyles.section]}>
                    <Text style={[styles.sectionTitle, themeStyles.sectionTitle]}>Receipt Size Distribution</Text>
                    {(() => {
                      // Calculate receipt size distribution
                      const sizeRanges = {
                        '0-25': { count: 0, total: 0 },
                        '25-50': { count: 0, total: 0 },
                        '50+': { count: 0, total: 0 },
                      };

                      recentReceipts.forEach((receipt: any) => {
                        const amount = receipt.json_data?.total_amount || 
                                      receipt.json_data?.amount || 
                                      receipt.json_data?.total ||
                                      receipt.amount || 
                                      receipt.total_amount || 0;
                        const numericAmount = typeof amount === 'number' ? amount : 
                                             (typeof amount === 'string' ? parseFloat(amount.replace(/[^0-9.-]/g, '')) || 0 : 0);
                        
                        if (numericAmount <= 25) {
                          sizeRanges['0-25'].count++;
                          sizeRanges['0-25'].total += numericAmount;
                        } else if (numericAmount <= 50) {
                          sizeRanges['25-50'].count++;
                          sizeRanges['25-50'].total += numericAmount;
                        } else {
                          sizeRanges['50+'].count++;
                          sizeRanges['50+'].total += numericAmount;
                        }
                      });

                      const maxCount = Math.max(sizeRanges['0-25'].count, sizeRanges['25-50'].count, sizeRanges['50+'].count);

                      return (
                        <View style={styles.sizeDistributionContainer}>
                          {Object.entries(sizeRanges).map(([range, data], index) => {
                            const percentage = maxCount > 0 ? (data.count / maxCount) * 100 : 0;
                            const color = index === 0 ? '#FF9500' : index === 1 ? '#8E8E93' : '#FF9500';
                            return (
                              <View key={`size-${range}`} style={styles.sizeDistributionItem}>
                                <View style={styles.sizeDistributionHeader}>
                                  <Text style={[styles.sizeDistributionLabel, themeStyles.sizeDistributionLabel]}>${range}</Text>
                                  <Text style={styles.sizeDistributionAmount}>{formatCurrency(data.total)}</Text>
                                </View>
                                <View style={[styles.sizeDistributionBar, themeStyles.sizeDistributionBar]}>
                                  <View style={[styles.sizeDistributionBarFill, { width: `${percentage}%`, backgroundColor: color }]} />
                                </View>
                                <Text style={[styles.sizeDistributionCount, themeStyles.sizeDistributionCount]}>{data.count} receipt{data.count !== 1 ? 's' : ''}</Text>
                              </View>
                            );
                          })}
                        </View>
                      );
                    })()}
                  </View>
                )}

                  {/* Recent Receipts */}
                  {recentReceipts.length > 0 ? (
                    <View style={[styles.section, themeStyles.section]}>
                      <Text style={[styles.sectionTitle, themeStyles.sectionTitle]}>Recent Receipts ({recentReceipts.length})</Text>
                      {recentReceipts.slice(0, receiptListDisplayLimit).map((receipt, index) => {
                        const amount = receipt.json_data?.total_amount || 
                                      receipt.json_data?.amount || 
                                      receipt.json_data?.total ||
                                      receipt.amount || 
                                      receipt.total_amount || 0;
                        const numericAmount = typeof amount === 'number' ? amount : 
                                             (typeof amount === 'string' ? parseFloat(amount.replace(/[^0-9.-]/g, '')) || 0 : 0);
                        
                        const businessName = getReceiptListTitle(receipt, index);
                        const secondaryMeta = getReceiptSecondaryMetaLine(receipt);

                        // Extract category
                        const category = receipt.category || receipt.json_data?.category || receipt.receipt_category || 'Uncategorized';
                        
                        // Debug logging for "techwave" receipts
                        if (businessName.toLowerCase().includes('techwave')) {
                          const jsonSerialized = JSON.stringify(receipt.json_data ?? null);
                          console.log('🔍 Techwave receipt found:', {
                            businessName,
                            secondaryMeta,
                            extractedAmount: amount,
                            numericAmount,
                            jsonDataKeys: receipt.json_data ? Object.keys(receipt.json_data) : [],
                            jsonDataTotal: receipt.json_data?.total,
                            jsonDataAmount: receipt.json_data?.amount,
                            jsonDataTotalAmount: receipt.json_data?.total_amount,
                            receiptAmount: receipt.amount,
                            fullJsonData: (typeof jsonSerialized === 'string' ? jsonSerialized : '').substring(0, 500)
                          });
                        }
                        
                        // Format date: use transaction date from json; if not available or invalid, show upload date (created_at)
                        const txDate = receipt.json_data?.date ?? receipt.json_data?.receipt_data?.date;
                        const uploadDate = receipt.created_at;
                        const date = (() => {
                          if (txDate) {
                            const d = new Date(txDate);
                            if (!Number.isNaN(d.getTime())) return d.toLocaleDateString();
                          }
                          if (uploadDate) {
                            const d = new Date(uploadDate);
                            if (!Number.isNaN(d.getTime())) return d.toLocaleDateString();
                          }
                          return 'Unknown date';
                        })();
                        
                        return (
                          <TouchableOpacity
                            key={`receipt-${index}-${getFileId(receipt) ?? index}`}
                            style={styles.receiptItemContainer}
                            activeOpacity={0.7}
                            onPress={() => handleOpenEdit(receipt, 'receipt')}
                          >
                            <View style={[styles.compactListItem, themeStyles.compactListItem]}>
                            <View style={styles.compactListInfo}>
                              <Text style={[styles.compactListName, themeStyles.compactListName]}>{businessName}</Text>
                              <Text style={[styles.compactListSubtext, themeStyles.compactListSubtext]}>
                                  {date} • {category}
                              </Text>
                              {secondaryMeta ? (
                                <Text style={[styles.compactListMeta, themeStyles.compactListMeta]} numberOfLines={2}>
                                  {secondaryMeta}
                                </Text>
                              ) : null}
                            </View>
                              <View style={styles.receiptActions}>
                            <Text style={[styles.compactListAmount, themeStyles.compactListAmount]}>{formatCurrency(numericAmount)}</Text>
                                <TouchableOpacity
                                  style={styles.viewButton}
                                  onPress={() => openFileInViewer(receipt)}
                                  accessibilityRole="button"
                                  accessibilityLabel="View receipt"
                                >
                                  <Text style={styles.viewButtonText}>View</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                  style={styles.editButton}
                                  onPress={() => handleOpenEdit(receipt, 'receipt')}
                                  accessibilityRole="button"
                                  accessibilityLabel="Edit receipt"
                                >
                                  <Text style={styles.editButtonText}>Edit</Text>
                                </TouchableOpacity>
                              </View>
                            </View>
                          </TouchableOpacity>
                        );
                      })}
                      {recentReceipts.length > receiptListDisplayLimit ? (
                        <TouchableOpacity
                          style={[styles.loadMoreFinancials, { borderTopColor: colors.border }]}
                          onPress={() =>
                            setReceiptListDisplayLimit((n) =>
                              Math.min(n + FINANCIALS_LIST_PAGE_SIZE, recentReceipts.length)
                            )
                          }
                          accessibilityRole="button"
                          accessibilityLabel="Load more receipts"
                        >
                          <Text style={[styles.loadMoreFinancialsText, { color: colors.primary }]}>
                            Load more ({recentReceipts.length - receiptListDisplayLimit} remaining)
                          </Text>
                        </TouchableOpacity>
                      ) : null}
                    </View>
                  ) : (
                    <View style={[styles.section, themeStyles.section]}>
                      <Text style={[styles.sectionTitle, themeStyles.sectionTitle]}>Recent Receipts</Text>
                      <View style={styles.emptyContainer}>
                        <Ionicons name="receipt-outline" size={48} color="#ccc" />
                        <Text style={[styles.emptyText, themeStyles.emptyText]}>No Receipts Found</Text>
                        <Text style={[styles.emptySubtext, themeStyles.emptySubtext]}>
                          {analytics?.receipts?.summary?.total_receipts 
                            ? `Analytics shows ${analytics.receipts.summary.total_receipts} receipt(s), but no receipt files were found.`
                            : 'Upload some receipts to see them here.'}
                        </Text>
                        {__DEV__ && (
                          <Text style={[styles.emptySubtext, { marginTop: 8, fontSize: 10 }]}>
                            Debug: recentReceipts.length = {recentReceipts.length}
                          </Text>
                        )}
                      </View>
                    </View>
                  )}
              </>
            ) : (
              <View style={styles.emptyContainer}>
                <Ionicons name="receipt-outline" size={64} color="#ccc" />
                <Text style={[styles.emptyText, themeStyles.emptyText]}>No Receipt Data Available</Text>
                <Text style={[styles.emptySubtext, themeStyles.emptySubtext]}>
                  Receipt analytics will appear here once you upload some receipts.
                </Text>
              </View>
            )}
          </>
        )}

        {activeTab === 'invoices' && (
          <>
            {analytics.invoices && analytics.invoices.overview ? (
              <>
                {/* Invoice Overview Stats */}
                <View style={[styles.section, themeStyles.section]}>
                  <Text style={[styles.sectionTitle, themeStyles.sectionTitle]}>Invoice Overview</Text>
                  <View style={styles.statsRow}>
                    <StatCard
                      title="Total Invoices"
                      value={analytics.invoices.overview.total_invoices || 0}
                      subtitle={formatCurrency(analytics.invoices.overview.total_amount || 0)}
                      icon="document-text"
                      color="#2563EB"
                    />
                    <StatCard
                      title="Overdue"
                      value={analytics.invoices.overview.overdue_count || 0}
                      subtitle={formatCurrency(analytics.invoices.overview.overdue_amount || 0)}
                      icon="calendar"
                      color="#F59E0B"
                    />
                  </View>
                  <View style={styles.statsRow}>
                    <StatCard
                      title="Paid"
                      value={analytics.invoices.overview.paid_count || 0}
                      subtitle={formatCurrency(analytics.invoices.overview.paid_amount || 0)}
                      icon="checkmark-circle"
                      color="#10B981"
                    />
                    <StatCard
                      title="Unpaid"
                      value={analytics.invoices.overview.unpaid_count || 0}
                      subtitle={formatCurrency(analytics.invoices.overview.unpaid_amount || 0)}
                      icon="close-circle"
                      color="#EF4444"
                    />
                  </View>
                </View>

                {/* Payment Status Distribution */}
                {analytics.invoices.payment_distribution && analytics.invoices.payment_distribution.length > 0 && (
                  <View style={[styles.section, themeStyles.section]}>
                    <Text style={[styles.sectionTitle, themeStyles.sectionTitle]}>Payment Status</Text>
                    <View style={styles.compactChartContainer}>
                      {analytics.invoices.payment_distribution.map((item, index) => {
                        const colors: Record<string, string> = { 'Paid': '#10B981', 'Unpaid': '#EF4444', 'Partial': '#F59E0B' };
                        const color = colors[item.status] || '#6366F1';
                        return (
                          <View key={`payment-${index}-${item.status}`} style={styles.compactChartItem}>
                            <View style={styles.compactChartHeader}>
                              <View style={[styles.compactChartDot, { backgroundColor: color }]} />
                              <Text style={[styles.compactChartLabel, themeStyles.compactChartLabel]}>{item.status}</Text>
                            </View>
                            <View style={[styles.compactChartBar, themeStyles.compactChartBar]}>
                              <View style={[styles.compactChartFill, { width: `${item.percentage}%`, backgroundColor: color }]} />
                            </View>
                            <View style={styles.compactChartValues}>
                              <Text style={[styles.compactChartAmount, themeStyles.compactChartAmount]}>{formatCurrency(item.total_amount)}</Text>
                              <Text style={styles.compactChartPercentage}>{item.percentage.toFixed(1)}%</Text>
                              <Text style={[styles.compactChartCount, themeStyles.compactChartCount]}>{item.count}</Text>
                            </View>
                          </View>
                        );
                      })}
                    </View>
                  </View>
                )}

                {/* Recent Invoices */}
                {recentInvoices.length > 0 && (
                  <View style={[styles.section, themeStyles.section]}>
                    <Text style={[styles.sectionTitle, themeStyles.sectionTitle]}>Recent Invoices ({recentInvoices.length})</Text>
                    {recentInvoices.slice(0, invoiceListDisplayLimit).map((invoice, index) => {
                      const amount = invoice.json_data?.total_amount || 
                                    invoice.json_data?.amount || 
                                    invoice.json_data?.invoice_amount ||
                                    invoice.json_data?.total ||
                                    invoice.amount || 
                                    invoice.total_amount || 0;
                      const numericAmount = typeof amount === 'number' ? amount : 
                                           (typeof amount === 'string' ? parseFloat(amount.replace(/[^0-9.-]/g, '')) || 0 : 0);
                      
                      // Extract business/vendor name from multiple possible locations
                      // Prioritize vendor_name, business_name, vendor fields over filename
                      const businessName = invoice.vendor_name ||
                                          invoice.business_name ||
                                          invoice.vendor ||
                                          invoice.json_data?.vendor_name || 
                                          invoice.json_data?.business_name || 
                                          invoice.json_data?.vendor ||
                                          invoice.json_data?.merchant_name ||
                                          invoice.json_data?.invoice_data?.vendor_name ||
                                          invoice.json_data?.invoice_data?.business_name ||
                                          invoice.json_data?.invoice_data?.vendor ||
                                          invoice.json_data?.invoice_data?.merchant_name ||
                                          `Invoice ${index + 1}`;
                      
                      // Only use filename as last resort if no business name is found
                      // Remove filename from the fallback chain
                      
                      // Prefer document date; if not available or invalid, show upload date (created_at)
                      const invTxDate = invoice.json_data?.date ?? invoice.json_data?.invoice_date;
                      const invUploadDate = invoice.created_at;
                      const date = (() => {
                        if (invTxDate) {
                          const d = new Date(invTxDate);
                          if (!Number.isNaN(d.getTime())) return d.toLocaleDateString();
                        }
                        if (invUploadDate) {
                          const d = new Date(invUploadDate);
                          if (!Number.isNaN(d.getTime())) return d.toLocaleDateString();
                        }
                        return 'Unknown date';
                      })();
                      const status = (invoice.payment_status || 
                                    invoice.json_data?.payment_status || 
                                    invoice.json_data?.status || 
                                    'unpaid').toLowerCase();
                      const statusColor = status === 'paid' ? '#10B981' : status === 'partial' ? '#F59E0B' : '#EF4444';
                      
                      return (
                        <TouchableOpacity
                          key={`invoice-${index}-${getFileId(invoice) ?? index}`}
                          style={styles.receiptItemContainer}
                          activeOpacity={0.7}
                          onPress={() => handleOpenEdit(invoice, 'invoice')}
                        >
                          <View style={[styles.compactListItem, themeStyles.compactListItem]}>
                          <View style={styles.compactListInfo}>
                              <Text style={[styles.compactListName, themeStyles.compactListName]}>{businessName}</Text>
                            <Text style={[styles.compactListSubtext, themeStyles.compactListSubtext]}>
                              {date} • <Text style={{ color: statusColor, textTransform: 'capitalize' }}>{status}</Text>
                            </Text>
                          </View>
                            <View style={styles.receiptActions}>
                          <Text style={[styles.compactListAmount, themeStyles.compactListAmount]}>{formatCurrency(numericAmount)}</Text>
                              <TouchableOpacity
                                style={styles.viewButton}
                                onPress={() => openFileInViewer(invoice)}
                                accessibilityRole="button"
                                accessibilityLabel="View invoice"
                              >
                                <Text style={styles.viewButtonText}>View</Text>
                              </TouchableOpacity>
                              <TouchableOpacity
                                style={styles.editButton}
                                onPress={() => handleOpenEdit(invoice, 'invoice')}
                                accessibilityRole="button"
                                accessibilityLabel="Edit invoice"
                              >
                                <Text style={styles.editButtonText}>Edit</Text>
                              </TouchableOpacity>
                              <TouchableOpacity
                                style={styles.categorizeButton}
                                onPress={() => handleUpdatePaymentStatus(invoice)}
                                accessibilityRole="button"
                                accessibilityLabel="Update payment status"
                              >
                                <Ionicons name="card-outline" size={18} color="#007AFF" />
                              </TouchableOpacity>
                            </View>
                          </View>
                        </TouchableOpacity>
                      );
                    })}
                    {recentInvoices.length > invoiceListDisplayLimit ? (
                      <TouchableOpacity
                        style={[styles.loadMoreFinancials, { borderTopColor: colors.border }]}
                        onPress={() =>
                          setInvoiceListDisplayLimit((n) =>
                            Math.min(n + FINANCIALS_LIST_PAGE_SIZE, recentInvoices.length)
                          )
                        }
                        accessibilityRole="button"
                        accessibilityLabel="Load more invoices"
                      >
                        <Text style={[styles.loadMoreFinancialsText, { color: colors.primary }]}>
                          Load more ({recentInvoices.length - invoiceListDisplayLimit} remaining)
                        </Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                )}
              </>
            ) : (
              <View style={styles.emptyContainer}>
                <Ionicons name="document-text-outline" size={64} color="#ccc" />
                <Text style={[styles.emptyText, themeStyles.emptyText]}>No Invoice Data Available</Text>
                <Text style={[styles.emptySubtext, themeStyles.emptySubtext]}>
                  Invoice analytics will appear here once you upload some invoices.
                </Text>
              </View>
            )}
          </>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* Document Viewer - opened from View on receipt/invoice rows */}
      {showDocumentViewer && selectedFileForView && (
        <DocumentViewer
          fileId={selectedFileForView.fileId}
          fileName={selectedFileForView.fileName}
          fileType={selectedFileForView.fileType}
          fileCategory={selectedFileForView.fileCategory}
          onClose={() => {
            setShowDocumentViewer(false);
            setSelectedFileForView(null);
          }}
        />
      )}
      
      <AdaptiveListPickerModal
        visible={showReceiptCategoryFilterModal}
        onClose={() => setShowReceiptCategoryFilterModal(false)}
        title="Filter by Category"
        itemCount={receiptCategoryFilterOptions.length}
      >
        {receiptCategoryFilterOptions.map((category) => (
          <TouchableOpacity
            key={category}
            style={[styles.categoryModalItem, themeStyles.categoryModalItem]}
            onPress={() => {
              setSelectedCategory(category);
              setShowReceiptCategoryFilterModal(false);
            }}
          >
            <Text style={[styles.categoryItemText, themeStyles.categoryItemText]}>{category}</Text>
            {selectedCategory === category && <Ionicons name="checkmark" size={20} color={colors.primary} />}
          </TouchableOpacity>
        ))}
      </AdaptiveListPickerModal>

      <AdaptiveListPickerModal
        visible={showCategoryModal}
        onClose={() => setShowCategoryModal(false)}
        title="Select Category"
        itemCount={receiptCategories.length}
        footer={
          categorizingReceipt ? (
            <View style={[styles.modalLoading, themeStyles.modalLoading]}>
              <ActivityIndicator size="large" color={colors.primary} />
            </View>
          ) : null
        }
      >
        {receiptCategories.map((category) => (
          <FeedbackTouchable
            key={category}
            style={[styles.categoryModalItem, themeStyles.categoryModalItem]}
            onPress={() => handleSelectCategory(category)}
            disabled={categorizingReceipt}
            loading={categorizingReceipt}
            spinnerColor={colors.primary}
            replaceWithSpinner={false}
          >
            <Text style={[styles.categoryItemText, themeStyles.categoryItemText]}>{category}</Text>
            <Ionicons name="chevron-forward" size={20} color={colors.textLight} />
          </FeedbackTouchable>
        ))}
      </AdaptiveListPickerModal>

      <MinimizableBottomSheet
        visible={showEditModal}
        onClose={handleCloseEdit}
        title={editType === 'invoice' ? 'Edit Invoice' : 'Correct Data'}
        heightRatio={0.85}
      >
        <ScrollView
          style={styles.editFormScroll}
          contentContainerStyle={styles.editFormScrollContent}
          keyboardShouldPersistTaps="handled"
          bounces={true}
          overScrollMode="always"
        >
              {getFileId(editItem) != null ? (
                  <View style={[styles.editFormRow, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}>
                    <Text style={[styles.editFormLabel, themeStyles.editFormLabel, { marginBottom: 0 }]}>Clients</Text>
                    <ClientsButton
                      itemType="file"
                      itemId={getFileId(editItem) as number}
                      allowCreate
                      compact
                    />
                  </View>
              ) : null}
              <View style={styles.editFormRow}>
                <Text style={[styles.editFormLabel, themeStyles.editFormLabel]}>{editType === 'invoice' ? 'Vendor name' : 'Store name'}</Text>
                <TextInput
                  style={[styles.editFormInput, themeStyles.editFormInput]}
                  value={editForm.store_name}
                  onChangeText={(t) => setEditForm((f) => ({ ...f, store_name: t }))}
                  placeholder={editType === 'invoice' ? 'Vendor name' : 'Store name'}
                  placeholderTextColor={colors.textLight}
                />
              </View>
              <View style={styles.editFormRowDateAmount}>
                <View style={[styles.editFormRow, { flex: 1 }]}>
                  <Text style={[styles.editFormLabel, themeStyles.editFormLabel]}>Date</Text>
                  <View style={styles.editFormDateWrapper}>
                    <TouchableOpacity
                      style={[styles.editFormInput, styles.editFormDateTouchable, themeStyles.editFormInput]}
                      activeOpacity={0.7}
                      onPress={() => {
                        const useToday = isEpochOrEmptyDate(editForm.date);
                        const d = !useToday && editForm.date ? parseLocalDateString(editForm.date) : null;
                        if (useToday || !d || isNaN(d.getTime())) {
                          setEditDatePickerValue(new Date());
                        } else {
                          setEditDatePickerValue(d);
                        }
                        // Close edit modal first so only one Modal is visible at a time (iOS doesn't show a second Modal on top)
                        setShowEditModal(false);
                        setTimeout(() => setShowEditDatePicker(true), Platform.OS === 'ios' ? 350 : 0);
                      }}
                    >
                      <View style={styles.editFormDateTextWrap}>
                        <Text style={[styles.editFormDateText, themeStyles.editFormDateText, !editForm.date && styles.editFormDatePlaceholder, !editForm.date && themeStyles.editFormDatePlaceholder]} numberOfLines={1}>
                          {editForm.date || 'Select date'}
                        </Text>
                      </View>
                      <Ionicons name="calendar-outline" size={20} color={colors.textSecondary} style={styles.editFormDateIcon} />
                    </TouchableOpacity>
                  </View>
                </View>
                <View style={[styles.editFormRow, { flex: 1 }]}>
                  <Text style={[styles.editFormLabel, themeStyles.editFormLabel]}>Total</Text>
                  <TextInput
                    style={[styles.editFormInput, themeStyles.editFormInput]}
                    value={editForm.total_amount}
                    onChangeText={(t) => setEditForm((f) => ({ ...f, total_amount: t }))}
                    placeholder="0.00"
                    placeholderTextColor={colors.textLight}
                    keyboardType="decimal-pad"
                  />
                </View>
              </View>
              <View style={styles.editFormRow}>
                <Text style={[styles.editFormLabel, themeStyles.editFormLabel]}>Category</Text>
                <View style={styles.editCategoryList}>
                  {receiptCategories.map((cat) => (
                    <TouchableOpacity
                      key={cat}
                      style={[
                        styles.editCategoryChip,
                        themeStyles.editCategoryChip,
                        editForm.category === cat && styles.editCategoryChipSelected,
                      ]}
                      onPress={() => setEditForm((f) => ({ ...f, category: cat }))}
                    >
                      <Text style={[
                        styles.editCategoryChipText,
                        themeStyles.editCategoryChipText,
                        editForm.category === cat && styles.editCategoryChipTextSelected,
                      ]}>{cat}</Text>
                      {editForm.category === cat && <Ionicons name="checkmark" size={18} color="#fff" />}
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
          </ScrollView>
        <View style={[styles.editFormActions, themeStyles.editFormActions]}>
          <TouchableOpacity
            style={[styles.editFormButton, styles.editFormButtonCancel, themeStyles.editFormButtonCancel]}
            onPress={handleCloseEdit}
            disabled={savingEdit}
          >
            <Text style={[styles.editFormButtonTextCancel, themeStyles.editFormButtonTextCancel]}>Cancel</Text>
          </TouchableOpacity>
          <FeedbackTouchable
            style={[styles.editFormButton, styles.editFormButtonSave]}
            onPress={handleConfirmSave}
            disabled={savingEdit}
            loading={savingEdit}
            spinnerColor="#fff"
          >
            <Text style={styles.editFormButtonText}>Save</Text>
          </FeedbackTouchable>
        </View>
      </MinimizableBottomSheet>

      {showEditDatePicker && Platform.OS === 'ios' && (
        <MinimizableBottomSheet
          visible={showEditDatePicker}
          onClose={handleEditDatePickerDone}
          title="Select date"
          sheetHeight={320}
          headerRight={() => (
            <TouchableOpacity onPress={() => { setShowEditDatePicker(false); setTimeout(() => setShowEditModal(true), 0); }}>
              <Text style={[styles.doneButton, themeStyles.doneButton]}>Done</Text>
            </TouchableOpacity>
          )}
        >
          <View style={[styles.pickerModalContent, themeStyles.pickerModalContent]}>
            <DateTimePicker
              value={getValidDate(editDatePickerValue)}
              mode="date"
              display="spinner"
              minimumDate={filterDateMin}
              maximumDate={filterDateMax}
              onChange={handleEditDateChange}
              style={styles.pickerModalDatePicker}
              textColor={colors.text}
              accentColor={colors.primary}
            />
          </View>
        </MinimizableBottomSheet>
      )}
      {/* Edit form date - Android: Native calendar */}
      {showEditDatePicker && Platform.OS !== 'ios' && (
        <DateTimePicker
          value={getValidDate(editDatePickerValue)}
          mode="date"
          display="default"
          minimumDate={filterDateMin}
          maximumDate={filterDateMax}
          onChange={handleEditDateChange}
        />
      )}
      
      <AdaptiveListPickerModal
        visible={showPaymentStatusModal}
        onClose={() => setShowPaymentStatusModal(false)}
        title="Update Payment Status"
        itemCount={paymentStatuses.length}
        footer={
          updatingPaymentStatus ? (
            <View style={[styles.modalLoading, themeStyles.modalLoading]}>
              <ActivityIndicator size="large" color={colors.primary} />
            </View>
          ) : null
        }
      >
        {paymentStatuses.map((status) => (
          <FeedbackTouchable
            key={status}
            style={[styles.categoryModalItem, themeStyles.categoryModalItem]}
            onPress={() => handleSelectPaymentStatus(status)}
            disabled={updatingPaymentStatus}
            loading={updatingPaymentStatus}
            spinnerColor={colors.primary}
            replaceWithSpinner={false}
          >
            <Text style={[styles.categoryItemText, themeStyles.categoryItemText]}>{status}</Text>
            <Ionicons name="chevron-forward" size={20} color={colors.textLight} />
          </FeedbackTouchable>
        ))}
      </AdaptiveListPickerModal>
      
      <MinimizableBottomSheet
        visible={showAdvancedFilterModal}
        onClose={() => {
          Keyboard.dismiss();
          setShowAdvancedFilterModal(false);
        }}
        title="Advanced Filters"
        heightRatio={0.92}
      >
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior="padding"
          keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 24}
        >
          <ScrollView
            style={styles.filterModalScroll}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.filterModalScrollContent}
            showsVerticalScrollIndicator={false}
          >
              {/* Date Range Section - same date picker trigger style as Schedule Meeting */}
              <View style={styles.filterSection}>
                <Text style={[styles.filterSectionTitle, themeStyles.filterSectionTitle]}>Date Range</Text>
                <TouchableOpacity
                  style={[styles.filterOptionButton, themeStyles.filterOptionButton]}
                  onPress={() => setDraftUseOneYear((prev) => !prev)}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.filterOptionText, themeStyles.filterOptionText]}>1yr</Text>
                  <View style={[styles.filterCheckbox, draftUseOneYear && styles.filterCheckboxChecked]}>
                    {draftUseOneYear && <Ionicons name="checkmark" size={16} color="#fff" />}
                  </View>
                </TouchableOpacity>

                <View style={styles.filterInputGroup}>
                  <Text style={[styles.filterInputLabel, themeStyles.filterInputLabel]}>From Date</Text>
                  <TouchableOpacity
                    style={[styles.filterDatePickerContainer, themeStyles.filterDatePickerContainer]}
                    onPress={() => {
                      datePickerEditingDraftRef.current = 'from';
                      if (Platform.OS === 'ios') fromPickerForDraftRef.current = true;
                      const fromStr = draftCustomDateFrom || customDateFrom;
                      if (fromStr) {
                        const [y, m, d] = fromStr.split('-').map(Number);
                        setDateFromPickerValue(new Date(y, m - 1, d));
                      }
                      if (Platform.OS === 'ios') {
                        setReopenAdvancedFilterAfterDatePicker(true);
                        setShowAdvancedFilterModal(false);
                        setTimeout(() => setShowDateFromPicker(true), 350);
                      } else {
                        setShowDateFromPicker(true);
                      }
                    }}
                  >
                    <Text style={draftCustomDateFrom ? [styles.filterDatePickerLabel, themeStyles.filterDatePickerLabel] : [styles.filterDatePickerPlaceholder, themeStyles.filterDatePickerPlaceholder]}>
                      {draftCustomDateFrom
                        ? (() => {
                            const d = parseLocalDateString(draftCustomDateFrom);
                            return !d || Number.isNaN(d.getTime())
                              ? draftCustomDateFrom
                              : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
                          })()
                        : 'Select date'}
                    </Text>
                    <Ionicons name="calendar-outline" size={20} color={colors.primary} />
                  </TouchableOpacity>
                </View>
                <View style={styles.filterInputGroup}>
                  <Text style={[styles.filterInputLabel, themeStyles.filterInputLabel]}>To Date</Text>
                  <TouchableOpacity
                    style={[styles.filterDatePickerContainer, themeStyles.filterDatePickerContainer]}
                    onPress={() => {
                      datePickerEditingDraftRef.current = 'to';
                      if (Platform.OS === 'ios') toPickerForDraftRef.current = true;
                      const toStr = draftCustomDateTo || customDateTo;
                      if (toStr) {
                        const [y, m, d] = toStr.split('-').map(Number);
                        setDateToPickerValue(new Date(y, m - 1, d));
                      }
                      if (Platform.OS === 'ios') {
                        setReopenAdvancedFilterAfterDatePicker(true);
                        setShowAdvancedFilterModal(false);
                        setTimeout(() => setShowDateToPicker(true), 350);
                      } else {
                        setShowDateToPicker(true);
                      }
                    }}
                  >
                        <Text style={draftCustomDateTo ? [styles.filterDatePickerLabel, themeStyles.filterDatePickerLabel] : [styles.filterDatePickerPlaceholder, themeStyles.filterDatePickerPlaceholder]}>
                          {draftCustomDateTo
                            ? (() => {
                                const d = parseLocalDateString(draftCustomDateTo);
                                return !d || Number.isNaN(d.getTime())
                                  ? draftCustomDateTo
                                  : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
                              })()
                            : 'Select date'}
                    </Text>
                    <Ionicons name="calendar-outline" size={20} color={colors.primary} />
                  </TouchableOpacity>
                </View>
              </View>
              
              {/* Amount Range Section */}
              <View style={styles.filterSection}>
                <Text style={[styles.filterSectionTitle, themeStyles.filterSectionTitle]}>Amount Range</Text>
                <View style={styles.amountRangeContainer}>
                  <View style={styles.amountInputContainer}>
                    <Text style={[styles.filterLabel, themeStyles.filterLabel]}>Min Amount</Text>
                    <TextInput
                      style={[styles.amountInput, themeStyles.amountInput]}
                      placeholder="0.00"
                      value={draftAmountMin}
                      onChangeText={setDraftAmountMin}
                      keyboardType="decimal-pad"
                      placeholderTextColor={colors.textLight}
                    />
                  </View>
                  <View style={styles.amountInputContainer}>
                    <Text style={[styles.filterLabel, themeStyles.filterLabel]}>Max Amount</Text>
                    <TextInput
                      style={[styles.amountInput, themeStyles.amountInput]}
                      placeholder="0.00"
                      value={draftAmountMax}
                      onChangeText={setDraftAmountMax}
                      keyboardType="decimal-pad"
                      placeholderTextColor={colors.textLight}
                    />
                  </View>
                </View>
              </View>
              
              {/* Store/Vendor Name Section */}
              <View style={styles.filterSection}>
                <Text style={[styles.filterSectionTitle, themeStyles.filterSectionTitle]}>
                  {activeTab === 'receipts' ? 'Store Name' : 'Vendor Name'}
                </Text>
                <TextInput
                  style={[styles.textInput, themeStyles.textInput]}
                  placeholder={`Enter ${activeTab === 'receipts' ? 'store' : 'vendor'} name`}
                  value={draftStoreVendorName}
                  onChangeText={setDraftStoreVendorName}
                  placeholderTextColor={colors.textLight}
                />
              </View>
              
              {/* Action Buttons */}
              <View style={styles.filterActions}>
                <TouchableOpacity
                  style={[styles.filterButton, styles.filterButtonSecondary, themeStyles.filterButtonSecondary]}
                  onPress={() => {
                    setDraftUseOneYear(false);
                    setDraftCustomDateFrom('');
                    setDraftCustomDateTo('');
                    setDraftAmountMin('');
                    setDraftAmountMax('');
                    setDraftStoreVendorName('');
                    setCustomDateFrom('');
                    setCustomDateTo('');
                    setAmountMin('');
                    setAmountMax('');
                    setStoreVendorName('');
                    setUseCustomFilters(false);
                    setTimePeriod('365'); // Restore default preset when clearing custom filters (1 year)
                    Keyboard.dismiss();
                    setTimeout(() => {
                      setShowAdvancedFilterModal(false);
                      loadAnalytics('365');
                    }, 100);
                  }}
                >
                  <Text style={[styles.filterButtonTextSecondary, themeStyles.filterButtonTextSecondary]}>Clear All</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.filterButton, styles.filterButtonPrimary]}
                  onPress={() => {
                    Keyboard.dismiss();
                    if (draftUseOneYear) {
                      setCustomDateFrom('');
                      setCustomDateTo('');
                      setAmountMin('');
                      setAmountMax('');
                      setStoreVendorName('');
                      setUseCustomFilters(false);
                      setTimePeriod('365');
                      setTimeout(() => {
                        setShowAdvancedFilterModal(false);
                        loadAnalytics('365');
                      }, 100);
                    } else {
                      setCustomDateFrom(draftCustomDateFrom);
                      setCustomDateTo(draftCustomDateTo);
                      setAmountMin(draftAmountMin);
                      setAmountMax(draftAmountMax);
                      setStoreVendorName(draftStoreVendorName);
                      setUseCustomFilters(true);
                      setTimePeriod(''); // Unselect 7/30/90 days when using custom/advanced filter
                      setShowAdvancedFilterModal(false);
                      // Don't call loadAnalytics here - state is not committed yet (stale closure).
                      // useEffect will run when customDateFrom/customDateTo/useCustomFilters change and refetch with correct params.
                    }
                  }}
                >
                  <Text style={styles.filterButtonTextPrimary}>Apply Filters</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
        </KeyboardAvoidingView>
      </MinimizableBottomSheet>

      {showDateFromPicker && Platform.OS === 'ios' && (
        <MinimizableBottomSheet
          visible={showDateFromPicker}
          onClose={() => {
            fromPickerForDraftRef.current = false;
            datePickerEditingDraftRef.current = null;
            setShowDateFromPicker(false);
            if (reopenAdvancedFilterAfterDatePicker) {
              setReopenAdvancedFilterAfterDatePicker(false);
              setTimeout(() => setShowAdvancedFilterModal(true), 100);
            }
          }}
          title="Select date"
          sheetHeight={320}
          headerRight={() => (
            <TouchableOpacity onPress={handleDateFromPickerDone}>
              <Text style={[styles.doneButton, themeStyles.doneButton]}>Done</Text>
            </TouchableOpacity>
          )}
        >
          <View style={[styles.pickerModalContent, themeStyles.pickerModalContent]}>
            <DateTimePicker
              value={getValidDate(dateFromPickerValue)}
              mode="date"
              display="spinner"
              onChange={handleDateFromChange}
              minimumDate={filterDateMin}
              maximumDate={filterDateMax}
              style={styles.pickerModalDatePicker}
              textColor={colors.text}
              accentColor={colors.primary}
            />
          </View>
        </MinimizableBottomSheet>
      )}
      {/* From Date - Android: Native calendar */}
      {showDateFromPicker && Platform.OS !== 'ios' && (
        <DateTimePicker
          value={getValidDate(dateFromPickerValue)}
          mode="date"
          display="default"
          onChange={handleDateFromChange}
          minimumDate={filterDateMin}
          maximumDate={filterDateMax}
        />
      )}

      {showDateToPicker && Platform.OS === 'ios' && (
        <MinimizableBottomSheet
          visible={showDateToPicker}
          onClose={() => {
            toPickerForDraftRef.current = false;
            datePickerEditingDraftRef.current = null;
            setShowDateToPicker(false);
            if (reopenAdvancedFilterAfterDatePicker) {
              setReopenAdvancedFilterAfterDatePicker(false);
              setTimeout(() => setShowAdvancedFilterModal(true), 100);
            }
          }}
          title="Select date"
          sheetHeight={320}
          headerRight={() => (
            <TouchableOpacity onPress={handleDateToPickerDone}>
              <Text style={[styles.doneButton, themeStyles.doneButton]}>Done</Text>
            </TouchableOpacity>
          )}
        >
          <View style={[styles.pickerModalContent, themeStyles.pickerModalContent]}>
            <DateTimePicker
              value={getValidDate(dateToPickerValue)}
              mode="date"
              display="spinner"
              onChange={handleDateToChange}
              minimumDate={getValidDate(dateFromPickerValue)}
              maximumDate={filterDateMax}
              style={styles.pickerModalDatePicker}
              textColor={colors.text}
              accentColor={colors.primary}
            />
          </View>
        </MinimizableBottomSheet>
      )}
      {/* To Date - Android: Native calendar */}
      {showDateToPicker && Platform.OS !== 'ios' && (
        <DateTimePicker
          value={getValidDate(dateToPickerValue)}
          mode="date"
          display="default"
          onChange={handleDateToChange}
          minimumDate={getValidDate(dateFromPickerValue)}
          maximumDate={filterDateMax}
        />
      )}
      <UploadOptionsModal
        visible={uploadSheet.visible}
        expandNonce={uploadSheet.expandNonce}
        isUploading={isUploading}
        onDismiss={dismissUploadModal}
        onFiles={handleFinancialsUploadFromFiles}
        onCamera={handleFinancialsUploadFromCamera}
        onGallery={handleFinancialsUploadFromGallery}
        onLink={handleFinancialsUploadByLink}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#333',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerButton: {
    padding: 8,
    marginTop: 4,
  },
  shareButton: {
    padding: 8,
    marginTop: 4,
  },
  placeholder: {
    width: 24,
  },
  content: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 16,
    fontSize: 16,
    color: '#666',
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  errorText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#666',
    marginTop: 16,
    textAlign: 'center',
  },
  errorSubtext: {
    fontSize: 14,
    color: '#999',
    marginTop: 8,
    textAlign: 'center',
    lineHeight: 20,
  },
  retryButton: {
    marginTop: 16,
    backgroundColor: '#007AFF',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  retryButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  section: {
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginVertical: 8,
    borderRadius: 12,
    padding: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#333',
    marginBottom: 16,
  },
  subsection: {
    marginBottom: 24,
  },
  subsectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
    marginBottom: 12,
  },
  timePeriodContainer: {
    backgroundColor: '#fff',
    marginHorizontal: Platform.OS === 'android' ? 12 : 16,
    marginVertical: 8,
    borderRadius: 12,
    padding: Platform.OS === 'android' ? 10 : 16,
  },
  timePeriodHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Platform.OS === 'android' ? 8 : 12,
  },
  activeFiltersText: {
    fontSize: 12,
    color: '#007AFF',
    fontWeight: '500',
    fontStyle: 'italic',
    flex: 1,
    textAlign: 'right',
    marginLeft: 12,
  },
  timePeriodButtons: {
    flexDirection: 'row',
    gap: Platform.OS === 'android' ? 4 : 8,
  },
  timePeriodButtonsRow: {
    flexWrap: 'wrap',
  },
  timePeriodButton: {
    flex: 1,
    paddingVertical: Platform.OS === 'android' ? 6 : 8,
    paddingHorizontal: Platform.OS === 'android' ? 4 : 12,
    borderRadius: 8,
    backgroundColor: '#f0f0f0',
    alignItems: 'center',
  },
  timePeriodButtonActive: {
    backgroundColor: '#007AFF',
  },
  timePeriodButtonText: {
    fontSize: Platform.OS === 'android' ? 12 : 14,
    fontWeight: '500',
    color: '#666',
  },
  timePeriodButtonTextActive: {
    color: '#fff',
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  statsRow: {
    flexDirection: 'row',
    gap: 12,
  },
  statsRowThree: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  statCard: {
    flex: 1,
    backgroundColor: '#f8f9fa',
    padding: 16,
    borderRadius: 12,
  },
  statCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  statCardIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 8,
  },
  statCardTitle: {
    fontSize: 14,
    fontWeight: '500',
    color: '#666',
  },
  statCardValue: {
    fontSize: 20,
    fontWeight: '700',
    color: '#333',
    marginBottom: 4,
  },
  statCardSubtitle: {
    fontSize: 12,
    color: '#666',
  },
  categoryBar: {
    marginBottom: 16,
  },
  categoryBarHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  categoryBarTitle: {
    fontSize: 14,
    fontWeight: '500',
    color: '#333',
  },
  categoryBarAmount: {
    fontSize: 14,
    fontWeight: '600',
    color: '#007AFF',
  },
  categoryBarContainer: {
    height: 8,
    backgroundColor: '#f0f0f0',
    borderRadius: 4,
    marginBottom: 4,
  },
  categoryBarFill: {
    height: '100%',
    borderRadius: 4,
  },
  categoryBarPercentage: {
    fontSize: 12,
    color: '#666',
    textAlign: 'right',
  },
  businessItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  businessInfo: {
    flex: 1,
  },
  businessName: {
    fontSize: 14,
    fontWeight: '500',
    color: '#333',
    marginBottom: 2,
  },
  businessStats: {
    fontSize: 12,
    color: '#666',
  },
  businessRank: {
    fontSize: 16,
    fontWeight: '700',
    color: '#007AFF',
  },
  fileTypeItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
  },
  fileTypeInfo: {
    flex: 1,
  },
  fileTypeName: {
    fontSize: 14,
    fontWeight: '500',
    color: '#333',
  },
  fileTypeCount: {
    fontSize: 12,
    color: '#666',
  },
  fileTypePercentage: {
    fontSize: 14,
    fontWeight: '600',
    color: '#007AFF',
  },
  storageInfo: {
    flexDirection: 'row',
    gap: 12,
  },
  workspaceItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  workspaceInfo: {
    flex: 1,
  },
  workspaceName: {
    fontSize: 14,
    fontWeight: '500',
    color: '#333',
    marginBottom: 2,
  },
  workspaceStats: {
    fontSize: 12,
    color: '#666',
  },
  emptyText: {
    fontSize: 14,
    color: '#999',
    textAlign: 'center',
    fontStyle: 'italic',
    paddingVertical: 20,
  },
  
  // Category Filter Styles
  categoryFilterContainer: {
    backgroundColor: '#f8f9fa',
    borderRadius: 8,
    padding: 16,
    marginBottom: 16,
  },
  categoryFilterContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  categoryFilterLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: '#333',
  },
  categoryDropdown: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  categoryDropdownText: {
    fontSize: 14,
    color: '#333',
    marginRight: 8,
  },
  categoryFilterNote: {
    fontSize: 12,
    color: '#666',
    fontStyle: 'italic',
  },
  categoryFilterNoteBold: {
    fontWeight: '600',
    color: '#007AFF',
  },
  
  // Receipt Stats Grid
  receiptStatsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  
  // Category Item Styles
  categoryItem: {
    backgroundColor: '#f8f9fa',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  categoryItemHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  categoryItemInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  categoryColorDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginRight: 8,
  },
  categoryItemName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
    flex: 1,
  },
  categoryItemAmount: {
    fontSize: 16,
    fontWeight: '700',
    color: '#007AFF',
  },
  categoryItemDetails: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  categoryItemPercentage: {
    fontSize: 14,
    fontWeight: '600',
    color: '#007AFF',
  },
  categoryItemCount: {
    fontSize: 12,
    color: '#666',
  },
  categoryProgressBar: {
    height: 6,
    backgroundColor: '#e0e0e0',
    borderRadius: 3,
    overflow: 'hidden',
  },
  categoryProgressFill: {
    height: '100%',
    borderRadius: 3,
  },
  
  // Enhanced Business Item Styles
  businessHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  businessAmount: {
    alignItems: 'flex-end',
  },
  businessTotal: {
    fontSize: 16,
    fontWeight: '700',
    color: '#AF52DE',
    marginBottom: 2,
  },
  
  // Activity Item Styles
  activityItem: {
    backgroundColor: '#f8f9fa',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
  },
  activityText: {
    fontSize: 14,
    color: '#333',
    lineHeight: 20,
  },
  tabsContainer: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
    paddingHorizontal: 16,
  },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
    gap: 6,
  },
  tabActive: {
    borderBottomColor: '#007AFF',
  },
  tabText: {
    fontSize: 15,
    fontWeight: '500',
    color: '#666',
  },
  tabTextActive: {
    color: '#007AFF',
    fontWeight: '600',
  },
  compactChartContainer: {
    gap: 12,
  },
  compactChartItem: {
    marginBottom: 12,
  },
  // Category Chart Container
  categoryChartContainer: {
    marginTop: 8,
  },
  // Donut Chart Styles
  donutChartContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
    paddingVertical: 12,
  },
  donutChartWrapper: {
    width: 120,
    height: 120,
    marginRight: 16,
  },
  donutLegend: {
    flex: 1,
    flexWrap: 'wrap',
    flexDirection: 'row',
    gap: 8,
  },
  donutLegendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 12,
    marginBottom: 6,
    minWidth: 100,
  },
  donutLegendDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginRight: 8,
  },
  donutLegendText: {
    fontSize: 12,
    color: '#333',
    flex: 1,
  },
  // Category Breakdown List
  categoryBreakdownList: {
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: '#e0e0e0',
  },
  categoryBreakdownTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
    marginBottom: 12,
  },
  categoryBreakdownItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  categoryBreakdownLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  categoryBreakdownDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 10,
  },
  categoryBreakdownName: {
    fontSize: 14,
    fontWeight: '500',
    color: '#333',
    flex: 1,
  },
  categoryBreakdownRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  categoryBreakdownAmount: {
    fontSize: 14,
    fontWeight: '600',
    color: '#007AFF',
    minWidth: 80,
    textAlign: 'right',
  },
  categoryBreakdownPercent: {
    fontSize: 13,
    color: '#666',
    minWidth: 50,
    textAlign: 'right',
  },
  categoryBreakdownCount: {
    fontSize: 13,
    color: '#999',
    minWidth: 35,
    textAlign: 'right',
  },
  compactChartHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
    gap: 8,
  },
  compactChartDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  compactChartLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: '#333',
  },
  compactChartBar: {
    height: 6,
    backgroundColor: '#f0f0f0',
    borderRadius: 3,
    marginBottom: 6,
    overflow: 'hidden',
  },
  compactChartFill: {
    height: '100%',
    borderRadius: 3,
  },
  compactChartValues: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  compactChartAmount: {
    fontSize: 14,
    fontWeight: '600',
    color: '#333',
  },
  compactChartPercentage: {
    fontSize: 13,
    fontWeight: '500',
    color: '#007AFF',
  },
  compactChartCount: {
    fontSize: 12,
    color: '#666',
  },
  compactListItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    paddingLeft: 12,
    paddingRight: 4,
    backgroundColor: '#f8f9fa',
    borderRadius: 8,
    marginBottom: 8,
  },
  compactListInfo: {
    flex: 1,
  },
  compactListName: {
    fontSize: 14,
    fontWeight: '500',
    color: '#333',
    marginBottom: 2,
  },
  compactListSubtext: {
    fontSize: 12,
    color: '#666',
  },
  compactListMeta: {
    fontSize: 11,
    color: '#888',
    marginTop: 2,
    lineHeight: 15,
  },
  compactListAmount: {
    fontSize: 15,
    fontWeight: '600',
    color: '#333',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 64,
    paddingHorizontal: 40,
  },
  emptySubtext: {
    fontSize: 14,
    color: '#999',
    marginTop: 8,
    textAlign: 'center',
    lineHeight: 20,
  },
  // Monthly Trends Styles
  trendsContainer: {
    marginTop: 8,
  },
  trendsBars: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    height: 120,
    gap: 4,
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  trendBar: {
    flex: 1,
    height: '100%',
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  trendBarFill: {
    backgroundColor: '#007AFF',
    borderRadius: 4,
    minHeight: 2,
    width: '100%',
  },
  trendBarLabel: {
    fontSize: 10,
    color: '#666',
    marginTop: 4,
    textAlign: 'center',
  },
  trendsValues: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
    marginTop: 4,
  },
  trendValue: {
    flex: 1,
    alignItems: 'center',
  },
  trendValueAmount: {
    fontSize: 11,
    fontWeight: '600',
    color: '#333',
  },
  trendValueCount: {
    fontSize: 10,
    color: '#666',
    marginTop: 2,
  },
  // Receipt Size Distribution Styles
  sizeDistributionContainer: {
    marginTop: 8,
    gap: 12,
  },
  sizeDistributionItem: {
    marginBottom: 12,
  },
  sizeDistributionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  sizeDistributionLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: '#333',
  },
  sizeDistributionAmount: {
    fontSize: 14,
    fontWeight: '600',
    color: '#007AFF',
  },
  sizeDistributionBar: {
    height: 8,
    backgroundColor: '#f0f0f0',
    borderRadius: 4,
    marginBottom: 4,
    overflow: 'hidden',
  },
  sizeDistributionBarFill: {
    height: '100%',
    borderRadius: 4,
  },
  sizeDistributionCount: {
    fontSize: 12,
    color: '#666',
  },
  
  // Receipt item with actions
  receiptItemContainer: {
    marginBottom: 8,
  },
  receiptActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  viewButton: {
    paddingVertical: 4,
    paddingHorizontal: 6,
  },
  viewButtonText: {
    fontSize: 14,
    color: '#007AFF',
    fontWeight: '500',
  },
  editButton: {
    paddingVertical: 4,
    paddingHorizontal: 6,
  },
  editButtonText: {
    fontSize: 14,
    color: '#007AFF',
    fontWeight: '600',
  },
  categorizeButton: {
    padding: 6,
  },
  
  // Category Modal Styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '70%',
    paddingBottom: 20,
  },
  editModalContent: {
    maxHeight: '85%',
    height: '85%',
    paddingBottom: 0,
  },
  editFormScroll: {
    flex: 1,
    minHeight: 0,
  },
  editFormScrollContent: {
    paddingBottom: 24,
  },
  editFormActions: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 16,
    paddingBottom: 24,
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
  },
  editFormButtonCancel: {
    flex: 1,
    backgroundColor: '#e5e7eb',
  },
  editFormButtonSave: {
    flex: 1,
    backgroundColor: '#007AFF',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#333',
  },
  categoryList: {
    maxHeight: 400,
  },
  categoryModalItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  categoryItemText: {
    fontSize: 16,
    color: '#333',
  },
  modalLoading: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  editFormRow: {
    paddingHorizontal: 16,
    marginBottom: 16,
  },
  editFormRowDateAmount: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    marginBottom: 16,
  },
  editFormLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#333',
    marginBottom: 6,
  },
  editFormInput: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: '#333',
  },
  editFormDateTextWrap: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
  },
  editFormDateText: {
    fontSize: 16,
    color: '#333',
  },
  editFormDatePlaceholder: {
    color: '#999',
  },
  editFormDateIcon: {
    marginLeft: 8,
    flexShrink: 0,
  },
  editFormDateWrapper: {
    position: 'relative',
  },
  editFormDateTouchable: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  editCategoryList: {
    marginTop: 4,
  },
  editCategoryChip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#f0f0f0',
    marginBottom: 8,
  },
  editCategoryChipSelected: {
    backgroundColor: '#007AFF',
  },
  editCategoryChipText: {
    fontSize: 14,
    color: '#333',
  },
  editCategoryChipTextSelected: {
    color: '#fff',
  },
  editFormButton: {
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  editFormButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
  },
  editFormButtonTextCancel: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
  },
  moreButton: {
    borderStyle: 'dashed',
    borderWidth: 1,
    borderColor: '#007AFF',
  },
  filterModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
    paddingBottom: 20,
  },
  filterModalKeyboardAvoid: {
    flex: 1,
    width: '100%',
    justifyContent: 'flex-end',
    maxHeight: '90%',
  },
  filterModalOverlayTouchable: {
    maxHeight: '90%',
  },
  filterModalContentBox: {
    backgroundColor: '#fff',
    minHeight: 320,
    borderRadius: 16,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 16,
    overflow: 'hidden',
    maxHeight: '90%',
    zIndex: 1,
  },
  filterModalScroll: {
    maxHeight: 500,
  },
  filterModalScrollContent: {
    padding: 20,
    paddingBottom: 20,
  },
  filterSection: {
    marginBottom: 24,
  },
  filterSectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
    marginBottom: 12,
  },
  filterOptionButton: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    backgroundColor: '#f8f9fa',
    borderRadius: 8,
    marginBottom: 12,
  },
  filterOptionText: {
    fontSize: 16,
    color: '#333',
  },
  filterCheckbox: {
    width: 22,
    height: 22,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: '#999',
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterCheckboxChecked: {
    backgroundColor: '#007AFF',
    borderColor: '#007AFF',
  },
  dateRangeContainer: {
    flexDirection: 'row',
    gap: 12,
  },
  dateInputContainer: {
    flex: 1,
  },
  filterLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: '#666',
    marginBottom: 8,
  },
  /* Filter date inputs - same look as Schedule Meeting date picker trigger */
  filterInputGroup: {
    marginBottom: 16,
  },
  filterInputLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: '#495057',
    marginBottom: 8,
  },
  filterDatePickerContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e9ecef',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: '#fff',
  },
  filterDatePickerLabel: {
    fontSize: 16,
    color: '#212529',
  },
  filterDatePickerPlaceholder: {
    fontSize: 16,
    color: '#6c757d',
  },
  dateInput: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#f8f9fa',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  dateInputText: {
    fontSize: 14,
    color: '#333',
  },
  dateInputPlaceholder: {
    fontSize: 14,
    color: '#999',
  },
  datePickerModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  datePickerModalContent: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingBottom: 24,
    width: '100%',
    minHeight: 400,
  },
  /* Compact date picker spinner modal */
  pickerModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  pickerModalContainer: {
    backgroundColor: '#fff',
    borderRadius: 12,
    marginHorizontal: 24,
    width: '85%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
  },
  pickerModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#e9ecef',
    backgroundColor: '#fff',
    zIndex: 1,
    elevation: 2,
  },
  pickerModalTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#212529',
  },
  pickerModalCancelButton: {
    fontSize: 15,
    color: '#6c757d',
  },
  pickerModalContent: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignItems: 'center',
  },
  pickerModalDatePicker: {
    width: '100%',
    height: 160,
  },
  calendarPickerWrapper: {
    width: '100%',
    minHeight: 360,
    paddingHorizontal: 16,
  },
  calendarPicker: {
    width: '100%',
    height: 360,
    alignSelf: 'stretch',
  },
  doneButton: {
    fontSize: 16,
    fontWeight: '600',
    color: '#007AFF',
  },
  amountRangeContainer: {
    flexDirection: 'row',
    gap: 12,
  },
  amountInputContainer: {
    flex: 1,
  },
  amountInput: {
    backgroundColor: '#f8f9fa',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#333',
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  textInput: {
    backgroundColor: '#f8f9fa',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#333',
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  filterActions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 8,
    marginBottom: 0,
  },
  filterButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterButtonPrimary: {
    backgroundColor: '#007AFF',
  },
  filterButtonSecondary: {
    backgroundColor: '#f0f0f0',
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  filterButtonTextPrimary: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  filterButtonTextSecondary: {
    color: '#666',
    fontSize: 16,
    fontWeight: '500',
  },
  loadMoreFinancials: {
    marginTop: 4,
    paddingVertical: 14,
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  loadMoreFinancialsText: {
    fontSize: 15,
    fontWeight: '600',
  },
}); 