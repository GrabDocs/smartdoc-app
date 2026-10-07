import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    FlatList,
    Modal,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import FileNameText from './FileNameText';
import AppHeaderTitle from './AppHeaderTitle';
import { DropboxLogo } from './DropboxLogo';
import { GoogleDriveLogo } from './GoogleDriveLogo';
import { ExternalFile, externalFileService } from '../services/externalFileServices';

interface ExternalFilePickerProps {
  visible: boolean;
  onClose: () => void;
  onFileImport: (file: ExternalFile) => void;
  onImportSuccess?: () => void;
}

interface ServiceConfig {
  id: 'dropbox' | 'googledrive';
  name: string;
  color: string;
}

const SERVICES: ServiceConfig[] = [
  {
    id: 'dropbox',
    name: 'Dropbox',
    color: '#0061FF',
  },
  {
    id: 'googledrive',
    name: 'Google Drive',
    color: '#4285F4',
  },
];

export function ExternalFilePicker({
  visible,
  onClose,
  onFileImport,
  onImportSuccess,
}: ExternalFilePickerProps) {
  const [selectedService, setSelectedService] = useState<'dropbox' | 'googledrive' | null>(null);
  const [files, setFiles] = useState<ExternalFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState<string>('');
  const [currentFolderId, setCurrentFolderId] = useState<string>('root');
  const [authenticated, setAuthenticated] = useState<Record<string, boolean>>({});

  // Check authentication status for all services
  useEffect(() => {
    checkAuthenticationStatus();
  }, []);

  const checkAuthenticationStatus = async () => {
    const authStatus: Record<string, boolean> = {};
    for (const service of SERVICES) {
      authStatus[service.id] = await externalFileService.isAuthenticated(service.id);
    }
    setAuthenticated(authStatus);
  };

  const handleServiceSelect = async (serviceId: 'dropbox' | 'googledrive') => {
    setSelectedService(serviceId);
    setLoading(true);
    
    try {
      // Check if authenticated
      if (!authenticated[serviceId]) {
        await handleAuthenticate(serviceId);
        return;
      }

      // Load files
      await loadFiles(serviceId);
    } catch (error) {
      console.error(`Error selecting ${serviceId}:`, error);
      Alert.alert('Error', `Failed to connect to ${externalFileService.getServiceName(serviceId)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleAuthenticate = async (serviceId: 'dropbox' | 'googledrive') => {
    try {
      setLoading(true);
      let result;
      
      if (serviceId === 'dropbox') {
        result = await externalFileService.authenticateDropbox();
      } else {
        result = await externalFileService.authenticateGoogleDrive();
      }

      if (result.success) {
        Alert.alert(
          'Connected successfully!',
          `Connected to ${externalFileService.getServiceName(serviceId)}`
        );
        setAuthenticated(prev => ({ ...prev, [serviceId]: true }));
        await loadFiles(serviceId);
      } else {
        Alert.alert(
          'Authentication Failed',
          result.error || 'Failed to authenticate'
        );
      }
    } catch (error: any) {
      console.error(`Authentication error for ${serviceId}:`, error);
      Alert.alert('Error', error.message || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  const loadFiles = async (serviceId: 'dropbox' | 'googledrive', path?: string, folderId?: string) => {
    try {
      setLoading(true);
      let result;
      
      if (serviceId === 'dropbox') {
        result = await externalFileService.getDropboxFiles(path || currentPath);
      } else {
        result = await externalFileService.getGoogleDriveFiles(folderId || currentFolderId);
      }

      if (result.success && result.files) {
        setFiles(result.files);
      } else {
        Alert.alert('Error', result.error || 'Failed to load files');
      }
    } catch (error: any) {
      console.error(`Error loading files from ${serviceId}:`, error);
      Alert.alert('Error', error.message || 'Failed to load files');
    } finally {
      setLoading(false);
    }
  };

  const handleFileSelect = (file: ExternalFile) => {
    if (externalFileService.isFolder(file)) {
      // Navigate into folder
      if (file.service === 'dropbox') {
        setCurrentPath(file.path_display || '');
        loadFiles('dropbox', file.path_display || '');
      } else {
        setCurrentFolderId(file.id);
        loadFiles('googledrive', undefined, file.id);
      }
    } else if (externalFileService.canDownload(file)) {
      // Import file
      handleFileImport(file);
    }
  };

  const handleFileImport = async (file: ExternalFile) => {
    try {
      setImporting(file.id);
      
      const result = await externalFileService.downloadFromExternalService(
        file.service,
        file.id,
        file.name,
        (progress) => {
          console.log(`Import progress: ${progress}%`);
        }
      );

      if (result.success) {
        Alert.alert(
          'File imported successfully!',
          `"${file.name}" has been added to your documents`
        );
        onFileImport(file);
        if (onImportSuccess) {
          onImportSuccess();
        }
      } else if (result.limit) {
        return;
      } else {
        Alert.alert(
          'Import Failed',
          result.error || 'Failed to import file'
        );
      }
    } catch (error: any) {
      console.error('File import error:', error);
      Alert.alert('Error', error.message || 'Failed to import file');
    } finally {
      setImporting(null);
    }
  };

  const handleGoBack = () => {
    if (selectedService === 'dropbox' && currentPath) {
      // Go to parent directory
      const pathParts = currentPath.split('/').filter(part => part);
      pathParts.pop();
      const newPath = pathParts.length > 0 ? '/' + pathParts.join('/') : '';
      setCurrentPath(newPath);
      loadFiles('dropbox', newPath);
    } else if (selectedService === 'googledrive' && currentFolderId !== 'root') {
      // For simplicity, just go back to root for Google Drive
      setCurrentFolderId('root');
      loadFiles('googledrive', undefined, 'root');
    } else {
      // Go back to service selection
      setSelectedService(null);
      setFiles([]);
      setCurrentPath('');
      setCurrentFolderId('root');
    }
  };

  const renderServiceItem = ({ item }: { item: ServiceConfig }) => (
    <TouchableOpacity
      style={[styles.serviceItem, { borderColor: item.color }]}
      onPress={() => handleServiceSelect(item.id)}
      disabled={loading}
    >
      <View style={styles.serviceContent}>
        <View style={[styles.serviceIcon, { backgroundColor: '#ffffff' }]}>
          {item.id === 'dropbox' ? <DropboxLogo size={32} /> : <GoogleDriveLogo size={28} />}
        </View>
        <Text style={styles.serviceName}>{item.name}</Text>
        {authenticated[item.id] && (
          <Ionicons name="checkmark-circle" size={20} color="#10B981" />
        )}
      </View>
    </TouchableOpacity>
  );

  const renderFileItem = ({ item }: { item: ExternalFile }) => (
    <TouchableOpacity
      style={styles.fileItem}
      onPress={() => handleFileSelect(item)}
      disabled={importing === item.id}
    >
      <View style={styles.fileContent}>
        <View style={styles.fileIcon}>
          <Ionicons
            name={externalFileService.isFolder(item) ? 'folder' : 'document'}
            size={24}
            color={externalFileService.isFolder(item) ? '#F59E0B' : '#6B7280'}
          />
        </View>
        <View style={styles.fileDetails}>
          <FileNameText name={item.name} style={styles.fileName} />
          {!externalFileService.isFolder(item) && item.size && (
            <Text style={styles.fileSize}>
              {externalFileService.formatFileSize(item.size)}
            </Text>
          )}
        </View>
        {importing === item.id ? (
          <ActivityIndicator size="small" color="#3B82F6" />
        ) : (
          <Ionicons
            name={externalFileService.isFolder(item) ? 'chevron-forward' : 'download'}
            size={20}
            color="#9CA3AF"
          />
        )}
      </View>
    </TouchableOpacity>
  );

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen">
      <SafeAreaView style={styles.container} edges={['top', 'bottom', 'left', 'right']}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={selectedService ? handleGoBack : onClose}>
            <Ionicons
              name={selectedService ? 'arrow-back' : 'close'}
              size={24}
              color="#374151"
            />
          </TouchableOpacity>
          <AppHeaderTitle>
            {selectedService
              ? externalFileService.getServiceName(selectedService)
              : 'Import from Cloud'}
          </AppHeaderTitle>
          <View style={{ width: 24 }} />
        </View>

        {/* Content */}
        <View style={styles.content}>
          {loading ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color="#3B82F6" />
              <Text style={styles.loadingText}>
                {selectedService ? 'Loading files...' : 'Connecting...'}
              </Text>
            </View>
          ) : selectedService ? (
            <FlatList
              data={files}
              keyExtractor={(item) => item.id}
              renderItem={renderFileItem}
              contentContainerStyle={styles.fileList}
              showsVerticalScrollIndicator={false}
              ListEmptyComponent={
                <View style={styles.emptyContainer}>
                  <Ionicons name="folder-open-outline" size={48} color="#9CA3AF" />
                  <Text style={styles.emptyText}>No files found</Text>
                </View>
              }
            />
          ) : (
            <FlatList
              data={SERVICES}
              keyExtractor={(item) => item.id}
              renderItem={renderServiceItem}
              contentContainerStyle={styles.serviceList}
              showsVerticalScrollIndicator={false}
            />
          )}
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#111827',
  },
  content: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 16,
    color: '#6B7280',
  },
  serviceList: {
    padding: 16,
  },
  serviceItem: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 2,
    marginBottom: 12,
    padding: 16,
  },
  serviceContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  serviceIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 16,
  },
  serviceName: {
    flex: 1,
    fontSize: 18,
    fontWeight: '600',
    color: '#111827',
  },
  fileList: {
    padding: 16,
  },
  fileItem: {
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    marginBottom: 8,
    padding: 12,
  },
  fileContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  fileIcon: {
    marginRight: 12,
  },
  fileDetails: {
    flex: 1,
    minWidth: 0,
  },
  fileName: {
    fontSize: 16,
    fontWeight: '500',
    color: '#111827',
    marginBottom: 2,
  },
  fileSize: {
    fontSize: 14,
    color: '#6B7280',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 64,
  },
  emptyText: {
    marginTop: 12,
    fontSize: 16,
    color: '#9CA3AF',
  },
});

export default ExternalFilePicker; 