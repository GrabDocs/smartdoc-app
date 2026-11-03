import { useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import AppBackButton from '../../components/AppBackButton';
import AppHeaderTitle from '../../components/AppHeaderTitle';
import { useThemeColors } from '../../hooks/useThemeColors';
import { listAssistPeople } from '../../services/assistApi';

export default function AssistPeopleScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const [members, setMembers] = useState<any[]>([]);
  const [shared, setShared] = useState<any[]>([]);
  const [workspaceId, setWorkspaceId] = useState<number | null>(null);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await listAssistPeople();
      setMembers(res?.members || []);
      setShared(res?.accounts_i_can_view || []);
      setWorkspaceId(res?.workspace_id || null);
      setMessage(res?.message || '');
    } catch {
      /* ignore */
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['top']}>
      <View style={styles.header}>
        <AppBackButton />
        <AppHeaderTitle title="People" />
        <View style={{ width: 40 }} />
      </View>
      <View style={{ padding: 16 }}>
        <Text style={{ color: colors.textSecondary, marginBottom: 8 }}>
          {message ||
            'Invite helpers with the standard workspace invite for your Assist workspace. Only invited people can see Assist data.'}
        </Text>
        {workspaceId ? (
          <TouchableOpacity
            style={styles.btn}
            onPress={() => router.push(`/workspaces` as any)}
          >
            <Text style={{ color: '#fff', fontWeight: '700' }}>Open workspace members</Text>
          </TouchableOpacity>
        ) : (
          <Text style={{ color: colors.textSecondary }}>Finish Assist setup to create the Assist workspace.</Text>
        )}
      </View>
      <FlatList
        data={members}
        keyExtractor={(item) => String(item.user_id)}
        contentContainerStyle={{ paddingHorizontal: 16 }}
        ListHeaderComponent={
          <Text style={[styles.section, { color: colors.text }]}>People on your Assist workspace</Text>
        }
        renderItem={({ item }) => (
          <View style={[styles.card, { borderColor: colors.border }]}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.text, fontWeight: '600' }}>
                {item.email || item.username || `User #${item.user_id}`}
              </Text>
              <Text style={{ color: colors.textSecondary, fontSize: 12 }}>{item.role}</Text>
            </View>
          </View>
        )}
        ListFooterComponent={
          <View style={{ marginTop: 24 }}>
            <Text style={[styles.section, { color: colors.text }]}>Accounts I can view</Text>
            {shared.length === 0 ? (
              <Text style={{ color: colors.textSecondary }}>None yet.</Text>
            ) : (
              shared.map((h) => (
                <TouchableOpacity
                  key={`${h.owner_user_id}-${h.workspace_id}`}
                  onPress={() =>
                    router.push({
                      pathname: '/assist',
                      params: { owner_user_id: String(h.owner_user_id) },
                    } as any)
                  }
                >
                  <Text style={{ color: '#0284C7', marginBottom: 8, fontWeight: '600' }}>
                    {h.owner_email || `Owner #${h.owner_user_id}`} · {h.role}
                  </Text>
                </TouchableOpacity>
              ))
            )}
          </View>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  btn: { backgroundColor: '#0284C7', paddingHorizontal: 14, paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
  section: { fontWeight: '700', marginBottom: 8 },
  card: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
});
