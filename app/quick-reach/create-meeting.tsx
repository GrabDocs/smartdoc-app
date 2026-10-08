import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import {
    Alert,
    KeyboardAvoidingView,
    Platform,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import ClientsButton from '../../components/clients/ClientsButton';
import { FeedbackTouchable } from '../../components/FeedbackTouchable';
import AppHeaderTitle from '../../components/AppHeaderTitle';
import { useLimitError } from '../../contexts/LimitErrorContext';
import { useThemeColors } from '../../hooks/useThemeColors';
import { apiClient } from '../../services/api';
import { setItemClients } from '../../services/clientsApi';
import { extractLimitErrorData, getErrorResponseData, limitErrorFromCaught } from '../../utils/limitErrorUtils';

function asPositiveInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.trunc(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const n = Number(value);
    return n > 0 ? n : null;
  }
  return null;
}

async function linkMeetingClients(clientIds: number[], responseData: any) {
  if (!clientIds.length) return;
  const payload = responseData?.data || responseData?.room || responseData;
  const videoCallId =
    asPositiveInt(payload?.id) ??
    asPositiveInt(responseData?.room?.id) ??
    asPositiveInt(responseData?.room_id) ??
    asPositiveInt(responseData?.video_call_id);
  const calendarEventId =
    asPositiveInt(responseData?.calendar_event_id) ??
    asPositiveInt(payload?.calendar_event_id);
  try {
    if (videoCallId != null) {
      await setItemClients({
        client_ids: clientIds,
        item_type: 'video_call',
        item_id: videoCallId,
      });
    }
    if (calendarEventId != null) {
      await setItemClients({
        client_ids: clientIds,
        item_type: 'calendar_event',
        item_id: calendarEventId,
      });
    }
  } catch (linkErr) {
    console.error('Error linking clients to meeting:', linkErr);
  }
}

