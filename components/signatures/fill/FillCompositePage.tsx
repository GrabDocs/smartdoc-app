import React, { forwardRef } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import type { WizardField } from '../../../types/signature';
import { fieldToPixelRect } from '../../../utils/fillable';
import { dateFieldDisplayText, fieldImageUri, fieldValueForWizardField, isSignFieldType } from '../../../utils/signatureRuntime';

interface Props {
  pageImageUrl: string;
  pageWidth: number;
  pageHeight: number;
  fields: WizardField[];
  fieldValues: Record<string, unknown>;
}

const FillCompositePage = forwardRef<View, Props>(function FillCompositePage(
  { pageImageUrl, pageWidth, pageHeight, fields, fieldValues },
  ref,
) {
  return (
    <View
      ref={ref}
      collapsable={false}
      style={{ width: pageWidth, height: pageHeight, backgroundColor: '#ffffff' }}
    >
      <Image
        source={{ uri: pageImageUrl }}
        style={{ width: pageWidth, height: pageHeight, position: 'absolute', left: 0, top: 0 }}
        resizeMode="stretch"
      />
      {fields.map((field) => {
        if (field.deleted) return null;
        if (field.x == null || field.y == null || field.w == null || field.h == null) return null;
        const rect = fieldToPixelRect(
          { x: field.x, y: field.y, w: field.w, h: field.h },
          pageWidth,
          pageHeight,
        );
        const val = fieldValueForWizardField(field, fieldValues);
        const fontSize = Math.max(10, Math.min(rect.height * 0.55, 28));

        if (isSignFieldType(field.type)) {
          const uri = fieldImageUri(val);
          if (!uri) return null;
          return (
            <Image
              key={field.id}
              source={{ uri }}
              style={{
                position: 'absolute',
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
                backgroundColor: 'transparent',
              }}
              resizeMode="contain"
            />
          );
        }

        if (field.type === 'checkbox') {
          const checked = Boolean(val);
          return (
            <View
              key={field.id}
              style={[
                styles.checkboxBox,
                {
                  left: rect.left,
                  top: rect.top,
                  width: rect.width,
                  height: rect.height,
                  borderColor: checked ? '#2563eb' : '#b8bec4',
                  backgroundColor: checked ? '#dbeafe' : '#ffffff',
                },
              ]}
            >
              {checked ? (
                <Text style={{ fontSize: Math.max(fontSize, 12), color: '#2563eb', fontWeight: '700' }}>✓</Text>
              ) : null}
            </View>
          );
        }

        if (field.type === 'text' || field.type === 'date') {
          const text =
            field.type === 'date'
              ? dateFieldDisplayText(val)
              : typeof val === 'string'
                ? val.trim()
                : '';
          if (!text) return null;
          return (
            <View
              key={field.id}
              style={[
                styles.textBox,
                {
                  left: rect.left,
                  top: rect.top,
                  width: rect.width,
                  height: rect.height,
                },
              ]}
            >
              <Text style={{ fontSize, color: '#111' }} numberOfLines={4}>
                {text}
              </Text>
            </View>
          );
        }

        return null;
      })}
    </View>
  );
});

export default FillCompositePage;

const styles = StyleSheet.create({
  textBox: {
    position: 'absolute',
    justifyContent: 'center',
    paddingHorizontal: 2,
    overflow: 'hidden',
  },
  checkboxBox: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderRadius: 3,
  },
});
