import { Ionicons } from '@expo/vector-icons';
import { Audio, InterruptionModeAndroid, InterruptionModeIOS, ResizeMode, Video } from 'expo-av';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  InteractionManager,
  Linking,
  Modal,
  PanResponder,
  Platform,
  RefreshControl,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import DocumentViewer from '../../components/DocumentViewer';
import { FeedbackTouchable } from '../../components/FeedbackTouchable';
import TextAssetViewer from '../../components/TextAssetViewer';
import ActionMenuModal, { type ActionMenuItem } from '../../components/ActionMenuModal';
import { API_BASE_URL, STORAGE_KEYS } from '../../constants/Config';
import { useThemeColors } from '../../hooks/useThemeColors';
import { apiClient } from '../../services/api';
import { secureStorage } from '../../utils/storage';

import AppBackButton from '../../components/AppBackButton';
import AppHeaderTitle from '../../components/AppHeaderTitle';
import { truncateAppHeaderTitle } from '../../utils/chatTitleDisplay';

interface MeetingAsset {
  id: string;
  meetingId?: string;
  title: string;
  type: 'recording' | 'transcript' | 'chat_log' | 'shared_files' | 'whiteboard' | 'notes' | 'meeting_report' | 'video' | 'call_transcript' | 'summary' | 'report' | 'chat' | 'meeting_chat' | 'files' | 'meeting_summary';
  date: string;
  duration?: number;
  participants?: string[];
  fileSize?: number;
  downloadUrl?: string;
  summary?: string;
  keywords?: string[];
  status?: 'processing' | 'ready' | 'error';
  thumbnailUrl?: string;
  quality?: 'hd' | 'sd' | 'audio_only';
  size?: string;
  url?: string;
  meeting_id?: string;
  meeting_title?: string;
  // Local file paths from database
  local_recording_path?: string;
  local_file_path?: string;
  local_transcript_path?: string;
  local_chat_path?: string;
  local_report_path?: string;
  original_filename?: string;
  // File ID for DocumentViewer
  file_id?: number | string;
  // Session information
  video_call_id?: string | number;
  session_number?: number;
  /** CallRecording.id — used for /api/v1/video/recording/{id}/download when file_id is missing */
  recording_db_id?: number;
  track_type?: string;
}

interface AssetDetail {
  id: string;
  content: string;
  timestamp?: string;
  speaker?: string;
  metadata?: any;
}

interface SessionGroup {
  sessionId: string;
  sessionNumber?: number;
  sessionTitle?: string;
  date: string;
  assets: MeetingAsset[];
  isExpanded: boolean;
}

