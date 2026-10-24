import { Ionicons } from '@expo/vector-icons';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Keyboard,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import ClientsButton from '../../components/clients/ClientsButton';
import { FeedbackTouchable } from '../../components/FeedbackTouchable';
import { useThemeColors } from '../../hooks/useThemeColors';
import { apiService } from '../../services/api';
import { setItemClients } from '../../services/clientsApi';
import { uploadLinksListScreenKey } from '../../services/userScopedCache';
import { screenCache } from '../../utils/screenCache';
import { useAuth } from '../context/auth';

import AppBackButton from '../../components/AppBackButton';
import AppHeaderTitle from '../../components/AppHeaderTitle';

function toLocalDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseLocalDate(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

function formatDisplayDate(value: string): string {
  return parseLocalDate(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function dateToEndOfDayIso(value: string): string {
  const d = parseLocalDate(value);
  d.setHours(23, 59, 0, 0);
  return d.toISOString();
}

function todayLocalDateString(): string {
  return toLocalDateString(new Date());
}

export default function CreateUploadLinkScreen() {
  const router = useRouter();
  const { client_id: clientIdParam } = useLocalSearchParams<{ client_id?: string }>();
  const { user } = useAuth();
  const colors = useThemeColors();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [maxUploads, setMaxUploads] = useState('');
  const [loading, setLoading] = useState(false);
  const [selectedClientIds, setSelectedClientIds] = useState<number[]>([]);

  useEffect(() => {
    const raw = Array.isArray(clientIdParam) ? clientIdParam[0] : clientIdParam;
    const id = typeof raw === 'string' && /^\d+$/.test(raw) ? parseInt(raw, 10) : null;
    if (id != null) {
      setSelectedClientIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    }
  }, [clientIdParam]);

  const handleCreate = async () => {
    if (!name.trim()) {
      Alert.alert('Error', 'Please enter a name for the file request');
      return;
    }

    setLoading(true);
    try {
      const data: any = {
        name: name.trim(),
        description: description.trim() || undefined,
      };

      if (expiresOn) {
        if (expiresOn < todayLocalDateString()) {
          Alert.alert('Error', 'Expiration date cannot be in the past');
          setLoading(false);
          return;
        }
        data.expires_at = dateToEndOfDayIso(expiresOn);
      }

      const maxText = maxUploads.trim();
      if (maxText) {
        const limit = parseInt(maxText, 10);
        if (isNaN(limit) || limit <= 0) {
          Alert.alert('Error', 'Please enter a valid upload limit');
          setLoading(false);
          return;
        }
        data.max_uploads = limit;
      }

      const response = await apiService.createUploadLink(data);
      
      if (response.success) {
        const resAny = response as any;
        const newLink = resAny.upload_link ?? resAny.link;
        const newLinkId = newLink?.id as number | undefined;
        if (newLinkId && selectedClientIds.length > 0) {
          try {
            await setItemClients({
              client_ids: selectedClientIds,
              item_type: 'file_upload_link',
              item_id: newLinkId,
            });
          } catch (linkErr) {
            console.error('Error linking clients:', linkErr);
          }
        }
        const listKey = uploadLinksListScreenKey(user?.id);
        if (listKey) screenCache.invalidate(listKey);
        Alert.alert(
          'Success',
          'File request created successfully!',
          [
            {
              text: 'OK',
              onPress: () => router.back(),
            },
          ]
        );
      } else {
        Alert.alert('Error', response.message || 'Failed to create upload link');
      }
    } catch (error: any) {
      console.error('Create upload link error:', error);
      Alert.alert('Error', error.message || 'Failed to create upload link');
    } finally {
      setLoading(false);
    }
  };

  const applyPickedDate = (date: Date) => {
    setExpiresOn(toLocalDateString(date));
  };

  const openDatePicker = () => {
    Keyboard.dismiss();
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value: expiresOn ? parseLocalDate(expiresOn) : new Date(),
        mode: 'date',
        minimumDate: parseLocalDate(todayLocalDateString()),
        onChange: (event, date) => {
          if (event?.type === 'set' && date) applyPickedDate(date);
        },
      });
    } else {
      setShowDatePicker(true);
    }
  };

  const dynamicStyles = useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: 16,
      backgroundColor: colors.headerBackground,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    title: {
      fontSize: 18,
      fontWeight: '600',
      color: colors.text,
    },
    placeholder: {
      width: 24,
    },
    content: {
      flex: 1,
    },
    section: {
      backgroundColor: colors.card,
      marginTop: 8,
      padding: 16,
    },
    sectionTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: colors.text,
      marginBottom: 16,
    },
    inputGroup: {
      marginBottom: 20,
    },
    label: {
      fontSize: 16,
      fontWeight: '500',
      color: colors.text,
      marginBottom: 8,
    },
    required: {
      color: '#FF3B30',
    },
    input: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 12,
      fontSize: 16,
      color: colors.text,
    },
    textArea: {
      height: 80,
      textAlignVertical: 'top',
    },
    row: { flexDirection: 'row', gap: 10 },
    flex1: { flex: 1 },
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
    pickerButtonText: { fontSize: 16, color: colors.text, flex: 1, marginRight: 8 },
    pickerPlaceholder: { color: colors.textLight },
    modalOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.5)',
      justifyContent: 'flex-end',
    },
    modalCard: {
      backgroundColor: colors.card,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
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
    linkText: { fontSize: 13, color: '#007AFF', fontWeight: '500' },
    infoBox: {
      flexDirection: 'row',
      backgroundColor: colors.surface,
      padding: 16,
      borderRadius: 8,
      margin: 16,
      borderLeftWidth: 4,
      borderLeftColor: '#007AFF',
    },
    infoText: {
      flex: 1,
      marginLeft: 12,
      fontSize: 14,
      color: colors.textSecondary,
      lineHeight: 20,
    },
    footer: {
      padding: 16,
      backgroundColor: colors.card,
      borderTopWidth: 1,
      borderTopColor: colors.border,
    },
    createButton: {
      backgroundColor: '#007AFF',
      paddingVertical: 16,
      borderRadius: 8,
      alignItems: 'center',
    },
    disabledButton: {
      opacity: 0.5,
    },
    createButtonText: {
      color: '#fff',
      fontSize: 16,
      fontWeight: '600',
    },
  }), [colors]);

  return (
    <SafeAreaView style={dynamicStyles.container}>
      <View style={dynamicStyles.header}>
        <AppBackButton onPress={() => {
            Keyboard.dismiss();
            router.back();
          }} />
        <AppHeaderTitle>Create File Request</AppHeaderTitle>
        <View style={dynamicStyles.placeholder} />
      </View>

      <ScrollView
        style={dynamicStyles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={dynamicStyles.section}>
          <Text style={dynamicStyles.sectionTitle}>Basic Information</Text>
          
          <View style={dynamicStyles.inputGroup}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <Text style={[dynamicStyles.label, { marginBottom: 0 }]}>
                Name <Text style={dynamicStyles.required}>*</Text>
              </Text>
              <ClientsButton
                selectedClientIds={selectedClientIds}
                onChange={setSelectedClientIds}
                allowCreate
                compact
              />
            </View>
            <TextInput
              style={dynamicStyles.input}
              value={name}
              onChangeText={setName}
              placeholder="e.g., Client Documents, Team Reports"
              placeholderTextColor={colors.textLight}
              maxLength={100}
            />
          </View>

          <View style={dynamicStyles.inputGroup}>
            <Text style={dynamicStyles.label}>Description (Optional)</Text>
            <TextInput
              style={[dynamicStyles.input, dynamicStyles.textArea]}
              value={description}
              onChangeText={setDescription}
              placeholder="Describe what files should be uploaded..."
              placeholderTextColor={colors.textLight}
              multiline
              numberOfLines={3}
              maxLength={500}
            />
          </View>
        </View>

        <View style={dynamicStyles.section}>
          <Text style={dynamicStyles.sectionTitle}>Limits</Text>

          <View style={[dynamicStyles.row, dynamicStyles.inputGroup, { marginBottom: 0 }]}>
            <View style={dynamicStyles.flex1}>
              <Text style={dynamicStyles.label}>Expires</Text>
              <TouchableOpacity style={dynamicStyles.pickerButton} onPress={openDatePicker}>
                <Text
                  style={[
                    dynamicStyles.pickerButtonText,
                    !expiresOn && dynamicStyles.pickerPlaceholder,
                  ]}
                  numberOfLines={1}
                >
                  {expiresOn ? formatDisplayDate(expiresOn) : 'No expiration'}
                </Text>
                {expiresOn ? (
                  <TouchableOpacity
                    onPress={() => setExpiresOn('')}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    accessibilityLabel="Clear expiration date"
                  >
                    <Ionicons name="close-circle" size={18} color={colors.textSecondary} />
                  </TouchableOpacity>
                ) : (
                  <Ionicons name="calendar-outline" size={18} color={colors.textSecondary} />
                )}
              </TouchableOpacity>
            </View>
            <View style={dynamicStyles.flex1}>
              <Text style={dynamicStyles.label}>Max uploads</Text>
              <TextInput
                style={dynamicStyles.input}
                value={maxUploads}
                onChangeText={setMaxUploads}
                keyboardType="number-pad"
                placeholder="Unlimited"
                placeholderTextColor={colors.textLight}
              />
            </View>
          </View>
        </View>

        <View style={dynamicStyles.infoBox}>
          <Ionicons name="information-circle" size={20} color="#007AFF" />
          <Text style={dynamicStyles.infoText}>
            Once created, you can share the upload link via email or copy it to share manually. 
            Recipients can upload files without needing an account.
          </Text>
        </View>
      </ScrollView>

      <View style={dynamicStyles.footer}>
        <FeedbackTouchable
          style={[dynamicStyles.createButton, loading && dynamicStyles.disabledButton]}
          onPress={handleCreate}
          disabled={loading}
          loading={loading}
          spinnerColor="#fff"
          replaceWithSpinner={false}
        >
          <Text style={dynamicStyles.createButtonText}>
            {loading ? 'Creating...' : 'Create File Request'}
          </Text>
        </FeedbackTouchable>
      </View>

      <Modal
        visible={showDatePicker}
        animationType="fade"
        transparent
        statusBarTranslucent
        onRequestClose={() => setShowDatePicker(false)}
      >
        <View style={dynamicStyles.modalOverlay}>
          <View style={dynamicStyles.modalCard}>
            <View style={dynamicStyles.modalHeader}>
              <TouchableOpacity
                onPress={() => {
                  setExpiresOn('');
                  setShowDatePicker(false);
                }}
              >
                <Text style={dynamicStyles.linkText}>Clear</Text>
              </TouchableOpacity>
              <Text style={dynamicStyles.modalTitle}>Expires</Text>
              <TouchableOpacity onPress={() => setShowDatePicker(false)}>
                <Text style={dynamicStyles.linkText}>Done</Text>
              </TouchableOpacity>
            </View>
            <DateTimePicker
              value={expiresOn ? parseLocalDate(expiresOn) : new Date()}
              mode="date"
              display="spinner"
              minimumDate={parseLocalDate(todayLocalDateString())}
              onChange={(_, d) => {
                if (d) applyPickedDate(d);
              }}
              textColor={colors.text}
            />
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}
