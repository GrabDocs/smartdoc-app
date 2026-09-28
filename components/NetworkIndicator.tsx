import React, { useEffect, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { apiClient } from '../services/api';
import { WifiCogIcon } from './WifiCogIcon';

interface NetworkStatus {
  isConnected: boolean;
  isChecking: boolean;
  lastCheck: Date | null;
  error?: string;
}

interface NetworkIndicatorProps {
  compact?: boolean;
  persistent?: boolean;
}

export default function NetworkIndicator({ compact = false, persistent = false }: NetworkIndicatorProps) {
  const [status, setStatus] = useState<NetworkStatus>({
    isConnected: false,
    isChecking: true,
    lastCheck: null,
  });
  
  const [pulseAnim] = useState(new Animated.Value(1));

  // Pulse animation for checking state
  useEffect(() => {
    if (status.isChecking) {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 0.5,
            duration: 1000,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 1000,
            useNativeDriver: true,
          }),
        ])
      );
      pulse.start();
      return () => pulse.stop();
    }
  }, [status.isChecking, pulseAnim]);

  const checkConnection = async () => {
    setStatus(prev => ({ ...prev, isChecking: true }));
    
    try {
      const result = await apiClient.testConnectivity();
      setStatus({
        isConnected: result.success,
        isChecking: false,
        lastCheck: new Date(),
        error: result.success ? undefined : result.message,
      });
    } catch (error) {
      setStatus({
        isConnected: false,
        isChecking: false,
        lastCheck: new Date(),
        error: error instanceof Error ? error.message : 'Connection failed',
      });
    }
  };

  // Check connection on mount and every 30 seconds
  useEffect(() => {
    checkConnection();
    
    const interval = setInterval(checkConnection, 30000);
    return () => clearInterval(interval);
  }, []);

  const getStatusColor = () => {
    if (status.isChecking) return '#FF6B35'; // Softer orange for checking
    if (status.isConnected) return '#32CD32'; // Lime green for connected
    return '#DC143C'; // Crimson red for disconnected
  };

  const getStatusText = () => {
    if (status.isChecking) return 'Checking...';
    if (status.isConnected) return 'Connected';
    return 'Disconnected';
  };

  // Compact version for persistent display
  if (compact) {
    return (
      <View style={styles.compactContainer}>
        {!persistent && (
          <Text style={styles.compactText}>{getStatusText()}</Text>
        )}
        <Animated.View 
          style={[
            styles.compactIndicator,
            { 
              opacity: pulseAnim 
            }
          ]}
        >
          <WifiCogIcon size={16} color={getStatusColor()} />
        </Animated.View>
      </View>
    );
  }

  // Full version (original)
  return (
    <View style={styles.container}>
      <Text style={styles.text}>{getStatusText()}</Text>
      <Animated.View 
        style={[
          styles.indicator,
          { 
            backgroundColor: getStatusColor(),
            opacity: pulseAnim 
          }
        ]}
      >
        <WifiCogIcon size={12} color="white" />
      </Animated.View>
      {status.error && !status.isChecking && (
        <Text style={styles.errorText} numberOfLines={1}>
          {status.error}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: 'rgba(0, 0, 0, 0.05)',
    borderRadius: 20,
    marginHorizontal: 16,
    marginVertical: 8,
  },
  indicator: {
    width: 20,
    height: 20,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 8,
  },
  text: {
    fontSize: 14,
    fontWeight: '500',
    color: '#333',
  },
  errorText: {
    fontSize: 12,
    color: '#F44336',
    marginLeft: 8,
    flex: 1,
  },
  // Compact styles for persistent display
  compactContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end', // Align to the right
    paddingHorizontal: 8,
    paddingVertical: 2,
    backgroundColor: 'transparent', // Remove background completely
    borderRadius: 12,
    marginHorizontal: 8,
    marginTop: -2,
    marginBottom: 4,
  },
  compactIndicator: {
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 6,
  },
  compactText: {
    fontSize: 12,
    fontWeight: '500',
    color: '#333',
  },
});
