import { Ionicons } from '@expo/vector-icons';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import * as Clipboard from 'expo-clipboard';
import * as ImagePicker from 'expo-image-picker';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import AdaptiveListPickerModal from '../../components/AdaptiveListPickerModal';
import ClientsButton from '../../components/clients/ClientsButton';
import DocumentViewer from '../../components/DocumentViewer';
import { FeedbackTouchable } from '../../components/FeedbackTouchable';
import {
  pickDocumentsLikeFilesScreen,
  pickGalleryImagesLikeFilesScreen,
} from '../../components/signatures/DocumentSourcePicker';
import { useMinimizableSheet } from '../../hooks/useMinimizableSheet';
import { resendCooldownKey, useResendCooldown } from '../../hooks/useResendCooldown';
import { useThemeColors } from '../../hooks/useThemeColors';
import { apiService } from '../../services/api';
import { intakeDetailScreenKey, intakesListScreenKey } from '../../services/userScopedCache';
import { useFileStore } from '../../stores/fileStore';
import { screenCache } from '../../utils/screenCache';
import { sanitizeDisplayFilename } from '../../utils/displayFilename';
import { checklistFileStillClassifying, getFullPublicUploadUrl, getUploadToBaseUrl } from '../../utils/uploadLinkHelpers';
import {
  INTAKE_ACTIVE_POLL_STATUSES,
  INTAKE_DUE_BADGE_LABELS,
  INTAKE_ITEM_STATUS_LABELS,
  INTAKE_REMINDER_PRESETS,
  INTAKE_SOURCE_LABELS,
  INTAKE_STATUS_LABELS,
  type Intake,
  type IntakeFileRow,
  type IntakeItem,
  type ReminderPreset,
} from '../../types/intake';
import { useAuth } from '../context/auth';
import { UploadOptionsModal } from '../components/UploadOptionsModal';

import AppBackButton, { APP_BACK_BUTTON_SLOT } from '../../components/AppBackButton';
import AppHeaderTitle from '../../components/AppHeaderTitle';
import { truncateAppHeaderTitle } from '../../utils/chatTitleDisplay';
import { formatRemainingCountdown, parseAsUTC, parseUtcMs } from '../../utils/timeFormatting';

const INTAKE_DETAIL_CACHE_MS = 30_000;

interface FolderOption {
  id: number;
  name: string;
}

function toLocalDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseUtc(dateString: string | undefined | null): Date {
  return parseAsUTC(dateString);
}

function formatDate(dateString: string | undefined | null): string {
  if (!dateString) return '';
  const date = parseUtc(dateString);
  if (isNaN(date.getTime())) return '';
  return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function intakeFileLabel(name: string | null | undefined, fileId?: number | null): string {
  if (name?.trim()) return sanitizeDisplayFilename(name);
  return fileId != null ? `File #${fileId}` : 'Document';
}

function getFileTypeFromFilename(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'heic', 'heif'];
  const docExts = ['doc', 'docx'];
  const xlsExts = ['xls', 'xlsx', 'csv'];
  const pptExts = ['ppt', 'pptx'];
  const textExts = ['txt', 'md', 'rtf'];

  if (ext === 'pdf') return 'application/pdf';
  if (imageExts.includes(ext)) return 'image';
  if (docExts.includes(ext)) return 'application/msword';
  if (xlsExts.includes(ext)) return 'application/vnd.ms-excel';
  if (pptExts.includes(ext)) return 'application/vnd.ms-powerpoint';
  if (textExts.includes(ext)) return 'text/plain';
  return '';
}

