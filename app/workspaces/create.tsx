import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import {
    Alert,
    KeyboardAvoidingView,
    Platform,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FeedbackTouchable } from '../../components/FeedbackTouchable';
import { useLimitError } from '../../contexts/LimitErrorContext';
import { useThemeColors } from '../../hooks/useThemeColors';
import { apiService } from '../../services/api';
import { extractLimitErrorData, limitErrorFromCaught } from '../../utils/limitErrorUtils';
import { workspacesListScreenKey } from '../../services/userScopedCache';
import { screenCache } from '../../utils/screenCache';
import { useAuth } from '../context/auth';

import AppBackButton from '../../components/AppBackButton';
import AppHeaderTitle from '../../components/AppHeaderTitle';

export default function CreateWorkspaceScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const colors = useThemeColors();
  const { showLimitError } = useLimitError();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [slug, setSlug] = useState('');
  const [loading, setLoading] = useState(false);

  const handleBack = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/workspaces' as any);
    }
  };

  const generateSlug = (text: string) => {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  };

  const handleNameChange = (text: string) => {
    setName(text);
    if (!slug || slug === generateSlug(name)) {
      setSlug(generateSlug(text));
    }
  };

  const dynamicStyles = useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-start',
      gap: 4,
      paddingHorizontal: 20,
      paddingVertical: 16,
      backgroundColor: colors.headerBackground,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    headerTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: colors.text,
      textAlign: 'left',
    },
    saveButton: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderRadius: 8,
      backgroundColor: '#007AFF',
    },
    saveButtonDisabled: {
      backgroundColor: '#ccc',
    },
    saveButtonText: {
      color: '#fff',
      fontSize: 16,
      fontWeight: '600',
    },
    saveButtonTextDisabled: {
      color: '#999',
    },
    content: {
      flex: 1,
    },
    form: {
      flex: 1,
      padding: 20,
    },
    section: {
      marginBottom: 32,
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
      color: '#FF6B6B',
    },
    input: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      paddingHorizontal: 16,
      paddingVertical: 12,
      fontSize: 16,
      color: colors.text,
    },
    textArea: {
      height: 100,
      paddingTop: 12,
    },
    helpText: {
      fontSize: 14,
      color: colors.textSecondary,
      marginTop: 4,
      lineHeight: 18,
    },
    infoBox: {
      flexDirection: 'row',
      backgroundColor: colors.surface,
      padding: 16,
      borderRadius: 8,
      borderLeftWidth: 4,
      borderLeftColor: '#007AFF',
    },
    infoContent: {
      flex: 1,
      marginLeft: 12,
    },
    infoTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: colors.text,
      marginBottom: 4,
    },
    infoText: {
      fontSize: 14,
      color: colors.textSecondary,
      lineHeight: 18,
    },
  }), [colors]);

  const handleCreate = async () => {
    if (!name.trim()) {
      Alert.alert('Error', 'Workspace name is required');
      return;
    }

    if (!slug.trim()) {
      Alert.alert('Error', 'Workspace slug is required');
      return;
    }

    setLoading(true);
    try {
      const response = await apiService.createWorkspace({
        name: name.trim(),
        description: description.trim() || undefined,
        slug: slug.trim(),
      });

      if (response.success) {
        const listKey = workspacesListScreenKey(user?.id);
        if (listKey) screenCache.invalidate(listKey);
        Alert.alert('Success', 'Workspace created successfully', [
          { text: 'OK', onPress: () => router.back() }
        ]);
      } else {
        const limitData = extractLimitErrorData(response);
        if (limitData) showLimitError(limitData);
        else Alert.alert('Error', response.message || 'Failed to create workspace');
      }
    } catch (error: any) {
      console.error('Create workspace error:', error);
      const limitData = limitErrorFromCaught(error);
      if (limitData) showLimitError(limitData);
      else Alert.alert('Error', error.message || 'Failed to create workspace');
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={dynamicStyles.container}>
      <View style={dynamicStyles.header}>
        <AppBackButton onPress={handleBack} />
        <AppHeaderTitle pointerEvents="none">Create Workspace</AppHeaderTitle>
        <FeedbackTouchable
          onPress={handleCreate}
          disabled={loading || !name.trim() || !slug.trim()}
          loading={loading}
          spinnerColor="#007AFF"
          replaceWithSpinner={false}
          style={[
            dynamicStyles.saveButton,
            (loading || !name.trim() || !slug.trim()) && dynamicStyles.saveButtonDisabled
          ]}
        >
          <Text style={[
            dynamicStyles.saveButtonText,
            (loading || !name.trim() || !slug.trim()) && dynamicStyles.saveButtonTextDisabled
          ]}>
            {loading ? 'Creating...' : 'Create'}
          </Text>
        </FeedbackTouchable>
      </View>

      <KeyboardAvoidingView
        style={dynamicStyles.content}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView style={dynamicStyles.form} showsVerticalScrollIndicator={false}>
          <View style={dynamicStyles.section}>
            <Text style={dynamicStyles.sectionTitle}>Workspace Details</Text>
            
            <View style={dynamicStyles.inputGroup}>
              <Text style={dynamicStyles.label}>
                Workspace Name <Text style={dynamicStyles.required}>*</Text>
              </Text>
              <TextInput
                style={dynamicStyles.input}
                value={name}
                onChangeText={handleNameChange}
                placeholder="Enter workspace name"
                placeholderTextColor={colors.textLight}
                autoCapitalize="words"
                maxLength={100}
              />
              <Text style={dynamicStyles.helpText}>
                A clear, descriptive name for your workspace
              </Text>
            </View>

            <View style={dynamicStyles.inputGroup}>
              <Text style={dynamicStyles.label}>Description</Text>
              <TextInput
                style={[dynamicStyles.input, dynamicStyles.textArea]}
                value={description}
                onChangeText={setDescription}
                placeholder="Describe what this workspace is for..."
                placeholderTextColor={colors.textLight}
                multiline
                numberOfLines={4}
                textAlignVertical="top"
                maxLength={500}
              />
              <Text style={dynamicStyles.helpText}>
                Optional description to help team members understand the workspace purpose
              </Text>
            </View>

            <View style={dynamicStyles.inputGroup}>
              <Text style={dynamicStyles.label}>
                Workspace Slug <Text style={dynamicStyles.required}>*</Text>
              </Text>
              <TextInput
                style={dynamicStyles.input}
                value={slug}
                onChangeText={setSlug}
                placeholder="workspace-slug"
                placeholderTextColor={colors.textLight}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={50}
              />
              <Text style={dynamicStyles.helpText}>
                URL-friendly identifier (lowercase, hyphens allowed). This will be used in workspace URLs.
              </Text>
            </View>
          </View>

          <View style={dynamicStyles.section}>
            <Text style={dynamicStyles.sectionTitle}>Workspace Settings</Text>
            <View style={dynamicStyles.infoBox}>
              <Ionicons name="information-circle" size={20} color="#007AFF" />
              <View style={dynamicStyles.infoContent}>
                <Text style={dynamicStyles.infoTitle}>Getting Started</Text>
                <Text style={dynamicStyles.infoText}>
                  After creating your workspace, you&apos;ll be able to invite team members and start collaborating on documents and forms.
                </Text>
              </View>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
