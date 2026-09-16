import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FeedbackTouchable } from '../../../components/FeedbackTouchable';
import { useThemeColors } from '../../../hooks/useThemeColors';
import { apiService } from '../../../services/api';
import type { IntakeTemplate, IntakeTemplateItem } from '../../../types/intake';

import AppBackButton, { APP_BACK_BUTTON_SLOT } from '../../../components/AppBackButton';
import AppHeaderTitle from '../../../components/AppHeaderTitle';

interface ChecklistItemForm {
  label: string;
  description: string;
  required: boolean;
}

export default function EditIntakeTemplateScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const { id } = useLocalSearchParams<{ id: string }>();
  const templateId = Number(id);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [industryTag, setIndustryTag] = useState('');
  const [items, setItems] = useState<ChecklistItemForm[]>([{ label: '', description: '', required: true }]);

  const loadTemplate = useCallback(async () => {
    if (!templateId) return;
    setLoading(true);
    try {
      const response = await apiService.getIntakeTemplate(templateId);
      if (response.success && response.template) {
        const t: IntakeTemplate = response.template;
        setName(t.name || '');
        setIndustryTag(t.industry_tag || '');
        setItems(
          t.items?.length
            ? t.items.map((i: IntakeTemplateItem) => ({
                label: i.label || '',
                description: i.description || '',
                required: i.required,
              }))
            : [{ label: '', description: '', required: true }],
        );
      } else {
        Alert.alert('Error', response.message || 'Template not found');
        router.back();
      }
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to load template');
      router.back();
    } finally {
      setLoading(false);
    }
  }, [templateId, router]);

  useEffect(() => {
    loadTemplate();
  }, [loadTemplate]);

  const updateItem = (idx: number, field: keyof ChecklistItemForm, value: string | boolean) => {
    setItems((prev) => prev.map((item, i) => (i === idx ? { ...item, [field]: value } : item)));
  };

  const addItem = () => setItems((prev) => [...prev, { label: '', description: '', required: true }]);

  const removeItem = (idx: number) => {
    if (items.length <= 1) return;
    setItems((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSave = async () => {
    const validItems = items.filter((i) => i.label.trim());
    if (!name.trim()) {
      Alert.alert('Error', 'Template name is required');
      return;
    }
    if (validItems.length === 0) {
      Alert.alert('Error', 'Add at least one checklist item');
      return;
    }
    setSaving(true);
    try {
      const response = await apiService.updateIntakeTemplate(templateId, {
        name: name.trim(),
        industry_tag: industryTag.trim() || null,
        items: validItems.map((i) => ({
          label: i.label.trim(),
          description: i.description.trim() || null,
          required: i.required,
        })),
      });
      if (response.success) {
        if (response.unchanged || response.already_exists) {
          Alert.alert(
            'Already saved',
            response.message || 'No changes were made — this template is already saved.',
          );
          return;
        }
        Alert.alert('Saved', 'Template updated');
        router.back();
      } else {
        Alert.alert('Error', response.message || 'Failed to update template');
      }
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to update template');
    } finally {
      setSaving(false);
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
    title: { fontSize: 17, fontWeight: '600', color: colors.text },
    linkText: { fontSize: 15, color: '#007AFF', fontWeight: '500' },
    center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    content: { padding: 16 },
    section: { marginBottom: 20 },
    sectionTitle: { fontSize: 15, fontWeight: '600', color: colors.text, marginBottom: 10 },
    sectionSubtitle: { fontSize: 12, color: colors.textSecondary, marginTop: -6, marginBottom: 12 },
    inputGroup: { marginBottom: 12 },
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
    itemCard: {
      backgroundColor: colors.card,
      borderRadius: 10,
      padding: 12,
      marginBottom: 10,
      borderWidth: 1,
      borderColor: colors.border,
    },
    itemHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
    itemTitle: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
    switchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
    switchLabel: { fontSize: 13, color: colors.text },
    addBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
    addBtnText: { fontSize: 14, color: '#007AFF', fontWeight: '500' },
  }), [colors]);

  if (loading) {
    return (
      <SafeAreaView style={dynamicStyles.container}>
        <View style={dynamicStyles.header}>
          <AppBackButton />
          <AppHeaderTitle>Edit template</AppHeaderTitle>
          <View style={{ width: APP_BACK_BUTTON_SLOT }} />
        </View>
        <View style={dynamicStyles.center}>
          <ActivityIndicator size="large" color="#007AFF" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={dynamicStyles.container}>
      <View style={dynamicStyles.header}>
        <AppBackButton />
        <AppHeaderTitle>Edit template</AppHeaderTitle>
        <FeedbackTouchable onPress={handleSave} disabled={saving} loading={saving} spinnerColor="#007AFF" replaceWithSpinner={false}>
          <Text style={[dynamicStyles.linkText, saving && { opacity: 0.5 }]}>
            {saving ? 'Saving...' : 'Save'}
          </Text>
        </FeedbackTouchable>
      </View>

      <ScrollView contentContainerStyle={dynamicStyles.content} showsVerticalScrollIndicator={false}>
        <View style={dynamicStyles.section}>
          <View style={dynamicStyles.inputGroup}>
            <Text style={dynamicStyles.label}>Template name *</Text>
            <TextInput
              style={dynamicStyles.input}
              value={name}
              onChangeText={setName}
              placeholderTextColor={colors.textLight}
            />
          </View>
          <View style={dynamicStyles.inputGroup}>
            <Text style={dynamicStyles.label}>Industry tag (optional)</Text>
            <TextInput
              style={dynamicStyles.input}
              value={industryTag}
              onChangeText={setIndustryTag}
              placeholder="e.g. accounting"
              placeholderTextColor={colors.textLight}
            />
          </View>
        </View>

        <View style={dynamicStyles.section}>
          <Text style={dynamicStyles.sectionTitle}>Checklist items</Text>
          <Text style={dynamicStyles.sectionSubtitle}>
            Specify the documents you want to collect.
          </Text>
          {items.map((item, idx) => (
            <View key={idx} style={dynamicStyles.itemCard}>
              <View style={dynamicStyles.itemHeader}>
                <Text style={dynamicStyles.itemTitle}>Item {idx + 1}</Text>
                {items.length > 1 && (
                  <TouchableOpacity onPress={() => removeItem(idx)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Ionicons name="trash-outline" size={18} color={colors.textLight} />
                  </TouchableOpacity>
                )}
              </View>
              <TextInput
                style={dynamicStyles.input}
                value={item.label}
                onChangeText={(v) => updateItem(idx, 'label', v)}
                placeholder="Label *"
                placeholderTextColor={colors.textLight}
              />
              <TextInput
                style={[dynamicStyles.input, { marginTop: 8 }]}
                value={item.description}
                onChangeText={(v) => updateItem(idx, 'description', v)}
                placeholder="Describe what this document looks like (optional)"
                placeholderTextColor={colors.textLight}
              />
              <View style={dynamicStyles.switchRow}>
                <Switch
                  value={item.required}
                  onValueChange={(v) => updateItem(idx, 'required', v)}
                  trackColor={{ false: colors.switchTrackOff, true: colors.switchTrackOn }}
                  thumbColor={colors.switchThumbAndroid(item.required)}
                />
                <Text style={dynamicStyles.switchLabel}>Required</Text>
              </View>
            </View>
          ))}
          <TouchableOpacity style={dynamicStyles.addBtn} onPress={addItem}>
            <Ionicons name="add-circle-outline" size={18} color="#007AFF" />
            <Text style={dynamicStyles.addBtnText}>Add item</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
