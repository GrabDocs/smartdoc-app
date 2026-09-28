import { Ionicons } from '@expo/vector-icons';
import { Audio, InterruptionModeAndroid, InterruptionModeIOS, ResizeMode, Video, VideoFullscreenUpdate } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { API_BASE_URL, STORAGE_KEYS } from '../../constants/Config';
import { useThemeColors } from '../../hooks/useThemeColors';
import { secureStorage } from '../../utils/storage';
import { isAudioTrackType } from './meetingRecapTypes';

export type MeetingInlinePlayerHandle = {
  seekToMillis: (millis: number) => Promise<void>;
};

type Props = {
  streamUrl: string;
  trackType?: string | null;
  assetId?: string;
  onPlaybackStatus?: (positionSeconds: number) => void;
};

function cachePath(kind: 'video' | 'audio', assetId: string | undefined, url: string, ext: string): string {
  const dir = FileSystem.cacheDirectory || FileSystem.documentDirectory || '';
  const key = assetId || `url_${Math.abs(url.split('').reduce((a, b) => ((a << 5) - a) + b.charCodeAt(0), 0) % 1e9)}`;
  const safe = key.replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 80);
  return `${dir}meeting_${kind}_${safe}.${ext}`;
}

function fileUri(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}

/**
 * Same progressive playback as the meeting-assets players:
 * stream immediately, start as data arrives, and switch to a cached MP4 when the download finishes.
 */
