import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import AdaptiveListPickerModal from './AdaptiveListPickerModal';
import { useThemeColors } from '../hooks/useThemeColors';
import {
  COUNTRY_PHONE_OPTIONS,
  buildPhoneNumber,
  formatNationalDisplay,
  parsePhoneNumber,
} from '../utils/phoneUtils';

type Props = {
  value: string;
  onChange: (fullPhone: string) => void;
  disabled?: boolean;
  placeholder?: string;
};

/** Phone input with country-code picker; value/onChange use E.164 (e.g. +12404958069). */
export default function PhoneNumberInput({
  value,
  onChange,
  disabled = false,
  placeholder = 'Phone number',
}: Props) {
  const colors = useThemeColors();
  const parsed = useMemo(() => parsePhoneNumber(value), [value]);
  const [countryCode, setCountryCode] = useState(parsed.countryCode);
  const [nationalDigits, setNationalDigits] = useState(parsed.nationalDigits);
  const [showCountryPicker, setShowCountryPicker] = useState(false);

  useEffect(() => {
    // Keep the selected country when the field is still empty (user picks +44 first).
    if (!(value || '').trim()) {
      setNationalDigits('');
      return;
    }
    setCountryCode(parsed.countryCode);
    setNationalDigits(parsed.nationalDigits);
  }, [value, parsed.countryCode, parsed.nationalDigits]);

  const displayNational = formatNationalDisplay(countryCode, nationalDigits);
  const selectedCountry =
    COUNTRY_PHONE_OPTIONS.find((c) => c.code === countryCode) ?? COUNTRY_PHONE_OPTIONS[0];

  const emitChange = (nextCountryCode: string, nextNationalDigits: string) => {
    onChange(buildPhoneNumber(nextCountryCode, nextNationalDigits));
  };

  return (
    <>
      <View style={[styles.row, { borderColor: colors.border }]}>
        <TouchableOpacity
          style={[styles.countryBtn, { borderColor: colors.border, backgroundColor: colors.background }]}
          onPress={() => !disabled && setShowCountryPicker(true)}
          disabled={disabled}
          accessibilityLabel="Country code"
        >
          <Text style={styles.flag}>{selectedCountry.flag}</Text>
          <Text style={[styles.countryCode, { color: colors.text }]}>{countryCode}</Text>
        </TouchableOpacity>
        <TextInput
          style={[styles.phoneInput, { color: colors.text, borderColor: colors.border }]}
          placeholder={placeholder}
          placeholderTextColor={colors.textSecondary}
          value={displayNational}
          onChangeText={(text) => {
            const digits = text.replace(/\D/g, '');
            setNationalDigits(digits);
            emitChange(countryCode, digits);
          }}
          keyboardType="phone-pad"
          editable={!disabled}
          autoComplete="tel"
          textContentType="telephoneNumber"
        />
      </View>

      <AdaptiveListPickerModal
        visible={showCountryPicker}
        onClose={() => setShowCountryPicker(false)}
        title="Country code"
        itemCount={COUNTRY_PHONE_OPTIONS.length}
      >
        {COUNTRY_PHONE_OPTIONS.map((country) => (
          <TouchableOpacity
            key={`${country.code}-${country.name}`}
            style={[styles.countryRow, { borderBottomColor: colors.border }]}
            onPress={() => {
              setCountryCode(country.code);
              emitChange(country.code, nationalDigits);
              setShowCountryPicker(false);
            }}
          >
            <Text style={styles.flag}>{country.flag}</Text>
            <Text style={[styles.countryName, { color: colors.text }]}>{country.name}</Text>
            <Text style={[styles.countryCode, { color: colors.textSecondary }]}>{country.code}</Text>
          </TouchableOpacity>
        ))}
      </AdaptiveListPickerModal>
    </>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderWidth: 1,
    borderRadius: 8,
    overflow: 'hidden',
  },
  countryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 12,
    borderRightWidth: StyleSheet.hairlineWidth,
    gap: 4,
  },
  flag: { fontSize: 18 },
  countryCode: { fontSize: 14, fontWeight: '500' },
  phoneInput: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 16,
  },
  countryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  countryName: { flex: 1, fontSize: 16 },
});
