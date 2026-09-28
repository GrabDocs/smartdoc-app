import { Ionicons } from '@expo/vector-icons';
import { Audio, InterruptionModeAndroid, InterruptionModeIOS, ResizeMode, Video, VideoFullscreenUpdate } from 'expo-av';
import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useThemeColors } from '../../hooks/useThemeColors';
import {
  getAuthToken,
  prepareAudioPlayback,
  prepareVideoPlayback,
  recordingDownloadUrl,
  startRecordingCacheDownload,
  startStreamFileDownload,
} from '../../utils/meetingRecordingPlayback';
import { isAudioTrackType } from './meetingRecapTypes';

export type MeetingCachedPlayerHandle = {
  seekToMillis: (millis: number) => Promise<void>;
};

type Props = {
  streamUrl: string;
  trackType?: string | null;
  assetId?: string;
  onPlaybackStatus?: (positionSeconds: number) => void;
};

const MeetingCachedRecordingPlayer = forwardRef<MeetingCachedPlayerHandle, Props>(function MeetingCachedRecordingPlayer(
  { streamUrl, trackType, assetId, onPlaybackStatus },
  ref
) {
  const colors = useThemeColors();
  const audio = isAudioTrackType(trackType);
  const videoRef = useRef<Video | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);
  const currentStreamUrlRef = useRef<string | null>(null);
  const pendingSeekRef = useRef<number | null>(null);
  const onPlaybackStatusRef = useRef(onPlaybackStatus);
  onPlaybackStatusRef.current = onPlaybackStatus;
  const [started, setStarted] = useState(false);
  const [loadNonce, setLoadNonce] = useState(0);
  const [uri, setUri] = useState<string | null>(null);
  const [videoKey, setVideoKey] = useState(0);
  const [buffering, setBuffering] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [audioPosition, setAudioPosition] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [loadingMessage, setLoadingMessage] = useState('Preparing...');

  const start = (seekMillis?: number) => {
    if (seekMillis != null) pendingSeekRef.current = seekMillis;
    setError(null);
    setStarted(true);
    setLoadNonce((n) => n + 1);
  };

  useImperativeHandle(ref, () => ({
    seekToMillis: async (millis: number) => {
      if (!started) {
        start(millis);
        return;
      }
      if (audio) {
        const sound = soundRef.current;
        if (!sound) return;
        const status = await sound.getStatusAsync();
        if (status.isLoaded) {
          await sound.setPositionAsync(millis);
          await sound.playAsync();
          setAudioPlaying(true);
        }
        return;
      }
      await videoRef.current?.setPositionAsync(millis);
      await videoRef.current?.playAsync();
    },
  }));

  useEffect(() => {
    if (!started) return;
    let cancelled = false;
    setError(null);
    setBuffering(true);
    setLoadingMessage(audio ? 'Loading audio...' : 'Loading video...');

    (async () => {
      try {
        if (audio) {
          await Audio.setAudioModeAsync({
            playsInSilentModeIOS: true,
            staysActiveInBackground: false,
            shouldDuckAndroid: true,
            playThroughEarpieceAndroid: false,
            interruptionModeIOS: InterruptionModeIOS.DoNotMix,
            interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
          }).catch(() => {});

          const prepared = await prepareAudioPlayback(streamUrl, assetId);
          if (cancelled) return;
          const playUri = prepared.cachedUri || prepared.finalUrl;
          setLoadingMessage(prepared.cachedUri ? 'Loading...' : 'Loading audio...');
          const { sound } = await Audio.Sound.createAsync(
            { uri: playUri },
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
          const status = await sound.getStatusAsync();
          if (!status.isLoaded) throw new Error('Audio failed to load - file may be corrupted or unsupported format');
          if (status.durationMillis) setAudioDuration(status.durationMillis);
          soundRef.current = sound;
          await sound.setVolumeAsync(1);
          await sound.setIsMutedAsync(false);
          const seek = pendingSeekRef.current;
          pendingSeekRef.current = null;
          if (seek != null) await sound.setPositionAsync(seek);
          await sound.playAsync();
          setAudioPlaying(true);
          setBuffering(false);

          if (!prepared.cachedUri && (streamUrl.includes('/stream') || streamUrl.includes('/download'))) {
            void startRecordingCacheDownload({
              recordingUrl: streamUrl,
              token: prepared.token,
              cachePath: prepared.cachePath,
              kind: 'audio',
            });
          }
          return;
        }

        const prepared = await prepareVideoPlayback(streamUrl, assetId);
        if (cancelled) return;
        if (prepared.isPlayingFromCache) {
          currentStreamUrlRef.current = null;
          setUri(prepared.uriToPlay);
          setVideoKey((k) => k + 1);
          setBuffering(false);
          return;
        }
        setLoadingMessage('Loading video...');
        currentStreamUrlRef.current = prepared.finalUrl;
        const cached = await startStreamFileDownload(prepared.finalUrl, prepared.cachePath);
        if (cancelled) return;
        if (cached) {
          setUri(cached);
          setVideoKey((k) => k + 1);
          setBuffering(true);
          currentStreamUrlRef.current = null;
          return;
        }
        currentStreamUrlRef.current = prepared.finalUrl;
        setUri(prepared.uriToPlay);
        setVideoKey((k) => k + 1);
        setBuffering(true);
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        if (audio && (message.includes('format is not supported') || message.includes('-11828'))) {
          try {
            const token = await getAuthToken();
            const fallbackUrl = recordingDownloadUrl(streamUrl, token, 'audio');
            if (!fallbackUrl) throw e;
            setLoadingMessage('Loading audio...');
            const { sound } = await Audio.Sound.createAsync(
              { uri: fallbackUrl },
              { shouldPlay: false, isMuted: false, volume: 1.0 }
            );
            if (cancelled) {
              await sound.unloadAsync().catch(() => {});
              return;
            }
            soundRef.current = sound;
            await sound.playAsync();
            setAudioPlaying(true);
            setBuffering(false);
            return;
          } catch {
            /* show original error */
          }
        }
        if (!cancelled) {
          setError(message || 'Unable to play this recording.');
          setBuffering(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      const sound = soundRef.current;
      soundRef.current = null;
      if (sound) void sound.unloadAsync().catch(() => {});
    };
  }, [streamUrl, audio, assetId, started, loadNonce]);

  const applyPendingVideoSeek = async () => {
    const seek = pendingSeekRef.current;
    if (seek == null) return;
    pendingSeekRef.current = null;
    try {
      await videoRef.current?.setPositionAsync(seek);
      await videoRef.current?.playAsync();
    } catch {
      /* native player reports its own error */
    }
  };

  const toggleFullscreen = async () => {
    if (fullscreen) {
      try {
        await videoRef.current?.dismissFullscreenPlayer();
      } catch {
        /* already dismissed */
      }
      setFullscreen(false);
      return;
    }
    try {
      await videoRef.current?.presentFullscreenPlayer();
      setFullscreen(true);
    } catch {
      setFullscreen(true);
    }
  };

  const toggleAudio = async () => {
    if (!started) {
      start();
      return;
    }
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
        {started && buffering ? (
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
                {started ? `${mins(audioPosition)} / ${mins(audioDuration)}` : 'Tap play'}
              </Text>
            </View>
          </View>
        )}
      </View>
    );
  }

  if (!started || !uri) {
    return (
      <View style={styles.videoWrap}>
        {started ? (
          <View style={styles.videoIdle}>
            <ActivityIndicator color="#fff" />
            <Text style={styles.videoIdleText}>{loadingMessage}</Text>
          </View>
        ) : (
          <TouchableOpacity style={styles.videoIdle} onPress={() => start()} accessibilityLabel="Play video">
            <Ionicons name="play-circle" size={56} color="#fff" />
            <Text style={styles.videoIdleText}>Tap play</Text>
          </TouchableOpacity>
        )}
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
            await applyPendingVideoSeek();
            setBuffering(false);
          } catch {
            setBuffering(false);
          }
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
              await applyPendingVideoSeek();
              setBuffering(false);
            }
          } catch {
            /* keep buffering */
          }
        }}
        onPlaybackStatusUpdate={(status) => {
          if (!status.isLoaded) return;
          if (status.isBuffering) setBuffering(true);
          else if (status.isPlaying || (status.playableDurationMillis || 0) > 0) setBuffering(false);
          if (status.positionMillis != null) onPlaybackStatusRef.current?.(status.positionMillis / 1000);
        }}
        onFullscreenUpdate={(event) => {
          if (event.fullscreenUpdate === VideoFullscreenUpdate.PLAYER_DID_PRESENT) setFullscreen(true);
          else if (event.fullscreenUpdate === VideoFullscreenUpdate.PLAYER_DID_DISMISS) setFullscreen(false);
        }}
        onError={() => setError('Unable to play this recording.')}
      />
      <TouchableOpacity
        style={styles.expand}
        onPress={() => void toggleFullscreen()}
        accessibilityLabel={fullscreen ? 'Exit full screen' : 'Full screen'}
      >
        <Ionicons name={fullscreen ? 'contract' : 'expand'} size={18} color="#fff" />
      </TouchableOpacity>
    </View>
  );
});

export default MeetingCachedRecordingPlayer;

const styles = StyleSheet.create({
  error: { color: '#dc2626', fontSize: 12, marginTop: 6 },
  videoWrap: { width: '100%', height: 200, borderRadius: 8, overflow: 'hidden', backgroundColor: '#000' },
  video: { width: '100%', height: '100%' },
  videoIdle: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  videoIdleText: { color: '#fff', marginTop: 8, fontSize: 13 },
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
