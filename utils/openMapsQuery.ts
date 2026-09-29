import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';
import { ActionSheetIOS, Alert, Platform, ToastAndroid } from 'react-native';

async function openUrlAttempt(url: string): Promise<boolean> {
  try {
    await Linking.openURL(url);
    return true;
  } catch {
    return false;
  }
}

function notifyCopied(): void {
  if (Platform.OS === 'android') {
    ToastAndroid.show('Address copied', ToastAndroid.SHORT);
  } else {
    Alert.alert('Copied', 'Address copied to clipboard.');
  }
}

async function copyAddress(label: string): Promise<void> {
  try {
    await Clipboard.setStringAsync(label);
    notifyCopied();
  } catch {
    Alert.alert('Copy', 'Could not copy this address.');
  }
}

async function openGoogleMaps(encodedQuery: string): Promise<void> {
  const order = [
    `comgooglemaps://?q=${encodedQuery}`,
    `https://www.google.com/maps/search/?api=1&query=${encodedQuery}`,
  ];
  for (const url of order) {
    if (await openUrlAttempt(url)) return;
  }
  Alert.alert('Maps', 'Could not open Google Maps.');
}

async function openAppleMaps(encodedQuery: string): Promise<void> {
  const order = [
    `maps://maps.apple.com/?q=${encodedQuery}`,
    `https://maps.apple.com/?q=${encodedQuery}`,
  ];
  for (const url of order) {
    if (await openUrlAttempt(url)) return;
  }
  Alert.alert('Maps', 'Could not open Apple Maps.');
}

async function openAndroidGeo(encodedQuery: string): Promise<void> {
  if (await openUrlAttempt(`geo:0,0?q=${encodedQuery}`)) return;
  // Fallback when no geo handler is installed
  await openGoogleMaps(encodedQuery);
}

/**
 * Show map-app choices (and Copy) for a location label instead of auto-opening
 * a single default maps handler.
 */
export async function openMapsForLocationLabel(label: string): Promise<void> {
  const raw = label.trim();
  if (!raw) return;

  if (/^https?:\/\//i.test(raw)) {
    try {
      await Linking.openURL(raw);
    } catch {
      Alert.alert('Maps', 'Could not open this link.');
    }
    return;
  }

  const encodedQuery = encodeURIComponent(raw);

  const runChoice = (choice: 'apple' | 'google' | 'geo' | 'copy') => {
    if (choice === 'copy') {
      void copyAddress(raw);
      return;
    }
    if (choice === 'apple') {
      void openAppleMaps(encodedQuery);
      return;
    }
    if (choice === 'google') {
      void openGoogleMaps(encodedQuery);
      return;
    }
    void openAndroidGeo(encodedQuery);
  };

  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: raw,
        options: ['Open in Apple Maps', 'Open in Google Maps', 'Copy Address', 'Cancel'],
        cancelButtonIndex: 3,
      },
      (buttonIndex) => {
        if (buttonIndex === 0) runChoice('apple');
        else if (buttonIndex === 1) runChoice('google');
        else if (buttonIndex === 2) runChoice('copy');
      }
    );
    return;
  }

  Alert.alert(raw, 'Choose how to open this address', [
    { text: 'Open in Google Maps', onPress: () => runChoice('google') },
    { text: 'Open in Maps', onPress: () => runChoice('geo') },
    { text: 'Copy Address', onPress: () => runChoice('copy') },
    { text: 'Cancel', style: 'cancel' },
  ]);
}
