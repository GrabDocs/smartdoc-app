import React, { useState } from 'react';
import {
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useThemeColors } from '../../hooks/useThemeColors';
import { apiService } from '../../services/api';

const CONSENT_TEXT =
  "I confirm I have the necessary rights and permissions to upload others' information to GrabDocs.";

interface DataRightsConsentScreenProps {
  onAccepted: () => void;
}

export default function DataRightsConsentScreen({ onAccepted }: DataRightsConsentScreenProps) {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleContinue = async () => {
    if (!checked) {
      setError('Please confirm you have the necessary rights and permissions to upload others\' information.');
      return;
    }
    try {
      setError('');
      setSaving(true);
      const res = await apiService.acceptDataRightsConsent();
      if ((res as any)?.success === false) {
        setError((res as any)?.message || 'Failed to save confirmation');
        return;
      }
      onAccepted();
    } catch (err: any) {
      setError(err?.message || 'Failed to save confirmation');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={[StyleSheet.absoluteFill, styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.card, { paddingTop: insets.top + 48, paddingBottom: insets.bottom + 32 }]}>
        <Text style={[styles.title, { color: colors.text }]}>Welcome to GrabDocs</Text>
        <Text style={[styles.subtitle, { color: colors.text }]}>
          Before you continue, please confirm:
        </Text>

        <Pressable
          style={styles.consentRow}
          onPress={() => setChecked((v) => !v)}
          accessibilityRole="checkbox"
          accessibilityState={{ checked }}
        >
          <View
            style={[
              styles.checkbox,
              { borderColor: '#007AFF' },
              checked && styles.checkboxChecked,
            ]}
          />
          <Text style={[styles.consentText, { color: colors.text }]}>{CONSENT_TEXT}</Text>
        </Pressable>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Text style={[styles.legal, { color: colors.text }]}>
          By continuing, you agree to our{' '}
          <Text
            style={styles.link}
            onPress={() => Linking.openURL('https://grabdocs.com/terms-of-service')}
          >
            Terms of Service
          </Text>
          {' '}and{' '}
          <Text
            style={styles.link}
            onPress={() => Linking.openURL('https://grabdocs.com/privacy-policy')}
          >
            Privacy Policy
          </Text>
          .
        </Text>

        <TouchableOpacity
          style={[styles.button, saving && styles.buttonDisabled]}
          onPress={handleContinue}
          disabled={saving}
          activeOpacity={0.8}
        >
          <Text style={styles.buttonText}>{saving ? 'Saving...' : 'Continue'}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    zIndex: 9998,
  },
  card: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 20,
    opacity: 0.85,
  },
  consentRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 16,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderWidth: 2,
    borderRadius: 4,
    marginRight: 12,
    marginTop: 2,
  },
  checkboxChecked: {
    backgroundColor: '#007AFF',
  },
  consentText: {
    flex: 1,
    fontSize: 15,
    lineHeight: 22,
  },
  error: {
    color: '#dc2626',
    fontSize: 14,
    marginBottom: 12,
  },
  legal: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 24,
    opacity: 0.8,
  },
  link: {
    color: '#007AFF',
    fontWeight: '600',
  },
  button: {
    backgroundColor: '#007AFF',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
});