const MeetingInlineRecordingPlayer = forwardRef<MeetingInlinePlayerHandle, Props>(function MeetingInlineRecordingPlayer(
  { streamUrl, trackType, assetId, onPlaybackStatus },
  ref
) {
  const colors = useThemeColors();
  const audio = isAudioTrackType(trackType);
  const videoRef = useRef<Video | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);
  const streamUrlRef = useRef<string | null>(null);
  const onPlaybackStatusRef = useRef(onPlaybackStatus);
  onPlaybackStatusRef.current = onPlaybackStatus;
  const [uri, setUri] = useState<string | null>(null);
  const [videoKey, setVideoKey] = useState(0);
  const [buffering, setBuffering] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [audioPosition, setAudioPosition] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [loadingMessage, setLoadingMessage] = useState('Loading...');

  useImperativeHandle(ref, () => ({
    seekToMillis: async (millis: number) => {
      if (audio && soundRef.current) {
        const status = await soundRef.current.getStatusAsync();
        if (status.isLoaded) {
          await soundRef.current.setPositionAsync(millis);
          await soundRef.current.playAsync();
          setAudioPlaying(true);
        }
        return;
      }
      await videoRef.current?.setPositionAsync(millis);
      await videoRef.current?.playAsync();
    },
  }));

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setUri(null);
    setBuffering(true);
    setLoadingMessage(audio ? 'Loading audio...' : 'Loading video...');

    (async () => {
      let token: string | null = null;
      try {
        token = await secureStorage.getItem(STORAGE_KEYS.AUTH_TOKEN);
      } catch {
        token = null;
      }
      if (cancelled) return;

      let finalUrl = streamUrl;
      if (token && !finalUrl.includes('token=')) {
        finalUrl += `${finalUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
      }
      if (finalUrl.includes('/recording/') && finalUrl.includes('/stream') && !finalUrl.includes('format=mp4')) {
        finalUrl += `${finalUrl.includes('?') ? '&' : '?'}format=mp4`;
      }

      if (audio) {
        try {
          await Audio.setAudioModeAsync({
            playsInSilentModeIOS: true,
            staysActiveInBackground: false,
            shouldDuckAndroid: true,
            playThroughEarpieceAndroid: false,
            interruptionModeIOS: InterruptionModeIOS.DoNotMix,
            interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
          });
        } catch {
          /* mode is best-effort */
        }
        const path = cachePath('audio', assetId, streamUrl, 'm4a');
        try {
          const cached = await FileSystem.getInfoAsync(path);
          const source = cached.exists && (cached.size ?? 0) > 0 ? path : finalUrl;
          if (cancelled) return;
          const { sound } = await Audio.Sound.createAsync(
            { uri: source },
            { shouldPlay: false, isMuted: false, volume: 1.0 },
            (status) => {
              if (!status.isLoaded) return;
              setAudioPosition(status.positionMillis || 0);
              if (status.durationMillis) setAudioDuration(status.durationMillis);
              setAudioPlaying(status.isPlaying);
              if (status.positionMillis != null) onPlaybackStatusRef.current?.(status.positionMillis / 1000);
            }
          );
          if (cancelled) {
            await sound.unloadAsync().catch(() => {});
            return;
          }
          soundRef.current = sound;
          const status = await sound.getStatusAsync();
          if (status.isLoaded && status.durationMillis) setAudioDuration(status.durationMillis);
          await sound.playAsync();
          setAudioPlaying(true);
          setBuffering(false);
          if (source === finalUrl && finalUrl.includes('/recording/')) {
            const id = finalUrl.match(/\/recording\/(\d+)\//)?.[1];
            if (id && token) {
              const downloadUrl = `${API_BASE_URL}/api/v1/video/recording/${id}/download?token=${encodeURIComponent(token)}&format=mp4`;
              FileSystem.downloadAsync(downloadUrl, path).catch(() => {});
            }
          }
        } catch (e) {
          if (!cancelled) setError(e instanceof Error ? e.message : 'Unable to play this recording.');
          setBuffering(false);
        }
        return;
      }

      const path = cachePath('video', assetId, finalUrl, 'mp4');
      let uriToPlay = finalUrl;
      try {
        const cached = await FileSystem.getInfoAsync(path);
        if (cached.exists && (cached.size ?? 0) > 0) {
          uriToPlay = fileUri(path);
        }
      } catch {
        /* stream instead */
      }
      if (cancelled) return;
      const fromCache = uriToPlay.startsWith('file://');
      streamUrlRef.current = fromCache ? null : finalUrl;
      setUri(uriToPlay);
      setBuffering(!fromCache);
      setVideoKey((k) => k + 1);

      if (!fromCache && finalUrl.includes('/recording/')) {
        const id = finalUrl.match(/\/recording\/(\d+)\//)?.[1];
        if (id && token) {
          const downloadUrl = `${API_BASE_URL}/api/v1/video/recording/${id}/download?token=${encodeURIComponent(token)}&format=mp4`;
          const watching = finalUrl;
          FileSystem.downloadAsync(downloadUrl, path)
            .then(() => {
              if (cancelled || streamUrlRef.current !== watching) return;
              streamUrlRef.current = null;
              setUri(fileUri(path));
              setVideoKey((k) => k + 1);
              setBuffering(false);
            })
            .catch(() => {});
        }
      }
    })();

    return () => {
      cancelled = true;
      streamUrlRef.current = null;
      const sound = soundRef.current;
      soundRef.current = null;
      if (sound) void sound.unloadAsync().catch(() => {});
    };
  }, [streamUrl, audio, assetId]);

  const toggleAudio = async () => {
    const sound = soundRef.current;
    if (!sound) return;
    const status = await sound.getStatusAsync();
    if (!status.isLoaded) return;
    if (status.isPlaying) {
      await sound.pauseAsync();
      setAudioPlaying(false);
    } else {
      await sound.playAsync();
      setAudioPlaying(true);
    }
  };

  if (error) {
    return <Text style={styles.error}>{error}</Text>;
  }

  if (audio) {
    const mins = (ms: number) => {
      const total = Math.floor(ms / 1000);
      const m = Math.floor(total / 60);
      const s = total % 60;
      return `${m}:${String(s).padStart(2, '0')}`;
    };
    return (
      <View style={[styles.audio, { backgroundColor: colors.surface || colors.card }]}>
        {buffering ? (
          <View style={styles.audioLoading}>
            <ActivityIndicator color={colors.tint || '#007AFF'} />
            <Text style={{ color: colors.textSecondary, marginTop: 6 }}>{loadingMessage}</Text>
          </View>
        ) : (
          <View style={styles.audioRow}>
            <TouchableOpacity onPress={() => void toggleAudio()} accessibilityLabel={audioPlaying ? 'Pause' : 'Play'}>
              <Ionicons name={audioPlaying ? 'pause-circle' : 'play-circle'} size={40} color={colors.tint || '#007AFF'} />
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <View style={[styles.track, { backgroundColor: colors.border }]}>
                <View
                  style={[
                    styles.trackFill,
                    {
                      width: audioDuration > 0 ? `${Math.min(100, (audioPosition / audioDuration) * 100)}%` : '0%',
                      backgroundColor: colors.tint || '#007AFF',
                    },
                  ]}
                />
              </View>
              <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 4 }}>
                {mins(audioPosition)} / {mins(audioDuration)}
              </Text>
            </View>
          </View>
        )}
      </View>
    );
  }

  if (!uri) {
    return (
      <View style={styles.videoLoading}>
        <ActivityIndicator color="#fff" />
        <Text style={styles.videoLoadingText}>{loadingMessage}</Text>
      </View>
    );
  }

  return (
    <View style={styles.videoWrap}>
      {buffering ? (
        <View style={styles.bufferBadge}>
          <ActivityIndicator size="small" color="#fff" />
          <Text style={styles.bufferText}>Buffering...</Text>
        </View>
      ) : null}
      <Video
        key={`${uri}-${videoKey}`}
        ref={(el) => {
          videoRef.current = el;
        }}
        source={{ uri }}
        style={styles.video}
        useNativeControls
        resizeMode={ResizeMode.CONTAIN}
        shouldPlay={false}
        progressUpdateIntervalMillis={500}
        onLoadStart={() => setBuffering(true)}
        onReadyForDisplay={async () => {
          try {
            await videoRef.current?.playAsync();
          } catch {
            /* user can tap play */
          }
          setBuffering(false);
        }}
        onLoad={async () => {
          try {
            const status = await videoRef.current?.getStatusAsync();
            if (!status?.isLoaded) return;
            const playable = status.playableDurationMillis || 0;
            const duration = status.durationMillis || 0;
            const minBuffer = Math.min(2000, duration * 0.1);
            if (playable >= minBuffer && !status.isPlaying) {
              await videoRef.current?.playAsync();
              setBuffering(false);
            }
          } catch {
            /* keep buffering indicator */
          }
        }}
        onPlaybackStatusUpdate={(status) => {
          if (!status.isLoaded) return;
          if (status.isBuffering) setBuffering(true);
          else if (status.isPlaying) setBuffering(false);
          if (status.positionMillis != null) onPlaybackStatusRef.current?.(status.positionMillis / 1000);
        }}
        onFullscreenUpdate={(event) => {
          if (event.fullscreenUpdate === VideoFullscreenUpdate.PLAYER_WILL_DISMISS) {
            /* native fullscreen returns to this inline player */
          }
        }}
        onError={() => setError('Unable to play this recording.')}
      />
      <TouchableOpacity
        style={styles.expand}
        onPress={() => void videoRef.current?.presentFullscreenPlayer().catch(() => {})}
        accessibilityLabel="Full screen"
      >
        <Ionicons name="expand" size={18} color="#fff" />
      </TouchableOpacity>
    </View>
  );
});

export default MeetingInlineRecordingPlayer;

const styles = StyleSheet.create({
  error: { color: '#dc2626', fontSize: 12, marginTop: 6 },
  videoWrap: { width: '100%', height: 200, borderRadius: 8, overflow: 'hidden', backgroundColor: '#000' },
  video: { width: '100%', height: '100%' },
  videoLoading: { height: 200, borderRadius: 8, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  videoLoadingText: { color: '#fff', marginTop: 8 },
  bufferBadge: {
    position: 'absolute',
    zIndex: 2,
    alignSelf: 'center',
    top: 80,
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
  },
  bufferText: { color: '#fff', fontSize: 12, marginTop: 4 },
  expand: {
    position: 'absolute',
    right: 8,
    top: 8,
    zIndex: 3,
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: 16,
    padding: 6,
  },
  audio: { borderRadius: 10, padding: 10 },
  audioLoading: { alignItems: 'center', paddingVertical: 12 },
  audioRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  trackFill: { height: '100%' },
});
