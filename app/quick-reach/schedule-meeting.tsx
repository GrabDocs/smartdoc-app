import { Ionicons } from '@expo/vector-icons';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import {
    Alert,
    KeyboardAvoidingView,
    Modal,
    Platform,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FeedbackTouchable } from '../../components/FeedbackTouchable';
import { useThemeColors } from '../../hooks/useThemeColors';
import { apiClient } from '../../services/api';
import { useLimitError } from '../../contexts/LimitErrorContext';
import { extractLimitErrorData, limitErrorFromCaught } from '../../utils/limitErrorUtils';

import AppBackButton from '../../components/AppBackButton';
import AppHeaderTitle from '../../components/AppHeaderTitle';

export default function ScheduleMeetingScreen() {
  const router = useRouter();
  const { showLimitError } = useLimitError();
  const colors = useThemeColors();
  const [loading, setLoading] = useState(false);
  // Default to 15 minutes ahead so "schedule now" isn't rejected as past by the API.
  const [startDateTime, setStartDateTime] = useState(() => new Date(Date.now() + 15 * 60 * 1000));
  const [endDateTime, setEndDateTime] = useState(() => new Date(Date.now() + 75 * 60 * 1000));
  const [meetingData, setMeetingData] = useState(() => {
    const start = new Date(Date.now() + 15 * 60 * 1000);
    const end = new Date(Date.now() + 75 * 60 * 1000);
    return {
      title: '',
      description: '',
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      passcode: '',
      enableRecording: false,
      enableTranscription: false,
      isPrivate: false,
      participants: [] as string[],
    };
  });
  const [newParticipant, setNewParticipant] = useState('');
  const [showStartDatePicker, setShowStartDatePicker] = useState(false);
  const [showEndDatePicker, setShowEndDatePicker] = useState(false);
  const [featuresExpanded, setFeaturesExpanded] = useState(false);

  /** Return a valid Date for DateTimePicker; never pass Invalid Date (causes picker not to display). */
  const getValidDate = (d: Date | undefined): Date => {
    if (d != null && !Number.isNaN(d.getTime())) return d;
    return new Date();
  };

  /** Android: open date then time with imperative API to avoid dismiss('datetime') crash (library has no pickers['datetime']). */
  const openStartDatePickerAndroid = () => {
    const value = getValidDate(startDateTime);
    const minDate = getValidDate(new Date());
    DateTimePickerAndroid.open({
      value,
      mode: 'date',
      minimumDate: minDate,
      onChange: (event, date) => {
        if (event?.type !== 'set' || !date) return;
        DateTimePickerAndroid.open({
          value: date,
          mode: 'time',
          onChange: (event2, time) => {
            if (event2?.type !== 'set' || !time) return;
            const combined = new Date(date);
            combined.setHours(time.getHours(), time.getMinutes(), time.getSeconds(), time.getMilliseconds());
            const now = new Date();
            if (combined < now) {
              Alert.alert('Invalid Date', 'Please select a future date and time for the meeting.');
              return;
            }
            setStartDateTime(combined);
            setMeetingData(prev => ({ ...prev, startTime: combined.toISOString() }));
            const newEnd = new Date(combined.getTime() + 60 * 60 * 1000);
            setEndDateTime(newEnd);
            setMeetingData(prev => ({ ...prev, endTime: newEnd.toISOString() }));
          },
        });
      },
    });
  };

  /** Android: open date then time with imperative API to avoid dismiss('datetime') crash. */
  const openEndDatePickerAndroid = () => {
    const value = getValidDate(endDateTime);
    const minDate = getValidDate(startDateTime);
    DateTimePickerAndroid.open({
      value,
      mode: 'date',
      minimumDate: minDate,
      onChange: (event, date) => {
        if (event?.type !== 'set' || !date) return;
        DateTimePickerAndroid.open({
          value: date,
          mode: 'time',
          onChange: (event2, time) => {
            if (event2?.type !== 'set' || !time) return;
            const combined = new Date(date);
            combined.setHours(time.getHours(), time.getMinutes(), time.getSeconds(), time.getMilliseconds());
            if (combined <= startDateTime) {
              Alert.alert('Invalid Time', 'End time must be after start time. Please select a later date and time.');
              return;
            }
            setEndDateTime(combined);
            setMeetingData(prev => ({ ...prev, endTime: combined.toISOString() }));
          },
        });
      },
    });
  };

  const createMeeting = async () => {
    if (!meetingData.title.trim()) {
      Alert.alert('Error', 'Please enter a meeting name');
      return;
    }

    if (!meetingData.startTime) {
      Alert.alert('Error', 'Please select a start date/time');
      return;
    }

    if (meetingData.isPrivate && !meetingData.passcode.trim()) {
      Alert.alert('Error', 'Please enter a passcode for private meetings');
      return;
    }

    // Prepare meeting data — field names must match backend schedule_meeting()
    const durationMinutes = Math.max(
      1,
      Math.round((endDateTime.getTime() - startDateTime.getTime()) / (1000 * 60))
    );
    const meetingPayload = {
      // Room information
      roomName: meetingData.title,
      room_name: meetingData.title,
      name: meetingData.title,
      title: meetingData.title,
      
      description: meetingData.description,
      
      // Date and time information
      start_time: startDateTime.toISOString(),
      end_time: endDateTime.toISOString(),
      startTime: startDateTime.toISOString(),
      endTime: endDateTime.toISOString(),
      scheduled_time: startDateTime.toISOString(),
      scheduled_at: startDateTime.toISOString(),
      
      timezone: meetingData.timezone,
      duration_minutes: durationMinutes,
      meeting_duration_minutes: durationMinutes,
      
      // Meeting settings (snake_case is what the backend reads)
      isPrivate: meetingData.isPrivate,
      passcode: meetingData.isPrivate ? meetingData.passcode : undefined,
      passcode_required: meetingData.isPrivate,
      enableRecording: meetingData.enableRecording,
      enable_recording: meetingData.enableRecording,
      enableTranscription: meetingData.enableTranscription,
      enable_transcription: meetingData.enableTranscription,
      
      // Participants — backend schedule_meeting() expects `invitees`
      participants: meetingData.participants,
      invited_participants: meetingData.participants,
      invitees: meetingData.participants,
      participant_count: meetingData.participants.length,
      
      // Email integration with Resend
      sendEmailInvites: true,
      send_email_invites: true,
      email_invites: true,
      notify_participants: true,
      use_resend: true,
      email_provider: 'resend',
      
      // Meeting metadata
      meeting_type: 'general',
      meeting_status: 'scheduled',
      status: 'scheduled',
      max_participants: 10,
      from_reach_page: true,
    };

    console.log('📱 Sending meeting payload:', JSON.stringify(meetingPayload, null, 2));

    try {
      setLoading(true);

      // Use the mobile schedule endpoint as specified
      const response = await apiClient.client.post('/api/v1/mobile/meetings/schedule', meetingPayload);
      
      console.log('📱 Meeting creation response:', JSON.stringify(response.data, null, 2));
      
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
        
        console.log('✅ Meeting scheduled successfully:', {
          meetingId,
          roomCode,
          hmsRoomId,
          title: meetingData?.title || meetingData?.name || meetingData?.roomName || meetingData?.room_name
        });
        
        Alert.alert('Success', 'Meeting scheduled successfully!', [
          {
            text: 'OK',
            onPress: () => {
              router.back();
            }
          }
        ]);
      } else {
        const limitData = limitErrorFromCaught({ response: { status: response.status, data: response.data } });
        if (limitData) showLimitError(limitData);
        else Alert.alert('Error', response.data.message || 'Failed to schedule meeting');
      }
    } catch (error: any) {
      console.error('Create meeting failed:', error);
      console.error('Error response:', error.response?.data);
      console.error('Error status:', error.response?.status);
      console.error('Full error object:', error);
      
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
                  const response = await apiClient.client.post('/api/v1/mobile/meetings/schedule', meetingPayload);
                  
                  console.log('📱 Meeting creation response (after ending existing):', JSON.stringify(response.data, null, 2));
                  
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
                    
                    console.log('✅ Meeting scheduled successfully:', {
                      meetingId,
                      roomCode,
                      hmsRoomId,
                      title: meetingData?.title || meetingData?.name || meetingData?.roomName || meetingData?.room_name
                    });
                    
                    Alert.alert('Success', 'Meeting scheduled successfully! Email invitations have been sent to all participants.', [
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
                    else Alert.alert('Error', response.data.message || 'Failed to schedule meeting');
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
        const serverMsg =
          error.response?.data?.message ||
          error.response?.data?.error ||
          'There was a server error while scheduling the meeting. Please try again or contact support.';
        Alert.alert('Server Error', serverMsg);
      } else {
        const limitData = limitErrorFromCaught(error);
        if (limitData) showLimitError(limitData);
        else {
          Alert.alert(
            'Error',
            error.response?.data?.message ||
              error.response?.data?.error ||
              'Failed to schedule meeting'
          );
        }
      }
    } finally {
      setLoading(false);
    }
  };

  const onStartDateChange = (event: any, selectedDate?: Date) => {
    // On Android, native picker sends 'set' (confirm) or 'dismissed' (cancel); hide picker when done
    if (Platform.OS === 'android') {
      setShowStartDatePicker(false);
      const confirmed = event && (event as { type?: string }).type === 'set';
      if (!confirmed || !selectedDate) return;
    }
    if (selectedDate) {
      // Prevent selecting past dates
      const now = new Date();
      if (selectedDate < now) {
        Alert.alert('Invalid Date', 'Please select a future date and time for the meeting.');
        return;
      }
      
      setStartDateTime(selectedDate);
      setMeetingData(prev => ({ ...prev, startTime: selectedDate.toISOString() }));
      
      // Auto-update end time to be 1 hour after start time
      const newEndTime = new Date(selectedDate.getTime() + 60 * 60 * 1000);
      setEndDateTime(newEndTime);
      setMeetingData(prev => ({ ...prev, endTime: newEndTime.toISOString() }));
    }
  };

  const onEndDateChange = (event: any, selectedDate?: Date) => {
    // On Android, native picker sends 'set' (confirm) or 'dismissed' (cancel); hide picker when done
    if (Platform.OS === 'android') {
      setShowEndDatePicker(false);
      const confirmed = event && (event as { type?: string }).type === 'set';
      if (!confirmed || !selectedDate) return;
    }
    if (selectedDate) {
      // Prevent selecting end time before or equal to start time
      if (selectedDate <= startDateTime) {
        Alert.alert('Invalid Time', 'End time must be after start time. Please select a later date and time.');
        return;
      }
      
      setEndDateTime(selectedDate);
      setMeetingData(prev => ({ ...prev, endTime: selectedDate.toISOString() }));
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
    backButton: {
      padding: 4,
      marginRight: 12,
    },
    headerTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: colors.text,
      flex: 1,
    },
    scheduleButton: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderRadius: 8,
      backgroundColor: '#007AFF',
    },
    scheduleButtonDisabled: {
      backgroundColor: '#c6c6c6',
    },
    scheduleButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: '#fff',
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
    sectionTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: colors.text,
    },
    sectionHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 16,
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
    datePickerContainer: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 12,
      backgroundColor: colors.inputBackground || colors.card,
    },
    datePickerLabel: {
      fontSize: 16,
      color: colors.text,
    },
    datePickerHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      marginBottom: 8,
    },
    datePickerTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: colors.text,
    },
    datePicker: {
      backgroundColor: colors.card,
      borderRadius: 8,
      marginTop: 8,
    },
    modalOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      justifyContent: 'center',
      alignItems: 'center',
    },
    modalContainer: {
      backgroundColor: colors.card,
      borderRadius: 12,
      marginHorizontal: 20,
      maxHeight: '80%',
      width: '90%',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.25,
      shadowRadius: 4,
      elevation: 5,
    },
    modalHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingVertical: 16,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    modalTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: colors.text,
    },
    modalCancelButton: {
      fontSize: 16,
      color: colors.textSecondary,
    },
    doneButton: {
      fontSize: 16,
      fontWeight: '600',
      color: '#007AFF',
    },
    modalContent: {
      paddingHorizontal: 20,
      paddingVertical: 20,
      alignItems: 'center',
    },
    modalDatePicker: {
      width: '100%',
      height: 200,
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
          <AppBackButton />
          <AppHeaderTitle>Schedule Meeting</AppHeaderTitle>
          <FeedbackTouchable
            style={[dynamicStyles.scheduleButton, loading && dynamicStyles.scheduleButtonDisabled]}
            onPress={createMeeting}
            disabled={loading}
            loading={loading}
            spinnerColor="#fff"
          >
            <Text style={dynamicStyles.scheduleButtonText}>Schedule</Text>
          </FeedbackTouchable>
        </View>

        <ScrollView style={dynamicStyles.content} showsVerticalScrollIndicator={false}>
          {/* Meeting Details */}
          <View style={dynamicStyles.section}>
            <View style={dynamicStyles.inputGroup}>
              <Text style={dynamicStyles.label}>Meeting Name *</Text>
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

            {/* Start Date/Time */}
            <View style={dynamicStyles.inputGroup}>
              <Text style={dynamicStyles.label}>Start Date & Time *</Text>
              <TouchableOpacity 
                style={dynamicStyles.datePickerContainer}
                onPress={() => {
                  if (Platform.OS === 'android') {
                    openStartDatePickerAndroid();
                  } else {
                    setShowStartDatePicker(true);
                    setShowEndDatePicker(false);
                  }
                }}
              >
                <Text style={dynamicStyles.datePickerLabel}>
                  {startDateTime.toLocaleString([], { 
                    month: 'short', 
                    day: 'numeric', 
                    year: 'numeric',
                    hour: '2-digit', 
                    minute: '2-digit' 
                  })}
                </Text>
                <Ionicons name="calendar-outline" size={20} color="#007AFF" />
              </TouchableOpacity>
            </View>

            {/* End Date/Time */}
            <View style={dynamicStyles.inputGroup}>
              <Text style={dynamicStyles.label}>End Date & Time *</Text>
              <TouchableOpacity 
                style={dynamicStyles.datePickerContainer}
                onPress={() => {
                  if (Platform.OS === 'android') {
                    openEndDatePickerAndroid();
                  } else {
                    setShowEndDatePicker(true);
                    setShowStartDatePicker(false);
                  }
                }}
              >
                <Text style={dynamicStyles.datePickerLabel}>
                  {endDateTime.toLocaleString([], { 
                    month: 'short', 
                    day: 'numeric', 
                    year: 'numeric',
                    hour: '2-digit', 
                    minute: '2-digit' 
                  })}
                </Text>
                <Ionicons name="calendar-outline" size={20} color="#007AFF" />
              </TouchableOpacity>
            </View>
          </View>

          {/* Features - Collapsible */}
          <View style={dynamicStyles.section}>
            <TouchableOpacity 
              style={dynamicStyles.sectionHeader}
              onPress={() => setFeaturesExpanded(!featuresExpanded)}
              activeOpacity={0.7}
            >
              <Text style={dynamicStyles.sectionTitle}>Features</Text>
              <Ionicons 
                name={featuresExpanded ? "chevron-up" : "chevron-down"} 
                size={20} 
                color="#007AFF" 
              />
            </TouchableOpacity>
            
            {featuresExpanded && (
              <>
                <TouchableOpacity 
                  style={dynamicStyles.featureRow}
                  onPress={() => toggleFeature('enableRecording')}
                >
                  <View style={dynamicStyles.featureInfo}>
                    <Text style={dynamicStyles.featureTitle}>Enable Recording</Text>
                  </View>
                  <View style={[dynamicStyles.checkbox, meetingData.enableRecording && dynamicStyles.checkboxChecked]}>
                    {meetingData.enableRecording && <Ionicons name="checkmark" size={16} color="#fff" />}
                  </View>
                </TouchableOpacity>

                <TouchableOpacity 
                  style={dynamicStyles.featureRow}
                  onPress={() => toggleFeature('enableTranscription')}
                >
                  <View style={dynamicStyles.featureInfo}>
                    <Text style={dynamicStyles.featureTitle}>Enable Transcription</Text>
                  </View>
                  <View style={[dynamicStyles.checkbox, meetingData.enableTranscription && dynamicStyles.checkboxChecked]}>
                    {meetingData.enableTranscription && <Ionicons name="checkmark" size={16} color="#fff" />}
                  </View>
                </TouchableOpacity>

                <TouchableOpacity 
                  style={dynamicStyles.featureRow}
                  onPress={() => toggleFeature('isPrivate')}
                >
                  <View style={dynamicStyles.featureInfo}>
                    <Text style={dynamicStyles.featureTitle}>Private Meeting (Requires Passcode)</Text>
                  </View>
                  <View style={[dynamicStyles.checkbox, meetingData.isPrivate && dynamicStyles.checkboxChecked]}>
                    {meetingData.isPrivate && <Ionicons name="checkmark" size={16} color="#fff" />}
                  </View>
                </TouchableOpacity>

                {meetingData.isPrivate && (
                  <View style={dynamicStyles.inputGroup}>
                    <Text style={dynamicStyles.label}>Passcode *</Text>
                    <TextInput
                      style={dynamicStyles.textInput}
                      placeholder="Enter passcode"
                      placeholderTextColor={colors.textSecondary}
                      value={meetingData.passcode}
                      onChangeText={(text) => setMeetingData(prev => ({ ...prev, passcode: text }))}
                      secureTextEntry
                      maxLength={20}
                    />
                  </View>
                )}
              </>
            )}
          </View>

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
      </KeyboardAvoidingView>

      {/* Start Date/Time Picker: Android uses imperative API (no component mount = no dismiss crash); iOS uses Modal with spinner */}
      {showStartDatePicker ? (
        <Modal
          visible={true}
          animationType="fade"
          transparent={true}
          statusBarTranslucent
          onRequestClose={() => setShowStartDatePicker(false)}
        >
          <TouchableOpacity
            style={dynamicStyles.modalOverlay}
            activeOpacity={1}
            onPress={() => setShowStartDatePicker(false)}
          >
            <TouchableOpacity
              style={dynamicStyles.modalContainer}
              activeOpacity={1}
              onPress={(e) => e.stopPropagation()}
            >
              <View style={dynamicStyles.modalHeader}>
                <TouchableOpacity onPress={() => setShowStartDatePicker(false)}>
                  <Text style={dynamicStyles.modalCancelButton}>Cancel</Text>
                </TouchableOpacity>
                <Text style={dynamicStyles.modalTitle}>Select Start Date & Time</Text>
                <TouchableOpacity onPress={() => setShowStartDatePicker(false)}>
                  <Text style={dynamicStyles.doneButton}>Done</Text>
                </TouchableOpacity>
              </View>
              <View style={dynamicStyles.modalContent}>
                <DateTimePicker
                  value={getValidDate(startDateTime)}
                  mode="datetime"
                  display="spinner"
                  onChange={onStartDateChange}
                  style={dynamicStyles.modalDatePicker}
                  textColor={colors.text}
                  accentColor="#007AFF"
                  minimumDate={getValidDate(new Date())}
                />
              </View>
            </TouchableOpacity>
          </TouchableOpacity>
        </Modal>
      ) : null}

      {/* End Date/Time Picker: Android uses imperative API (no component mount = no dismiss crash); iOS uses Modal with spinner */}
      {showEndDatePicker ? (
        <Modal
          visible={true}
          animationType="fade"
          transparent={true}
          statusBarTranslucent
          onRequestClose={() => setShowEndDatePicker(false)}
        >
          <TouchableOpacity
            style={dynamicStyles.modalOverlay}
            activeOpacity={1}
            onPress={() => setShowEndDatePicker(false)}
          >
            <TouchableOpacity
              style={dynamicStyles.modalContainer}
              activeOpacity={1}
              onPress={(e) => e.stopPropagation()}
            >
              <View style={dynamicStyles.modalHeader}>
                <TouchableOpacity onPress={() => setShowEndDatePicker(false)}>
                  <Text style={dynamicStyles.modalCancelButton}>Cancel</Text>
                </TouchableOpacity>
                <Text style={dynamicStyles.modalTitle}>Select End Date & Time</Text>
                <TouchableOpacity onPress={() => setShowEndDatePicker(false)}>
                  <Text style={dynamicStyles.doneButton}>Done</Text>
                </TouchableOpacity>
              </View>
              <View style={dynamicStyles.modalContent}>
                <DateTimePicker
                  value={getValidDate(endDateTime)}
                  mode="datetime"
                  display="spinner"
                  onChange={onEndDateChange}
                  style={dynamicStyles.modalDatePicker}
                  textColor={colors.text}
                  accentColor="#007AFF"
                  minimumDate={getValidDate(startDateTime)}
                />
              </View>
            </TouchableOpacity>
          </TouchableOpacity>
        </Modal>
      ) : null}
    </SafeAreaView>
  );
}