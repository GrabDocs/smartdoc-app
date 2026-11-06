import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'grabdocs_incoming_ask_wait_v1';

export async function markIncomingAskWait(fileId: number): Promise<void> {
  await AsyncStorage.setItem(KEY, String(fileId));
}

export async function getIncomingAskWaitFileId(): Promise<number | null> {
  const raw = await AsyncStorage.getItem(KEY);
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : null;
}

export async function clearIncomingAskWait(): Promise<void> {
  await AsyncStorage.removeItem(KEY);
}
