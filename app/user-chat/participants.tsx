import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLimitError } from '../../contexts/LimitErrorContext';
import { useThemeColors } from '../../hooks/useThemeColors';
import { apiService as api } from '../../services/api';
import { extractLimitErrorData, limitErrorFromCaught } from '../../utils/limitErrorUtils';
import { getReachParticipantDisplayName } from '../../utils/reachDisplayName';
import { useAuth } from '../context/auth';

import AppBackButton, { APP_BACK_BUTTON_SLOT } from '../../components/AppBackButton';
import AppHeaderTitle from '../../components/AppHeaderTitle';

interface ChatParticipant {
  id: number;
  username: string;
  email: string;
}

export default function ChatParticipantsScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const colors = useThemeColors();
  const { showLimitError } = useLimitError();
  const { user } = useAuth();
  
  const chatId = params.chatId ? Number(params.chatId) : null;
  const [participants, setParticipants] = useState<ChatParticipant[]>([]);
  const [filteredParticipants, setFilteredParticipants] = useState<ChatParticipant[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [creatingMeeting, setCreatingMeeting] = useState(false);

  useEffect(() => {
    if (chatId) {
      loadParticipants();
    }
  }, [chatId]);

  useEffect(() => {
    if (searchQuery.trim() === '') {
      setFilteredParticipants(participants);
    } else {
      const query = searchQuery.toLowerCase();
      const filtered = participants.filter(
        (p) =>
          p.username.toLowerCase().includes(query) ||
          p.email.toLowerCase().includes(query)
      );
      setFilteredParticipants(filtered);
    }
  }, [searchQuery, participants]);

  const loadParticipants = async () => {
    if (!chatId) return;
    
    try {
      setLoading(true);
      // Load chat details to get participants
      // Try to get chat from the chats list first
      const chatsResponse = await api.getChats();
      
      console.log('📋 Chats response:', JSON.stringify(chatsResponse, null, 2));
      
      if (chatsResponse.success && chatsResponse.chats) {
        const chat = chatsResponse.chats.find((c: any) => c.id === chatId);
        console.log('📋 Found chat:', JSON.stringify(chat, null, 2));
        
        if (chat && chat.participants) {
          // Normalize participant data structure
          // Participants have nested user object: { user: { username, email, ... } }
          const normalizedParticipants = chat.participants.map((p: any) => {
            const user = p.user || p;
            const username = user.username || 
                           (user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : null) ||
                           user.name || 
                           user.display_name || 
                           user.email?.split('@')[0] || 
                           'User';
            const email = user.email || user.email_address || '';
            
            return {
              id: user.id || p.user_id || p.id,
              username: username,
              email: email,
            };
          });
          
          console.log('📋 Normalized participants:', JSON.stringify(normalizedParticipants, null, 2));
          
          setParticipants(normalizedParticipants);
          setFilteredParticipants(normalizedParticipants);
          setLoading(false);
          return;
        }
      }
      
      // Fallback: try to get from messages endpoint
      const response = await api.getChatMessages(chatId);
      console.log('📋 Messages response:', JSON.stringify(response, null, 2));
      
      if (response.success && response.data) {
        // Extract participants from chat data
        const chatData = response.data.chat || response.data;
        const participantsList = chatData.participants || [];
        
        // Normalize participant data structure
        // Participants have nested user object: { user: { username, email, ... } }
        const normalizedParticipants = participantsList.map((p: any) => {
          const user = p.user || p;
          const username = user.username || 
                         (user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : null) ||
                         user.name || 
                         user.display_name || 
                         user.email?.split('@')[0] || 
                         'User';
          const email = user.email || user.email_address || '';
          
          return {
            id: user.id || p.user_id || p.id,
            username: username,
            email: email,
          };
        });
        
        console.log('📋 Normalized participants from messages:', JSON.stringify(normalizedParticipants, null, 2));
        
        setParticipants(normalizedParticipants);
        setFilteredParticipants(normalizedParticipants);
      } else {
        Alert.alert('Error', 'Failed to load participants');
      }
    } catch (error: any) {
      console.error('Failed to load participants:', error);
      Alert.alert('Error', error.message || 'Failed to load participants');
    } finally {
      setLoading(false);
    }
  };

  const startMeeting = async () => {
    if (participants.length === 0) {
      Alert.alert('Error', 'No participants to start a meeting with');
      return;
    }

    try {
      setCreatingMeeting(true);

      const participantNames = participants
        .map((p) => p.username)
        .slice(0, 3)
        .join(', ');
      const meetingTitle = participants.length > 3
        ? `${participantNames} and ${participants.length - 3} more`
        : participantNames;

      const meetingPayload = {
        title: meetingTitle,
        roomName: meetingTitle,
        room_name: meetingTitle,
        name: meetingTitle,
        description: `Meeting with ${participants.length} participant${participants.length !== 1 ? 's' : ''}`,
        participants: participants.map((p) => p.id),
        participant_count: participants.length,
        isPrivate: false,
      };

      console.log('📱 Creating meeting from chat participants:', meetingPayload);

      const response = await api.client.post('/api/v1/mobile/meetings/create', meetingPayload);

      if (response.data.success) {
        const meetingData = response.data.data || response.data.room || response.data;
        const meetingId =
          meetingData?.meetingId ||
          meetingData?.meeting_id ||
          meetingData?.id;
        const titleResolved =
          meetingData?.title ||
          meetingData?.name ||
          meetingData?.roomName ||
          meetingData?.room_name ||
          meetingTitle;

        if (!meetingId) {
          Alert.alert(
            'Warning',
            'Meeting was created but we could not open the call automatically. Join it from your meetings list.',
            [{ text: 'OK' }]
          );
          return;
        }

        const q = new URLSearchParams({
          meetingId: String(meetingId),
          title: String(titleResolved),
          userName: getReachParticipantDisplayName(user),
        });
        router.push(`/quick-reach/hms-meeting-interface?${q.toString()}` as any);
      } else {
        const limitData = extractLimitErrorData(response.data);
        if (limitData) showLimitError(limitData);
        else Alert.alert('Error', response.data.message || 'Failed to create meeting');
      }
    } catch (error: any) {
      console.error('Failed to create meeting:', error);
      if (error.response?.status === 409) {
        const activeMeeting =
          error.response?.data?.active_meeting || error.response?.data?.activeMeeting;
        const conflictMeetingId = String(
          activeMeeting?.meeting_id || activeMeeting?.meetingId || activeMeeting?.id || ''
        ).trim();
        const conflictName = activeMeeting?.name || 'Unknown';
        Alert.alert(
          'Active Meeting Exists',
          `You already have an active meeting: "${conflictName}". Join it now?`,
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Join Meeting',
              onPress: () => {
                if (!conflictMeetingId) {
                  Alert.alert('Error', 'Could not read the active meeting ID.');
                  return;
                }
                const q = new URLSearchParams({
                  meetingId: conflictMeetingId,
                  title: String(conflictName),
                  userName: getReachParticipantDisplayName(user),
                });
                router.push(`/quick-reach/hms-meeting-interface?${q.toString()}` as any);
              },
            },
          ]
        );
      } else {
        const limitData = limitErrorFromCaught(error);
        if (limitData) showLimitError(limitData);
        else Alert.alert(
          'Error',
          error.response?.data?.message || error.message || 'Failed to create meeting'
        );
      }
    } finally {
      setCreatingMeeting(false);
    }
  };

  const renderParticipant = ({ item }: { item: ChatParticipant }) => {
    const username = item.username || item.email?.split('@')[0] || 'User';
    const initials = username
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);

    return (
      <View style={[styles.participantItem, { borderBottomColor: colors.border }]}>
        <View style={[styles.avatar, { backgroundColor: `${colors.primary}20` }]}>
          <Text style={[styles.avatarText, { color: colors.primary }]}>
            {initials}
          </Text>
        </View>
        <View style={styles.participantInfo}>
          <Text style={[styles.participantName, { color: colors.text }]}>
            {username}
          </Text>
          <Text style={[styles.participantEmail, { color: colors.textSecondary }]}>
            {item.email || 'No email'}
          </Text>
        </View>
      </View>
    );
  };

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={[styles.header, { backgroundColor: colors.headerBackground }]}>
          <AppBackButton />
          <AppHeaderTitle>Participants</AppHeaderTitle>
          <View style={{ width: APP_BACK_BUTTON_SLOT }} />
        </View>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { borderBottomColor: colors.border, backgroundColor: colors.headerBackground }]}>
        <AppBackButton />
        <AppHeaderTitle>Participants</AppHeaderTitle>
        <View style={{ width: APP_BACK_BUTTON_SLOT }} />
      </View>

      {/* Search Bar */}
      <View style={[styles.searchContainer, { backgroundColor: colors.card }]}>
        <Ionicons name="search" size={20} color={colors.textSecondary} style={styles.searchIcon} />
        <TextInput
          style={[styles.searchInput, { color: colors.text }]}
          placeholder="Search participants..."
          placeholderTextColor={colors.textSecondary}
          value={searchQuery}
          onChangeText={setSearchQuery}
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity onPress={() => setSearchQuery('')}>
            <Ionicons name="close-circle" size={20} color={colors.textSecondary} />
          </TouchableOpacity>
        )}
      </View>

      {/* Participants List */}
      <FlatList
        data={filteredParticipants}
        renderItem={renderParticipant}
        keyExtractor={(item) => item.id.toString()}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Ionicons name="people-outline" size={64} color={colors.textSecondary} />
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
              {searchQuery ? 'No participants found' : 'No participants'}
            </Text>
          </View>
        }
      />

      {/* Start Meeting Button */}
      {participants.length > 0 && (
        <View style={[styles.footer, { borderTopColor: colors.border, backgroundColor: colors.background }]}>
          <TouchableOpacity
            style={[styles.startMeetingButton, { backgroundColor: colors.primary }]}
            onPress={startMeeting}
            disabled={creatingMeeting}
          >
            {creatingMeeting ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <Ionicons name="videocam" size={20} color="#fff" style={{ marginRight: 8 }} />
                <Text style={styles.startMeetingText}>Start Meeting</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  backButton: {
    padding: 4,
    marginRight: 8,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    flex: 1,
    textAlign: 'center',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
  },
  searchIcon: {
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
  },
  listContent: {
    paddingBottom: 16,
  },
  participantItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  avatarText: {
    fontSize: 16,
    fontWeight: 'bold',
  },
  participantInfo: {
    flex: 1,
  },
  participantName: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 2,
  },
  participantEmail: {
    fontSize: 14,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 60,
  },
  emptyText: {
    fontSize: 16,
    marginTop: 12,
  },
  footer: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
  },
  startMeetingButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: 8,
  },
  startMeetingText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