export default function MeetingDetailsScreen() {
  const router = useRouter();
  const themeColors = useThemeColors();
  const insets = useSafeAreaInsets();
  const { meetingId, meetingTitle, roomCode, entry } = useLocalSearchParams<{
    meetingId: string;
    meetingTitle: string;
    roomCode: string;
    entry?: string;
  }>();

  /** Folder icon on Reach: compact top bar on assets entry */
  const fromAssetsShortcut = entry === 'assets';
  
  const [assets, setAssets] = useState<MeetingAsset[]>([]);
  const [sessionGroups, setSessionGroups] = useState<SessionGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingAll, setDeletingAll] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedAsset, setSelectedAsset] = useState<MeetingAsset | null>(null);
  const [showAssetModal, setShowAssetModal] = useState(false);
  const [assetDetails, setAssetDetails] = useState<AssetDetail[]>([]);
  const [showDocumentViewer, setShowDocumentViewer] = useState(false);
  const [selectedFileForViewing, setSelectedFileForViewing] = useState<{fileId: string; fileName: string; fileType: string; fileCategory?: string} | null>(null);
  const [showVideoPlayer, setShowVideoPlayer] = useState(false);
  const [selectedVideoUrl, setSelectedVideoUrl] = useState<string | null>(null);
  const [originalVideoUrl, setOriginalVideoUrl] = useState<string | null>(null);
  const [videoAssetId, setVideoAssetId] = useState<string | undefined>(undefined);
  const [videoDirectUrl, setVideoDirectUrl] = useState<string | null>(null);
  const [hasTriedVideoFallback, setHasTriedVideoFallback] = useState(false);
  const [isVideoFallbackInProgress, setIsVideoFallbackInProgress] = useState(false);
  const [videoRef, setVideoRef] = useState<Video | null>(null);
  const [videoLoading, setVideoLoading] = useState(false);
  const [videoKey, setVideoKey] = useState(0); // Key counter to force remounts
  const [videoTitle, setVideoTitle] = useState<string>('');
  const [videoBuffering, setVideoBuffering] = useState(true); // Track if video is buffering
  const hasShownVideoErrorRef = useRef(false); // Track if we've shown an error to prevent duplicates
  const assetsLoadInFlightRef = useRef(false); // Prevent duplicate getMeetingAssets (e.g. Strict Mode)
  const videoLoadingTimeoutRef = useRef<NodeJS.Timeout | null>(null); // Timeout for video loading
  const videoBufferingCheckRef = useRef<NodeJS.Timeout | null>(null); // Interval to check buffering progress
  const currentVideoStreamUrlRef = useRef<string | null>(null); // Stream URL we're playing (so we can switch to cache when download completes)
  /** Same as web: cache POST /recording/{id}/share share_url per session */
  const recordingShareUrlCacheRef = useRef<Record<number, string>>({});
  const [menuAsset, setMenuAsset] = useState<MeetingAsset | null>(null);
  const [showTextViewer, setShowTextViewer] = useState(false);
  const [textViewerContent, setTextViewerContent] = useState<string>('');
  const [textViewerTitle, setTextViewerTitle] = useState<string>('');
  const [textViewerAssetType, setTextViewerAssetType] = useState<string>('');
  const [textViewerLoading, setTextViewerLoading] = useState(false);
  const [showAudioPlayer, setShowAudioPlayer] = useState(false);
  const [audioSound, setAudioSound] = useState<Audio.Sound | null>(null);
  const [audioLoading, setAudioLoading] = useState(false);
  const [audioTitle, setAudioTitle] = useState<string>('');
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [audioPosition, setAudioPosition] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekPosition, setSeekPosition] = useState(0);
  const [progressBarWidth, setProgressBarWidth] = useState(300);
  const progressBarRef = useRef<View>(null);
  const [audioLoadingMessage, setAudioLoadingMessage] = useState('Loading audio...');

  // Set audio mode once on mount so playback has sound (required on iOS/Android)
  useEffect(() => {
    Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false,
      interruptionModeIOS: InterruptionModeIOS.DoNotMix,
      interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
    }).catch((err) => console.warn('Audio mode set failed:', err));
  }, []);

  useEffect(() => {
    if (meetingId) {
      loadMeetingAssets();
    }
  }, [meetingId]);

  useEffect(() => {
    organizeAssetsBySession();
  }, [assets, searchQuery, meetingId, meetingTitle]);

  useEffect(() => {
    // Cleanup video when component unmounts
    return () => {
      if (videoRef && !isVideoFallbackInProgress) {
        // Only cleanup if not in the middle of a fallback transition
        videoRef.getStatusAsync()
          .then(status => {
            if (status.isLoaded) {
              return videoRef.unloadAsync();
            }
          })
          .catch((err) => {
            // Silently ignore errors during cleanup
            if (!err?.message?.includes('has not yet loaded')) {
              console.error('Video cleanup error:', err);
            }
          });
      }
      if (audioSound) {
        audioSound.unloadAsync().catch(console.error);
      }
      // Clear loading timeout on unmount
      if (videoLoadingTimeoutRef.current) {
        clearTimeout(videoLoadingTimeoutRef.current);
        videoLoadingTimeoutRef.current = null;
      }
      // Clear buffering check interval
      if (videoBufferingCheckRef.current) {
        clearInterval(videoBufferingCheckRef.current);
        videoBufferingCheckRef.current = null;
      }
    };
  }, [videoRef, audioSound, isVideoFallbackInProgress]);

  // Audio position update interval
  useEffect(() => {
    if (!audioSound || !audioPlaying) return;

    const interval = setInterval(async () => {
      try {
        const status = await audioSound.getStatusAsync();
        if (status.isLoaded) {
          setAudioPosition(status.positionMillis);
          if (status.durationMillis) {
            setAudioDuration(status.durationMillis);
          }
          if (status.didJustFinish) {
            setAudioPlaying(false);
            setAudioPosition(0);
          }
        }
      } catch (error) {
        console.error('Error getting audio status:', error);
      }
    }, 500);

    return () => clearInterval(interval);
  }, [audioSound, audioPlaying]);

  // Loading timeout: if video doesn't load within 20 seconds, check status and show appropriate error
  useEffect(() => {
    if (videoLoading && selectedVideoUrl) {
      // Clear any existing timeout
      if (videoLoadingTimeoutRef.current) {
        clearTimeout(videoLoadingTimeoutRef.current);
      }
      
      // Set new timeout - longer for MP4 videos which may need time to buffer
      videoLoadingTimeoutRef.current = setTimeout(async () => {
        if (videoLoading && !hasShownVideoErrorRef.current && videoRef) {
          // Check video status before assuming format error
          try {
            const status = await videoRef.getStatusAsync();
            if (status.isLoaded) {
              // Video actually loaded, just clear loading state
              console.log('🎬 Video loaded during timeout check');
              setVideoLoading(false);
              return;
            }
          } catch (statusError) {
            console.warn('🎬 Error checking video status:', statusError);
          }
          
          // Video still not loaded after timeout - show loading timeout message (not format error)
          console.warn('🎬 Video loading timeout after 20s');
          setVideoLoading(false);
          hasShownVideoErrorRef.current = true;
          
          const streamUrlForBrowser = (() => {
            const urlToMatch = originalVideoUrl || selectedVideoUrl || '';
            const id = urlToMatch.match(/\/recording\/(\d+)(?:\/|$)/)?.[1];
            return id ? `${API_BASE_URL}/api/v1/video/recording/${id}/stream` : null;
          })();
          
          // Show "Loading Timeout" instead of "Format Not Supported" since backend returns MP4
          Alert.alert(
            'Video Loading Timeout',
            'The video is taking longer than expected to load. This may be due to network speed or file size. You can try opening it in your browser instead.',
            [
              { text: 'OK', style: 'cancel' as const },
              ...(streamUrlForBrowser ? [{
                text: 'Open in Browser',
                onPress: async () => {
                  try {
                    const token = await secureStorage.getItem(STORAGE_KEYS.AUTH_TOKEN);
                    const url = token
                      ? `${streamUrlForBrowser}?token=${encodeURIComponent(token)}&format=mp4`
                      : `${streamUrlForBrowser}?format=mp4`;
                    const canOpen = await Linking.canOpenURL(url);
                    if (canOpen) await Linking.openURL(url);
                    else Alert.alert('Error', 'Cannot open browser');
                  } catch (e) {
                    console.warn('Open in browser failed:', e);
                    Alert.alert('Error', 'Could not open browser');
                  }
                },
              }] : []),
            ]
          );
        }
      }, 20000); // 20 second timeout - MP4 videos may need time to buffer
    } else {
      // Clear timeout when loading stops or URL changes
      if (videoLoadingTimeoutRef.current) {
        clearTimeout(videoLoadingTimeoutRef.current);
        videoLoadingTimeoutRef.current = null;
      }
    }
    
    return () => {
      if (videoLoadingTimeoutRef.current) {
        clearTimeout(videoLoadingTimeoutRef.current);
        videoLoadingTimeoutRef.current = null;
      }
    };
  }, [videoLoading, selectedVideoUrl, originalVideoUrl]);

  const loadMeetingAssets = async () => {
    if (assetsLoadInFlightRef.current) return;
    assetsLoadInFlightRef.current = true;
    try {
      setLoading(true);
      console.log('📁 Loading assets for meeting ID:', meetingId);
      const response = await apiClient.getMeetingAssets();
      if (response.success && response.data) {
        // Handle both response structures: data.assets or data.meetings
        let allAssets: MeetingAsset[] = [];
        
        if (response.data.assets && Array.isArray(response.data.assets)) {
          // Direct assets array - map to ensure file_id is properly extracted
          allAssets = response.data.assets.map((asset: any, index: number) => {
            // Try to find the actual file ID (numeric ID from backend)
            // Check multiple possible property names, but prioritize file_id/fileId
            const fileId = asset.file_id || asset.fileId || asset.file_id_num || 
                          (typeof asset.id === 'number' ? asset.id : null) ||
                          (typeof asset.id === 'string' && /^\d+$/.test(asset.id.trim()) ? parseInt(asset.id.trim(), 10) : null);
            
            // Generate a unique React key/id that's different from file_id
            const reactId = asset.id || (fileId ? `asset_${fileId}` : `asset_${asset.type}_${index}_${Date.now()}`);
            
            if (index < 3) {
              console.log(`📁 Asset ${index} mapping:`, {
                original_id: asset.id,
                file_id: asset.file_id,
                fileId: asset.fileId,
                extracted_file_id: fileId,
                react_id: reactId,
                type: asset.type,
                allKeys: Object.keys(asset)
              });
            }
            
            return {
              ...asset,
              file_id: fileId || undefined, // Only set if we found a valid file ID
              id: reactId, // Use separate id for React keys
            };
          });
          console.log('📁 Found assets array with', allAssets.length, 'assets');
        } else if (response.data.meetings && Array.isArray(response.data.meetings)) {
          // Assets nested in meetings array - flatten them
          console.log('📁 Found meetings array with', response.data.meetings.length, 'meetings');
          
          // First, try to find the matching meeting to understand its structure
          const currentTitleNormalized = (meetingTitle || '').toLowerCase().trim();
          const currentIdNormalized = (meetingId || '').toString();
          
          let matchingMeeting: any = null;
          response.data.meetings.forEach((meeting: any, index: number) => {
            const dbId = meeting.id || meeting.meeting_id;
            const dbTitle = (meeting.title || meeting.meeting_title || '').toLowerCase().trim();
            const hmsMeetingId = meeting.meetingId || meeting.hms_meeting_id;
            
            // Check if this meeting matches
            const idMatch = dbId?.toString() === currentIdNormalized || 
                          hmsMeetingId?.toString() === currentIdNormalized;
            const titleMatch = dbTitle === currentTitleNormalized;
            
            if (idMatch || titleMatch) {
              matchingMeeting = meeting;
              console.log(`📁 Found matching meeting at index ${index}:`, {
                dbId,
                hmsMeetingId,
                title: meeting.title || meeting.meeting_title,
                idMatch,
                titleMatch
              });
            }
            
            console.log(`📁 Meeting ${index} full object keys:`, Object.keys(meeting));
            console.log(`📁 Meeting ${index} structure:`, {
              id: dbId,
              hmsMeetingId: hmsMeetingId,
              title: meeting.title || meeting.meeting_title,
              hasAssets: !!meeting.assets,
              assetsCount: meeting.assets?.length || 0,
              hasFiles: !!meeting.files,
              filesCount: meeting.files?.length || 0,
              allKeys: Object.keys(meeting)
            });
            
            // Check if assets are in a different property
            if (meeting.assets && Array.isArray(meeting.assets)) {
              // Map assets to ensure file_id is properly extracted
              const mappedAssets = meeting.assets.map((asset: any, assetIndex: number) => {
                // Try to find the actual file ID (numeric ID from backend)
                const fileId = asset.file_id || asset.fileId || asset.file_id_num || 
                              (typeof asset.id === 'number' ? asset.id : null) ||
                              (typeof asset.id === 'string' && /^\d+$/.test(asset.id.trim()) ? parseInt(asset.id.trim(), 10) : null);
                
                // Generate a unique React key/id
                const reactId = asset.id || (fileId ? `asset_${fileId}` : `asset_${asset.type}_${assetIndex}_${Date.now()}`);
                
                return {
                  ...asset,
                  file_id: fileId || undefined, // Only set if we found a valid file ID
                  id: reactId, // Use separate id for React keys
                };
              });
              allAssets = allAssets.concat(mappedAssets);
            } else if (meeting.files && Array.isArray(meeting.files)) {
              // Maybe assets are called "files"?
              const mappedFiles = meeting.files.map((file: any, fileIndex: number) => {
                const fileId = file.file_id || file.fileId || file.file_id_num || 
                              (typeof file.id === 'number' ? file.id : null) ||
                              (typeof file.id === 'string' && /^\d+$/.test(file.id.trim()) ? parseInt(file.id.trim(), 10) : null);
                
                const reactId = file.id || (fileId ? `file_${fileId}` : `file_${file.type || 'file'}_${fileIndex}_${Date.now()}`);
                
                return {
                  ...file,
                  file_id: fileId || undefined,
                  id: reactId,
                };
              });
              allAssets = allAssets.concat(mappedFiles);
            }
          });
          
          console.log('📁 Flattened', allAssets.length, 'assets from meetings');
          
          // If no assets found, log a sample meeting and the matching meeting to debug
          if (allAssets.length === 0 && response.data.meetings.length > 0) {
            console.log('📁 Sample meeting object (first meeting):', JSON.stringify(response.data.meetings[0], null, 2));
            if (matchingMeeting) {
              console.log('📁 Matching meeting full object:', JSON.stringify(matchingMeeting, null, 2));
            } else {
              console.log('📁 No matching meeting found in the array - this might be why assets are empty');
            }
          }
        }
        
        console.log('📁 All assets from backend:', allAssets);
        console.log('📁 Asset types found:', allAssets.map((a: any) => a.type));
        
        // Log sample asset to see actual structure
        if (allAssets.length > 0) {
          console.log('📁 Sample asset (first one):', JSON.stringify(allAssets[0], null, 2));
        }
        console.log('📁 Meeting title filter:', meetingTitle);
        console.log('📁 Current meeting ID:', meetingId);
        console.log('📁 Current meeting title:', meetingTitle);
        
        // Filter assets for this specific meeting
        // Note: meetingId might be HMS meeting ID (like 85506248) while backend uses database ID
        // So we need to match by both ID and title
        const meetingAssets = allAssets.filter((asset: MeetingAsset) => {
          // Check if this asset belongs to the current meeting
          // Try multiple matching strategies:
          // 1. Direct ID matches (HMS meeting ID or database ID)
          // 2. Title match (normalized for comparison)
          const assetMeetingId = asset.meeting_id || asset.meetingId || '';
          const assetTitle = (asset.meeting_title || asset.title || '').toLowerCase().trim();
          const currentTitle = (meetingTitle || '').toLowerCase().trim();
          
          const idMatch = assetMeetingId === meetingId || assetMeetingId.toString() === meetingId?.toString();
          const titleMatch = assetTitle === currentTitle && currentTitle !== '';
          
          const belongsToMeeting = idMatch || titleMatch;
          
          console.log(`📁 Asset ${asset.id} (${asset.type}): meetingId=${asset.meetingId}, meeting_id=${asset.meeting_id}, meeting_title=${asset.meeting_title}, title=${asset.title}, idMatch=${idMatch}, titleMatch=${titleMatch}, belongsToMeeting=${belongsToMeeting}`);
          return belongsToMeeting;
        });
        console.log('📁 Filtered assets for meeting:', meetingAssets);
        console.log('📁 Filtered asset types:', meetingAssets.map((a: MeetingAsset) => a.type));
        
        // Check if we have Summary assets
        const hasSummary = meetingAssets.some((asset: MeetingAsset) => 
          asset.type === 'meeting_report' || 
          asset.type === 'summary' || 
          asset.type === 'report' ||
          asset.type === 'meeting_summary'
        );
        
        console.log('📁 Has Summary assets:', hasSummary);
        if (!hasSummary) {
          console.log('📁 No Summary assets found for this meeting');
          console.log('📁 This suggests the backend is not returning Summary assets for this specific meeting');
          console.log('📁 Meeting Summaries are stored in the File table with file_type="meeting_summary" and file_kind="ai_summary"');
          console.log('📁 The backend mobile endpoint may not be querying the File table for these assets');
        }
        
        setAssets(meetingAssets);
      } else {
        console.warn('No meeting assets data returned');
        setAssets([]);
      }
    } catch (error) {
      console.error('Failed to load meeting assets:', error);
      setAssets([]);
    } finally {
      setLoading(false);
      assetsLoadInFlightRef.current = false;
    }
  };

  const organizeAssetsBySession = () => {
    let filteredAssets = assets;

    // Apply search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filteredAssets = filteredAssets.filter(asset =>
        asset.title.toLowerCase().includes(query) ||
        (asset.summary && asset.summary.toLowerCase().includes(query)) ||
        (asset.keywords && asset.keywords.some(keyword => keyword.toLowerCase().includes(query))) ||
        asset.type.toLowerCase().includes(query)
      );
    }

    // Group by meeting name AND session number
    // Assets should be grouped by session like in the web version
    const groupedBySessions: { [sessionKey: string]: MeetingAsset[] } = {};
    
    filteredAssets.forEach(asset => {
      // Use meeting title + session number as the grouping key
      const meetingTitle = (asset.meeting_title || asset.title || 'Unknown Meeting').trim();
      const sessionNumber = asset.session_number || 0; // 0 for legacy assets without session
      const sessionKey = `${meetingTitle.toLowerCase()}_session_${sessionNumber}`;
      
      if (!groupedBySessions[sessionKey]) {
        groupedBySessions[sessionKey] = [];
        console.log(`📁 Creating new session group: ${meetingTitle} - Session ${sessionNumber}`);
      }
      groupedBySessions[sessionKey].push(asset);
    });
    
    console.log(`📁 Total session groups created: ${Object.keys(groupedBySessions).length}`);

    // Convert to SessionGroup array
    const groups: SessionGroup[] = Object.keys(groupedBySessions)
      .map(sessionKey => {
        const sessionAssets = groupedBySessions[sessionKey];
        
        // Sort assets within session by date (newest first)
        sessionAssets.sort((a, b) => {
          return new Date(b.date).getTime() - new Date(a.date).getTime();
        });
        
        // Get the first asset to extract meeting and session info
        const firstAsset = sessionAssets[0];
        
        // Use the meeting title (properly cased) from the first asset
        const meetingTitle = firstAsset.meeting_title || firstAsset.title || 'Unknown Meeting';
        const sessionNumber = firstAsset.session_number || 0;
        
        // Newest-first sort above: show the latest asset date on the session header
        const sessionDate = firstAsset.date;
        
        return {
          sessionId: sessionKey, // Using sessionKey as unique identifier
          sessionNumber: sessionNumber,
          sessionTitle: `Session ${sessionNumber}`,
          date: sessionDate,
          assets: sessionAssets,
          isExpanded: false, // set below: exactly one group expanded
        };
      })
      .sort((a, b) => {
        // Sort sessions by date (newest first)
        return new Date(b.date).getTime() - new Date(a.date).getTime();
      });

    const routeId = String(meetingId || '').trim();
    const routeTitle = (meetingTitle || '').toLowerCase().trim();

    const groupMatchesOpenedMeeting = (g: SessionGroup) =>
      g.assets.some((asset) => {
        const aid = String(asset.meeting_id ?? asset.meetingId ?? '').trim();
        const atitle = (asset.meeting_title || asset.title || '').toLowerCase().trim();
        const idMatch = !!routeId && !!aid && aid === routeId;
        const titleMatch = !!routeTitle && atitle === routeTitle;
        return idMatch || titleMatch;
      });

    // Expand only the newest session that belongs to the meeting we opened (same id/title rules as asset filter).
    let expandedSessionId: string | null = null;
    if (groups.length === 1) {
      expandedSessionId = groups[0].sessionId;
    } else if (groups.length > 1) {
      const match = groups.find(groupMatchesOpenedMeeting);
      expandedSessionId = match ? match.sessionId : groups[0].sessionId;
    }

    const withExpansion = groups.map((g) => ({
      ...g,
      isExpanded: expandedSessionId != null && g.sessionId === expandedSessionId,
    }));

    setSessionGroups(withExpansion);
  };

  /** Accordion: at most one session expanded; opening one collapses all others. */
  const toggleSessionGroup = (sessionId: string) => {
    setSessionGroups((prev) => {
      if (prev.length <= 1) {
        return prev.map((group) =>
          group.sessionId === sessionId ? { ...group, isExpanded: !group.isExpanded } : group
        );
      }

      const clicked = prev.find((g) => g.sessionId === sessionId);
      if (!clicked) return prev;

      const opening = !clicked.isExpanded;
      return prev.map((group) => ({
        ...group,
        isExpanded: opening ? group.sessionId === sessionId : false,
      }));
    });
  };

  const playRecording = async (asset: MeetingAsset) => {
    try {
      // Helper function to check if URL/filename is audio
      const isAudioFile = (url: string): boolean => {
        const audioExtensions = ['.m4a', '.mp3', '.wav', '.aac', '.ogg', '.flac', '.m4p'];
        const lowerUrl = url.toLowerCase();
        return audioExtensions.some(ext => lowerUrl.includes(ext)) || 
               lowerUrl.includes('/audio/');
      };
      
      // Helper function to check if URL/filename is video
      const isVideoFile = (url: string): boolean => {
        const videoExtensions = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.flv', '.wmv', '.3gp'];
        const lowerUrl = url.toLowerCase();
        return videoExtensions.some(ext => lowerUrl.includes(ext)) || 
               lowerUrl.includes('/video/') ||
               lowerUrl.includes('/recordings/');
      };
      
      // Check if explicitly marked as audio-only
      const isExplicitlyAudioOnly = asset.quality === 'audio_only';
      
      // Check file extensions first (most reliable)
      const hasAudioExtension = (asset.url && isAudioFile(asset.url)) ||
                                 (asset.downloadUrl && isAudioFile(asset.downloadUrl)) ||
                                 (asset.original_filename && isAudioFile(asset.original_filename));
      
      const hasVideoExtension = (asset.url && isVideoFile(asset.url)) ||
                                (asset.downloadUrl && isVideoFile(asset.downloadUrl)) ||
                                (asset.original_filename && isVideoFile(asset.original_filename));
      
      // Determine if it's audio based on explicit quality, file extension, or asset properties
      // Priority: explicit audio-only > video extension > audio extension > quality check
      const isAudio = isExplicitlyAudioOnly || 
                     (hasAudioExtension && !hasVideoExtension) ||
                     (!hasVideoExtension && !hasAudioExtension && asset.type === 'recording' && asset.quality !== 'hd' && asset.quality !== 'sd');
      
      console.log(isAudio ? '🎵 Audio asset detected' : '🎬 Video asset detected', { 
        hasFileId: !!asset.file_id, 
        fileId: asset.file_id,
        hasUrl: !!asset.url,
        url: asset.url?.substring(0, 50),
        quality: asset.quality,
        type: asset.type,
        isAudio,
        hasAudioExtension,
        hasVideoExtension
      });
      
      // If we have file_id, always use the backend download endpoint (handles auth properly)
      // Append auth token as query param since expo-av can't send headers
      if (asset.file_id) {
        const token = await secureStorage.getItem(STORAGE_KEYS.AUTH_TOKEN);
        let downloadUrl = `${API_BASE_URL}/api/v1/mobile/file/${asset.file_id}/download`;
        // Append token as query parameter if available (backend should accept this)
        if (token) {
          downloadUrl += `?token=${encodeURIComponent(token)}`;
        }
        
        if (isAudio) {
          // For audio files, download, cache, and play with audio player
          await playAudioWithCache(downloadUrl, asset.title || asset.original_filename || 'Audio', asset.id);
          return;
        } else {
          // For video files, download, cache, and play with video player
          console.log('🎬 Playing video from download endpoint:', downloadUrl);
          await playVideoWithCache(downloadUrl, asset.title || asset.original_filename || 'Video', asset.id, asset.url || asset.downloadUrl);
        }
          return;
      }
      
      // Fallback: Use direct URLs if available (only if no file_id)
      let mediaUrl = asset.url || asset.downloadUrl || asset.local_recording_path;
      
      if (!mediaUrl) {
        Alert.alert('Error', 'No recording URL available');
        return;
      }

      // If we have a direct URL (http/https), try to use it
      // If it fails (likely due to auth), try to get file_id from backend or use download endpoint
      if (mediaUrl.startsWith('http://') || mediaUrl.startsWith('https://')) {
        // First, try using CallRecording endpoint if we have recording ID (more reliable)
        // This works for both audio and video recordings
        if (asset.id && typeof asset.id === 'string') {
          const idMatch = asset.id.match(/call_recording[_-](\d+)$/);
          if (idMatch) {
            const recordingId = parseInt(idMatch[1], 10);
            let playbackSucceeded = false;
            
            try {
              // Use the video recording stream endpoint (handles auth server-side)
              const streamUrl = `${API_BASE_URL}/api/v1/video/recording/${recordingId}/stream`;
              
              if (isAudio) {
                console.log('🎵 Using CallRecording endpoint for audio recording ID:', recordingId);
                await playAudioWithCache(streamUrl, asset.title || asset.original_filename || 'Audio', asset.id);
              } else {
                console.log('🎬 Using CallRecording endpoint for video recording ID:', recordingId);
                await playVideoWithCache(streamUrl, asset.title || asset.original_filename || 'Video', asset.id, mediaUrl);
              }
              playbackSucceeded = true;
            } catch (recordingError) {
              console.error('Recording endpoint failed, trying direct URL:', recordingError);
            }
            
            if (playbackSucceeded) {
              return;
            }
          }
        }
        
        // If recording endpoint didn't work or no recording ID, try direct URL
        if (isAudio) {
          try {
            console.log('🎵 Playing audio from direct URL:', mediaUrl);
            await playAudioWithCache(mediaUrl, asset.title || asset.original_filename || 'Audio', asset.id);
          } catch (audioError) {
            console.error('Audio playback error (direct URL failed):', audioError);
            Alert.alert('Error', 'Failed to play audio. The file may not be available or accessible.');
          }
        } else {
          // For video files, download, cache, and play with video player
          console.log('🎬 Playing video from URL:', mediaUrl);
          await playVideoWithCache(mediaUrl, asset.title || asset.original_filename || 'Video', asset.id, mediaUrl);
        }
        return;
      }
      
      // If we have file_id but no direct URL, use the download endpoint
      if (asset.file_id && !mediaUrl.startsWith('http')) {
        const downloadUrl = `${API_BASE_URL}/api/v1/mobile/file/${asset.file_id}/download`;
        // Reuse the same detection logic
        const fileIsAudio = isExplicitlyAudioOnly || 
                            (asset.original_filename && isAudioFile(asset.original_filename) && !isVideoFile(asset.original_filename));
        
        if (fileIsAudio) {
          // For audio files, download, cache, and play with audio player
          await playAudioWithCache(downloadUrl, asset.title || asset.original_filename || 'Audio', asset.id);
        } else {
          // For video files, download, cache, and play with video player
          console.log('🎬 Playing video from download endpoint:', downloadUrl);
          await playVideoWithCache(downloadUrl, asset.title || asset.original_filename || 'Video', asset.id, mediaUrl);
        }
        return;
      }

      // For cloud URLs or direct URLs (duplicate check - should not reach here, but keeping for safety)
      if (mediaUrl.startsWith('http://') || mediaUrl.startsWith('https://')) {
        const urlIsAudio = isExplicitlyAudioOnly || 
                          (isAudioFile(mediaUrl) && !isVideoFile(mediaUrl)) ||
                          (asset.original_filename && isAudioFile(asset.original_filename) && !isVideoFile(asset.original_filename));
        
        if (urlIsAudio) {
          // For audio files, download, cache, and play with audio player
          await playAudioWithCache(mediaUrl, asset.title || asset.original_filename || 'Audio', asset.id);
        } else {
          // For video files, download, cache, and play with video player
          await playVideoWithCache(mediaUrl, asset.title || asset.original_filename || 'Video', asset.id, mediaUrl);
        }
      } else {
        // Try to open in external player for local paths
        const canOpen = await Linking.canOpenURL(mediaUrl);
        if (canOpen) {
          await Linking.openURL(mediaUrl);
        } else {
          Alert.alert('Error', 'Cannot open this recording. Please check the file path.');
        }
      }
    } catch (error) {
      console.error('Play recording error:', error);
      Alert.alert('Error', 'Failed to play recording');
    }
  };

  // Simple hash function for creating unique cache keys
  const simpleHash = (str: string): string => {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(36);
  };

  const playVideoWithCache = async (videoUrl: string, title: string, assetId?: string, directUrl?: string) => {
    // Get auth token to append to URL if needed (outside try block so it's available in catch)
    let token: string | null = null;
    try {
      token = await secureStorage.getItem(STORAGE_KEYS.AUTH_TOKEN);
    } catch (tokenError) {
      console.warn('Failed to retrieve auth token:', tokenError);
    }
    
    try {
      let finalUrl = videoUrl;
      
      // If URL doesn't already have auth, append token as query parameter
      // This allows expo-av to authenticate while using progressive streaming
      if (token && !videoUrl.includes('token=')) {
        const separator = videoUrl.includes('?') ? '&' : '?';
        finalUrl = `${videoUrl}${separator}token=${encodeURIComponent(token)}`;
      }
      // Request MP4 so backend transcodes WebM→MP4 for iOS/Android (backend checks format=mp4)
      if (finalUrl.includes('/recording/') && finalUrl.includes('/stream') && !finalUrl.includes('format=mp4')) {
        finalUrl += finalUrl.includes('?') ? '&format=mp4' : '?format=mp4';
      }
      
      // Check if URL has unsupported format extension (WebM not supported on iOS native player)
      const urlLower = finalUrl.toLowerCase();
      if (urlLower.includes('.webm') || (urlLower.includes('/download') && !urlLower.includes('format=mp4') && !urlLower.includes('/stream'))) {
        console.warn('🎬 Detected WebM or unsupported format - will likely fail, showing browser option');
        // Don't prevent trying, but we'll timeout faster if it fails
      }

      // Use cached file when available to avoid loading from network each time
      const videoCachePath = getVideoCachePath(assetId, finalUrl);
      let uriToPlay = finalUrl;
      try {
        const cached = await FileSystem.getInfoAsync(videoCachePath);
        if (cached.exists && (cached.size ?? 0) > 0) {
          // expo-av expects file:// for local paths on some platforms
          uriToPlay = videoCachePath.startsWith('file://') ? videoCachePath : `file://${videoCachePath}`;
          console.log('🎬 Playing video from cache (no network load)');
        }
      } catch (_) {
        // Ignore cache check errors; fall back to stream
      }
      
      console.log(uriToPlay === videoCachePath ? '🎬 Starting cached video playback' : '🎬 Starting progressive video playback:', uriToPlay === videoCachePath ? '(cached)' : finalUrl);
      
      // Store original URL and assetId for fallback
      setOriginalVideoUrl(videoUrl);
      setVideoAssetId(assetId);
      setVideoDirectUrl(directUrl || null); // Store direct URL for fallback
      setHasTriedVideoFallback(false); // Reset fallback flag
      setIsVideoFallbackInProgress(false); // Reset fallback progress flag
      hasShownVideoErrorRef.current = false; // Reset error shown flag
      
      setVideoTitle(title);
      setSelectedVideoUrl(uriToPlay);
      setShowVideoPlayer(true);
      setVideoLoading(true);
      setVideoBuffering(uriToPlay !== (videoCachePath.startsWith('file://') ? videoCachePath : `file://${videoCachePath}`)); // Cached file typically doesn't need buffering

      const isPlayingFromCache = (uriToPlay.startsWith('file://') || uriToPlay === videoCachePath);
      if (isPlayingFromCache) {
        currentVideoStreamUrlRef.current = null;
      } else {
        currentVideoStreamUrlRef.current = finalUrl; // So we can switch to cache when download completes
      }

      // When streaming (not from cache), download to cache in background; when done, switch playback to cache so video starts (stream can take 1–2 min to transcode)
      if (!isPlayingFromCache && finalUrl.includes('/recording/')) {
        const recordingIdMatch = finalUrl.match(/\/recording\/(\d+)\//);
        if (recordingIdMatch && token) {
          const recordingId = recordingIdMatch[1];
          const downloadUrl = `${API_BASE_URL}/api/v1/video/recording/${recordingId}/download?token=${encodeURIComponent(token)}&format=mp4`;
          const streamUrlForSwitch = finalUrl;
          const pathForSwitch = videoCachePath;
          FileSystem.downloadAsync(downloadUrl, videoCachePath).then(() => {
            console.log('🎬 Video cached for next playback');
            // If we're still showing this stream (user didn't close or change video), switch to cached file so playback can start (backend stream can take 1–2 min to transcode)
            if (currentVideoStreamUrlRef.current === streamUrlForSwitch) {
              const fileUri = pathForSwitch.startsWith('file://') ? pathForSwitch : `file://${pathForSwitch}`;
              setSelectedVideoUrl(fileUri);
              setVideoKey((k) => k + 1);
              setVideoLoading(false);
              setVideoBuffering(false);
              currentVideoStreamUrlRef.current = null;
              console.log('🎬 Switched to cached file – playback should start');
            }
          }).catch(() => {});
        }
      }
      
    } catch (error) {
      console.error('Failed to prepare video playback:', error);
      setVideoLoading(false);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      Alert.alert(
        'Failed to Play Video',
        `Unable to load video file. ${errorMessage.includes('authentication') ? 'The file requires authentication.' : 'Please try again later.'}`
      );
      setShowVideoPlayer(false);
    }
  };

  const getAudioCachePath = (assetId?: string, url?: string): string => {
    const dir = FileSystem.cacheDirectory || FileSystem.documentDirectory || '';
    const key = assetId || (url ? 'url_' + String(url.split('').reduce((a: number, b: string) => ((a << 5) - a) + b.charCodeAt(0), 0) % 1e9) : 'audio');
    const safe = key.replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 80);
    return `${dir}meeting_audio_${safe}.m4a`;
  };

  const getVideoCachePath = (assetId?: string, url?: string): string => {
    const dir = FileSystem.cacheDirectory || FileSystem.documentDirectory || '';
    const key = assetId || (url ? 'url_' + String(url.split('').reduce((a: number, b: string) => ((a << 5) - a) + b.charCodeAt(0), 0) % 1e9) : 'video');
    const safe = key.replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 80);
    return `${dir}meeting_video_${safe}.mp4`;
  };

  const playAudioWithCache = async (audioUrl: string, title: string, assetId?: string) => {
    let token: string | null = null;
    try {
      token = await secureStorage.getItem(STORAGE_KEYS.AUTH_TOKEN);
    } catch (tokenError) {
      console.warn('Failed to retrieve auth token:', tokenError);
    }

    // Show modal and loading UI immediately so user never sees a blank screen
    setAudioTitle(title);
    setShowAudioPlayer(true);
    setAudioLoading(true);
    setAudioLoadingMessage('Preparing...');

    const doPlay = async () => {
      try {
        let finalUrl = audioUrl;
        if (token && !audioUrl.includes('token=')) {
          const separator = audioUrl.includes('?') ? '&' : '?';
          finalUrl = `${audioUrl}${separator}token=${encodeURIComponent(token)}`;
        }

        const cachePath = getAudioCachePath(assetId, audioUrl);
        const cached = await FileSystem.getInfoAsync(cachePath);

        if (cached.exists && (cached.size ?? 0) > 0) {
          setAudioLoadingMessage('Loading...');
          const { sound } = await Audio.Sound.createAsync(
            { uri: cachePath },
            { shouldPlay: false, isMuted: false, volume: 1.0 }
          );
          await sound.setVolumeAsync(1);
          await sound.setIsMutedAsync(false);
          const status = await sound.getStatusAsync();
          if (status.isLoaded && status.durationMillis) setAudioDuration(status.durationMillis);
          setAudioSound(sound);
          await sound.playAsync();
          setAudioPlaying(true);
          setAudioLoading(false);
          console.log('🎵 Audio playing from cache');
          return;
        }

        // Progressive play: stream from URL — playback starts as data arrives, no full download first
        setAudioLoadingMessage('Loading audio...');
        const { sound } = await Audio.Sound.createAsync(
          { uri: finalUrl },
          { shouldPlay: false, isMuted: false, volume: 1.0 }
        );
        await new Promise(resolve => setTimeout(resolve, 100));
        const status = await sound.getStatusAsync();
        if (!status.isLoaded) throw new Error('Audio failed to load - file may be corrupted or unsupported format');
        if (status.durationMillis) setAudioDuration(status.durationMillis);
        setAudioSound(sound);
        await sound.setVolumeAsync(1);
        await sound.setIsMutedAsync(false);
        await sound.playAsync();
        setAudioPlaying(true);
        setAudioLoading(false);
        console.log('🎵 Audio playback started (progressive stream)');

        // Cache in background for next time (does not block playback)
        if (audioUrl.includes('/recording/') && (audioUrl.includes('/stream') || audioUrl.includes('/download'))) {
          const recordingIdMatch = audioUrl.match(/\/recording\/(\d+)\//);
          if (recordingIdMatch) {
            const recordingId = recordingIdMatch[1];
            const downloadUrl = `${API_BASE_URL}/api/v1/video/recording/${recordingId}/download`;
            const downloadFinal = token ? `${downloadUrl}?token=${encodeURIComponent(token)}` : downloadUrl;
            FileSystem.downloadAsync(downloadFinal, cachePath).catch(() => {});
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes('format is not supported') || errorMessage.includes('-11828')) {
          if (audioUrl.includes('/recording/') && audioUrl.includes('/stream')) {
            const recordingIdMatch = audioUrl.match(/\/recording\/(\d+)\//);
            if (recordingIdMatch) {
              const recordingId = recordingIdMatch[1];
              const downloadUrl = `${API_BASE_URL}/api/v1/video/recording/${recordingId}/download`;
              const fallbackUrl = token ? `${downloadUrl}?token=${encodeURIComponent(token)}` : downloadUrl;
              const cachePath = getAudioCachePath(assetId, audioUrl);

              // Try progressive play from download URL first (no full download wait)
              try {
                setAudioLoadingMessage('Loading audio...');
                const { sound: fallbackSound } = await Audio.Sound.createAsync(
                  { uri: fallbackUrl },
                  { shouldPlay: false, isMuted: false, volume: 1.0 }
                );
                await fallbackSound.setVolumeAsync(1);
                await fallbackSound.setIsMutedAsync(false);
                const st = await fallbackSound.getStatusAsync();
                if (st.isLoaded && st.durationMillis) setAudioDuration(st.durationMillis);
                setAudioSound(fallbackSound);
                await fallbackSound.playAsync();
                setAudioPlaying(true);
                setAudioLoading(false);
                console.log('🎵 Audio playing from download URL (progressive)');
                // Cache in background for next time
                FileSystem.downloadAsync(fallbackUrl, cachePath).catch(() => {});
                return;
              } catch (streamFallbackError) {
                console.warn('Progressive fallback failed, trying full download:', streamFallbackError);
              }

              // Last resort: full download then play (only when streaming fails)
              try {
                setAudioLoadingMessage('Downloading...');
                await FileSystem.downloadAsync(fallbackUrl, cachePath);
                setAudioLoadingMessage('Loading...');
                const { sound: fallbackSound } = await Audio.Sound.createAsync(
                  { uri: cachePath },
                  { shouldPlay: false, isMuted: false, volume: 1.0 }
                );
                await fallbackSound.setVolumeAsync(1);
                await fallbackSound.setIsMutedAsync(false);
                const st = await fallbackSound.getStatusAsync();
                if (st.isLoaded && st.durationMillis) setAudioDuration(st.durationMillis);
                setAudioSound(fallbackSound);
                await fallbackSound.playAsync();
                setAudioPlaying(true);
                setAudioLoading(false);
                console.log('🎵 Audio playing from cache (full download fallback)');
                return;
              } catch (fullDownloadError) {
                console.error('Full download fallback failed:', fullDownloadError);
              }
            }
          }
        }
        setAudioLoading(false);
        console.error('🎵 Audio playback failed:', { errorMessage: errorMessage, audioUrl });
        Alert.alert('Error', `Failed to play audio: ${errorMessage}`);
        setShowAudioPlayer(false);
      }
    };

    // Defer heavy work so modal and loading spinner paint first
    InteractionManager.runAfterInteractions(() => {
      doPlay();
    });
  };

  const openFile = async (asset: MeetingAsset) => {
    try {
      // Use fallback values since config endpoint is not available
      const basePath = 'C:\\llm\\projects\\grabdocs-app\\grabdocs\\manager-francis\\data';
      const username = 'francis';
      console.log('Using fallback values:', { basePath, username });
      
      let localPath = '';
      
      // Get the filename from the asset (should be in format: {file_type}_{video_call_id}_{timestamp}_{uuid}.{ext})
      const filename = asset.title || asset.id || 'unknown';
      
      switch (asset.type) {
        case 'recording':
          // Private recordings: {base_path}/{username}/recordings/
          localPath = `${basePath}/${username}/recordings/${filename}`;
          break;
        case 'transcript':
          // Private transcripts: {base_path}/{username}/transcripts/
          localPath = `${basePath}/${username}/transcripts/${filename}`;
          break;
        case 'meeting_report':
          // Reports stored with transcripts: {base_path}/{username}/transcripts/
          localPath = `${basePath}/${username}/transcripts/${filename}`;
          break;
        case 'chat_log':
          // Shared chat logs: {base_path}/shared_chats/
          localPath = `${basePath}/shared_chats/${filename}`;
          break;
        case 'shared_files':
          // Shared meeting files: {base_path}/shared_meeting_files/
          localPath = `${basePath}/shared_meeting_files/${filename}`;
          break;
        case 'notes':
        case 'whiteboard':
          // These might be stored as shared files or in transcripts
          localPath = `${basePath}/shared_meeting_files/${filename}`;
          break;
        default:
          // Fallback to shared files
          localPath = `${basePath}/shared_meeting_files/${filename}`;
      }

      // If we have a direct local path from the database, use that instead
      if (asset.local_recording_path) {
        localPath = asset.local_recording_path;
        console.log(`📁 Using database local_recording_path: ${localPath}`);
      } else if (asset.local_file_path) {
        localPath = asset.local_file_path;
        console.log(`📁 Using database local_file_path: ${localPath}`);
      } else if (asset.local_transcript_path) {
        localPath = asset.local_transcript_path;
        console.log(`📁 Using database local_transcript_path: ${localPath}`);
      } else if (asset.local_chat_path) {
        localPath = asset.local_chat_path;
        console.log(`📁 Using database local_chat_path: ${localPath}`);
      } else if (asset.local_report_path) {
        localPath = asset.local_report_path;
        console.log(`📁 Using database local_report_path: ${localPath}`);
      } else {
        console.log(`📁 No local paths found, using constructed path: ${localPath}`);
        // Don't use asset.url as it's likely a cloud URL
      }

      if (!localPath) {
        Alert.alert('Error', 'No file path available for this asset');
        return;
      }

      // Check if this is a cloud URL (not a local path)
      if (localPath.startsWith('http://') || localPath.startsWith('https://') || localPath.startsWith('gcp-')) {
        Alert.alert(
          'Cloud URL Detected',
          `This file is stored in the cloud and cannot be opened locally.\n\nURL: ${localPath}\n\nPlease contact support to download the file locally.`,
          [
            { text: 'Copy URL', onPress: async () => {
              await Clipboard.setStringAsync(localPath);
              Alert.alert('Copied', 'Cloud URL copied to clipboard');
            }},
            { text: 'Cancel', style: 'cancel' }
          ]
        );
        return;
      }

      console.log(`🔍 Opening file: ${localPath} for asset type: ${asset.type}`);
      console.log(`📁 Asset details:`, {
        title: asset.title,
        type: asset.type,
        id: asset.id,
        filename: filename,
        url: asset.url,
        local_recording_path: asset.local_recording_path,
        local_file_path: asset.local_file_path
      });

      // Try to open the file in the device's default app
      const canOpen = await Linking.canOpenURL(localPath);
      if (canOpen) {
        await Linking.openURL(localPath);
      } else {
        // If we can't open the file directly, show file info
        Alert.alert(
          'View File',
          `File: ${asset.title}\n\nType: ${asset.type}\nPath: ${localPath}\nSize: ${asset.size || 'Unknown'}`,
          [
            { text: 'Copy Path', onPress: async () => {
              // Copy to clipboard
              await Clipboard.setStringAsync(localPath);
              Alert.alert('Copied', 'File path copied to clipboard');
            }},
            { text: 'Cancel', style: 'cancel' }
          ]
        );
      }
    } catch (error) {
      console.error('Open file error:', error);
      Alert.alert('Error', 'Failed to open file');
    }
  };

  const viewAsset = async (asset: MeetingAsset) => {
    try {
      // Define text-based asset types that should open in DocumentViewer
      const textTypes = [
        'transcript',
        'call_transcript',
        'meeting_summary',
        'summary',
        'report',
        'meeting_report',
        'chat_log',
        'chat',
        'meeting_chat',
        'notes'
      ];
      
      // Define audio/video asset types that should play in a player
      const mediaTypes = ['recording', 'video'];
      
      // Check if it's a text type - open in TextAssetViewer (same as web)
      if (textTypes.includes(asset.type)) {
        const defaultTitle = asset.type === 'transcript' || asset.type === 'call_transcript' ? 'Transcript' :
                            asset.type === 'meeting_summary' || asset.type === 'summary' ? 'Summary' :
                            asset.type === 'meeting_report' || asset.type === 'report' ? 'Report' :
                            asset.type === 'chat_log' || asset.type === 'chat' || asset.type === 'meeting_chat' ? 'Chat' :
                            asset.type === 'notes' ? 'Notes' : 'Document';
        const fullTitle = asset.title || asset.original_filename || defaultTitle;

        setTextViewerLoading(true);
        setShowTextViewer(true);
        setTextViewerTitle(fullTitle);
        setTextViewerAssetType(asset.type);

        try {
          if (asset.file_id) {
            // Same as web: /api/v1/web/files/:id/view
            const content = await apiClient.getWebFileContent(Number(asset.file_id));
            setTextViewerContent(content);
          } else if (asset.url) {
            // Same as web: /api/v1/video/asset-content?asset_type=&url=
            const assetType = asset.type === 'transcript' || asset.type === 'call_transcript' ? 'transcript' :
                             asset.type === 'meeting_summary' || asset.type === 'summary' ? 'meeting_summary' :
                             asset.type === 'meeting_report' || asset.type === 'report' ? 'meeting_report' :
                             asset.type === 'chat_log' || asset.type === 'chat' || asset.type === 'meeting_chat' ? 'meeting_chat' :
                             asset.type === 'notes' ? 'meeting_note' : 'transcript';
            const content = await apiClient.getVideoAssetContent(assetType, asset.url);
            setTextViewerContent(content);
          } else {
            setTextViewerLoading(false);
            setShowTextViewer(false);
            if (asset.local_transcript_path || asset.local_file_path || asset.local_chat_path || asset.local_report_path) {
              await openFile(asset);
            } else {
              Alert.alert('Error', 'No file available for this asset');
            }
            return;
          }
          setTextViewerLoading(false);
        } catch (error) {
          console.error('Failed to fetch text asset content:', error);
          setTextViewerLoading(false);
          Alert.alert('Error', 'Failed to load content. The file may not be available.');
          setShowTextViewer(false);
        }
        return;
      }

      // Check if it's audio or video - play in player
      if (mediaTypes.includes(asset.type)) {
        await playRecording(asset);
        return;
      }
      
      // For other types (shared_files, files, whiteboard, etc.), try to open file or show modal
      if (asset.file_id) {
        // If it has a file_id, try DocumentViewer first
        const fileType = asset.original_filename 
          ? getFileTypeFromFilename(asset.original_filename)
          : 'document';
        
        setSelectedFileForViewing({
          fileId: String(asset.file_id),
          fileName: asset.title || asset.original_filename || 'File',
          fileType: fileType,
          fileCategory: asset.type
        });
        setShowDocumentViewer(true);
        return;
      } else if (asset.local_file_path || asset.local_report_path || asset.url) {
        await openFile(asset);
        return;
      }
      
      // Fallback: show modal for other cases
      setSelectedAsset(asset);
      setShowAssetModal(true);
      setAssetDetails([{
        id: '1',
        content: `Asset: ${asset.title}\nType: ${asset.type}\nDate: ${asset.date}`,
        timestamp: asset.date,
        speaker: 'System'
      }]);
    } catch (error) {
      console.error('Failed to view asset:', error);
      Alert.alert('Error', 'Failed to open asset');
    }
  };

  const getFileTypeFromFilename = (filename: string): string => {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'];
    const pdfExts = ['pdf'];
    const docExts = ['doc', 'docx'];
    const xlsExts = ['xls', 'xlsx', 'csv'];
    const textExts = ['txt', 'md'];
    const videoExts = ['mp4', 'mov', 'avi', 'mkv'];
    const audioExts = ['mp3', 'wav', 'm4a', 'aac'];
    
    if (imageExts.includes(ext)) return 'image';
    if (pdfExts.includes(ext)) return 'application/pdf';
    if (docExts.includes(ext)) return 'application/msword';
    if (xlsExts.includes(ext)) return 'application/vnd.ms-excel';
    if (textExts.includes(ext)) return 'text/plain';
    if (videoExts.includes(ext)) return 'video';
    if (audioExts.includes(ext)) return 'audio';
    
    return 'document';
  };

  const downloadAsset = async (asset: MeetingAsset) => {
    try {
      Alert.alert('Download', `Downloading ${asset.title}...`);
      
      const downloadInfo = await apiClient.downloadMeetingAsset(
        asset.meetingId || asset.id, 
        asset.type
      );
      
      if (downloadInfo.url) {
        Alert.alert('Download Ready', `Download URL: ${downloadInfo.url}`);
      }
    } catch (error) {
      console.error('Download failed:', error);
      Alert.alert('Error', 'Failed to download asset');
    }
  };

  const getShareMimeType = (extension: string): string => {
    const mimeTypes: Record<string, string> = {
      pdf: 'application/pdf',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      txt: 'text/plain',
      csv: 'text/csv',
      vtt: 'text/vtt',
      json: 'application/json',
      mp4: 'video/mp4',
      mov: 'video/quicktime',
      m4a: 'audio/mp4',
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      webm: 'video/webm',
    };
    return mimeTypes[extension.toLowerCase()] || 'application/octet-stream';
  };

  const mimeTypeFromDownloadHeaders = (headers: Record<string, string> | undefined): string | null => {
    if (!headers) return null;
    const raw =
      headers['Content-Type'] ||
      headers['content-type'] ||
      headers['Content-type'] ||
      '';
    const base = raw.split(';')[0].trim().toLowerCase();
    return base || null;
  };

  /** True when this row is an audio-only meeting recording (not room-composite / video). */
  const isAudioMeetingRecordingAsset = (asset: MeetingAsset): boolean => {
    if (asset.type !== 'recording' && asset.type !== 'video') return false;
    const anyAsset = asset as any;
    const tt = String(anyAsset.track_type || anyAsset.trackType || '').toLowerCase();
    if (tt === 'audio' || tt.includes('audio-m4a') || tt === 'audio_only') return true;
    if (asset.quality === 'audio_only') return true;
    const paths = [
      asset.url,
      asset.downloadUrl,
      asset.original_filename,
      asset.local_recording_path,
    ].filter(Boolean) as string[];
    for (const p of paths) {
      const lower = p.toLowerCase();
      if (/\.(m4a|mp3|aac|wav|opus)(\?|#|$)/i.test(lower)) return true;
      if (lower.includes('/audio/')) return true;
    }
    return false;
  };

  const readLocalFileHeadBytes = async (uri: string, byteLength: number): Promise<Uint8Array | null> => {
    try {
      const b64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
        length: byteLength,
        position: 0,
      });
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch {
      return null;
    }
  };

  /**
   * Prefer magic bytes over Content-Type (proxies often mislabel MP3/MP4 as video/webm).
   */
  const inferShareMimeFromMagic = (bytes: Uint8Array | null, isAudioAsset: boolean): string | null => {
    if (!bytes || bytes.length < 12) return null;
    if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'audio/mpeg';
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return 'audio/mpeg';
    if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
      return isAudioAsset ? 'audio/mp4' : 'video/mp4';
    }
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
      return isAudioAsset ? 'audio/webm' : 'video/webm';
    }
    return null;
  };

  const extractCallRecordingDbId = (asset: MeetingAsset): number | null => {
    const anyAsset = asset as any;
    if (anyAsset.recording_db_id != null && !Number.isNaN(Number(anyAsset.recording_db_id))) {
      return Number(anyAsset.recording_db_id);
    }
    if (typeof asset.id === 'string') {
      const m = asset.id.match(/call_recording[_-](\d+)/i);
      if (m) return parseInt(m[1], 10);
    }
    for (const u of [asset.url, asset.downloadUrl]) {
      if (!u) continue;
      const m = u.match(/\/recording\/(\d+)\/(?:stream|download)/i);
      if (m) return parseInt(m[1], 10);
    }
    return null;
  };

  const extractCallTranscriptDbId = (asset: MeetingAsset): number | null => {
    if (typeof asset.id !== 'string') return null;
    const m = asset.id.match(/call_transcript[_-](\d+)/i);
    return m ? parseInt(m[1], 10) : null;
  };

  const recordingShareFilename = (asset: MeetingAsset): string => {
    const anyAsset = asset as any;
    const base = (asset.original_filename || asset.title || 'recording').replace(/[^a-zA-Z0-9.-]/g, '_');
    if (/\.\w{2,8}$/i.test(base)) return base;
    const hint = `${asset.url || ''} ${asset.downloadUrl || ''} ${asset.original_filename || ''}`.toLowerCase();
    if (/\.mp3(\?|#|$)/i.test(hint)) return `${base}.mp3`;
    const tt = String(anyAsset.track_type || anyAsset.trackType || '').toLowerCase();
    const isAudio =
      tt === 'audio' ||
      tt.includes('audio-m4a') ||
      asset.quality === 'audio_only' ||
      /\.(m4a|mp3|aac|wav)(\?|#|$)/i.test(hint);
    return isAudio ? (hint.includes('.mp3') ? `${base}.mp3` : `${base}.m4a`) : `${base}.mp4`;
  };

  const appendTokenQuery = (url: string, token: string | null): string => {
    if (!token || url.includes('token=')) return url;
    if (!url.startsWith(API_BASE_URL)) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}token=${encodeURIComponent(token)}`;
  };

  /**
   * Video/composite: ask for MP4 so iOS gets H.264. Audio tracks: never add format=mp4 — avoids wrong
   * transcode hints and bogus video/webm Content-Types for m4a/mp3.
   */
  const appendRecordingShareQueryParams = (url: string, token: string | null, asset: MeetingAsset): string => {
    let u = appendTokenQuery(url, token);
    if (!u.includes('/api/v1/video/recording/') || !u.includes('/download')) return u;
    if (/[?&]format=/i.test(u)) return u;
    if (isAudioMeetingRecordingAsset(asset)) return u;
    u += u.includes('?') ? '&' : '?';
    u += 'format=mp4';
    return u;
  };

  /** expo-file-system download cannot use axios interceptors — send the same Bearer token as the API client. */
  const authHeadersForDownloadUrl = (url: string, token: string | null): Record<string, string> => {
    if (!token || !url.startsWith(API_BASE_URL)) return {};
    return { Authorization: `Bearer ${token}` };
  };

  /** Resolves a downloadable URL without using the unimplemented mobile /meetings/{id}/download/{type} route. */
  const resolveMeetingAssetShareSource = async (
    asset: MeetingAsset,
    token: string | null
  ): Promise<{ url: string; filename: string }> => {
    const fid = asset.file_id;
    const hasNumericFileId =
      fid !== undefined && fid !== null && fid !== '' && !Number.isNaN(Number(fid));

    if (hasNumericFileId) {
      return apiClient.downloadFile(Number(fid));
    }

    if (typeof asset.id === 'string' && /^report_file_\d+$/i.test(asset.id)) {
      const reportFileId = parseInt(asset.id.replace(/^report_file_/i, ''), 10);
      if (!Number.isNaN(reportFileId)) {
        return apiClient.downloadFile(reportFileId);
      }
    }

    const recId = extractCallRecordingDbId(asset);
    if (recId != null) {
      const downloadUrl = `${API_BASE_URL}/api/v1/video/recording/${recId}/download`;
      return {
        url: appendRecordingShareQueryParams(downloadUrl, token, asset),
        filename: recordingShareFilename(asset),
      };
    }

    const transcriptId = extractCallTranscriptDbId(asset);
    if (
      transcriptId != null &&
      (asset.type === 'transcript' ||
        asset.type === 'call_transcript' ||
        asset.type === 'chat_log' ||
        asset.type === 'chat' ||
        asset.type === 'meeting_chat')
    ) {
      const downloadUrl = `${API_BASE_URL}/api/v1/video/transcript/${transcriptId}/download`;
      const name = (asset.original_filename || asset.title || 'transcript').replace(/[^a-zA-Z0-9.-]/g, '_');
      const withExt = /\.(txt|vtt|csv)$/i.test(name) ? name : `${name}.txt`;
      return { url: appendTokenQuery(downloadUrl, token), filename: withExt };
    }

    if (
      (asset.type === 'meeting_summary' || asset.type === 'summary') &&
      typeof asset.id === 'string' &&
      asset.id.startsWith('meeting_summary_')
    ) {
      const downloadUrl = `${API_BASE_URL}/api/v1/video/summary/${encodeURIComponent(asset.id)}/download`;
      const name = (asset.original_filename || asset.title || 'summary').replace(/[^a-zA-Z0-9.-]/g, '_');
      const withExt = /\.txt$/i.test(name) ? name : `${name}.txt`;
      return { url: appendTokenQuery(downloadUrl, token), filename: withExt };
    }

    const direct = asset.url || asset.downloadUrl;
    if (direct && (direct.startsWith('http://') || direct.startsWith('https://'))) {
      const streamMatch = direct.match(/\/api\/v1\/video\/recording\/(\d+)\/stream/i);
      if (streamMatch) {
        const id = streamMatch[1];
        const downloadUrl = `${API_BASE_URL}/api/v1/video/recording/${id}/download`;
        return {
          url: appendRecordingShareQueryParams(downloadUrl, token, asset),
          filename: recordingShareFilename(asset),
        };
      }
      return {
        url: direct,
        filename:
          (asset.original_filename || asset.title || 'meeting_asset').replace(/[^a-zA-Z0-9.-]/g, '_') ||
          'meeting_asset',
      };
    }

    throw new Error(
      'No shareable download link for this asset. If it is still processing, try again when it is ready.'
    );
  };

  /** Web parity: POST share → public /public/asset/{token} URL for browser playback. */
  const copyRecordingGrabdocsPlayLink = async (asset: MeetingAsset) => {
    const recId = extractCallRecordingDbId(asset);
    if (recId == null) {
      Alert.alert('Copy link', 'A GrabDocs play link is not available for this recording.');
      return;
    }
    try {
      let shareUrl = recordingShareUrlCacheRef.current[recId];
      if (!shareUrl) {
        shareUrl = await apiClient.createOrGetRecordingShareUrl(recId);
        recordingShareUrlCacheRef.current[recId] = shareUrl;
      }
      const lines: string[] = [];
      lines.push(meetingTitle || asset.meeting_title || 'Meeting');
      if (asset.date) {
        try {
          const d = new Date(asset.date);
          lines.push(Number.isNaN(d.getTime()) ? String(asset.date) : d.toLocaleString());
        } catch {
          lines.push(String(asset.date));
        }
      }
      if (typeof asset.duration === 'number' && asset.duration > 0) {
        const dm = Math.round(asset.duration);
        lines.push(
          dm < 60
            ? `${dm} minute${dm !== 1 ? 's' : ''}`
            : `${Math.floor(dm / 60)} hr ${dm % 60} min`
        );
      }
      lines.push('', shareUrl);
      await Clipboard.setStringAsync(lines.join('\n'));
      Alert.alert(
        'Copied',
        'GrabDocs play link copied. Open it in a browser to play without signing in.'
      );
    } catch (error: any) {
      const msg =
        error?.response?.data?.error || error?.message || 'Could not create share link.';
      Alert.alert('Error', msg);
    }
  };

  const shareAsset = async (asset: MeetingAsset) => {
    try {
      let token: string | null = null;
      try {
        token = await secureStorage.getItem(STORAGE_KEYS.AUTH_TOKEN);
      } catch {
        token = null;
      }

      const fileInfo = await resolveMeetingAssetShareSource(asset, token);

      if (!fileInfo?.url) {
        throw new Error('No download URL available');
      }

      const filename =
        fileInfo.filename || asset.title || asset.original_filename || 'meeting_asset';
      const sanitizedFilename = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
      const cacheDir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
      if (!cacheDir) {
        throw new Error('Unable to access file system directories');
      }
      const uniquePrefix = `share_${Date.now()}_${simpleHash(asset.id)}_`;
      const fileUri = `${cacheDir}${uniquePrefix}${sanitizedFilename}`;

      const authHeaders = authHeadersForDownloadUrl(fileInfo.url, token);

      const downloadResult = await FileSystem.downloadAsync(fileInfo.url, fileUri, {
        headers: authHeaders,
      });

      if (downloadResult.status < 200 || downloadResult.status >= 300) {
        throw new Error(`Download failed (HTTP ${downloadResult.status}). Try again later.`);
      }

      const localInfo = await FileSystem.getInfoAsync(downloadResult.uri);
      if (!localInfo.exists || !localInfo.size || localInfo.size < 1) {
        throw new Error('Downloaded file is empty. The recording may still be processing.');
      }

      const headerMime = mimeTypeFromDownloadHeaders(downloadResult.headers as Record<string, string>);
      const isAudioAsset = isAudioMeetingRecordingAsset(asset);
      let ext = sanitizedFilename.includes('.')
        ? sanitizedFilename.split('.').pop() || 'bin'
        : 'bin';
      let shareMime = headerMime || getShareMimeType(ext);

      const magicBytes = await readLocalFileHeadBytes(downloadResult.uri, 32);
      const magicMime = inferShareMimeFromMagic(magicBytes, isAudioAsset);
      if (magicMime) {
        shareMime = magicMime;
        if (magicMime === 'audio/mpeg') ext = 'mp3';
        else if (magicMime === 'audio/mp4') ext = 'm4a';
        else if (magicMime === 'video/mp4') ext = 'mp4';
        else if (magicMime.endsWith('/webm')) ext = 'webm';
      } else if (headerMime?.includes('webm')) {
        if (headerMime.startsWith('audio/') || isAudioAsset) {
          shareMime = headerMime.startsWith('audio/') ? headerMime : 'audio/webm';
          ext = ext === 'bin' || !ext ? 'webm' : ext;
        } else {
          ext = 'webm';
          shareMime = 'video/webm';
        }
      } else if (headerMime?.includes('mp4') || headerMime === 'video/mp4') {
        ext = 'mp4';
        shareMime = isAudioAsset ? 'audio/mp4' : 'video/mp4';
      } else if (
        fileInfo.url.includes('format=mp4') &&
        extractCallRecordingDbId(asset) != null &&
        !isAudioAsset &&
        (!headerMime || headerMime === 'application/octet-stream')
      ) {
        ext = 'mp4';
        shareMime = 'video/mp4';
      }

      const isAvailable = await Sharing.isAvailableAsync();
      const displayName = asset.title || filename;

      const shareLocalFile = async () => {
        const localUri = downloadResult.uri;
        if (isAvailable) {
          try {
            await Sharing.shareAsync(localUri, {
              mimeType: shareMime,
              dialogTitle: `Share ${displayName}`,
            });
            return;
          } catch (shareErr: any) {
            console.warn('expo-sharing failed, retrying without mimeType:', shareErr);
            try {
              await Sharing.shareAsync(localUri, {
                dialogTitle: `Share ${displayName}`,
              });
              return;
            } catch (shareErr2: any) {
              console.warn('expo-sharing retry failed:', shareErr2);
            }
          }
        }
        if (Platform.OS === 'ios') {
          const fileUrl =
            localUri.startsWith('file://') ? localUri : `file://${localUri.replace(/^\/+/, '')}`;
          await Share.share({
            title: displayName,
            message: displayName,
            url: fileUrl,
          });
          return;
        }
        if (Platform.OS === 'android') {
          await Share.share({
            title: displayName,
            message: `${displayName}\n\n${fileInfo.url}`,
            url: fileInfo.url,
          });
          return;
        }
        await Clipboard.setStringAsync(fileInfo.url);
        Alert.alert('Share', 'Download link copied to clipboard.');
      };

      const scheduleShareFileCleanup = () => {
        setTimeout(async () => {
          try {
            const info = await FileSystem.getInfoAsync(downloadResult.uri);
            if (info.exists) {
              await FileSystem.deleteAsync(downloadResult.uri, { idempotent: true });
            }
          } catch {
            // ignore cleanup errors
          }
        }, 60000);
      };

      // Only warn for video WebM — not audio/webm, and magic/headers often lie for composite vs track
      if (Platform.OS === 'ios' && shareMime === 'video/webm') {
        Alert.alert(
          'Share recording',
          'This recording is in WebM video format, which iOS often cannot pass to other apps. Copy a GrabDocs play link (same as web) or a direct download URL, or try the share sheet.',
          [
            {
              text: 'Cancel',
              style: 'cancel',
              onPress: () => scheduleShareFileCleanup(),
            },
            {
              text: 'Copy play link',
              onPress: async () => {
                await copyRecordingGrabdocsPlayLink(asset);
                scheduleShareFileCleanup();
              },
            },
            {
              text: 'Copy download link',
              onPress: async () => {
                await Clipboard.setStringAsync(fileInfo.url);
                Alert.alert('Copied', 'Signed download URL copied to clipboard.');
                scheduleShareFileCleanup();
              },
            },
            {
              text: 'Try share anyway',
              onPress: () => {
                shareLocalFile()
                  .then(() => scheduleShareFileCleanup())
                  .catch((e: any) => {
                    scheduleShareFileCleanup();
                    Alert.alert('Error', e?.message || 'Could not share this file.');
                  });
              },
            },
          ]
        );
        return;
      }

      await shareLocalFile();
      scheduleShareFileCleanup();
    } catch (error: any) {
      console.error('Share asset error:', error);
      Alert.alert('Error', error.message || 'Failed to share asset');
    }
  };

  const deleteAsset = async (asset: MeetingAsset) => {
    // Log full asset structure for debugging
    console.log('🗑️ Delete asset called with full asset object:', JSON.stringify(asset, null, 2));
    console.log('🗑️ Asset keys:', Object.keys(asset));
    
    // Try to get file_id from various possible properties
    // Check multiple property names that might contain the file ID
    const assetAny = asset as any;
    
    // Log the actual file_id value to debug
    console.log('🗑️ asset.file_id value:', asset.file_id, 'type:', typeof asset.file_id);
    console.log('🗑️ asset.fileId value:', assetAny.fileId, 'type:', typeof assetAny.fileId);
    
    // Check if file_id exists and is valid (not null, undefined, or empty string)
    let fileId: number | string | undefined = undefined;
    
    if (asset.file_id !== null && asset.file_id !== undefined && asset.file_id !== '') {
      fileId = asset.file_id;
      console.log('🗑️ Using asset.file_id:', fileId);
    } else if (assetAny.fileId !== null && assetAny.fileId !== undefined && assetAny.fileId !== '') {
      fileId = assetAny.fileId;
      console.log('🗑️ Using assetAny.fileId:', fileId);
    } else if (assetAny.file_id_num !== null && assetAny.file_id_num !== undefined && assetAny.file_id_num !== '') {
      fileId = assetAny.file_id_num;
      console.log('🗑️ Using assetAny.file_id_num:', fileId);
    } else if (assetAny.file_record_id !== null && assetAny.file_record_id !== undefined && assetAny.file_record_id !== '') {
      fileId = assetAny.file_record_id;
      console.log('🗑️ Using assetAny.file_record_id:', fileId);
    } else if (assetAny.fileRecordId !== null && assetAny.fileRecordId !== undefined && assetAny.fileRecordId !== '') {
      fileId = assetAny.fileRecordId;
      console.log('🗑️ Using assetAny.fileRecordId:', fileId);
    } else if (assetAny.record_id !== null && assetAny.record_id !== undefined && assetAny.record_id !== '') {
      fileId = assetAny.record_id;
      console.log('🗑️ Using assetAny.record_id:', fileId);
    } else if (assetAny.recordId !== null && assetAny.recordId !== undefined && assetAny.recordId !== '') {
      fileId = assetAny.recordId;
      console.log('🗑️ Using assetAny.recordId:', fileId);
    }
    
    // For old format assets, try to extract numeric ID from various sources
    // Only do this if we haven't found a valid file_id above
    if (!fileId || fileId === 0 || fileId === '0') {
      // PRIORITY 1: For meeting assets (recordings, transcripts, reports), use video_call_id or extract from ID
      // The asset.id format varies:
      // - "recording_1125" or "call_recording_123" -> recording ID
      // - "transcript_1125" or "call_transcript_456" -> transcript ID  
      // - "report_file_123" -> File.id = 123 (combined CSV, same as web)
      // - "report_202" / "meeting_report_789" -> legacy MeetingReport.id (deprecated)
      
      if (typeof asset.id === 'string') {
        // Extract numeric ID from formatted IDs
        const numericMatch = asset.id.match(/\d+/);
        if (numericMatch) {
          fileId = parseInt(numericMatch[0], 10);
          
          // Determine what this ID represents based on asset type
          if (asset.id.startsWith('recording_')) {
            console.log('🗑️ Extracted ID from asset.id:', fileId, '(VideoCall.id or CallRecording.id)');
          } else if (asset.id.startsWith('call_recording_')) {
            console.log('🗑️ Extracted ID from asset.id:', fileId, '(CallRecording.id)');
          } else if (asset.id.startsWith('transcript_')) {
            console.log('🗑️ Extracted ID from asset.id:', fileId, '(VideoCall.id or CallTranscript.id)');
          } else if (asset.id.startsWith('call_transcript_')) {
            console.log('🗑️ Extracted ID from asset.id:', fileId, '(CallTranscript.id)');
          } else if (asset.id.startsWith('report_file_')) {
            console.log('🗑️ Extracted ID from asset.id:', fileId, '(File.id - combined meeting report CSV)');
          } else if (asset.id.startsWith('report_') || asset.id.startsWith('meeting_report_')) {
            console.log('🗑️ Extracted ID from asset.id:', fileId, '(MeetingReport.id, legacy)');
          } else {
            console.log('🗑️ Extracted ID from asset.id:', fileId);
          }
        }
      } else if (typeof asset.id === 'number') {
        fileId = asset.id;
        console.log('🗑️ Using asset.id as number:', fileId);
      }
      
      // PRIORITY 2: For legacy recordings/transcripts, prefer video_call_id if available
      if ((!fileId || fileId === 0 || fileId === '0') && assetAny.video_call_id) {
        fileId = assetAny.video_call_id;
        console.log('🗑️ Using video_call_id as fallback:', fileId);
      }
      
      // PRIORITY 3: Try to extract from URL path (least reliable - this is just directory structure)
      if ((!fileId || fileId === 0 || fileId === '0') && asset.url) {
        // Match pattern: /{numeric_id}/ followed by a filename with extension
        const urlMatch = asset.url.match(/\/(\d+)\/[^\/]+\.\w+$/);
        if (urlMatch) {
          fileId = parseInt(urlMatch[1], 10);
          console.warn('🗑️ Extracted file ID from URL path (before filename):', fileId);
          console.warn('🗑️ WARNING: This may be a directory ID, not the actual record ID!');
        }
      }
    }

    Alert.alert(
      'Delete Asset',
      `Are you sure you want to delete "${asset.title}"? This action cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            let fileIdNum: number | undefined = undefined;
            try {
              // If we still don't have a file_id, show error
              if (!fileId) {
                console.warn('🗑️ No file_id found for asset');
                Alert.alert('Cannot Delete', 'This asset does not have a valid file ID and cannot be deleted.');
                return;
              }
              
              // Convert file_id to number if it's a string
              if (typeof fileId === 'string') {
                // Check if string is numeric
                const trimmed = fileId.trim();
                if (!/^\d+$/.test(trimmed)) {
                  console.error('🗑️ Invalid file_id format (not numeric):', fileId);
                  Alert.alert('Error', 'Invalid file ID format. Cannot delete this asset.');
                  return;
                }
                fileIdNum = parseInt(trimmed, 10);
                if (isNaN(fileIdNum)) {
                  console.error('🗑️ Failed to parse file_id:', fileId);
                  Alert.alert('Error', 'Invalid file ID. Cannot delete this asset.');
                  return;
                }
              } else if (typeof fileId === 'number') {
                fileIdNum = fileId;
              } else {
                console.error('🗑️ file_id is not a string or number:', typeof fileId, fileId);
                Alert.alert('Error', 'Invalid file ID type. Cannot delete this asset.');
                return;
              }
              
              console.log('🗑️ Deleting asset with file_id:', fileIdNum, 'for asset:', asset.title, 'type:', asset.type);
              
              // Check if this is a legacy asset (not in File table)
              if (assetAny.is_legacy_recording) {
                console.warn('🗑️ This is a legacy asset from VideoCall table, not File table');
              }
              
              // Log which table this asset is likely in
              if (asset.type === 'recording') {
                console.log('🗑️ Recording assets may be in: File, CallRecording, or VideoCall table');
              } else if (asset.type === 'transcript') {
                console.log('🗑️ Transcript assets may be in: File, CallTranscript, or VideoCall table');
              } else if (asset.type === 'meeting_report' || asset.type === 'report') {
                console.log('🗑️ Report assets are in: File table (combined CSV) or legacy MeetingReport table');
              }
              
              await apiClient.deleteFile(fileIdNum);
              
              // Remove asset from state
              setAssets(prevAssets => prevAssets.filter(a => a.id !== asset.id));
              
              Alert.alert('Success', 'Asset deleted successfully');
            } catch (error: any) {
              console.error('🗑️ Delete asset error:', error);
              console.error('🗑️ Error details:', {
                message: error.message,
                response: error.response?.data,
                status: error.response?.status,
                fileId: fileIdNum,
                assetType: asset.type,
                assetId: asset.id
              });
              
              let errorMessage = error.response?.data?.message || error.message || 'Failed to delete asset';
              
              // Provide more specific error messages
              if (error.message?.includes('File not found') || error.response?.status === 404) {
                errorMessage = `File not found. This asset (${asset.type}) may not be deletable, or the file ID (${fileIdNum ?? 'unknown'}) is incorrect.`;
              } else if (error.response?.status === 403) {
                errorMessage = 'You do not have permission to delete this asset.';
              }
              
              Alert.alert('Error', errorMessage);
            }
          }
        }
      ]
    );
  };

  const deleteAllAssets = async () => {
    if (assets.length === 0) {
      Alert.alert('No Assets', 'There are no assets for this meeting.');
      return;
    }

    // Filter assets that have valid file IDs
    const assetsWithFileIds = assets.filter(asset => {
      const fileId = asset.file_id || asset.id;
      return fileId !== undefined && fileId !== null;
    });
    
    if (assetsWithFileIds.length === 0) {
      Alert.alert(
        'Cannot Delete Assets',
        'Assets do not have file IDs. Individual asset deletion is not available.'
      );
      return;
    }

    Alert.alert(
      'Delete All Assets',
      `Are you sure you want to delete all ${assetsWithFileIds.length} asset${assetsWithFileIds.length !== 1 ? 's' : ''} for this meeting? This action cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete All',
          style: 'destructive',
          onPress: async () => {
            setDeletingAll(true);
            try {
              setLoading(true);
              
              // Try to use the bulk delete endpoint first (like web version)
              try {
                console.log('🗑️ Attempting bulk delete of all assets for meeting:', meetingId);
                await apiClient.deleteMeetingAssets(meetingId);
                console.log('✅ Bulk delete successful');
                
                // Clear assets from state
                setAssets([]);
                
                // Reload assets to refresh the list
                await loadMeetingAssets();
                
                Alert.alert('Success', `All ${assetsWithFileIds.length} asset${assetsWithFileIds.length !== 1 ? 's' : ''} deleted successfully.`);
              } catch (bulkError: any) {
                // If bulk delete fails (e.g., endpoint doesn't exist), fall back to individual deletions
                if (bulkError.response?.status === 404 || bulkError.message?.includes('not found')) {
                  console.log('⚠️ Bulk delete endpoint not available, falling back to individual deletions');
                  
                  // Delete all assets in parallel
                  const deletePromises = assetsWithFileIds.map(async (asset) => {
                    try {
                      const fileId = asset.file_id || asset.id;
                      const fileIdNum = typeof fileId === 'string' ? parseInt(fileId, 10) : fileId;
                      
                      if (!fileIdNum || isNaN(fileIdNum)) {
                        return { success: false, assetId: asset.id, error: 'Invalid file ID' };
                      }
                      
                      await apiClient.deleteFile(fileIdNum);
                      return { success: true, assetId: asset.id };
                    } catch (error: any) {
                      console.error(`Failed to delete asset ${asset.id}:`, error);
                      return { success: false, assetId: asset.id, error: error.message };
                    }
                  });

                  const results = await Promise.all(deletePromises);
                  const successful = results.filter(r => r.success).length;
                  const failed = results.filter(r => !r.success).length;

                  // Clear assets from state
                  setAssets([]);
                  
                  // Reload assets to refresh the list
                  await loadMeetingAssets();

                  if (failed === 0) {
                    Alert.alert('Success', `All ${successful} asset${successful !== 1 ? 's' : ''} deleted successfully.`);
                  } else {
                    Alert.alert(
                      'Partial Success',
                      `${successful} asset${successful !== 1 ? 's' : ''} deleted successfully. ${failed} asset${failed !== 1 ? 's' : ''} failed to delete.`
                    );
                  }
                } else {
                  // Re-throw other errors
                  throw bulkError;
                }
              }
            } catch (error: any) {
              console.error('Delete all assets error:', error);
              const errorMessage = error.response?.data?.message || error.message || 'Failed to delete assets';
              Alert.alert('Error', errorMessage);
            } finally {
              setLoading(false);
              setDeletingAll(false);
            }
          }
        }
      ]
    );
  };

  const assetMenuItems = useMemo((): ActionMenuItem[] => {
    if (!menuAsset) return [];
    const asset = menuAsset;
    const canCopyPlayLink =
      (asset.type === 'recording' || asset.type === 'video') &&
      extractCallRecordingDbId(asset) != null;
    const items: ActionMenuItem[] = [
      {
        id: 'view',
        label: 'View',
        icon: 'eye-outline',
        iconColor: '#007AFF',
        onPress: () => {
          void viewAsset(asset);
        },
      },
    ];
    if (canCopyPlayLink) {
      items.push({
        id: 'copy-link',
        label: 'Copy play link',
        icon: 'link-outline',
        iconColor: '#007AFF',
        onPress: () => {
          void copyRecordingGrabdocsPlayLink(asset);
        },
      });
    }
    items.push(
      {
        id: 'share',
        label: 'Share',
        icon: 'share-outline',
        iconColor: '#007AFF',
        onPress: () => {
          void shareAsset(asset);
        },
      },
      {
        id: 'delete',
        label: 'Delete',
        icon: 'trash-outline',
        destructive: true,
        onPress: () => {
          void deleteAsset(asset);
        },
      },
    );
    return items;
  }, [menuAsset]);

  const showAssetMenu = (asset: MeetingAsset) => {
    setMenuAsset(asset);
  };

  const getAssetIcon = (type: string) => {
    switch (type) {
      case 'recording': return 'videocam';
      case 'transcript': return 'document-text';
      case 'chat_log': return 'chatbubbles';
      case 'shared_files': return 'folder';
      case 'whiteboard': return 'color-palette';
      case 'notes': return 'document';
      case 'meeting_summary': return 'sparkles';
      case 'meeting_report': return 'analytics';
      case 'summary': return 'sparkles';
      case 'report': return 'analytics';
      default: return 'document';
    }
  };

  const getAssetColor = (type: string) => {
    switch (type) {
      case 'recording': return '#FF3B30';
      case 'transcript': return '#007AFF';
      case 'chat_log': return '#34C759';
      case 'shared_files': return '#FF9500';
      case 'whiteboard': return '#AF52DE';
      case 'notes': return '#5856D6';
      case 'meeting_summary': return '#FF6B35';
      case 'meeting_report': return '#5AC8FA';
      case 'summary': return '#FF6B35';
      case 'report': return '#5AC8FA';
      default: return '#8E8E93';
    }
  };

  const getAssetTypeDisplay = (asset: MeetingAsset): string => {
    // For recordings, determine if it's audio or video
    if (asset.type === 'recording' || asset.type === 'video') {
      // Helper function to check if URL/filename is audio
      const isAudioFile = (url: string): boolean => {
        const audioExtensions = ['.m4a', '.mp3', '.wav', '.aac', '.ogg', '.flac', '.m4p'];
        const lowerUrl = url.toLowerCase();
        return audioExtensions.some(ext => lowerUrl.includes(ext)) || 
               lowerUrl.includes('/audio/');
      };
      
      // Helper function to check if URL/filename is video
      const isVideoFile = (url: string): boolean => {
        const videoExtensions = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.flv', '.wmv', '.3gp'];
        const lowerUrl = url.toLowerCase();
        return videoExtensions.some(ext => lowerUrl.includes(ext)) || 
               lowerUrl.includes('/video/') ||
               lowerUrl.includes('/recordings/');
      };
      
      // Check if explicitly marked as audio-only
      const isExplicitlyAudioOnly = asset.quality === 'audio_only';
      
      // Check file extensions first (most reliable)
      const hasAudioExtension = (asset.url && isAudioFile(asset.url)) ||
                                 (asset.downloadUrl && isAudioFile(asset.downloadUrl)) ||
                                 (asset.original_filename && isAudioFile(asset.original_filename));
      
      const hasVideoExtension = (asset.url && isVideoFile(asset.url)) ||
                                (asset.downloadUrl && isVideoFile(asset.downloadUrl)) ||
                                (asset.original_filename && isVideoFile(asset.original_filename));
      
      // Determine if it's audio or video
      if (isExplicitlyAudioOnly || (hasAudioExtension && !hasVideoExtension)) {
        return 'Audio';
      } else if (hasVideoExtension || asset.quality === 'hd' || asset.quality === 'sd') {
        return 'Video';
      } else {
        // Default to video if uncertain (most recordings are video)
        return 'Video';
      }
    }
    
    // Special cases for specific types
    if (asset.type === 'meeting_summary' || asset.type === 'summary') {
      return 'Summary';
    }
    if (asset.type === 'meeting_report' || asset.type === 'report') {
      return 'Report';
    }
    
    // For other types, capitalize the first letter
    return asset.type.charAt(0).toUpperCase() + asset.type.slice(1).replace(/_/g, ' ');
  };

  const formatAudioTime = (milliseconds: number): string => {
    if (!milliseconds || milliseconds < 0) return '0:00';
    const totalSeconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  const formatDuration = (duration: number | string | undefined): string => {
    // Handle undefined, null, or invalid values
    if (!duration || duration === 'unknown' || duration === 'Unknown') return '';
    
    // If it's already a formatted string like "5:00" or "1:05:23", return as-is
    if (typeof duration === 'string' && duration.includes(':')) {
      // Validate the format (MM:SS or HH:MM:SS)
      const parts = duration.split(':');
      if (parts.length === 2 || parts.length === 3) {
        // Check if all parts are valid numbers
        const allValid = parts.every(part => !isNaN(parseInt(part)));
        if (allValid) {
          return duration; // Return the formatted string as-is
        }
      }
    }
    
    // Convert to number if it's a string (not in MM:SS format)
    let value: number;
    if (typeof duration === 'string') {
      value = parseFloat(duration);
      if (isNaN(value)) return '';
    } else {
      value = duration;
    }
    
    // Ensure it's a valid positive number
    if (!value || value < 0 || isNaN(value)) return '';
    
    // Backend sends duration_minutes, so if value is small (< 1000), it's likely in minutes
    // If value is large (> 1000), it might be in seconds or milliseconds
    let totalSeconds: number;
    if (value < 1000) {
      // Likely in minutes (e.g., 5.5 minutes = 5:30, 0.07 minutes = 4 seconds)
      totalSeconds = Math.floor(value * 60);
    } else if (value > 3600000) {
      // Likely milliseconds, convert to seconds
      totalSeconds = Math.floor(value / 1000);
    } else {
      // Likely seconds
      totalSeconds = Math.floor(value);
    }
    
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const secs = Math.floor(totalSeconds % 60);
    
    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    } else {
      return `${minutes}:${secs.toString().padStart(2, '0')}`;
    }
  };

  const formatDate = (dateString: string) => {
    try {
      const date = new Date(dateString);
      return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return 'Unknown date';
    }
  };

  const formatGroupDate = (dateString: string) => {
    try {
      const date = new Date(dateString);
      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      
      if (date.toDateString() === today.toDateString()) {
        return 'Today';
      } else if (date.toDateString() === yesterday.toDateString()) {
        return 'Yesterday';
      } else {
        return date.toLocaleDateString('en-US', {
          weekday: 'long',
          month: 'long',
          day: 'numeric',
          year: 'numeric'
        });
      }
    } catch {
      return 'Unknown date';
    }
  };

  const extractFilenameFromUrl = (url: string | undefined): string | null => {
    if (!url) return null;
    
    try {
      // If it's an S3 URL or file path, extract the filename
      // S3 URLs: https://bucket.s3.region.amazonaws.com/path/to/file.ext
      // File paths: /path/to/file.ext or C:\path\to\file.ext
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      const filename = pathname.split('/').pop() || pathname.split('\\').pop();
      if (filename && filename.includes('.')) {
        return filename;
      }
    } catch {
      // If URL parsing fails, try to extract from path string
      const parts = url.split('/');
      const filename = parts[parts.length - 1];
      if (filename && filename.includes('.')) {
        return filename;
      }
      
      // Try Windows path format
      const winParts = url.split('\\');
      const winFilename = winParts[winParts.length - 1];
      if (winFilename && winFilename.includes('.')) {
        return winFilename;
      }
    }
    
    return null;
  };

  const getAssetDisplayTitle = (asset: MeetingAsset) => {
    // Priority 1: Use original_filename (exact S3 filename from backend)
    if (asset.original_filename) {
      return asset.original_filename;
    }
    
    // Priority 2: Extract filename from URL (S3 URL or file path)
    const urlFilename = extractFilenameFromUrl(asset.url || asset.downloadUrl || asset.local_file_path || asset.local_recording_path || asset.local_transcript_path);
    if (urlFilename) {
      return urlFilename;
    }
    
    // Priority 3: Use title if it looks like a filename (contains extension)
    if (asset.title && (asset.title.includes('.') || asset.title !== asset.type)) {
      // Check if title looks like a filename (has extension) or is not just the type
      const hasExtension = /\.\w{2,4}$/.test(asset.title);
      if (hasExtension || asset.title !== asset.type) {
        return asset.title;
      }
    }
    
    // Fallback: Use mapped display names only if no filename available
    switch (asset.type) {
      case 'transcript':
      case 'call_transcript':
        return 'Call Transcript';
      case 'meeting_report':
      case 'report':
        return 'Report';
      case 'summary':
      case 'meeting_summary':
        return 'Summary';
      case 'recording':
      case 'video':
        return 'Video';
      case 'chat_log':
      case 'chat':
      case 'meeting_chat':
        return 'Meeting Chat Export';
      case 'shared_files':
      case 'files':
        return 'Shared Files';
      case 'whiteboard':
        return 'Whiteboard';
      case 'notes':
        return 'Notes';
      default:
        return asset.title || String(asset.type).charAt(0).toUpperCase() + String(asset.type).slice(1);
    }
  };

  const dynamicStyles = useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: themeColors.background,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 12,
      backgroundColor: themeColors.headerBackground || themeColors.card,
      borderBottomWidth: 1,
      borderBottomColor: themeColors.border,
    },
    backButton: {
      padding: 4,
      marginRight: 8,
    },
    headerContent: {
      flex: 1,
    },
    headerTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: themeColors.text,
    },
    headerSubtitle: {
      fontSize: 14,
      color: themeColors.textSecondary,
      marginTop: 2,
    },
    headerActions: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    headerCompact: {
      paddingVertical: 8,
    },
    deleteAllButton: {
      padding: 4,
      marginRight: 8,
    },
    refreshButton: {
      padding: 4,
    },
    searchContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: themeColors.inputBackground || themeColors.surface,
      marginHorizontal: 16,
      marginVertical: 12,
      paddingHorizontal: 12,
      borderRadius: 8,
    },
    searchIcon: {
      marginRight: 8,
    },
    searchInput: {
      flex: 1,
      paddingVertical: 10,
      fontSize: 16,
      color: themeColors.text,
    },
    assetsList: {
      flex: 1,
    },
    dateGroup: {
      marginBottom: 8,
    },
    dateGroupHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 12,
      backgroundColor: themeColors.surface,
      borderBottomWidth: 1,
      borderBottomColor: themeColors.border,
    },
    dateGroupInfo: {
      flex: 1,
    },
    dateGroupTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: themeColors.text,
    },
    dateGroupCount: {
      fontSize: 14,
      color: themeColors.textSecondary,
      marginTop: 2,
    },
    dateGroupContent: {
      backgroundColor: themeColors.background,
    },
    assetWrapper: {
      borderBottomWidth: 1,
      borderBottomColor: themeColors.borderLight || themeColors.border,
    },
    assetItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 12,
      paddingHorizontal: 16,
      backgroundColor: themeColors.card,
      position: 'relative',
    },
    assetIcon: {
      width: 40,
      height: 40,
      borderRadius: 20,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: 12,
    },
    assetContent: {
      flex: 1,
    },
    assetTitle: {
      fontSize: 16,
      fontWeight: '500',
      color: themeColors.text,
      marginBottom: 4,
    },
    assetType: {
      fontSize: 14,
      color: themeColors.textSecondary,
      marginRight: 4,
    },
    assetDetails: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    assetDate: {
      fontSize: 12,
      color: themeColors.textLight,
    },
    assetSize: {
      fontSize: 12,
      color: themeColors.textLight,
      marginLeft: 4,
    },
    moreButton: {
      padding: 4,
    },
    loadingContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    loadingText: {
      marginTop: 12,
      fontSize: 16,
      color: themeColors.textSecondary,
    },
    emptyContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingVertical: 60,
    },
    emptyText: {
      fontSize: 18,
      fontWeight: '500',
      color: themeColors.textSecondary,
      marginTop: 16,
      textAlign: 'center',
    },
    emptySubtext: {
      fontSize: 14,
      color: themeColors.textLight,
      marginTop: 8,
      textAlign: 'center',
      paddingHorizontal: 32,
    },
    modalContainer: {
      flex: 1,
      backgroundColor: themeColors.background,
    },
    modalHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingBottom: 12,
      backgroundColor: themeColors.headerBackground || themeColors.card,
      borderBottomWidth: 1,
      borderBottomColor: themeColors.border,
    },
    modalCloseButton: {
      fontSize: 16,
      color: themeColors.tint || '#007AFF',
    },
    modalTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: themeColors.text,
    },
    modalActions: {
      flexDirection: 'row',
      gap: 16,
    },
    modalContent: {
      flex: 1,
      padding: 16,
    },
    assetOverview: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 24,
    },
    assetIconLarge: {
      width: 64,
      height: 64,
      borderRadius: 32,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: 16,
    },
    assetInfo: {
      flex: 1,
    },
    assetTitleLarge: {
      fontSize: 20,
      fontWeight: '600',
      color: themeColors.text,
      marginBottom: 4,
    },
    assetTypeLarge: {
      fontSize: 16,
      color: themeColors.textSecondary,
      marginBottom: 8,
    },
    assetMeta: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    assetDateLarge: {
      fontSize: 14,
      color: themeColors.textLight,
    },
    assetSizeLarge: {
      fontSize: 14,
      color: themeColors.textLight,
      marginLeft: 4,
    },
    detailSection: {
      marginBottom: 16,
    },
    detailLabel: {
      fontSize: 14,
      fontWeight: '500',
      color: themeColors.textSecondary,
      marginBottom: 4,
    },
    detailValue: {
      fontSize: 16,
      color: themeColors.text,
    },
  }), [themeColors]);

  const renderAssetItem = ({ item }: { item: MeetingAsset }) => (
    <View style={dynamicStyles.assetItem}>
      <TouchableOpacity 
        style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}
        onPress={() => viewAsset(item)}
      >
        <View style={[dynamicStyles.assetIcon, { backgroundColor: `${getAssetColor(item.type)}20` }]}>
          <Ionicons name={getAssetIcon(item.type) as any} size={20} color={getAssetColor(item.type)} />
        </View>
        <View style={dynamicStyles.assetContent}>
          <Text style={dynamicStyles.assetTitle} numberOfLines={1} ellipsizeMode="tail">{getAssetDisplayTitle(item)}</Text>
          <View style={dynamicStyles.assetDetails}>
            <Text style={dynamicStyles.assetType}>{getAssetTypeDisplay(item)}</Text>
            <Text style={dynamicStyles.assetDate}>• {formatDate(item.date)}</Text>
          </View>
        </View>
      </TouchableOpacity>
      <TouchableOpacity 
        style={dynamicStyles.moreButton}
        onPress={() => showAssetMenu(item)}
      >
        <Ionicons name="ellipsis-vertical" size={16} color={themeColors.textSecondary} />
      </TouchableOpacity>
    </View>
  );

  const renderSessionGroup = ({ item }: { item: SessionGroup }) => {
    // Display meeting title (no session numbers since we're grouping by meeting)
    const meetingTitle = item.sessionTitle || 'Unknown Meeting';
    
    return (
      <View style={dynamicStyles.dateGroup}>
        <TouchableOpacity 
          style={dynamicStyles.dateGroupHeader} 
          onPress={() => toggleSessionGroup(item.sessionId)}
        >
          <View style={dynamicStyles.dateGroupInfo}>
            <Text style={dynamicStyles.dateGroupTitle} numberOfLines={1} ellipsizeMode="tail">
              {meetingTitle}
            </Text>
            <Text style={dynamicStyles.dateGroupCount}>
              {formatGroupDate(item.date)} • {item.assets.length} asset{item.assets.length !== 1 ? 's' : ''}
            </Text>
          </View>
          <Ionicons 
            name={item.isExpanded ? "chevron-up" : "chevron-down"} 
            size={20} 
            color={themeColors.textSecondary} 
          />
        </TouchableOpacity>
      
      {item.isExpanded && (
        <View style={dynamicStyles.dateGroupContent}>
          {item.assets.map((asset) => (
            <View key={asset.id} style={dynamicStyles.assetWrapper}>
              {renderAssetItem({ item: asset })}
            </View>
          ))}
        </View>
      )}
    </View>
    );
  };

  return (
    <SafeAreaView style={dynamicStyles.container} edges={['top']}>
      {/* Header */}
      <View style={[dynamicStyles.header, fromAssetsShortcut && dynamicStyles.headerCompact]}>
        <AppBackButton />
        <View style={dynamicStyles.headerContent}>
          <AppHeaderTitle shrink={false}>
            {truncateAppHeaderTitle(meetingTitle || 'Meeting Details')}
          </AppHeaderTitle>
          {!fromAssetsShortcut ? (
            <Text style={dynamicStyles.headerSubtitle}>Room: {roomCode}</Text>
          ) : null}
        </View>
        <View style={dynamicStyles.headerActions}>
          {assets.length > 0 && (
            <FeedbackTouchable
              style={dynamicStyles.deleteAllButton}
              onPress={deleteAllAssets}
              disabled={deletingAll}
              loading={deletingAll}
              spinnerColor="#FF3B30"
            >
              <Ionicons name="trash-outline" size={24} color="#FF3B30" />
            </FeedbackTouchable>
          )}
          <FeedbackTouchable
            style={dynamicStyles.refreshButton}
            onPress={loadMeetingAssets}
            disabled={deletingAll || loading}
            spinnerColor={themeColors.tint || '#007AFF'}
          >
            <Ionicons name="refresh" size={24} color={themeColors.tint || '#007AFF'} />
          </FeedbackTouchable>
        </View>
      </View>

      {/* Search Bar */}
      <View style={dynamicStyles.searchContainer}>
        <Ionicons name="search" size={20} color={themeColors.textSecondary} style={dynamicStyles.searchIcon} />
        <TextInput
          style={dynamicStyles.searchInput}
          placeholder="Search assets..."
          placeholderTextColor={themeColors.textLight}
          value={searchQuery}
          onChangeText={setSearchQuery}
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity onPress={() => setSearchQuery('')}>
            <Ionicons name="close-circle" size={20} color={themeColors.textSecondary} />
          </TouchableOpacity>
        )}
      </View>

      {/* Assets List */}
      {loading ? (
        <View style={dynamicStyles.loadingContainer}>
          <ActivityIndicator size="large" color={themeColors.tint || '#007AFF'} />
          <Text style={dynamicStyles.loadingText}>Loading meeting assets...</Text>
        </View>
      ) : (
        <FlatList
          data={sessionGroups}
          renderItem={renderSessionGroup}
          keyExtractor={(item) => item.sessionId}
          style={dynamicStyles.assetsList}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={loadMeetingAssets} />}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <View style={dynamicStyles.emptyContainer}>
              <Ionicons name="folder-open-outline" size={64} color={themeColors.textLight} />
              <Text style={dynamicStyles.emptyText}>
                {searchQuery ? 'No assets match your search' : 'No assets for this meeting'}
              </Text>
              <Text style={dynamicStyles.emptySubtext}>
                {searchQuery 
                  ? 'Try adjusting your search terms' 
                  : 'Meeting recordings and transcripts will appear here'
                }
              </Text>
            </View>
          }
        />
      )}

      {/* Asset Details Modal */}
      <Modal
        visible={showAssetModal}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setShowAssetModal(false)}
      >
        <SafeAreaView style={dynamicStyles.modalContainer} edges={['top', 'bottom', 'left', 'right']}>
          <View style={[dynamicStyles.modalHeader, { paddingTop: Math.max(insets.top, 12) }]}>
            <TouchableOpacity onPress={() => setShowAssetModal(false)}>
              <Text style={dynamicStyles.modalCloseButton}>Close</Text>
            </TouchableOpacity>
            <Text style={dynamicStyles.modalTitle}>Asset Details</Text>
            <View style={dynamicStyles.modalActions}>
              <TouchableOpacity onPress={() => downloadAsset(selectedAsset!)}>
                <Ionicons name="download" size={24} color={themeColors.tint || '#007AFF'} />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => shareAsset(selectedAsset!)}>
                <Ionicons name="share" size={24} color={themeColors.tint || '#007AFF'} />
              </TouchableOpacity>
            </View>
          </View>
          
          {selectedAsset && (
            <View style={dynamicStyles.modalContent}>
              <View style={dynamicStyles.assetOverview}>
                <View style={[dynamicStyles.assetIconLarge, { backgroundColor: `${getAssetColor(selectedAsset.type)}20` }]}>
                  <Ionicons name={getAssetIcon(selectedAsset.type) as any} size={32} color={getAssetColor(selectedAsset.type)} />
                </View>
                <View style={dynamicStyles.assetInfo}>
                  <Text style={dynamicStyles.assetTitleLarge} numberOfLines={1} ellipsizeMode="tail">{getAssetDisplayTitle(selectedAsset)}</Text>
                  <Text style={dynamicStyles.assetTypeLarge}>{selectedAsset.type.charAt(0).toUpperCase() + selectedAsset.type.slice(1)}</Text>
                  <View style={dynamicStyles.assetMeta}>
                    <Text style={dynamicStyles.assetDateLarge}>{formatDate(selectedAsset.date)}</Text>
                    {selectedAsset.size && <Text style={dynamicStyles.assetSizeLarge}>• {selectedAsset.size}</Text>}
                  </View>
                </View>
              </View>
              
              {selectedAsset.meeting_title && (
                <View style={dynamicStyles.detailSection}>
                  <Text style={dynamicStyles.detailLabel}>Meeting</Text>
                  <Text style={dynamicStyles.detailValue}>{selectedAsset.meeting_title}</Text>
                </View>
              )}
              
              {selectedAsset.url && (
                <View style={dynamicStyles.detailSection}>
                  <Text style={dynamicStyles.detailLabel}>URL</Text>
                  <Text style={dynamicStyles.detailValue} numberOfLines={2}>{selectedAsset.url}</Text>
                </View>
              )}
            </View>
          )}
        </SafeAreaView>
      </Modal>

      {/* Document Viewer */}
      {showDocumentViewer && selectedFileForViewing && (
        <DocumentViewer
          fileId={selectedFileForViewing.fileId}
          fileName={selectedFileForViewing.fileName}
          fileType={selectedFileForViewing.fileType}
          fileCategory={selectedFileForViewing.fileCategory}
          onClose={() => {
            setShowDocumentViewer(false);
            setSelectedFileForViewing(null);
          }}
        />
      )}

      {/* Video Player Modal */}
      <Modal
        visible={showVideoPlayer}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={async () => {
          setShowVideoPlayer(false);
          if (videoRef) {
            try {
              const status = await videoRef.getStatusAsync();
              if (status.isLoaded) {
                await videoRef.unloadAsync();
              }
            } catch (error) {
              // Ignore errors when closing
            }
          }
                  setSelectedVideoUrl(null);
                  setOriginalVideoUrl(null);
                  setVideoDirectUrl(null);
                  setHasTriedVideoFallback(false);
                  setIsVideoFallbackInProgress(false);
                  setVideoLoading(false);
                  setVideoBuffering(false);
                  setVideoKey(0); // Reset key for next time
                  hasShownVideoErrorRef.current = false; // Reset error flag
                  currentVideoStreamUrlRef.current = null;
                  // Clear buffering check interval
                  if (videoBufferingCheckRef.current) {
                    clearInterval(videoBufferingCheckRef.current);
                    videoBufferingCheckRef.current = null;
                  }
                }}
              >
        <SafeAreaView style={{ flex: 1, backgroundColor: '#000' }}>
          {/* Close button in its own row above the video — avoids native-control touch interception */}
          <View style={{ alignItems: 'center', paddingVertical: 12 }}>
            <TouchableOpacity
              onPress={async () => {
                setShowVideoPlayer(false);
                if (videoRef) {
                  try {
                    const status = await videoRef.getStatusAsync();
                    if (status.isLoaded) {
                      await videoRef.unloadAsync();
                    }
                  } catch (error) {
                    // Ignore errors when closing
                  }
                }
                setSelectedVideoUrl(null);
                setOriginalVideoUrl(null);
                setVideoDirectUrl(null);
                setHasTriedVideoFallback(false);
                setIsVideoFallbackInProgress(false);
                setVideoLoading(false);
                setVideoBuffering(false);
                hasShownVideoErrorRef.current = false;
                currentVideoStreamUrlRef.current = null;
                if (videoBufferingCheckRef.current) {
                  clearInterval(videoBufferingCheckRef.current);
                  videoBufferingCheckRef.current = null;
                }
              }}
              style={{
                backgroundColor: 'rgba(255,255,255,0.15)',
                borderRadius: 22,
                padding: 10,
                paddingHorizontal: 12,
              }}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            >
              <Ionicons name="close" size={24} color="#fff" />
            </TouchableOpacity>
          </View>
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            {videoLoading && !selectedVideoUrl ? (
              <View style={{ alignItems: 'center', width: '100%', paddingHorizontal: 40 }}>
                <View style={{ 
                  width: 120, 
                  height: 120, 
                  borderRadius: 60, 
                  backgroundColor: 'rgba(255, 255, 255, 0.2)',
                  justifyContent: 'center',
                  alignItems: 'center',
                  marginBottom: 40
                }}>
                  <ActivityIndicator size="large" color="#fff" />
                </View>
                
                <Text style={{ marginBottom: 24, fontSize: 18, fontWeight: '600', color: '#fff', textAlign: 'center' }}>
                  Loading video...
                </Text>
              </View>
            ) : selectedVideoUrl ? (
              <View style={{ flex: 1, width: '100%' }}>
                {videoBuffering && (
                  <View style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, zIndex: 5, justifyContent: 'center', alignItems: 'center' }}>
                    <View style={{ backgroundColor: 'rgba(0, 0, 0, 0.7)', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8 }}>
                      <ActivityIndicator size="small" color="#fff" />
                      <Text style={{ color: '#fff', fontSize: 12, marginTop: 4 }}>Buffering...</Text>
                    </View>
                  </View>
                )}
                <View style={{ flex: 1, alignSelf: 'stretch', width: '100%' }}>
                  <Video
                    key={`${selectedVideoUrl}-${videoKey}`} // Force remount when URL or key changes
                    ref={(ref) => {
                      setVideoRef(ref);
                      // Don't set loading to false here - wait for onLoad callback
                    }}
                    source={{ uri: selectedVideoUrl }}
                    style={{ flex: 1, width: '100%', minHeight: 200 }}
                    useNativeControls
                    resizeMode={ResizeMode.CONTAIN}
                    shouldPlay={false} // Don't auto-play - we'll start when buffered
                    progressUpdateIntervalMillis={500} // Update progress every 500ms for buffering check
                  onLoadStart={() => {
                    console.log('🎬 Video load started - buffering begins');
                    setVideoBuffering(true);
                  }}
                  onReadyForDisplay={async () => {
                    console.log('🎬 Video ready for display - first frame available');
                    // First frame is ready - start playback immediately for progressive loading
                    if (videoRef) {
                      try {
                        await videoRef.playAsync();
                        console.log('🎬 ✅ Started playback (progressive)');
                        setVideoLoading(false); // Hide loading indicator
                        setVideoBuffering(false);
                      } catch (playError) {
                        console.warn('🎬 Auto-play failed:', playError);
                        // Still hide loading - user can tap play button
                        setVideoLoading(false);
                      }
                    }
                  }}
                  onLoad={async () => {
                    // Video metadata loaded - check if we have enough buffered data
                    if (videoRef) {
                      try {
                        const status = await videoRef.getStatusAsync();
                        if (status.isLoaded) {
                          const playableDuration = status.playableDurationMillis || 0;
                          const duration = status.durationMillis || 0;
                          
                          console.log(`🎬 Video metadata loaded - playable: ${(playableDuration/1000).toFixed(1)}s, total: ${(duration/1000).toFixed(1)}s`);
                          
                          // If we have at least 2 seconds buffered or 10% of video, start playing
                          const minBufferMs = Math.min(2000, duration * 0.1);
                          if (playableDuration >= minBufferMs && !status.isPlaying) {
                            await videoRef.playAsync();
                            console.log('🎬 ✅ Started playback (enough buffered)');
                            setVideoLoading(false);
                            setVideoBuffering(false);
                          } else if (playableDuration > 0) {
                            // Some data buffered but not enough - start monitoring
                            setVideoLoading(false); // Hide loading spinner, show video
                            // Start monitoring buffering progress
                            if (videoBufferingCheckRef.current) {
                              clearInterval(videoBufferingCheckRef.current);
                            }
                            videoBufferingCheckRef.current = setInterval(async () => {
                              if (videoRef) {
                                try {
                                  const currentStatus = await videoRef.getStatusAsync();
                                  if (currentStatus.isLoaded) {
                                    const currentPlayable = currentStatus.playableDurationMillis || 0;
                                    const currentDuration = currentStatus.durationMillis || 0;
                                    const minBuffer = Math.min(2000, currentDuration * 0.1);
                                    
                                    // Start playing when we have enough buffered
                                    if (currentPlayable >= minBuffer && !currentStatus.isPlaying && !currentStatus.isBuffering) {
                                      await videoRef.playAsync();
                                      console.log('🎬 ✅ Started playback (buffered enough)');
                                      setVideoBuffering(false);
                                      if (videoBufferingCheckRef.current) {
                                        clearInterval(videoBufferingCheckRef.current);
                                        videoBufferingCheckRef.current = null;
                                      }
                                    }
                                  }
                                } catch (err) {
                                  console.warn('Buffering check error:', err);
                                }
                              }
                            }, 500);
                          }
                          
                          // Clear loading timeout since video is loading
                          if (videoLoadingTimeoutRef.current) {
                            clearTimeout(videoLoadingTimeoutRef.current);
                            videoLoadingTimeoutRef.current = null;
                          }
                        }
                      } catch (statusError) {
                        console.warn('Error checking video status:', statusError);
                      }
                    }
                  }}
                  onPlaybackStatusUpdate={async (status) => {
                    if (status.isLoaded) {
                      // Update buffering state based on playback status
                      if (status.isBuffering && !videoBuffering) {
                        setVideoBuffering(true);
                      } else if (!status.isBuffering && videoBuffering && status.isPlaying) {
                        setVideoBuffering(false);
                      }
                      
                      // Clear loading state once playback starts
                      if (status.isPlaying && videoLoading) {
                        setVideoLoading(false);
                        setIsVideoFallbackInProgress(false);
                        // Clear timeout
                        if (videoLoadingTimeoutRef.current) {
                          clearTimeout(videoLoadingTimeoutRef.current);
                          videoLoadingTimeoutRef.current = null;
                        }
                      }
                    }
                  }}
                  onError={async (error: any) => {
                    let errorMessage: string;
                    if (typeof error === 'string') {
                      errorMessage = error;
                    } else if (error && typeof error === 'object') {
                      errorMessage = (error as any)?.error?.message || (error as any)?.message || String(error);
                    } else {
                      errorMessage = String(error);
                    }
                    // Use warn so AVFoundation -11800 doesn't dump a red ERROR stack (known: format/load failure in native player)
                    console.warn('Video playback error (native):', errorMessage);
                    
                    // Don't process errors if we're already in the middle of a fallback attempt
                    if (isVideoFallbackInProgress) {
                      console.log('🎬 Fallback in progress, ignoring error');
                      return;
                    }
                    
                    // We use the same stream endpoint as web: /api/v1/video/recording/{id}/stream
                    // Don't fallback to download for format errors - same file (WebM) fails on iOS either way
                    const isDownloadEndpoint = selectedVideoUrl?.includes('/download');
                    const isFormatError = errorMessage.includes('format is not supported') ||
                                         errorMessage.includes('-11828') ||
                                         errorMessage.includes('-11800') ||
                                         errorMessage.includes('-12792') ||
                                         errorMessage.includes('AVFoundationErrorDomain');
                    
                    // Only try direct URL if download failed with a non-format error (e.g. network)
                    if (isDownloadEndpoint && hasTriedVideoFallback && !isFormatError && videoDirectUrl) {
                      console.log('🎬 Download endpoint failed with non-format error, trying direct URL as fallback...');
                      
                      let directUrl = videoDirectUrl;
                      let fallbackToken: string | null = null;
                      try {
                        fallbackToken = await secureStorage.getItem(STORAGE_KEYS.AUTH_TOKEN);
                      } catch (tokenError) {
                        console.warn('Failed to retrieve auth token for direct URL:', tokenError);
                      }
                      
                      if (fallbackToken && !directUrl.includes('token=')) {
                        const separator = directUrl.includes('?') ? '&' : '?';
                        directUrl = `${directUrl}${separator}token=${encodeURIComponent(fallbackToken)}`;
                      }
                      
                      console.log('🎬 Trying direct URL:', directUrl);
                      setIsVideoFallbackInProgress(true); // Mark that fallback is in progress
                      // Increment key to force Video component remount with new URL
                      setVideoKey(prev => prev + 1);
                      setSelectedVideoUrl(directUrl);
                      setVideoLoading(true);
                      return; // Don't show error alert yet
                    }
                    
                    // Only show error if all fallbacks have been exhausted and we haven't shown it yet
                    if (hasShownVideoErrorRef.current) {
                      console.log('🎬 Error already shown, skipping duplicate alert');
                      return;
                    }
                    
                    setIsVideoFallbackInProgress(false);
                    setVideoLoading(false);
                    hasShownVideoErrorRef.current = true; // Mark that we've shown the error
                    
                    // Provide more specific error message; offer "Open in Browser" (same stream URL as web)
                    const errorTitle = isFormatError ? 'Video Format Not Supported' : 'Failed to Play Video';
                    const errorText = isFormatError 
                      ? 'This video format is not supported in the app. You can open the same stream in your browser to try playback there.'
                      : 'Failed to play video. Please check your connection and try again.';
                    
                    const streamUrlForBrowser = (() => {
                      const urlToMatch = originalVideoUrl || selectedVideoUrl || '';
                      const id = urlToMatch.match(/\/recording\/(\d+)(?:\/|$)/)?.[1];
                      return id ? `${API_BASE_URL}/api/v1/video/recording/${id}/stream` : null;
                    })();
                    
                    if (isFormatError && streamUrlForBrowser) {
                      Alert.alert(errorTitle, errorText, [
                        { text: 'OK', style: 'cancel' as const },
                        {
                          text: 'Open in Browser',
                          onPress: async () => {
                            try {
                              const token = await secureStorage.getItem(STORAGE_KEYS.AUTH_TOKEN);
                              const baseUrl = token
                                ? `${streamUrlForBrowser}?token=${encodeURIComponent(token)}`
                                : streamUrlForBrowser;
                              const url = baseUrl.includes('format=mp4') 
                                ? baseUrl 
                                : `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}format=mp4`;
                              const canOpen = await Linking.canOpenURL(url);
                              if (canOpen) await Linking.openURL(url);
                              else Alert.alert('Error', 'Cannot open browser');
                            } catch (e) {
                              console.warn('Open in browser failed:', e);
                              Alert.alert('Error', 'Could not open browser');
                            }
                          },
                        },
                      ]);
                    } else {
                      Alert.alert(errorTitle, errorText);
                    }
                  }}
                  />
                </View>
              </View>
            ) : (
              <Text style={{ color: '#fff' }}>No video loaded</Text>
            )}
          </View>
        </SafeAreaView>
      </Modal>

      {/* Audio Player Modal */}
      <Modal
        visible={showAudioPlayer}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={async () => {
          if (audioSound) {
            await audioSound.unloadAsync();
            setAudioSound(null);
          }
          setShowAudioPlayer(false);
          setAudioPlaying(false);
                  setAudioPosition(0);
                  setAudioDuration(0);
        }}
      >
        <SafeAreaView style={{ flex: 1, backgroundColor: themeColors.background }}>
          <View style={{ flex: 1, padding: 20 }}>
            {/* Close center top; title below so it doesn't cover progress/play controls */}
            <View style={{ marginBottom: 24, paddingTop: 0, alignItems: 'center' }}>
              <TouchableOpacity
                onPress={async () => {
                  if (audioSound) {
                    await audioSound.unloadAsync();
                    setAudioSound(null);
                  }
                  setShowAudioPlayer(false);
                  setAudioPlaying(false);
                  setAudioPosition(0);
                  setAudioDuration(0);
                }}
                style={{
                  backgroundColor: 'rgba(0,0,0,0.08)',
                  borderRadius: 22,
                  padding: 10,
                  paddingHorizontal: 12,
                }}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              >
                <Ionicons name="close" size={24} color={themeColors.text} />
              </TouchableOpacity>
              <Text style={{ fontSize: 18, fontWeight: '600', color: themeColors.text, marginTop: 12, textAlign: 'center', paddingHorizontal: 16 }} numberOfLines={1} ellipsizeMode="tail">
                {audioTitle}
              </Text>
            </View>

            {/* Audio Player Content */}
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', minHeight: 280 }}>
              {audioLoading || !audioSound ? (
                <View style={{ alignItems: 'center', width: '100%', paddingHorizontal: 40 }}>
                  <View style={{ 
                    width: 120, 
                    height: 120, 
                    borderRadius: 60, 
                    backgroundColor: `${themeColors.tint || '#007AFF'}20`,
                    justifyContent: 'center',
                    alignItems: 'center',
                    marginBottom: 24
                  }}>
                    <ActivityIndicator size="large" color={themeColors.tint || '#007AFF'} />
                  </View>
                  <Text style={{ marginBottom: 8, fontSize: 18, fontWeight: '600', color: themeColors.text, textAlign: 'center' }}>
                    {audioLoadingMessage}
                  </Text>
                  <Text style={{ fontSize: 14, color: themeColors.textSecondary || themeColors.text, textAlign: 'center', opacity: 0.8 }}>
                    {audioTitle ? `${audioTitle}` : 'Audio player'}
                  </Text>
                </View>
              ) : (
                <View style={{ width: '100%', alignItems: 'center' }}>
                  {/* Audio Icon */}
                  <View style={{ 
                    width: 120, 
                    height: 120, 
                    borderRadius: 60, 
                    backgroundColor: `${themeColors.tint || '#007AFF'}20`,
                    justifyContent: 'center',
                    alignItems: 'center',
                    marginBottom: 40
                  }}>
                    <Ionicons name="musical-notes" size={60} color={themeColors.tint || '#007AFF'} />
                  </View>

                  {/* Progress Bar with Seek Functionality */}
                  <View style={{ width: '100%', marginBottom: 20 }}>
                    <View 
                      ref={progressBarRef}
                      style={{ 
                        height: 40, 
                        justifyContent: 'center',
                        marginBottom: 8,
                        paddingVertical: 18
                      }}
                      onLayout={(event) => {
                        const { width } = event.nativeEvent.layout;
                        setProgressBarWidth(width);
                      }}
                      {...PanResponder.create({
                        onStartShouldSetPanResponder: () => true,
                        onMoveShouldSetPanResponder: () => true,
                        onPanResponderGrant: (evt) => {
                          if (audioDuration > 0 && audioSound) {
                            setIsSeeking(true);
                            const x = evt.nativeEvent.locationX;
                            const percentage = Math.max(0, Math.min(100, (x / progressBarWidth) * 100));
                            const newPosition = (percentage / 100) * audioDuration;
                            setSeekPosition(newPosition);
                          }
                        },
                        onPanResponderMove: (evt) => {
                          if (audioDuration > 0 && isSeeking) {
                            const x = evt.nativeEvent.locationX;
                            const percentage = Math.max(0, Math.min(100, (x / progressBarWidth) * 100));
                            const newPosition = (percentage / 100) * audioDuration;
                            setSeekPosition(newPosition);
                          }
                        },
                        onPanResponderRelease: async () => {
                          if (audioSound && isSeeking) {
                            setIsSeeking(false);
                            const status = await audioSound.getStatusAsync();
                            if (status.isLoaded) {
                              await audioSound.setPositionAsync(seekPosition);
                              setAudioPosition(seekPosition);
                            }
                          }
                        },
                        onPanResponderTerminate: () => {
                          setIsSeeking(false);
                        }
                      }).panHandlers}
                    >
                      <View style={{ 
                        height: 4, 
                        backgroundColor: themeColors.borderLight || themeColors.border, 
                        borderRadius: 2,
                        position: 'relative'
                      }}>
                        <View style={{ 
                          height: '100%', 
                          backgroundColor: themeColors.tint || '#007AFF',
                          width: audioDuration > 0 
                            ? `${((isSeeking ? seekPosition : audioPosition) / audioDuration) * 100}%` 
                            : '0%',
                          borderRadius: 2
                        }} />
                        {audioDuration > 0 && (
                          <View style={{
                            position: 'absolute',
                            left: audioDuration > 0 
                              ? `${((isSeeking ? seekPosition : audioPosition) / audioDuration) * 100}%` 
                              : '0%',
                            top: -6,
                            width: 16,
                            height: 16,
                            borderRadius: 8,
                            backgroundColor: themeColors.tint || '#007AFF',
                            borderWidth: 2,
                            borderColor: themeColors.background || '#fff',
                            marginLeft: -8
                          }} />
                        )}
                      </View>
                    </View>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text style={{ fontSize: 12, color: themeColors.textSecondary }}>
                        {formatAudioTime(isSeeking ? seekPosition : audioPosition)}
                      </Text>
                      <Text style={{ fontSize: 12, color: themeColors.textSecondary }}>
                        {formatAudioTime(audioDuration)}
                      </Text>
                    </View>
                  </View>

                  {/* Controls */}
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 30 }}>
                    <TouchableOpacity
                      onPress={async () => {
                        if (audioSound) {
                          const status = await audioSound.getStatusAsync();
                          if (status.isLoaded) {
                            const newPosition = Math.max(0, audioPosition - 10000); // Skip back 10 seconds
                            await audioSound.setPositionAsync(newPosition);
                            setAudioPosition(newPosition);
                          }
                        }
                      }}
                      style={{ padding: 10 }}
                    >
                      <Ionicons name="play-back" size={32} color={themeColors.text} />
                    </TouchableOpacity>

                    <TouchableOpacity
                      onPress={async () => {
                        if (audioSound) {
                          if (audioPlaying) {
                            await audioSound.pauseAsync();
                            setAudioPlaying(false);
                          } else {
                            await audioSound.playAsync();
                            setAudioPlaying(true);
                          }
                        }
                      }}
                      style={{
                        width: 64,
                        height: 64,
                        borderRadius: 32,
                        backgroundColor: themeColors.tint || '#007AFF',
                        justifyContent: 'center',
                        alignItems: 'center'
                      }}
                    >
                      <Ionicons 
                        name={audioPlaying ? "pause" : "play"} 
                        size={32} 
                        color="#fff" 
                      />
                    </TouchableOpacity>

                    <TouchableOpacity
                      onPress={async () => {
                        if (audioSound) {
                          const status = await audioSound.getStatusAsync();
                          if (status.isLoaded && status.durationMillis) {
                            const newPosition = Math.min(status.durationMillis, audioPosition + 10000); // Skip forward 10 seconds
                            await audioSound.setPositionAsync(newPosition);
                            setAudioPosition(newPosition);
                          }
                        }
                      }}
                      style={{ padding: 10 }}
                    >
                      <Ionicons name="play-forward" size={32} color={themeColors.text} />
                    </TouchableOpacity>
                  </View>
                </View>
              )}
            </View>
          </View>
        </SafeAreaView>
      </Modal>

      {/* Text Asset Viewer - Reusable component for all text assets */}
      <TextAssetViewer
        visible={showTextViewer}
        title={textViewerTitle}
        content={textViewerContent}
        loading={textViewerLoading}
        assetType={textViewerAssetType}
        onClose={() => {
          setShowTextViewer(false);
          setTextViewerContent('');
          setTextViewerTitle('');
          setTextViewerAssetType('');
          setTextViewerLoading(false);
        }}
      />
      <ActionMenuModal
        visible={menuAsset != null}
        title={menuAsset?.title ?? 'Asset'}
        message="Choose an action"
        items={assetMenuItems}
        onClose={() => setMenuAsset(null)}
      />
    </SafeAreaView>
  );
}

