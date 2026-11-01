import AsyncStorage from '@react-native-async-storage/async-storage';
import { VISIBLE_APPS_SETUP_VERSION } from './visibleApps';

export function visibleAppsSetupLocalKey(userId: string | number): string {
  return `grabdocs_visible_apps_setup_${VISIBLE_APPS_SETUP_VERSION}:${userId}`;
}

export async function readVisibleAppsSetupLocal(userId: string | number): Promise<boolean> {
  try {
    const v = await AsyncStorage.getItem(visibleAppsSetupLocalKey(userId));
    return v === '1';
  } catch {
    return false;
  }
}

export async function writeVisibleAppsSetupLocal(userId: string | number): Promise<void> {
  try {
    await AsyncStorage.setItem(visibleAppsSetupLocalKey(userId), '1');
  } catch {
    /* ignore */
  }
}
