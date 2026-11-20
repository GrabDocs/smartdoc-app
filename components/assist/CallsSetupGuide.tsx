import * as Clipboard from 'expo-clipboard';
import React, { useState } from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

type ForwardClient = 'iphone' | 'android' | 'carrier';

const FORWARD_STEPS: Record<ForwardClient, { title: string; steps: (capture: string) => string[] }> = {
  iphone: {
    title: 'iPhone',
    steps: (capture) => [
      'Open Settings → Phone → Call Forwarding.',
      'Turn Call Forwarding on.',
      `Enter ${capture} as the forward-to number.`,
      'Save. New calls to your personal number go to GrabDocs, then ring your eSIM.',
    ],
  },
  android: {
    title: 'Android',
    steps: (capture) => [
      'Open the Phone app → ⋮ → Settings → Calling accounts / Calls → Call forwarding.',
      'Choose Always forward (or your carrier’s unconditional forwarding).',
      `Enter ${capture}.`,
      'Confirm. Test by calling your personal number from another phone.',
    ],
  },
  carrier: {
    title: 'Carrier',
    steps: (capture) => [
      'Open your carrier app or account site (AT&T, T-Mobile, Verizon, etc.).',
      'Find Call Forwarding for your personal line.',
      `Set always forward to ${capture}.`,
      'Save. Keep 911 on your normal dialer — Assist is not an emergency service.',
    ],
  },
};

export default function CallsSetupGuide({ captureNumber }: { captureNumber: string | null }) {
  const [client, setClient] = useState<ForwardClient>('iphone');

  if (!captureNumber) {
    return (
      <View style={[styles.card, { backgroundColor: '#FFFBEB', borderColor: '#FDE68A' }]}>
        <Text style={{ color: '#92400E', fontSize: 13 }}>
          Waiting for an admin to assign your GrabDocs capture number. After that, this section shows
          the number to forward to and eSIM setup steps.
        </Text>
      </View>
    );
  }

  const guide = FORWARD_STEPS[client];

  return (
    <View style={{ gap: 10 }}>
      <View style={[styles.card, { backgroundColor: '#F0F9FF', borderColor: '#BAE6FD' }]}>
        <Text style={{ color: '#0C4A6E', fontWeight: '700', fontSize: 13, marginBottom: 4 }}>
          Your GrabDocs capture number
        </Text>
        <Text style={{ color: '#082F49', fontFamily: 'monospace', fontSize: 18, fontWeight: '700' }}>
          {captureNumber}
        </Text>
        <Text style={{ color: '#075985', fontSize: 12, marginTop: 8 }}>
          Forward your personal number to this address. Do not enter this as your eSIM ring number.
        </Text>
        <TouchableOpacity
          style={[styles.btn, { marginTop: 10, marginBottom: 0 }]}
          onPress={async () => {
            await Clipboard.setStringAsync(captureNumber);
            Alert.alert('Copied', captureNumber);
          }}
        >
          <Text style={{ color: '#fff', fontWeight: '700' }}>Copy number</Text>
        </TouchableOpacity>
      </View>

      <View style={[styles.card, { backgroundColor: '#EFF6FF', borderColor: '#BFDBFE' }]}>
        <Text style={{ color: '#1E3A8A', fontWeight: '700', fontSize: 13, marginBottom: 6 }}>
          Ring number = verified phone
        </Text>
        {[
          'Assist rings your account verified phone (managed in Settings).',
          'If you use an eSIM as that line, confirm it rings when dialed.',
          'Change the number only in Settings → Profile → Phone.',
          'Then return here to finish forwarding and Save Calls setup.',
        ].map((step, i) => (
          <Text key={i} style={{ color: '#1E40AF', fontSize: 12, marginBottom: 4 }}>
            {i + 1}. {step}
          </Text>
        ))}
      </View>

      <View style={[styles.card, { backgroundColor: '#EFF6FF', borderColor: '#BFDBFE' }]}>
        <Text style={{ color: '#1E3A8A', fontWeight: '700', fontSize: 13, marginBottom: 8 }}>
          Forward your personal number — {guide.title}
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
          {(['iphone', 'android', 'carrier'] as const).map((c) => {
            const on = client === c;
            return (
              <TouchableOpacity
                key={c}
                onPress={() => setClient(c)}
                style={{
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                  borderRadius: 999,
                  backgroundColor: on ? '#2563EB' : '#DBEAFE',
                }}
              >
                <Text style={{ color: on ? '#fff' : '#1D4ED8', fontSize: 12, fontWeight: '600' }}>
                  {c === 'iphone' ? 'iPhone' : c === 'android' ? 'Android' : 'Carrier'}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
        {guide.steps(captureNumber).map((step, i) => (
          <Text key={i} style={{ color: '#1E40AF', fontSize: 12, marginBottom: 4 }}>
            {i + 1}. {step}
          </Text>
        ))}
        <Text style={{ color: '#1D4ED8', fontSize: 12, marginTop: 8 }}>
          Callers hear: “This call may be recorded by GrabDocs Assist for the account holder.” Hang up
          to decline.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  btn: {
    backgroundColor: '#0284C7',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 8,
  },
  card: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
  },
});
