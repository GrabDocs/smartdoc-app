import React, { useEffect, useMemo, useState } from 'react';
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useThemeColors } from '../../hooks/useThemeColors';
import { useAuth } from '../context/auth';
import { apiService } from '../../services/api';
import {
  FALLBACK_REGISTRY,
  normalizeAppRegistry,
  type AppFeatureFromApi,
} from '../../utils/visibleApps';
import { writeVisibleAppsSetupLocal } from '../../utils/visibleAppsSetupLocal';

const CONSENT_TEXT =
  "I confirm I have the necessary rights and permissions to upload others' information to GrabDocs.";

interface DataRightsConsentScreenProps {
  userId?: string | number | null;
  needsConsent?: boolean;
  needsAppsSetup?: boolean;
  registry?: AppFeatureFromApi[];
  hiddenApps?: Record<string, boolean>;
  onAccepted: (hiddenApps?: Record<string, boolean>) => void;
}

function initialEnabled(
  registry: AppFeatureFromApi[],
  hiddenApps: Record<string, boolean>,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const app of registry) {
    if (app.system) {
      out[app.key] = true;
      continue;
    }
    out[app.key] = !hiddenApps[app.key];
  }
  return out;
}

export default function DataRightsConsentScreen({
  userId,
  needsConsent = false,
  needsAppsSetup = true,
  registry,
  hiddenApps = {},
  onAccepted,
}: DataRightsConsentScreenProps) {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const { signOut } = useAuth();
  const apps = useMemo(
    () => normalizeAppRegistry(registry?.length ? registry : FALLBACK_REGISTRY),
    [registry],
  );
  const [consentChecked, setConsentChecked] = useState(!needsConsent);
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() =>
    initialEnabled(apps, hiddenApps),
  );
  const [saving, setSaving] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setConsentChecked(!needsConsent);
    setEnabled(initialEnabled(apps, hiddenApps));
  }, [needsConsent, apps, hiddenApps]);

  const alwaysOn = apps.filter((a) => a.system);
  const optional = apps.filter((a) => !a.system);

  const handleContinue = async () => {
    if (needsConsent && !consentChecked) {
      setError('Please confirm you have the necessary rights and permissions to upload others\' information.');
      return;
    }
    try {
      setError('');
      setSaving(true);
      const enabledApps = Object.entries(enabled)
        .filter(([key, on]) => on && !apps.find((a) => a.key === key)?.system)
        .map(([key]) => key);
      const res = await apiService.completeWelcomeSetup({
        dataRightsConsent: needsConsent ? true : undefined,
        enabledApps,
      });
      if ((res as any)?.success === false) {
        setError((res as any)?.message || 'Failed to save');
        return;
      }
      if (userId != null) await writeVisibleAppsSetupLocal(userId);
      onAccepted((res as any)?.hiddenApps ?? (res as any)?.hidden_apps);
    } catch (err: any) {
      setError(err?.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleLogOut = async () => {
    if (saving || loggingOut) return;
    try {
      setLoggingOut(true);
      setError('');
      await signOut();
    } catch (err: any) {
      setError(err?.message || 'Could not log out');
      setLoggingOut(false);
    }
  };

  const renderRow = (app: AppFeatureFromApi, locked: boolean) => {
    const checked = locked ? true : !!enabled[app.key];
    return (
      <Pressable
        key={app.key}
        style={styles.appRow}
        onPress={() => {
          if (locked) return;
          setEnabled((prev) => ({ ...prev, [app.key]: !prev[app.key] }));
        }}
        accessibilityRole="checkbox"
        accessibilityState={{ checked, disabled: locked }}
      >
        <View
          style={[
            styles.checkbox,
            { borderColor: '#007AFF' },
            checked && styles.checkboxChecked,
            locked && styles.checkboxLocked,
          ]}
        />
        <View style={{ flex: 1 }}>
          <Text style={[styles.appName, { color: colors.text }]}>{app.name}</Text>
          {app.description ? (
            <Text style={[styles.appDesc, { color: colors.text }]}>{app.description}</Text>
          ) : null}
          {locked ? (
            <Text style={[styles.appDesc, { color: colors.text, opacity: 0.55 }]}>Always on</Text>
          ) : null}
        </View>
      </Pressable>
    );
  };

  return (
    <View style={[StyleSheet.absoluteFill, styles.container, { backgroundColor: colors.background }]}>
      <ScrollView
        contentContainerStyle={[
          styles.card,
          { paddingTop: insets.top + 32, paddingBottom: insets.bottom + 32 },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={[styles.title, { color: colors.text }]}>Welcome to GrabDocs</Text>
        {needsConsent ? (
          <>
            <Text style={[styles.subtitle, { color: colors.text }]}>
              Before you continue, please confirm:
            </Text>
            <Pressable
              style={styles.consentRow}
              onPress={() => setConsentChecked((v) => !v)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: consentChecked }}
            >
              <View
                style={[
                  styles.checkbox,
                  { borderColor: '#007AFF' },
                  consentChecked && styles.checkboxChecked,
                ]}
              />
              <Text style={[styles.consentText, { color: colors.text }]}>{CONSENT_TEXT}</Text>
            </Pressable>
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
          </>
        ) : null}

        {needsAppsSetup ? (
          <>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>
              Choose the features you want to see
            </Text>
            <Text style={[styles.hint, { color: colors.text }]}>
              You can add or remove features later in Settings → Choose your apps.
            </Text>
            {alwaysOn.map((app) => renderRow(app, true))}
            {optional.map((app) => renderRow(app, false))}
          </>
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TouchableOpacity
          style={[styles.button, (saving || loggingOut) && styles.buttonDisabled]}
          onPress={handleContinue}
          disabled={saving || loggingOut}
          activeOpacity={0.8}
        >
          <Text style={styles.buttonText}>{saving ? 'Saving...' : 'Continue'}</Text>
        </TouchableOpacity>
        {needsConsent ? (
          <TouchableOpacity
            style={styles.logoutButton}
            onPress={() => void handleLogOut()}
            disabled={saving || loggingOut}
            activeOpacity={0.8}
          >
            <Text style={[styles.logoutText, { color: colors.text }]}>
              {loggingOut ? 'Logging out...' : 'Log out'}
            </Text>
          </TouchableOpacity>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    zIndex: 9998,
  },
  card: {
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
    marginBottom: 16,
    opacity: 0.85,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginTop: 8,
    marginBottom: 4,
  },
  hint: {
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 12,
    opacity: 0.75,
  },
  consentRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 16,
  },
  appRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 10,
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
  checkboxLocked: {
    opacity: 0.7,
  },
  consentText: {
    flex: 1,
    fontSize: 15,
    lineHeight: 22,
  },
  appName: {
    fontSize: 15,
    fontWeight: '600',
  },
  appDesc: {
    fontSize: 13,
    lineHeight: 18,
    marginTop: 2,
    opacity: 0.75,
  },
  error: {
    color: '#dc2626',
    fontSize: 14,
    marginBottom: 12,
  },
  legal: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 16,
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
    marginTop: 8,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  logoutButton: {
    marginTop: 14,
    paddingVertical: 10,
    alignItems: 'center',
  },
  logoutText: {
    fontSize: 15,
    fontWeight: '600',
    opacity: 0.8,
  },
});
