import React from 'react';
import { StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';
import PhoneNumberInput from '../PhoneNumberInput';
import { useThemeColors } from '../../hooks/useThemeColors';
import type { RecipientInput } from '../../types/signature';

interface Props {
  recipients: RecipientInput[];
  onChange: (recipients: RecipientInput[]) => void;
}

export default function RecipientEditor({ recipients, onChange }: Props) {
  const colors = useThemeColors();

  const update = (index: number, patch: Partial<RecipientInput>) => {
    const next = recipients.map((r, i) => (i === index ? { ...r, ...patch } : r));
    onChange(next);
  };

  const addSigner = () => {
    onChange([
      ...recipients,
      {
        email: '',
        name: '',
        role: 'signer',
        order_index: recipients.filter((r) => r.role === 'signer').length,
      },
    ]);
  };

  const addCc = () => {
    onChange([...recipients, { email: '', name: '', role: 'cc', order_index: 999 }]);
  };

  const remove = (index: number) => {
    onChange(recipients.filter((_, i) => i !== index));
  };

  return (
    <View>
      {recipients.map((r, i) => (
        <View key={i} style={[styles.row, { borderColor: colors.border }]}>
          <Text style={[styles.role, { color: colors.textSecondary }]}>
            {r.role === 'cc' ? 'CC' : `Signer ${(r.order_index ?? 0) + 1}`}
          </Text>
          <TextInput
            style={[styles.input, { color: colors.text, borderColor: colors.border }]}
            placeholder="Email"
            placeholderTextColor={colors.textSecondary}
            value={r.email}
            onChangeText={(email) => update(i, { email })}
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
            textContentType="emailAddress"
            importantForAutofill="yes"
          />
          <TextInput
            style={[styles.input, { color: colors.text, borderColor: colors.border }]}
            placeholder="Name (optional)"
            placeholderTextColor={colors.textSecondary}
            value={r.name ?? ''}
            onChangeText={(name) => update(i, { name })}
            autoComplete="name"
            textContentType="name"
            importantForAutofill="yes"
          />
          {r.role === 'signer' ? (
            <>
              <View style={styles.switchRow}>
                <Text style={{ color: colors.text, flex: 1 }}>Require phone verification</Text>
                <Switch
                  value={Boolean(r.phone_verification_required)}
                  onValueChange={(phone_verification_required) =>
                    update(i, {
                      phone_verification_required,
                      ...(phone_verification_required ? {} : { phone_number: undefined }),
                    })
                  }
                />
              </View>
              {r.phone_verification_required ? (
                <View style={styles.phoneInputWrap}>
                  <PhoneNumberInput
                    value={r.phone_number ?? ''}
                    onChange={(phone_number) => update(i, { phone_number })}
                    placeholder="Phone number"
                  />
                </View>
              ) : null}
            </>
          ) : null}
          <TouchableOpacity onPress={() => remove(i)}>
            <Text style={{ color: '#dc2626' }}>Remove</Text>
          </TouchableOpacity>
        </View>
      ))}
      <View style={styles.addRow}>
        <TouchableOpacity style={[styles.addBtn, { borderColor: colors.primary }]} onPress={addSigner}>
          <Text style={{ color: colors.primary }}>+ Signer</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.addBtn, { borderColor: colors.border }]} onPress={addCc}>
          <Text style={{ color: colors.textSecondary }}>+ CC</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { marginBottom: 16, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  role: { fontSize: 12, fontWeight: '600', marginBottom: 8, textTransform: 'uppercase' },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 8,
    fontSize: 16,
  },
  phoneInputWrap: {
    marginBottom: 8,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
    gap: 8,
  },
  addRow: { flexDirection: 'row', gap: 12, marginTop: 8 },
  addBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
  },
});
