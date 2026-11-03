import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';

/** Deep-link entry: open Ask as a side panel on Assist. */
export default function AssistAskScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ owner_user_id?: string }>();

  useEffect(() => {
    router.replace({
      pathname: '/assist',
      params: {
        ask: '1',
        ...(params.owner_user_id ? { owner_user_id: String(params.owner_user_id) } : {}),
      },
    } as any);
  }, []);

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator color="#0284C7" />
    </View>
  );
}