export default function IntakeDetailScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [intake, setIntake] = useState<Intake | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<'send' | 'remind' | 'archive' | 'restore' | null>(null);
  const [itemBusyId, setItemBusyId] = useState<number | null>(null);
  const [assignBusyItemId, setAssignBusyItemId] = useState<number | null>(null);

  const [viewerFileId, setViewerFileId] = useState<number | null>(null);
  const [viewerFileName, setViewerFileName] = useState<string>('');

  const [assigningFile, setAssigningFile] = useState<IntakeFileRow | null>(null);

  // Edit modal state
  const [editing, setEditing] = useState(false);
  const [folders, setFolders] = useState<FolderOption[]>([]);
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editClientName, setEditClientName] = useState('');
  const [editClientEmail, setEditClientEmail] = useState('');
  const [editDueAt, setEditDueAt] = useState('');
  const [editFolderId, setEditFolderId] = useState<number | null>(null);
  const [editReminderPreset, setEditReminderPreset] = useState<ReminderPreset>('standard');
  const [editCustomReminder, setEditCustomReminder] = useState({ first: 48, repeat: 72, max: 4 });
  const [editReminderEnabled, setEditReminderEnabled] = useState(true);
  const [editAutoVerify, setEditAutoVerify] = useState(false);
  const [editSenders, setEditSenders] = useState<{ name: string; email: string }[]>([{ name: '', email: '' }]);
  const [savingEdit, setSavingEdit] = useState(false);

  const [showSaveTemplateModal, setShowSaveTemplateModal] = useState(false);
  const [templateNameForSave, setTemplateNameForSave] = useState('');
  const [templateIndustryForSave, setTemplateIndustryForSave] = useState('');
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [uploadingItemId, setUploadingItemId] = useState<number | null>(null);
  const [classifyingFileIds, setClassifyingFileIds] = useState<Record<number, true>>({});
  const [regeneratingCode, setRegeneratingCode] = useState(false);
  const uploadSheet = useMinimizableSheet();
  const [uploadTargetItemId, setUploadTargetItemId] = useState<number | null>(null);

  const intakeId = Number(id);
  const detailCacheKey = intakeDetailScreenKey(user?.id, intakeId);

  const clientPingCooldownKey = intakeId ? resendCooldownKey('intake', intakeId) : null;
  const clientPingServerAt = useMemo(() => {
    if (!intake) return null;
    const candidates = [intake.sent_at, intake.last_reminder_sent_at]
      .filter((v): v is string => !!v)
      .map((v) => parseUtcMs(v))
      .filter((t) => !Number.isNaN(t));
    if (candidates.length === 0) return null;
    return new Date(Math.max(...candidates)).toISOString();
  }, [intake?.sent_at, intake?.last_reminder_sent_at]);
  const {
    remainingSec: clientPingCooldownSec,
    isCoolingDown: clientPingCoolingDown,
    markSent: markClientPingSent,
  } = useResendCooldown(clientPingCooldownKey, { serverSentAt: clientPingServerAt });

  const invalidateIntakeCaches = useCallback(() => {
    if (!user?.id) return;
    if (detailCacheKey) screenCache.invalidate(detailCacheKey);
    const activeKey = intakesListScreenKey(user.id, false);
    const archivedKey = intakesListScreenKey(user.id, true);
    if (activeKey) screenCache.invalidate(activeKey);
    if (archivedKey) screenCache.invalidate(archivedKey);
  }, [user?.id, detailCacheKey]);

  const loadIntake = useCallback(async (forceRefresh = false) => {
    if (!user || !intakeId) {
      setLoading(false);
      return;
    }
    if (!forceRefresh && detailCacheKey) {
      const cached = screenCache.get<Intake>(detailCacheKey, INTAKE_DETAIL_CACHE_MS);
      if (cached) {
        setIntake(cached);
        setLoading(false);
        setRefreshing(false);
        return;
      }
    }
    try {
      if (!forceRefresh && !intake) setLoading(true);
      const response = await apiService.getIntake(intakeId);
      if (response.success) {
        setIntake(response.intake);
        if (detailCacheKey) screenCache.set(detailCacheKey, response.intake);
      } else {
        Alert.alert('Error', response.message || 'Failed to load Intake');
        router.back();
      }
    } catch (error: any) {
      console.error('Load intake error:', error);
      Alert.alert('Error', error.message || 'Failed to load Intake');
      router.back();
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user, intakeId, router, detailCacheKey, intake]);

  const lastLoadTimeRef = useRef<number>(0);
  const RELOAD_DEBOUNCE_MS = 2000;

  useFocusEffect(
    useCallback(() => {
      if (!user || !intakeId) return;
      const now = Date.now();
      if (now - lastLoadTimeRef.current > RELOAD_DEBOUNCE_MS) {
        lastLoadTimeRef.current = now;
        loadIntake();
      }
    }, [user, intakeId, loadIntake])
  );

  useEffect(() => {
    if (!intake || !INTAKE_ACTIVE_POLL_STATUSES.includes(intake.status)) return;
    const interval = setInterval(() => {
      loadIntake(true);
    }, 10_000);
    return () => clearInterval(interval);
  }, [intake?.status, intake?.id, loadIntake]);

  useEffect(() => {
    const fileIds = Object.keys(classifyingFileIds).map(Number);
    if (fileIds.length === 0) return;

    let cancelled = false;
    const poll = async () => {
      for (const fileId of fileIds) {
        if (cancelled) return;
        try {
          const response = await apiService.getFileById(fileId);
          const file = response.file;
          if (file && !checklistFileStillClassifying(file.file_kind, file.processing_status)) {
            setClassifyingFileIds((prev) => {
              const next = { ...prev };
              delete next[fileId];
              return next;
            });
            loadIntake(true);
          }
        } catch {
          // keep polling
        }
      }
    };

    const interval = setInterval(poll, 2000);
    poll();
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [classifyingFileIds, loadIntake]);

  const handleRefresh = () => {
    if (!user) return;
    setRefreshing(true);
    if (detailCacheKey) screenCache.invalidate(detailCacheKey);
    loadIntake(true);
  };

  const reloadAfterMutation = useCallback(() => {
    invalidateIntakeCaches();
    loadIntake(true);
  }, [invalidateIntakeCaches, loadIntake]);

  const copyUploadCode = async (code: string) => {
    await Clipboard.setStringAsync(code);
    Alert.alert('Copied', 'Upload code copied');
  };

  const handleShareLink = async () => {
    if (!intake?.upload_link?.public_url) return;
    const fullUrl = getFullPublicUploadUrl(intake.upload_link.public_url);
    try {
      await Share.share({
        message: `Please upload your documents for "${intake.title}" using this link: ${fullUrl}`,
        url: fullUrl,
        title: `Upload documents: ${intake.title}`,
      });
    } catch (error) {
      console.error('Share intake link error:', error);
    }
  };

  const handleSend = async () => {
    if (!intake || busy) return;
    if (intake.sent_at && clientPingCoolingDown) {
      Alert.alert('Please wait', `You can resend in ${clientPingCooldownSec}s`);
      return;
    }
    setBusy(true);
    setBusyAction('send');
    try {
      const response = await apiService.sendIntake(intake.id);
      if (response.success) {
        markClientPingSent();
        Alert.alert('Sent', response.resent ? 'Upload link resent to client' : 'Intake sent to client');
        reloadAfterMutation();
      } else {
        Alert.alert('Error', response.message || 'Failed to send Intake');
      }
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to send Intake');
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  };

  const handleRegenerateCode = () => {
    const linkId = intake?.upload_link?.id;
    if (!linkId) return;
    Alert.alert(
      'Regenerate upload code',
      'Generate a new upload code? The old code will stop working.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Regenerate',
          style: 'destructive',
          onPress: async () => {
            setRegeneratingCode(true);
            try {
              const response = await apiService.regenerateUploadLinkCode(linkId);
              if (response.success) {
                reloadAfterMutation();
                const newCode = response.upload_code || response.upload_link?.upload_code;
                Alert.alert('Done', newCode ? `New code: ${newCode}` : 'Upload code regenerated');
              } else {
                Alert.alert('Error', response.message || 'Failed to regenerate code');
              }
            } catch (error: any) {
              Alert.alert('Error', error.message || 'Failed to regenerate code');
            } finally {
              setRegeneratingCode(false);
            }
          },
        },
      ],
    );
  };

  const handleSaveAsTemplate = async () => {
    const validItems = (intake?.items || []).filter((i) => i.label.trim());
    if (validItems.length === 0) {
      Alert.alert('Error', 'Add at least one checklist item first');
      return;
    }
    if (!templateNameForSave.trim()) {
      Alert.alert('Error', 'Template name is required');
      return;
    }
    setSavingTemplate(true);
    try {
      const response = await apiService.createIntakeTemplate({
        name: templateNameForSave.trim(),
        industry_tag: templateIndustryForSave.trim() || null,
        items: validItems.map((i) => ({
          label: i.label.trim(),
          description: i.description?.trim() || null,
          required: i.required,
        })),
      });
      if (response.success) {
        setShowSaveTemplateModal(false);
        setTemplateNameForSave('');
        setTemplateIndustryForSave('');
        if (response.already_exists || response.unchanged) {
          Alert.alert(
            'Already saved',
            response.message || 'No changes were made — this template is already saved.',
          );
        } else {
          Alert.alert('Saved', 'Template saved');
        }
      } else {
        Alert.alert('Error', response.message || 'Failed to save template');
      }
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to save template');
    } finally {
      setSavingTemplate(false);
    }
  };

  const uploadFileToItem = async (itemId: number, asset: { uri: string; name: string; type?: string }) => {
    if (!intake) return;
    setUploadingItemId(itemId);
    try {
      const response = await apiService.uploadIntakeItem(intake.id, itemId, {
        uri: asset.uri,
        name: asset.name,
        type: asset.type || 'application/octet-stream',
      });
      if (response.success) {
        if (response.file?.id) {
          setClassifyingFileIds((prev) => ({ ...prev, [response.file.id]: true }));
        }
        reloadAfterMutation();
      } else {
        Alert.alert('Error', response.message || 'Failed to upload file');
      }
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to upload file');
    } finally {
      setUploadingItemId(null);
      setUploadTargetItemId(null);
    }
  };

  const openUploadOptions = (item: IntakeItem) => {
    if (!intake || item.status !== 'pending' || intake.status === 'archived') return;
    setUploadTargetItemId(item.id);
    uploadSheet.open();
  };

  const dismissUploadModal = () => {
    uploadSheet.close();
    setUploadTargetItemId(null);
  };

  const handleUploadFromFiles = async () => {
    if (!uploadTargetItemId || uploadingItemId != null) return;
    uploadSheet.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      await useFileStore.getState().forceResetDocumentPicker();
      const assets = await pickDocumentsLikeFilesScreen();
      const asset = assets?.[0];
      if (!asset) return;
      await uploadFileToItem(uploadTargetItemId, {
        uri: asset.uri,
        name: asset.name || 'upload',
        type: asset.mimeType || 'application/octet-stream',
      });
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to upload file');
      setUploadTargetItemId(null);
    }
  };

  const handleUploadFromGallery = async () => {
    if (!uploadTargetItemId || uploadingItemId != null) return;
    uploadSheet.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const assets = await pickGalleryImagesLikeFilesScreen();
      const asset = assets?.[0];
      if (!asset) return;
      await uploadFileToItem(uploadTargetItemId, {
        uri: asset.uri,
        name: asset.name || 'upload',
        type: asset.mimeType || 'image/jpeg',
      });
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to upload file');
      setUploadTargetItemId(null);
    }
  };

  const handleUploadFromCamera = async () => {
    if (!uploadTargetItemId || uploadingItemId != null) return;
    uploadSheet.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const permissionResult = await ImagePicker.requestCameraPermissionsAsync();
      if (!permissionResult.granted) {
        Alert.alert('Permission required', 'Camera permission is required to take photos.');
        setUploadTargetItemId(null);
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [4, 3],
        quality: 0.8,
      });
      if (result.canceled || !result.assets?.[0]) {
        setUploadTargetItemId(null);
        return;
      }
      const asset = result.assets[0];
      await uploadFileToItem(uploadTargetItemId, {
        uri: asset.uri,
        name: `photo_${Date.now()}.${asset.type?.includes('heic') ? 'heic' : 'jpg'}`,
        type: asset.mimeType || asset.type || 'image/jpeg',
      });
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to upload photo');
      setUploadTargetItemId(null);
    }
  };

  const handleUploadByLink = () => {
    uploadSheet.close();
    setUploadTargetItemId(null);
    router.push('/upload-by-link-code');
  };

  const handleRemindNow = async () => {
    if (!intake || busy) return;
    if (clientPingCoolingDown) {
      Alert.alert('Please wait', `You can send another reminder in ${clientPingCooldownSec}s`);
      return;
    }
    setBusy(true);
    setBusyAction('remind');
    try {
      const response = await apiService.remindIntake(intake.id);
      if (response.success) {
        markClientPingSent();
        Alert.alert('Sent', 'Reminder sent');
        reloadAfterMutation();
      } else {
        Alert.alert('Error', response.message || 'Failed to send reminder');
      }
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to send reminder');
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  };

  const handleArchive = () => {
    if (!intake) return;
    Alert.alert(
      'Archive Intake',
      'Archive this Intake? You can find it later under the Archived tab.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Archive',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            setBusyAction('archive');
            try {
              await apiService.archiveIntake(intake.id);
              invalidateIntakeCaches();
              router.replace('/intake');
            } catch (error: any) {
              Alert.alert('Error', error.message || 'Failed to archive Intake');
              setBusy(false);
              setBusyAction(null);
            }
          },
        },
      ]
    );
  };

  const handleUnarchive = () => {
    if (!intake) return;
    Alert.alert(
      'Restore Intake',
      'Restore this Intake? It will return to the Active list with its previous workflow status.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Restore',
          onPress: async () => {
            setBusy(true);
            setBusyAction('restore');
            try {
              const response = await apiService.unarchiveIntake(intake.id);
              if (response.success) {
                invalidateIntakeCaches();
                if (response.intake) {
                  setIntake(response.intake);
                  if (detailCacheKey) screenCache.set(detailCacheKey, response.intake);
                } else {
                  reloadAfterMutation();
                }
                Alert.alert('Restored', 'Intake restored to Active');
              } else {
                Alert.alert('Error', response.message || 'Failed to restore Intake');
              }
            } catch (error: any) {
              Alert.alert('Error', error.message || 'Failed to restore Intake');
            } finally {
              setBusy(false);
              setBusyAction(null);
            }
          },
        },
      ]
    );
  };

  const handleConfirmItem = async (itemId: number) => {
    if (!intake || itemBusyId != null) return;
    setItemBusyId(itemId);
    try {
      const response = await apiService.confirmIntakeItem(intake.id, itemId);
      if (response.success) {
        reloadAfterMutation();
      } else {
        Alert.alert('Error', response.message || 'Failed to verify item');
      }
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to verify item');
    } finally {
      setItemBusyId(null);
    }
  };

  const handleRejectMatch = (itemId: number) => {
    if (!intake || itemBusyId != null) return;
    const current = intake.items?.find((i) => i.id === itemId);
    if (!current || (current.status !== 'matched' && current.status !== 'confirmed')) {
      reloadAfterMutation();
      return;
    }

    Alert.alert(
      'Reject match',
      'Reject this match? The item will go back to Missing and the file will move to Unmatched.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reject',
          style: 'destructive',
          onPress: async () => {
            setItemBusyId(itemId);
            try {
              // Re-fetch so we don't reject against a stale checklist (polling / prior action).
              const latest = await apiService.getIntake(intake.id);
              const latestItem = latest.success
                ? latest.intake?.items?.find((i: { id: number }) => i.id === itemId)
                : null;
              if (
                !latestItem ||
                (latestItem.status !== 'matched' && latestItem.status !== 'confirmed')
              ) {
                if (latest.success && latest.intake) {
                  setIntake(latest.intake);
                  if (detailCacheKey) screenCache.set(detailCacheKey, latest.intake);
                } else {
                  reloadAfterMutation();
                }
                Alert.alert(
                  'Already updated',
                  'This item no longer has a match to reject. The checklist was refreshed.',
                );
                return;
              }

              const response = await apiService.rejectIntakeItem(intake.id, itemId);
              if (response.success) {
                reloadAfterMutation();
              } else {
                const msg = response.message || 'Failed to reject match';
                if (/received or verified|no longer|already/i.test(msg)) {
                  reloadAfterMutation();
                  Alert.alert('Already updated', 'This match is no longer active. The checklist was refreshed.');
                } else {
                  Alert.alert('Error', msg);
                }
              }
            } catch (error: any) {
              const msg = error.message || 'Failed to reject match';
              if (/received or verified|no longer|already/i.test(msg)) {
                reloadAfterMutation();
                Alert.alert('Already updated', 'This match is no longer active. The checklist was refreshed.');
              } else {
                Alert.alert('Error', msg);
              }
            } finally {
              setItemBusyId(null);
            }
          },
        },
      ],
    );
  };

  const handleNotApplicable = async (itemId: number) => {
    if (!intake || itemBusyId != null) return;
    setItemBusyId(itemId);
    try {
      const response = await apiService.markIntakeItemNotApplicable(intake.id, itemId);
      if (response.success) {
        reloadAfterMutation();
      } else {
        Alert.alert('Error', response.message || 'Failed to update item');
      }
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to update item');
    } finally {
      setItemBusyId(null);
    }
  };

  const openAssignPicker = (file: IntakeFileRow) => setAssigningFile(file);

  const handleAssignFile = async (itemId: number) => {
    if (!intake || !assigningFile || assignBusyItemId != null) return;
    setAssignBusyItemId(itemId);
    try {
      const response = await apiService.assignIntakeFile(intake.id, itemId, assigningFile.file_id, assigningFile.match_confidence ?? undefined);
      setAssigningFile(null);
      if (response.success) {
        reloadAfterMutation();
      } else {
        Alert.alert('Error', response.message || 'Failed to assign file');
      }
    } catch (error: any) {
      setAssigningFile(null);
      Alert.alert('Error', error.message || 'Failed to assign file');
    } finally {
      setAssignBusyItemId(null);
    }
  };

  const openFileViewer = (fileId: number | null | undefined, fileName?: string | null) => {
    if (!fileId) return;
    setViewerFileId(fileId);
    setViewerFileName(intakeFileLabel(fileName, fileId));
  };

  const openEdit = async () => {
    if (!intake) return;
    setEditTitle(intake.title);
    setEditClientName(intake.client_name || '');
    setEditClientEmail(intake.client_primary_email || '');
    setEditDueAt(intake.due_at ? intake.due_at.slice(0, 10) : '');
    setEditFolderId(intake.destination_folder_id || null);
    const preset = (intake.reminder_preset || 'standard') as ReminderPreset;
    setEditReminderPreset(preset === 'gentle' || preset === 'standard' || preset === 'urgent' || preset === 'custom' ? preset : 'custom');
    setEditCustomReminder({
      first: intake.reminder_first_after_hours || 48,
      repeat: intake.reminder_repeat_every_hours || 72,
      max: intake.reminder_max_count || 4,
    });
    setEditReminderEnabled(intake.reminder_enabled);
    setEditAutoVerify(intake.auto_verify_high_confidence);
    setEditSenders(
      intake.authorized_senders?.length
        ? intake.authorized_senders.map((s) => ({ name: s.name || '', email: s.email || '' }))
        : [{ name: '', email: '' }]
    );
    setEditing(true);
    try {
      const response = await apiService.listFolders({ limit: 500 });
      if (response.success) {
        setFolders((response.folders || []).map((f: any) => ({ id: f.id, name: f.name })));
      }
    } catch (error) {
      console.error('Load folders error:', error);
    }
  };

  const openEditDatePicker = () => {
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value: editDueAt ? new Date(editDueAt) : new Date(),
        mode: 'date',
        onChange: (event, date) => {
          if (event?.type === 'set' && date) setEditDueAt(toLocalDateString(date));
        },
      });
    } else {
      setShowDatePicker(true);
    }
  };

  const handleSaveEdit = async () => {
    if (!intake) return;
    if (!editTitle.trim()) {
      Alert.alert('Error', 'Title is required');
      return;
    }
    setSavingEdit(true);
    try {
      const reminderFields =
        editReminderPreset === 'custom'
          ? {
              reminder_preset: 'custom' as const,
              reminder_first_after_hours: editCustomReminder.first,
              reminder_repeat_every_hours: editCustomReminder.repeat,
              reminder_max_count: editCustomReminder.max,
            }
          : { reminder_preset: editReminderPreset };

      const response = await apiService.updateIntake(intake.id, {
        title: editTitle.trim(),
        client_name: editClientName.trim() || null,
        client_primary_email: editClientEmail.trim() || null,
        authorized_senders: editSenders.filter((s) => s.email.trim()),
        due_at: editDueAt || null,
        destination_folder_id: editFolderId,
        reminder_enabled: editReminderEnabled,
        auto_verify_high_confidence: editAutoVerify,
        ...reminderFields,
      });
      if (response.success) {
        setEditing(false);
        reloadAfterMutation();
      } else {
        Alert.alert('Error', response.message || 'Failed to update Intake');
      }
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to update Intake');
    } finally {
      setSavingEdit(false);
    }
  };

  const dynamicStyles = useMemo(() => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: 16,
      backgroundColor: colors.headerBackground,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    headerTitle: { fontSize: 17, fontWeight: '600', color: colors.text, flex: 1, marginHorizontal: 8 },
    placeholder: { width: APP_BACK_BUTTON_SLOT },
    centerContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    loadingText: { fontSize: 16, color: colors.textSecondary },
    content: { padding: 16 },
    titleRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 4 },
    titleText: { fontSize: 20, fontWeight: '700', color: colors.text, flexShrink: 1 },
    clientText: { fontSize: 14, color: colors.textSecondary, marginBottom: 12 },
    badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 12 },
    badgeText: { fontSize: 11, fontWeight: '600' },
    actionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 },
    actionButton: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 8,
      backgroundColor: colors.surface,
    },
    actionButtonPrimary: { backgroundColor: '#007AFF' },
    actionButtonRestore: { backgroundColor: '#DBEAFE' },
    actionButtonText: { fontSize: 13, fontWeight: '500', color: colors.text, marginLeft: 6 },
    actionButtonTextPrimary: { color: '#fff' },
    actionButtonTextRestore: { color: '#1D4ED8' },
    card: {
      backgroundColor: colors.card,
      borderRadius: 12,
      padding: 16,
      marginBottom: 16,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.08,
      shadowRadius: 4,
      elevation: 2,
    },
    cardTitle: { fontSize: 15, fontWeight: '600', color: colors.text, marginBottom: 10 },
    cardSubtitle: { fontSize: 12, color: colors.textSecondary, marginTop: -6, marginBottom: 10 },
    progressRow: { flexDirection: 'row', alignItems: 'center' },
    progressBarBg: { flex: 1, height: 8, borderRadius: 4, backgroundColor: colors.surface, marginRight: 10 },
    progressBarFill: { height: 8, borderRadius: 4, backgroundColor: '#007AFF' },
    progressLabel: { fontSize: 13, color: colors.textSecondary, fontWeight: '500' },
    shareRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
    linkBox: {
      flex: 1,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    linkBoxText: { fontSize: 11, color: colors.textSecondary },
    iconButton: { backgroundColor: '#007AFF', padding: 10, borderRadius: 8 },
    codeText: { fontSize: 12, color: colors.textSecondary, marginTop: 4 },
    codeValue: { fontFamily: 'monospace', fontWeight: '700', color: '#007AFF', fontSize: 15 },
    codeActionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
    itemRow: {
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    itemTopRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
    itemLabel: { fontSize: 14, fontWeight: '600', color: colors.text, flexShrink: 1 },
    itemOptional: { fontSize: 11, color: colors.textLight },
    itemFileName: { fontSize: 12, color: '#007AFF', marginTop: 4 },
    itemPlainFileName: { fontSize: 12, color: colors.textSecondary, marginTop: 4 },
    itemConfidence: { fontSize: 12, color: colors.textSecondary },
    itemDescription: { fontSize: 12, color: colors.textLight, marginTop: 4 },
    itemButtonsRow: { flexDirection: 'row', gap: 8, marginTop: 8 },
    smallActionBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 6,
    },
    smallActionBtnText: { fontSize: 12, fontWeight: '500', marginLeft: 4 },
    verifyBtn: { backgroundColor: '#34C759' },
    rejectBtn: { backgroundColor: '#FEF2F2' },
    naBtn: { backgroundColor: colors.surface },
    fileRow: {
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    fileRowName: { fontSize: 14, fontWeight: '500', color: '#007AFF' },
    fileRowMeta: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
    assignBtn: {
      alignSelf: 'flex-start',
      marginTop: 8,
      backgroundColor: '#007AFF',
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 6,
    },
    assignBtnText: { color: '#fff', fontSize: 12, fontWeight: '600' },
    historyRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    historyFileCol: { flex: 1, marginRight: 8 },
    historyMetaText: { fontSize: 11, color: colors.textSecondary },
    modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
    modalCard: { backgroundColor: colors.card, borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: '80%' },
    /** Absolute overlays inside the edit pageSheet (nested RN Modals do not stack reliably). */
    editSheetOverlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0,0,0,0.5)',
      justifyContent: 'flex-end',
      zIndex: 20,
    },
    editSheetCard: {
      backgroundColor: colors.card,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      maxHeight: '80%',
      paddingBottom: Math.max(insets.bottom, 12),
    },
    modalHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    modalTitle: { fontSize: 16, fontWeight: '600', color: colors.text },
    modalOption: { paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.border },
    modalOptionText: { fontSize: 15, color: colors.text },
    linkText: { fontSize: 15, color: '#007AFF', fontWeight: '500' },
    editContainer: { flex: 1, backgroundColor: colors.background },
    editContent: { padding: 16 },
    inputGroup: { marginBottom: 16 },
    label: { fontSize: 14, fontWeight: '500', color: colors.text, marginBottom: 6 },
    input: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 15,
      color: colors.text,
    },
    smallInput: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 8,
      fontSize: 14,
      color: colors.text,
    },
    row: { flexDirection: 'row', gap: 10 },
    flex1: { flex: 1 },
    senderRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
    addLink: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
    addLinkText: { fontSize: 14, color: '#007AFF', fontWeight: '500', marginLeft: 4 },
    pickerButton: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 12,
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    pickerButtonText: { fontSize: 15, color: colors.text },
    presetOption: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 10, marginBottom: 8 },
    presetOptionSelected: {
      borderColor: '#007AFF',
      backgroundColor: colors.isDark ? 'rgba(59, 130, 246, 0.24)' : '#E3F2FD',
    },
    presetOptionTitle: { fontSize: 14, fontWeight: '600', color: colors.text },
    customRow: { flexDirection: 'row', gap: 8, marginTop: 8 },
    customField: { flex: 1 },
    customLabel: { fontSize: 11, color: colors.textSecondary, marginBottom: 4 },
    switchInlineRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
    switchInlineLabel: { fontSize: 14, color: colors.text },
  }), [colors, insets.bottom]);

  const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
    draft: { bg: '#E5E7EB', text: '#374151' },
    waiting_for_client: { bg: '#DBEAFE', text: '#1D4ED8' },
    in_review: { bg: '#FEF3C7', text: '#92400E' },
    completed: { bg: '#D1FAE5', text: '#065F46' },
    archived: { bg: '#E5E7EB', text: '#6B7280' },
  };
  const DUE_BADGE_COLORS: Record<string, { bg: string; text: string }> = {
    on_track: { bg: '#ECFDF5', text: '#047857' },
    due_tomorrow: { bg: '#FFFBEB', text: '#B45309' },
    overdue: { bg: '#FEF2F2', text: '#B91C1C' },
  };
  const ITEM_STATUS_COLORS: Record<string, { bg: string; text: string }> = {
    pending: { bg: colors.surface, text: colors.textSecondary },
    matched: { bg: '#DBEAFE', text: '#1D4ED8' },
    confirmed: { bg: '#D1FAE5', text: '#065F46' },
    not_applicable: { bg: colors.surface, text: colors.textLight },
  };

  if (loading || !intake) {
    return (
      <SafeAreaView style={dynamicStyles.container}>
        <View style={dynamicStyles.header}>
          <AppBackButton />
          <AppHeaderTitle>Intake</AppHeaderTitle>
          <View style={dynamicStyles.placeholder} />
        </View>
        <View style={dynamicStyles.centerContainer}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={dynamicStyles.loadingText}>Loading Intake...</Text>
        </View>
      </SafeAreaView>
    );
  }

  const items = intake.items || [];
  const pendingItems = items.filter((i) => i.status === 'pending');
  const otherItems = items.filter((i) => i.status !== 'pending');
  const orderedItems = [...pendingItems, ...otherItems];
  const needsAttention = intake.needs_attention || [];
  const unmatched = intake.unmatched || [];
  const arrivalHistory = intake.arrival_history || [];
  const statusColor = STATUS_COLORS[intake.status] || STATUS_COLORS.draft;
  const dueColor = intake.due_badge ? DUE_BADGE_COLORS[intake.due_badge] : null;
  const clientShareUrl = intake.upload_link
    ? getFullPublicUploadUrl(intake.upload_link.public_url)
    : null;

  return (
    <SafeAreaView style={dynamicStyles.container}>
      <View style={dynamicStyles.header}>
        <AppBackButton />
        <AppHeaderTitle shrink={false} style={{ marginRight: 8 }}>
          {truncateAppHeaderTitle(intake.title || 'Intake')}
        </AppHeaderTitle>
        {intake.status !== 'archived' ? (
          <TouchableOpacity
            onPress={openEdit}
            disabled={busy}
            accessibilityLabel="Edit"
            style={{ flexShrink: 0 }}
          >
            <Text style={[dynamicStyles.linkText, busy && { opacity: 0.5 }]}>Edit</Text>
          </TouchableOpacity>
        ) : (
          <View style={dynamicStyles.placeholder} />
        )}
      </View>

      <ScrollView
        contentContainerStyle={dynamicStyles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#007AFF" />}
      >
        <View style={dynamicStyles.titleRow}>
          <View style={[dynamicStyles.badge, { backgroundColor: statusColor.bg }]}>
            <Text style={[dynamicStyles.badgeText, { color: statusColor.text }]}>{INTAKE_STATUS_LABELS[intake.status]}</Text>
          </View>
          {intake.due_badge && dueColor && (
            <View style={[dynamicStyles.badge, { backgroundColor: dueColor.bg }]}>
              <Text style={[dynamicStyles.badgeText, { color: dueColor.text }]}>{INTAKE_DUE_BADGE_LABELS[intake.due_badge]}</Text>
            </View>
          )}
          <ClientsButton itemType="intake" itemId={intake.id} compact allowCreate />
        </View>
        {intake.client_name && <Text style={dynamicStyles.clientText}>{intake.client_name}</Text>}

        <View style={dynamicStyles.actionsRow}>
          {intake.status !== 'archived' && (
            <FeedbackTouchable
              style={[
                dynamicStyles.actionButton,
                dynamicStyles.actionButtonPrimary,
                !!intake.sent_at && clientPingCoolingDown && { opacity: 0.55 },
              ]}
              onPress={handleSend}
              disabled={busy || (!!intake.sent_at && clientPingCoolingDown)}
              loading={busyAction === 'send'}
              spinnerColor="#fff"
            >
              <Ionicons name="paper-plane" size={15} color="#fff" />
              <Text style={[dynamicStyles.actionButtonText, dynamicStyles.actionButtonTextPrimary]}>
                {intake.sent_at
                  ? clientPingCoolingDown
                    ? `Resend in ${formatRemainingCountdown(clientPingCooldownSec)}`
                    : 'Resend to Client'
                  : 'Send to Client'}
              </Text>
            </FeedbackTouchable>
          )}
          {intake.status === 'waiting_for_client' && (
            <FeedbackTouchable
              style={[dynamicStyles.actionButton, clientPingCoolingDown && { opacity: 0.55 }]}
              onPress={handleRemindNow}
              disabled={busy || clientPingCoolingDown}
              loading={busyAction === 'remind'}
              spinnerColor={colors.text}
            >
              <Ionicons name="refresh" size={15} color={colors.text} />
              <Text style={dynamicStyles.actionButtonText}>
                {clientPingCoolingDown
                  ? `Remind in ${formatRemainingCountdown(clientPingCooldownSec)}`
                  : 'Send Reminder Now'}
              </Text>
            </FeedbackTouchable>
          )}
          {intake.status !== 'archived' && (intake.items?.length ?? 0) > 0 && (
            <FeedbackTouchable
              style={dynamicStyles.actionButton}
              onPress={() => {
                setTemplateNameForSave(intake.title);
                setShowSaveTemplateModal(true);
              }}
              disabled={busy}
              replaceWithSpinner={false}
            >
              <Ionicons name="bookmark-outline" size={15} color={colors.text} />
              <Text style={dynamicStyles.actionButtonText}>Template</Text>
            </FeedbackTouchable>
          )}
          {intake.status !== 'archived' && (
            <FeedbackTouchable
              style={dynamicStyles.actionButton}
              onPress={handleArchive}
              disabled={busy}
              loading={busyAction === 'archive'}
              spinnerColor={colors.text}
            >
              <Ionicons name="archive-outline" size={15} color={colors.text} />
              <Text style={dynamicStyles.actionButtonText}>Archive</Text>
            </FeedbackTouchable>
          )}
          {intake.status === 'archived' && (
            <FeedbackTouchable
              style={[dynamicStyles.actionButton, dynamicStyles.actionButtonRestore]}
              onPress={handleUnarchive}
              disabled={busy}
              loading={busyAction === 'restore'}
              spinnerColor="#1D4ED8"
            >
              <Ionicons name="arrow-undo-outline" size={15} color="#1D4ED8" />
              <Text style={[dynamicStyles.actionButtonText, dynamicStyles.actionButtonTextRestore]}>Restore</Text>
            </FeedbackTouchable>
          )}
        </View>

        {/* Progress */}
        <View style={dynamicStyles.card}>
          <View style={dynamicStyles.progressRow}>
            <View style={dynamicStyles.progressBarBg}>
              <View style={[dynamicStyles.progressBarFill, { width: `${intake.progress?.percent ?? 0}%` }]} />
            </View>
            <Text style={dynamicStyles.progressLabel}>
              {intake.progress?.received ?? 0}/{intake.progress?.total ?? 0} &middot; {intake.progress?.percent ?? 0}%
            </Text>
          </View>
        </View>

        {/* Share panel */}
        {clientShareUrl && intake.upload_link && (
          <View style={dynamicStyles.card}>
            <Text style={dynamicStyles.cardTitle}>Share with client</Text>
            <View style={dynamicStyles.shareRow}>
              <View style={dynamicStyles.linkBox}>
                <Text style={dynamicStyles.linkBoxText} numberOfLines={1}>{clientShareUrl}</Text>
              </View>
              <FeedbackTouchable style={dynamicStyles.iconButton} onPress={handleShareLink} spinnerColor="#fff">
                <Ionicons name="share-outline" size={18} color="#fff" />
              </FeedbackTouchable>
            </View>
            {intake.upload_link.upload_code && (
              <View style={{ marginTop: 8 }}>
                <View style={dynamicStyles.codeActionRow}>
                  <FeedbackTouchable
                    onPress={() => copyUploadCode(intake.upload_link!.upload_code!)}
                    replaceWithSpinner={false}
                  >
                    <Text style={dynamicStyles.codeValue}>{intake.upload_link.upload_code}</Text>
                  </FeedbackTouchable>
                  {intake.upload_link.id ? (
                    <FeedbackTouchable
                      style={[dynamicStyles.smallActionBtn, dynamicStyles.naBtn]}
                      onPress={handleRegenerateCode}
                      disabled={regeneratingCode}
                      loading={regeneratingCode}
                      spinnerColor={colors.text}
                    >
                      <Ionicons name="refresh" size={14} color={colors.text} />
                      <Text style={[dynamicStyles.smallActionBtnText, { color: colors.text, marginLeft: 4 }]}>
                        Regenerate
                      </Text>
                    </FeedbackTouchable>
                  ) : null}
                </View>
                <Text style={dynamicStyles.codeText}>{getUploadToBaseUrl()}</Text>
              </View>
            )}
          </View>
        )}

        {/* Checklist */}
        <View style={dynamicStyles.card}>
          <Text style={dynamicStyles.cardTitle}>Checklist</Text>
          {orderedItems.map((item) => {
            const itemColor = ITEM_STATUS_COLORS[item.status] || ITEM_STATUS_COLORS.pending;
            const isClassifying = item.matched_file_id != null && classifyingFileIds[item.matched_file_id];
            const isUploading = uploadingItemId === item.id;
            const isItemBusy = itemBusyId === item.id;
            return (
              <View key={item.id} style={dynamicStyles.itemRow}>
                <View style={dynamicStyles.itemTopRow}>
                  <Text style={dynamicStyles.itemLabel}>{item.label}</Text>
                  {!item.required && <Text style={dynamicStyles.itemOptional}>optional</Text>}
                  <View style={[dynamicStyles.badge, { backgroundColor: itemColor.bg }]}>
                    <Text style={[dynamicStyles.badgeText, { color: itemColor.text }]}>{INTAKE_ITEM_STATUS_LABELS[item.status]}</Text>
                  </View>
                  {item.auto_verified && <Text style={dynamicStyles.itemOptional}>auto-verified</Text>}
                  {isClassifying && <ActivityIndicator size="small" color="#F59E0B" style={{ marginLeft: 4 }} />}
                </View>
                {item.matched_file_name && (
                  item.matched_file_id ? (
                    <TouchableOpacity onPress={() => openFileViewer(item.matched_file_id, item.matched_file_name)} activeOpacity={0.7}>
                      <Text style={dynamicStyles.itemFileName}>
                        {intakeFileLabel(item.matched_file_name, item.matched_file_id)}
                        {item.match_confidence != null && ` · ${Math.round(item.match_confidence * 100)}%`}
                      </Text>
                    </TouchableOpacity>
                  ) : (
                    <Text style={dynamicStyles.itemPlainFileName}>
                      {intakeFileLabel(item.matched_file_name)}
                    </Text>
                  )
                )}
                {item.description && <Text style={dynamicStyles.itemDescription}>{item.description}</Text>}
                <View style={dynamicStyles.itemButtonsRow}>
                  {item.status === 'pending' && intake.status !== 'archived' && (
                    <FeedbackTouchable
                      style={[dynamicStyles.smallActionBtn, dynamicStyles.naBtn]}
                      onPress={() => openUploadOptions(item)}
                      disabled={isUploading || busy || itemBusyId != null}
                      loading={isUploading}
                      spinnerColor="#007AFF"
                    >
                      <Ionicons name="cloud-upload-outline" size={14} color="#007AFF" />
                      <Text style={[dynamicStyles.smallActionBtnText, { color: '#007AFF', marginLeft: 4 }]}>Upload</Text>
                    </FeedbackTouchable>
                  )}
                  {item.status === 'matched' && (
                    <FeedbackTouchable
                      style={[dynamicStyles.smallActionBtn, dynamicStyles.verifyBtn]}
                      onPress={() => handleConfirmItem(item.id)}
                      disabled={itemBusyId != null || busy}
                      loading={isItemBusy}
                      spinnerColor="#fff"
                    >
                      <Ionicons name="checkmark" size={14} color="#fff" />
                      <Text style={[dynamicStyles.smallActionBtnText, { color: '#fff' }]}>Verify</Text>
                    </FeedbackTouchable>
                  )}
                  {(item.status === 'matched' || item.status === 'confirmed') && (
                    <FeedbackTouchable
                      style={[dynamicStyles.smallActionBtn, dynamicStyles.rejectBtn]}
                      onPress={() => handleRejectMatch(item.id)}
                      disabled={itemBusyId != null || busy}
                      loading={isItemBusy}
                      spinnerColor="#B91C1C"
                    >
                      <Ionicons name="close" size={14} color="#B91C1C" />
                      <Text style={[dynamicStyles.smallActionBtnText, { color: '#B91C1C' }]}>Reject</Text>
                    </FeedbackTouchable>
                  )}
                  {item.status === 'pending' && intake.status !== 'archived' && (
                    <FeedbackTouchable
                      style={[dynamicStyles.smallActionBtn, dynamicStyles.naBtn]}
                      onPress={() => handleNotApplicable(item.id)}
                      disabled={itemBusyId != null || busy}
                      loading={isItemBusy}
                      spinnerColor={colors.text}
                    >
                      <Text style={[dynamicStyles.smallActionBtnText, { color: colors.text, marginLeft: 0 }]}>Mark N/A</Text>
                    </FeedbackTouchable>
                  )}
                </View>
              </View>
            );
          })}
        </View>

        {/* Needs Attention */}
        {needsAttention.length > 0 && (
          <View style={dynamicStyles.card}>
            <Text style={[dynamicStyles.cardTitle, { color: '#92400E' }]}>Needs Attention</Text>
            <Text style={dynamicStyles.cardSubtitle}>Files GrabDocs isn&apos;t fully confident about — pick the checklist item they satisfy.</Text>
            {needsAttention.map((f) => (
              <View key={f.id} style={dynamicStyles.fileRow}>
                <TouchableOpacity onPress={() => openFileViewer(f.file_id, f.filename)}>
                  <Text style={dynamicStyles.fileRowName}>{intakeFileLabel(f.filename, f.file_id)}</Text>
                </TouchableOpacity>
                <Text style={dynamicStyles.fileRowMeta}>
                  Received via {INTAKE_SOURCE_LABELS[f.source] || f.source}
                  {f.matched_item_label && ` · Suggested: ${f.matched_item_label}`}
                  {f.match_confidence != null && ` (${Math.round(f.match_confidence * 100)}%)`}
                </Text>
                <FeedbackTouchable
                  style={dynamicStyles.assignBtn}
                  onPress={() => openAssignPicker(f)}
                  replaceWithSpinner={false}
                >
                  <Text style={dynamicStyles.assignBtnText}>Satisfy checklist item…</Text>
                </FeedbackTouchable>
              </View>
            ))}
          </View>
        )}

        {/* Unmatched */}
        {unmatched.length > 0 && (
          <View style={dynamicStyles.card}>
            <Text style={dynamicStyles.cardTitle}>Unmatched</Text>
            <Text style={dynamicStyles.cardSubtitle}>Files that arrived but didn&apos;t match anything on the checklist.</Text>
            {unmatched.map((f) => (
              <View key={f.id} style={dynamicStyles.fileRow}>
                <TouchableOpacity onPress={() => openFileViewer(f.file_id, f.filename)} activeOpacity={0.7}>
                  <Text style={dynamicStyles.fileRowName}>{intakeFileLabel(f.filename, f.file_id)}</Text>
                </TouchableOpacity>
                <Text style={dynamicStyles.fileRowMeta}>Received via {INTAKE_SOURCE_LABELS[f.source] || f.source}</Text>
                <FeedbackTouchable
                  style={dynamicStyles.assignBtn}
                  onPress={() => openAssignPicker(f)}
                  replaceWithSpinner={false}
                >
                  <Text style={dynamicStyles.assignBtnText}>Satisfy checklist item…</Text>
                </FeedbackTouchable>
              </View>
            ))}
          </View>
        )}

        {/* Arrival history */}
        {arrivalHistory.length > 0 && (
          <View style={dynamicStyles.card}>
            <Text style={dynamicStyles.cardTitle}>Arrival history</Text>
            {arrivalHistory.map((f) => (
              <View key={f.id} style={dynamicStyles.historyRow}>
                <View style={dynamicStyles.historyFileCol}>
                  <TouchableOpacity onPress={() => openFileViewer(f.file_id, f.filename)}>
                    <Text style={dynamicStyles.fileRowName} numberOfLines={1}>
                      {intakeFileLabel(f.filename, f.file_id)}
                    </Text>
                  </TouchableOpacity>
                  <Text style={dynamicStyles.historyMetaText}>
                    {INTAKE_SOURCE_LABELS[f.source] || f.source} &middot; {f.match_status.replace(/_/g, ' ')}
                  </Text>
                </View>
                <Text style={dynamicStyles.historyMetaText}>{formatDate(f.created_at)}</Text>
              </View>
            ))}
          </View>
        )}

        <View style={{ height: 24 }} />
      </ScrollView>

      {/* Assign file to checklist item picker */}
      <AdaptiveListPickerModal
        visible={!!assigningFile}
        onClose={() => setAssigningFile(null)}
        title={`Assign "${intakeFileLabel(assigningFile?.filename, assigningFile?.file_id)}"`}
        itemCount={items.length}
      >
        {items.map((item) => (
          <FeedbackTouchable
            key={item.id}
            style={dynamicStyles.modalOption}
            onPress={() => handleAssignFile(item.id)}
            disabled={assignBusyItemId != null}
            loading={assignBusyItemId === item.id}
            spinnerColor="#007AFF"
          >
            <Text style={dynamicStyles.modalOptionText}>{item.label}</Text>
          </FeedbackTouchable>
        ))}
      </AdaptiveListPickerModal>

      {/* File viewer */}
      {viewerFileId != null && (
        <DocumentViewer
          fileId={String(viewerFileId)}
          fileName={viewerFileName}
          fileType={getFileTypeFromFilename(viewerFileName)}
          onClose={() => {
            setViewerFileId(null);
            setViewerFileName('');
          }}
        />
      )}

      {/* Edit modal */}
      <Modal
        visible={editing}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => {
          setShowFolderPicker(false);
          setShowDatePicker(false);
          setEditing(false);
        }}
      >
        <SafeAreaView style={dynamicStyles.editContainer} edges={['left', 'right', 'bottom']}>
          <View style={[dynamicStyles.modalHeader, { paddingTop: insets.top + 12 }]}>
            <TouchableOpacity
              onPress={() => {
                setShowFolderPicker(false);
                setShowDatePicker(false);
                setEditing(false);
              }}
            >
              <Text style={dynamicStyles.linkText}>Cancel</Text>
            </TouchableOpacity>
            <Text style={dynamicStyles.modalTitle}>Edit Intake</Text>
            <FeedbackTouchable onPress={handleSaveEdit} disabled={savingEdit} loading={savingEdit} spinnerColor="#007AFF" replaceWithSpinner={false}>
              <Text style={[dynamicStyles.linkText, savingEdit && { opacity: 0.5 }]}>
                {savingEdit ? 'Saving...' : 'Save'}
              </Text>
            </FeedbackTouchable>
          </View>
          <ScrollView contentContainerStyle={dynamicStyles.editContent}>
            <View style={dynamicStyles.inputGroup}>
              <Text style={dynamicStyles.label}>Title *</Text>
              <TextInput style={dynamicStyles.input} value={editTitle} onChangeText={setEditTitle} placeholderTextColor={colors.textLight} />
            </View>
            <View style={dynamicStyles.row}>
              <View style={[dynamicStyles.inputGroup, dynamicStyles.flex1]}>
                <Text style={dynamicStyles.label}>Client name</Text>
                <TextInput style={dynamicStyles.input} value={editClientName} onChangeText={setEditClientName} placeholderTextColor={colors.textLight} />
              </View>
              <View style={[dynamicStyles.inputGroup, dynamicStyles.flex1]}>
                <Text style={dynamicStyles.label}>Due date</Text>
                <TouchableOpacity style={dynamicStyles.pickerButton} onPress={openEditDatePicker}>
                  <Text style={dynamicStyles.pickerButtonText}>{editDueAt || 'None'}</Text>
                  <Ionicons name="calendar-outline" size={18} color={colors.textSecondary} />
                </TouchableOpacity>
              </View>
            </View>
            <View style={dynamicStyles.inputGroup}>
              <Text style={dynamicStyles.label}>Primary client email</Text>
              <TextInput
                style={dynamicStyles.input}
                value={editClientEmail}
                onChangeText={setEditClientEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                placeholderTextColor={colors.textLight}
              />
            </View>

            <View style={dynamicStyles.inputGroup}>
              <Text style={dynamicStyles.label}>Authorized senders</Text>
              {editSenders.map((sender, idx) => (
                <View key={idx} style={dynamicStyles.senderRow}>
                  <TextInput
                    style={[dynamicStyles.smallInput, { flex: 1 }]}
                    value={sender.name}
                    onChangeText={(v) => setEditSenders((prev) => prev.map((s, i) => (i === idx ? { ...s, name: v } : s)))}
                    placeholder="Name"
                    placeholderTextColor={colors.textLight}
                  />
                  <TextInput
                    style={[dynamicStyles.smallInput, { flex: 1.5 }]}
                    value={sender.email}
                    onChangeText={(v) => setEditSenders((prev) => prev.map((s, i) => (i === idx ? { ...s, email: v } : s)))}
                    placeholder="email@example.com"
                    placeholderTextColor={colors.textLight}
                    keyboardType="email-address"
                    autoCapitalize="none"
                  />
                  <TouchableOpacity onPress={() => setEditSenders((prev) => prev.filter((_, i) => i !== idx))} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Ionicons name="trash-outline" size={18} color={colors.textLight} />
                  </TouchableOpacity>
                </View>
              ))}
              <TouchableOpacity style={dynamicStyles.addLink} onPress={() => setEditSenders((prev) => [...prev, { name: '', email: '' }])}>
                <Ionicons name="add-circle-outline" size={18} color="#007AFF" />
                <Text style={dynamicStyles.addLinkText}>Add sender</Text>
              </TouchableOpacity>
            </View>

            <View style={dynamicStyles.inputGroup}>
              <Text style={dynamicStyles.label}>Destination folder</Text>
              <TouchableOpacity style={dynamicStyles.pickerButton} onPress={() => setShowFolderPicker(true)}>
                <Text style={dynamicStyles.pickerButtonText}>
                  {editFolderId ? (folders.find((f) => f.id === editFolderId)?.name || 'Selected folder') : 'Leave files where they land'}
                </Text>
                <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>

            <View style={dynamicStyles.inputGroup}>
              <Text style={dynamicStyles.label}>Reminder cadence</Text>
              {(['gentle', 'standard', 'urgent'] as const).map((key) => (
                <TouchableOpacity
                  key={key}
                  style={[dynamicStyles.presetOption, editReminderPreset === key && dynamicStyles.presetOptionSelected]}
                  onPress={() => {
                    setEditReminderPreset(key);
                    setEditCustomReminder(INTAKE_REMINDER_PRESETS[key]);
                  }}
                >
                  <Text style={dynamicStyles.presetOptionTitle}>{key.charAt(0).toUpperCase() + key.slice(1)}</Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity
                style={[dynamicStyles.presetOption, editReminderPreset === 'custom' && dynamicStyles.presetOptionSelected]}
                onPress={() => setEditReminderPreset('custom')}
              >
                <Text style={dynamicStyles.presetOptionTitle}>Custom</Text>
              </TouchableOpacity>
              {editReminderPreset === 'custom' && (
                <View style={dynamicStyles.customRow}>
                  <View style={dynamicStyles.customField}>
                    <Text style={dynamicStyles.customLabel}>First (hrs)</Text>
                    <TextInput
                      style={dynamicStyles.smallInput}
                      value={String(editCustomReminder.first)}
                      onChangeText={(v) => setEditCustomReminder((p) => ({ ...p, first: parseInt(v, 10) || 1 }))}
                      keyboardType="numeric"
                    />
                  </View>
                  <View style={dynamicStyles.customField}>
                    <Text style={dynamicStyles.customLabel}>Repeat (hrs)</Text>
                    <TextInput
                      style={dynamicStyles.smallInput}
                      value={String(editCustomReminder.repeat)}
                      onChangeText={(v) => setEditCustomReminder((p) => ({ ...p, repeat: parseInt(v, 10) || 1 }))}
                      keyboardType="numeric"
                    />
                  </View>
                  <View style={dynamicStyles.customField}>
                    <Text style={dynamicStyles.customLabel}>Max</Text>
                    <TextInput
                      style={dynamicStyles.smallInput}
                      value={String(editCustomReminder.max)}
                      onChangeText={(v) => setEditCustomReminder((p) => ({ ...p, max: parseInt(v, 10) || 1 }))}
                      keyboardType="numeric"
                    />
                  </View>
                </View>
              )}
            </View>

            <View style={dynamicStyles.switchInlineRow}>
              <Switch
                value={editReminderEnabled}
                onValueChange={setEditReminderEnabled}
                trackColor={{ false: colors.switchTrackOff, true: colors.switchTrackOn }}
                thumbColor={colors.switchThumbAndroid(editReminderEnabled)}
                ios_backgroundColor={colors.switchTrackOff}
              />
              <Text style={dynamicStyles.switchInlineLabel}>Reminders enabled</Text>
            </View>
            <View style={dynamicStyles.switchInlineRow}>
              <Switch
                value={editAutoVerify}
                onValueChange={setEditAutoVerify}
                trackColor={{ false: colors.switchTrackOff, true: colors.switchTrackOn }}
                thumbColor={colors.switchThumbAndroid(editAutoVerify)}
                ios_backgroundColor={colors.switchTrackOff}
              />
              <Text style={dynamicStyles.switchInlineLabel}>Auto-verify AI matches &ge; 95% confidence</Text>
            </View>
          </ScrollView>

          {/* In-sheet overlays — nested RN Modals do not stack reliably over pageSheet. */}
          {showFolderPicker ? (
            <View style={dynamicStyles.editSheetOverlay}>
              <TouchableOpacity
                style={StyleSheet.absoluteFill}
                activeOpacity={1}
                onPress={() => setShowFolderPicker(false)}
              />
              <View style={dynamicStyles.editSheetCard}>
                <View style={dynamicStyles.modalHeader}>
                  <Text style={dynamicStyles.modalTitle}>Destination folder</Text>
                  <TouchableOpacity onPress={() => setShowFolderPicker(false)} hitSlop={8}>
                    <Ionicons name="close" size={22} color={colors.text} />
                  </TouchableOpacity>
                </View>
                <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 360 }}>
                  <TouchableOpacity
                    style={dynamicStyles.modalOption}
                    onPress={() => { setEditFolderId(null); setShowFolderPicker(false); }}
                  >
                    <Text style={dynamicStyles.modalOptionText}>Leave files where they land</Text>
                  </TouchableOpacity>
                  {folders.map((f) => (
                    <TouchableOpacity
                      key={f.id}
                      style={dynamicStyles.modalOption}
                      onPress={() => { setEditFolderId(f.id); setShowFolderPicker(false); }}
                    >
                      <Text style={dynamicStyles.modalOptionText}>{f.name}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            </View>
          ) : null}

          {showDatePicker ? (
            <View style={dynamicStyles.editSheetOverlay}>
              <TouchableOpacity
                style={StyleSheet.absoluteFill}
                activeOpacity={1}
                onPress={() => setShowDatePicker(false)}
              />
              <View style={dynamicStyles.editSheetCard}>
                <View style={dynamicStyles.modalHeader}>
                  <TouchableOpacity onPress={() => { setEditDueAt(''); setShowDatePicker(false); }}>
                    <Text style={dynamicStyles.linkText}>Clear</Text>
                  </TouchableOpacity>
                  <Text style={dynamicStyles.modalTitle}>Due date</Text>
                  <TouchableOpacity onPress={() => setShowDatePicker(false)}>
                    <Text style={dynamicStyles.linkText}>Done</Text>
                  </TouchableOpacity>
                </View>
                <DateTimePicker
                  value={editDueAt ? new Date(editDueAt) : new Date()}
                  mode="date"
                  display="spinner"
                  onChange={(_, d) => { if (d) setEditDueAt(toLocalDateString(d)); }}
                  textColor={colors.text}
                />
              </View>
            </View>
          ) : null}
        </SafeAreaView>
      </Modal>

      {/* Save Template modal */}
      <Modal visible={showSaveTemplateModal} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setShowSaveTemplateModal(false)}>
        <SafeAreaView style={dynamicStyles.editContainer} edges={['left', 'right', 'bottom']}>
          <View style={[dynamicStyles.modalHeader, { paddingTop: insets.top + 12 }]}>
            <TouchableOpacity onPress={() => setShowSaveTemplateModal(false)}>
              <Text style={dynamicStyles.linkText}>Cancel</Text>
            </TouchableOpacity>
            <Text style={dynamicStyles.modalTitle}>Template</Text>
            <FeedbackTouchable onPress={handleSaveAsTemplate} disabled={savingTemplate} loading={savingTemplate} spinnerColor="#007AFF" replaceWithSpinner={false}>
              <Text style={[dynamicStyles.linkText, savingTemplate && { opacity: 0.5 }]}>
                {savingTemplate ? 'Saving...' : 'Save'}
              </Text>
            </FeedbackTouchable>
          </View>
          <View style={{ padding: 16 }}>
            <View style={dynamicStyles.inputGroup}>
              <Text style={dynamicStyles.label}>Template name</Text>
              <TextInput
                style={dynamicStyles.input}
                value={templateNameForSave}
                onChangeText={setTemplateNameForSave}
                placeholder="e.g. Individual Tax Prep Checklist"
                placeholderTextColor={colors.textLight}
                autoFocus
              />
            </View>
            <View style={dynamicStyles.inputGroup}>
              <Text style={dynamicStyles.label}>Industry tag (optional)</Text>
              <TextInput
                style={dynamicStyles.input}
                value={templateIndustryForSave}
                onChangeText={setTemplateIndustryForSave}
                placeholder="e.g. accounting"
                placeholderTextColor={colors.textLight}
              />
            </View>
          </View>
        </SafeAreaView>
      </Modal>

      <UploadOptionsModal
        visible={uploadSheet.visible}
        expandNonce={uploadSheet.expandNonce}
        isUploading={uploadingItemId != null}
        onDismiss={dismissUploadModal}
        onFiles={handleUploadFromFiles}
        onCamera={handleUploadFromCamera}
        onGallery={handleUploadFromGallery}
        onLink={handleUploadByLink}
      />
    </SafeAreaView>
  );
}