export default function CreateMeetingScreen() {
  const colors = useThemeColors();
  const router = useRouter();
  const { client_id: clientIdParam } = useLocalSearchParams<{ client_id?: string }>();
  const { showLimitError } = useLimitError();
  const [loading, setLoading] = useState(false);
  const [selectedClientIds, setSelectedClientIds] = useState<number[]>([]);
  const [meetingData, setMeetingData] = useState({
    title: '',
    description: '',
    passcode: '',
    enableRecording: false,
    enableTranscription: false,
    isPrivate: false,
    participants: [] as string[]
  });
  const [newParticipant, setNewParticipant] = useState('');
  const [featuresExpanded, setFeaturesExpanded] = useState(false);

  useEffect(() => {
    const raw = Array.isArray(clientIdParam) ? clientIdParam[0] : clientIdParam;
    const id = typeof raw === 'string' && /^\d+$/.test(raw) ? parseInt(raw, 10) : null;
    if (id != null) {
      setSelectedClientIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    }
  }, [clientIdParam]);

  const createMeeting = async () => {
    if (!meetingData.title.trim()) {
      Alert.alert('Error', 'Please enter a meeting name');
      return;
    }

    if (meetingData.isPrivate && !meetingData.passcode.trim()) {
      Alert.alert('Error', 'Please enter a passcode for private meetings');
      return;
    }

    // Prepare meeting data for immediate creation
    // Use mobile endpoint which properly handles title/roomName conversion to room_name
    const meetingPayload = {
      // Room information - include all variations for backend compatibility
      roomName: meetingData.title,
      room_name: meetingData.title,
      name: meetingData.title,
      title: meetingData.title,
      
      description: meetingData.description,
      
      // Meeting settings
      isPrivate: meetingData.isPrivate,
      passcode: meetingData.isPrivate ? meetingData.passcode : undefined,
      passcode_required: meetingData.isPrivate,
      enableRecording: meetingData.enableRecording,
      enable_recording: meetingData.enableRecording,
      enableTranscription: meetingData.enableTranscription,
      enable_transcription: meetingData.enableTranscription,
      
      // Participants
      participants: meetingData.participants,
      invited_participants: meetingData.participants,
      invitees: meetingData.participants,
      participant_count: meetingData.participants.length,
      
      // Meeting metadata
      meeting_type: 'general',
      meeting_status: 'active',
      status: 'active',
      from_reach_page: true,
    };

    console.log('📱 Sending create meeting payload:', meetingPayload);

    try {
      setLoading(true);

      // Use mobile endpoint which properly handles title/roomName conversion to room_name
      const response = await apiClient.client.post('/api/v1/mobile/meetings/create', meetingPayload);
      
      console.log('📱 Create meeting response:', JSON.stringify(response.data, null, 2));
      
      if (response.data.success) {
        // Verify meeting was actually created by checking for meeting ID or room code
        const meetingData = response.data.data || response.data.room || response.data;
        const meetingId = meetingData?.meetingId || meetingData?.meeting_id || meetingData?.id;
        const roomCode = meetingData?.roomCode || meetingData?.room_code;
        const hmsRoomId = meetingData?.hmsRoomId || meetingData?.hms_room_id;
        
        // Validate that we have at least one identifier
        if (!meetingId && !roomCode && !hmsRoomId) {
          console.error('❌ Meeting creation response missing identifiers:', response.data);
          Alert.alert(
            'Warning', 
            'Meeting creation response did not include meeting ID. The meeting may not have been created. Please check your meetings list or try again.',
            [{ text: 'OK' }]
          );
          return;
        }
        
        const meetingTitle = meetingData?.title || meetingData?.name || meetingData?.roomName || meetingData?.room_name || 'Meeting';
        
        console.log('✅ Meeting created successfully:', {
          meetingId,
          roomCode,
          hmsRoomId,
          title: meetingTitle
        });

        await linkMeetingClients(selectedClientIds, response.data);
        
        // Show success message and go back to meeting list
        // User can now join the meeting from the list or send it to others
        Alert.alert('Success', `Meeting "${meetingTitle}" created successfully! You can join it from the meeting list or send it to others.`, [
          {
            text: 'OK',
            onPress: () => {
              router.back();
            }
          }
        ]);
      } else {
        const errorMessage = response.data.message || 'Failed to create meeting';
        console.error('❌ Meeting creation failed:', errorMessage);
        Alert.alert('Error', errorMessage);
      }
    } catch (error: any) {
      console.error('Create meeting failed:', error);
      console.error('Error response:', error.response?.data);
      console.error('Error status:', error.response?.status);
      
      if (error.response?.status === 409) {
        // Handle conflict - existing active meeting
        const activeMeeting = error.response?.data?.activeMeeting;
        Alert.alert(
          'Active Meeting Exists',
          `You already have an active meeting: "${activeMeeting?.name || 'Unknown'}". Would you like to end it and create a new one?`,
          [
            { text: 'Cancel', style: 'cancel' },
            { 
              text: 'End & Create New', 
              style: 'destructive',
              onPress: async () => {
                setLoading(true);
                try {
                  // End the existing meeting first
                  await apiClient.endMeeting(activeMeeting.id.toString());
                  
                  // Then create the new meeting
                  const response = await apiClient.client.post('/api/v1/mobile/meetings/create', meetingPayload);
                  
                  console.log('📱 Create meeting response (after ending existing):', JSON.stringify(response.data, null, 2));
                  
                  if (response.data.success) {
                    // Verify meeting was actually created
                    const meetingData = response.data.data || response.data.room || response.data;
                    const meetingId = meetingData?.meetingId || meetingData?.meeting_id || meetingData?.id;
                    const roomCode = meetingData?.roomCode || meetingData?.room_code;
                    const hmsRoomId = meetingData?.hmsRoomId || meetingData?.hms_room_id;
                    
                    // Validate that we have at least one identifier
                    if (!meetingId && !roomCode && !hmsRoomId) {
                      console.error('❌ Meeting creation response missing identifiers:', response.data);
                      Alert.alert(
                        'Warning', 
                        'Meeting creation response did not include meeting ID. The meeting may not have been created. Please check your meetings list or try again.',
                        [{ text: 'OK' }]
                      );
                      return;
                    }
                    
                    const meetingTitle = meetingData?.title || meetingData?.name || meetingData?.roomName || meetingData?.room_name || 'Meeting';
                    
                    console.log('✅ Meeting created successfully:', {
                      meetingId,
                      roomCode,
                      hmsRoomId,
                      title: meetingTitle
                    });

                    await linkMeetingClients(selectedClientIds, response.data);
                    
                    // Show success message and go back to meeting list
                    Alert.alert('Success', `Meeting "${meetingTitle}" created successfully! You can join it from the meeting list or send it to others.`, [
                      {
                        text: 'OK',
                        onPress: () => {
                          router.back();
                        }
                      }
                    ]);
                  } else {
                    const limitData = extractLimitErrorData(response.data);
                    if (limitData) showLimitError(limitData);
                    else Alert.alert('Error', response.data.message || 'Failed to create meeting');
                  }
                } catch (endError) {
                  console.error('Failed to end existing meeting:', endError);
                  const limitData = limitErrorFromCaught(endError);
                  if (limitData) showLimitError(limitData);
                  else Alert.alert('Error', 'Failed to end existing meeting. Please try again.');
                } finally {
                  setLoading(false);
                }
              }
            }
          ]
        );
      } else if (error.response?.status === 500) {
        Alert.alert('Server Error', 'There was a server error while creating the meeting. Please try again or contact support.');
      } else {
        const limitData = extractLimitErrorData(getErrorResponseData(error));
        if (limitData) {
          showLimitError(limitData);
        } else {
          Alert.alert('Error', error.response?.data?.message || 'Failed to create meeting');
        }
      }
    } finally {
      setLoading(false);
    }
  };

  const addParticipant = () => {
    if (newParticipant.trim() && !meetingData.participants.includes(newParticipant.trim())) {
      setMeetingData(prev => ({
        ...prev,
        participants: [...prev.participants, newParticipant.trim()]
      }));
      setNewParticipant('');
    }
  };

  const removeParticipant = (email: string) => {
    setMeetingData(prev => ({
      ...prev,
      participants: prev.participants.filter(p => p !== email)
    }));
  };

  const toggleFeature = (feature: 'enableRecording' | 'enableTranscription' | 'isPrivate') => {
    setMeetingData(prev => ({
      ...prev,
      [feature]: !prev[feature],
      // Clear passcode if making meeting public
      ...(feature === 'isPrivate' && !prev.isPrivate ? { passcode: '' } : {})
    }));
  };

  const dynamicStyles = useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    keyboardView: {
      flex: 1,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingVertical: 16,
      backgroundColor: colors.headerBackground,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    headerTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: colors.text,
    },
    closeButton: {
      padding: 4,
    },
    content: {
      flex: 1,
      paddingHorizontal: 20,
    },
    section: {
      backgroundColor: colors.card,
      marginTop: 16,
      borderRadius: 12,
      padding: 16,
    },
    sectionHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 16,
    },
    sectionTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: colors.text,
      marginBottom: 14,
    },
    inputGroup: {
      marginBottom: 16,
    },
    label: {
      fontSize: 14,
      fontWeight: '500',
      color: colors.textSecondary,
      marginBottom: 8,
    },
    textInput: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 12,
      fontSize: 16,
      color: colors.text,
      backgroundColor: colors.inputBackground || colors.card,
    },
    textArea: {
      height: 80,
      textAlignVertical: 'top',
    },
    featureRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    featureInfo: {
      flex: 1,
    },
    featureTitle: {
      fontSize: 16,
      color: colors.text,
    },
    checkbox: {
      width: 24,
      height: 24,
      borderRadius: 4,
      borderWidth: 2,
      borderColor: colors.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    checkboxChecked: {
      backgroundColor: '#007AFF',
      borderColor: '#007AFF',
    },
    participantInput: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 12,
    },
    participantTextInput: {
      flex: 1,
      marginRight: 12,
    },
    addButton: {
      padding: 8,
    },
    participantsList: {
      marginTop: 8,
    },
    participantItem: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 8,
      paddingHorizontal: 12,
      backgroundColor: colors.surface || colors.background,
      borderRadius: 8,
      marginBottom: 8,
    },
    participantEmail: {
      fontSize: 14,
      color: colors.textSecondary,
      flex: 1,
    },
    actionButtons: {
      flexDirection: 'row',
      paddingHorizontal: 20,
      paddingVertical: 16,
      backgroundColor: colors.card,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      gap: 12,
    },
    cancelButton: {
      flex: 1,
      paddingVertical: 12,
      borderRadius: 8,
      backgroundColor: '#6c757d',
      alignItems: 'center',
    },
    cancelButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: '#fff',
    },
    createButton: {
      flex: 1,
      paddingVertical: 12,
      borderRadius: 8,
      backgroundColor: '#007AFF',
      alignItems: 'center',
    },
    createButtonDisabled: {
      backgroundColor: '#c6c6c6',
    },
    createButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: '#fff',
    },
  }), [colors]);

  return (
    <SafeAreaView style={dynamicStyles.container}>
      <KeyboardAvoidingView 
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={dynamicStyles.keyboardView}
      >
        {/* Header */}
        <View style={dynamicStyles.header}>
          <AppHeaderTitle>Create New Meeting</AppHeaderTitle>
          <TouchableOpacity onPress={() => router.back()} style={dynamicStyles.closeButton}>
            <Ionicons name="close" size={28} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>

        <ScrollView style={dynamicStyles.content} showsVerticalScrollIndicator={false}>
          {/* Meeting Details */}
          <View style={dynamicStyles.section}>
            <Text style={dynamicStyles.sectionTitle}>Meeting Details</Text>
            
            <View style={dynamicStyles.inputGroup}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <Text style={[dynamicStyles.label, { marginBottom: 0 }]}>Meeting Name *</Text>
                <ClientsButton
                  selectedClientIds={selectedClientIds}
                  onChange={setSelectedClientIds}
                  allowCreate
                  compact
                />
              </View>
              <TextInput
                style={dynamicStyles.textInput}
                placeholder="Enter meeting name"
                placeholderTextColor={colors.textSecondary}
                value={meetingData.title}
                onChangeText={(text) => setMeetingData(prev => ({ ...prev, title: text }))}
                maxLength={100}
              />
            </View>

            <View style={dynamicStyles.inputGroup}>
              <Text style={dynamicStyles.label}>Description (Optional)</Text>
              <TextInput
                style={[dynamicStyles.textInput, dynamicStyles.textArea]}
                placeholder="Enter meeting description"
                placeholderTextColor={colors.textSecondary}
                value={meetingData.description}
                onChangeText={(text) => setMeetingData(prev => ({ ...prev, description: text }))}
                multiline
                numberOfLines={3}
                maxLength={500}
              />
            </View>
          </View>

          {/* Features section hidden */}

          {/* Participants */}
          <View style={dynamicStyles.section}>
            <Text style={dynamicStyles.sectionTitle}>Participants (Optional)</Text>
            
            <View style={dynamicStyles.participantInput}>
              <TextInput
                style={[dynamicStyles.textInput, dynamicStyles.participantTextInput]}
                placeholder="Enter email address"
                placeholderTextColor={colors.textSecondary}
                value={newParticipant}
                onChangeText={setNewParticipant}
                keyboardType="email-address"
                autoCapitalize="none"
              />
              <TouchableOpacity style={dynamicStyles.addButton} onPress={addParticipant}>
                <Ionicons name="add" size={20} color="#007AFF" />
              </TouchableOpacity>
            </View>

            {meetingData.participants.length > 0 && (
              <View style={dynamicStyles.participantsList}>
                {meetingData.participants.map((email, index) => (
                  <View key={index} style={dynamicStyles.participantItem}>
                    <Text style={dynamicStyles.participantEmail}>{email}</Text>
                    <TouchableOpacity onPress={() => removeParticipant(email)}>
                      <Ionicons name="close-circle" size={20} color="#FF3B30" />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )}
          </View>
        </ScrollView>

        {/* Action Buttons */}
        <View style={dynamicStyles.actionButtons}>
          <TouchableOpacity 
            style={dynamicStyles.cancelButton}
            onPress={() => router.back()}
          >
            <Text style={dynamicStyles.cancelButtonText}>Cancel</Text>
          </TouchableOpacity>
          
          <FeedbackTouchable
            style={[dynamicStyles.createButton, loading && dynamicStyles.createButtonDisabled]}
            onPress={createMeeting}
            disabled={loading}
            loading={loading}
            spinnerColor="#fff"
          >
            <Text style={dynamicStyles.createButtonText}>Create Meeting</Text>
          </FeedbackTouchable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}


