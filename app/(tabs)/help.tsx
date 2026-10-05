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
    View
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FeedbackTouchable } from '../../components/FeedbackTouchable';
import { useScrollRestoresHeaderProps } from '../../contexts/HeaderVisibilityContext';
import { useThemeColors } from '../../hooks/useThemeColors';
import { apiClient } from '../../services/api';
import { AnimatedHeaderContainer } from '../components/AnimatedHeaderContainer';
import { TapToToggleHeaderView } from '../components/TapToToggleHeaderView';
import { useAuth } from '../context/auth';

import AppBackButton from '../../components/AppBackButton';
import AppHeaderTitle from '../../components/AppHeaderTitle';

const FEEDBACK_CATEGORIES = [
  { value: 'bug', label: 'Bug Report' },
  { value: 'feature', label: 'Feature Request' },
  { value: 'question', label: 'Question' },
  { value: 'feedback', label: 'General Feedback' },
  { value: 'other', label: 'Other' }
];

export default function HelpScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const colors = useThemeColors();
  const scrollRestoresHeaderProps = useScrollRestoresHeaderProps();
  const [loading, setLoading] = useState(false);
  const [feedbackData, setFeedbackData] = useState({
    category: 'feedback',
    title: '',
    message: ''
  });

  const dynamicStyles = useMemo(
    () =>
      StyleSheet.create({
        container: {
          flex: 1,
          backgroundColor: colors.background,
        },
        content: {
          flex: 1,
          padding: 16,
        },
        section: {
          backgroundColor: colors.card,
          borderRadius: 12,
          padding: 12,
          marginBottom: 12,
        },
        sectionTitle: {
          fontSize: 18,
          fontWeight: '600',
          color: colors.text,
          marginBottom: 8,
        },
        label: {
          fontSize: 14,
          fontWeight: '500',
          color: colors.textSecondary,
          marginBottom: 6,
        },
        input: {
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: 8,
          paddingHorizontal: 12,
          paddingVertical: 10,
          fontSize: 16,
          color: colors.text,
          backgroundColor: colors.inputBackground,
          minHeight: 44,
        },
        textArea: {
          minHeight: 120,
          textAlignVertical: 'top',
          paddingTop: 12,
        },
        categoryContainer: {
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: 6,
        },
        categoryButton: {
          paddingHorizontal: 14,
          paddingVertical: 6,
          borderRadius: 20,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.inputBackground,
        },
        categoryButtonSelected: {
          backgroundColor: '#007AFF',
          borderColor: '#007AFF',
        },
        categoryButtonText: {
          fontSize: 14,
          color: colors.text,
        },
        categoryButtonTextSelected: {
          color: '#fff',
          fontWeight: '600',
        },
        submitButton: {
          backgroundColor: '#007AFF',
          paddingVertical: 14,
          borderRadius: 8,
          alignItems: 'center',
          marginTop: 4,
        },
        submitButtonDisabled: {
          backgroundColor: '#c6c6c6',
        },
        submitButtonText: {
          color: '#fff',
          fontSize: 16,
          fontWeight: '600',
        },
        infoText: {
          fontSize: 14,
          color: colors.textSecondary,
          marginTop: 4,
          lineHeight: 20,
        },
      }),
    [colors]
  );

  const handleSubmit = async () => {
    // Validate required fields
    if (!feedbackData.title.trim()) {
      Alert.alert('Required Field', 'Please enter a title for your feedback');
      return;
    }

    if (!feedbackData.message.trim()) {
      Alert.alert('Required Field', 'Please enter your message');
      return;
    }

    if (!feedbackData.category) {
      Alert.alert('Required Field', 'Please select a category');
      return;
    }

    try {
      setLoading(true);

      const response = await apiClient.client.post('/api/v1/mobile/feedback', {
        category: feedbackData.category,
        title: feedbackData.title.trim(),
        message: feedbackData.message.trim()
      });

      if (response.data.success) {
        Alert.alert(
          'Thank You!',
          'Your feedback has been submitted successfully. We appreciate your input!',
          [
            {
              text: 'OK',
              onPress: () => {
                // Reset form
                setFeedbackData({
                  category: 'feedback',
                  title: '',
                  message: ''
                });
                // Redirect to home
                router.replace('/(tabs)');
              }
            }
          ]
        );
      } else {
        Alert.alert('Error', response.data.message || 'Failed to submit feedback. Please try again.');
      }
    } catch (error: any) {
      console.error('Failed to submit feedback:', error);
      console.error('Error response:', error.response?.data);
      const errorMessage = error.response?.data?.message || 
                          error.response?.data?.error ||
                          error.message || 
                          'Failed to submit feedback. Please check your connection and try again.';
      Alert.alert('Error', errorMessage);
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={dynamicStyles.container} edges={['top']}>
      <TapToToggleHeaderView style={dynamicStyles.container}>
      <AnimatedHeaderContainer>
        <View style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 16,
          paddingVertical: 12,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
          backgroundColor: colors.headerBackground
        }}>
          <AppBackButton />
          <AppHeaderTitle>Help & Support</AppHeaderTitle>
        </View>
      </AnimatedHeaderContainer>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <ScrollView
          style={dynamicStyles.content}
          contentContainerStyle={{ paddingBottom: 96 }}
          showsVerticalScrollIndicator={false}
          {...scrollRestoresHeaderProps}
        >
          {/* Header */}
          <View style={[dynamicStyles.section, { marginTop: 0 }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
              <Ionicons name="help-circle" size={24} color="#007AFF" />
              <Text style={[dynamicStyles.sectionTitle, { marginLeft: 8, marginBottom: 0 }]}>
                Help & Feedback
              </Text>
            </View>
            <Text style={dynamicStyles.infoText}>
              {"We'd love to hear from you! Share your feedback, report issues, or ask questions."}
            </Text>
          </View>

          {/* Category Selection */}
          <View style={dynamicStyles.section}>
            <Text style={dynamicStyles.label}>Category *</Text>
            <View style={dynamicStyles.categoryContainer}>
              {FEEDBACK_CATEGORIES.map((category) => (
                <TouchableOpacity
                  key={category.value}
                  style={[
                    dynamicStyles.categoryButton,
                    feedbackData.category === category.value && dynamicStyles.categoryButtonSelected
                  ]}
                  onPress={() => setFeedbackData(prev => ({ ...prev, category: category.value }))}
                >
                  <Text
                    style={[
                      dynamicStyles.categoryButtonText,
                      feedbackData.category === category.value && dynamicStyles.categoryButtonTextSelected
                    ]}
                  >
                    {category.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* Title Input */}
          <View style={dynamicStyles.section}>
            <Text style={dynamicStyles.label}>Title *</Text>
            <TextInput
              style={dynamicStyles.input}
              placeholder="Brief summary of your feedback"
              placeholderTextColor={colors.textLight}
              value={feedbackData.title}
              onChangeText={(text) => setFeedbackData(prev => ({ ...prev, title: text }))}
              maxLength={200}
            />
            <Text style={[dynamicStyles.infoText, { fontSize: 12 }]}>
              {feedbackData.title.length}/200 characters
            </Text>
          </View>

          {/* Message Input */}
          <View style={dynamicStyles.section}>
            <Text style={dynamicStyles.label}>Message *</Text>
            <TextInput
              style={[dynamicStyles.input, dynamicStyles.textArea]}
              placeholder="Please provide details about your feedback, issue, or question..."
              placeholderTextColor={colors.textLight}
              value={feedbackData.message}
              onChangeText={(text) => setFeedbackData(prev => ({ ...prev, message: text }))}
              multiline
              numberOfLines={8}
              maxLength={2000}
            />
            <Text style={[dynamicStyles.infoText, { fontSize: 12 }]}>
              {feedbackData.message.length}/2000 characters
            </Text>
          </View>

          {/* Submit Button */}
          <FeedbackTouchable
            style={[
              dynamicStyles.submitButton,
              loading && dynamicStyles.submitButtonDisabled
            ]}
            onPress={handleSubmit}
            disabled={loading}
            loading={loading}
            spinnerColor="#fff"
            replaceWithSpinner={false}
          >
            <Text style={dynamicStyles.submitButtonText}>
              {loading ? 'Submitting...' : 'Submit Feedback'}
            </Text>
          </FeedbackTouchable>

          {/* Additional Help Info */}
          <View style={[dynamicStyles.section, { marginTop: 4 }]}>
            <Text style={[dynamicStyles.label, { marginBottom: 8 }]}>Need More Help?</Text>
            <Text style={dynamicStyles.infoText}>
              • Contact support at support@grabdocs.com{'\n'}
              • Visit our website for more resources{'\n'}
              • Check our documentation and guides
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
      </TapToToggleHeaderView>
    </SafeAreaView>
  );
}
