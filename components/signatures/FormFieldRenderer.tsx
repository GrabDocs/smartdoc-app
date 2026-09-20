import React from 'react';
import { ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useThemeColors } from '../../hooks/useThemeColors';
import type { RuntimeDocument } from '../../types/signature';
import { hasFieldSignature, isDateFieldType, isFieldEditable, isSignFieldType, dateFieldDisplayText } from '../../utils/signatureRuntime';

interface Props {
  document: RuntimeDocument;
  fieldValues: Record<string, unknown>;
  editableKeys: ReadonlySet<string>;
  onFieldPress: (fieldKey: string, fieldType: string) => void;
  onTextChange: (fieldKey: string, text: string) => void;
  onCheckboxToggle: (fieldKey: string, checked: boolean) => void;
}

export default function FormFieldRenderer({
  document,
  fieldValues,
  editableKeys,
  onFieldPress,
  onTextChange,
  onCheckboxToggle,
}: Props) {
  const colors = useThemeColors();

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <Text style={[styles.docTitle, { color: colors.text }]}>{document.title}</Text>
      {document.fields.map((f) => {
        const editable = isFieldEditable(editableKeys, f.key);
        const val = fieldValues[f.key];
        return (
          <View key={f.key} style={[styles.fieldRow, { borderColor: colors.border }]}>
            <Text style={[styles.label, { color: colors.text }]}>
              {f.label}
              {f.required ? ' *' : ''}
            </Text>
            {f.type === 'checkbox' ? (
              <Switch
                value={Boolean(val)}
                onValueChange={(v) => onCheckboxToggle(f.key, v)}
                disabled={!editable}
                trackColor={{ false: colors.switchTrackOff, true: colors.switchTrackOn }}
                thumbColor={colors.switchThumbAndroid(Boolean(val))}
                ios_backgroundColor={colors.switchTrackOff}
              />
            ) : isSignFieldType(f.type) ? (
              <Text
                style={{ color: colors.primary }}
                onPress={() => editable && onFieldPress(f.key, f.type)}
              >
                {hasFieldSignature(val)
                  ? 'Signed ✓'
                  : editable
                    ? 'Tap to sign'
                    : '—'}
              </Text>
            ) : isDateFieldType(f.type) ? (
              <Text style={[styles.dateValue, { color: colors.text }]}>
                {dateFieldDisplayText(val) || '—'}
              </Text>
            ) : (
              <TextInput
                style={[styles.input, { color: colors.text, borderColor: colors.border }]}
                editable={editable}
                value={typeof val === 'string' ? val : ''}
                onChangeText={(t) => onTextChange(f.key, t)}
                placeholder={f.label}
                placeholderTextColor={colors.textSecondary}
                autoComplete="name"
                textContentType="name"
                importantForAutofill="yes"
              />
            )}
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { padding: 14, paddingBottom: 40 },
  docTitle: { fontSize: 18, fontWeight: '600', marginBottom: 16 },
  fieldRow: { marginBottom: 16, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  label: { fontSize: 14, fontWeight: '500', marginBottom: 8 },
  input: { borderWidth: 1, borderRadius: 8, padding: 10, fontSize: 16 },
  dateValue: { fontSize: 16, paddingVertical: 8 },
});
