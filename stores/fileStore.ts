import Constants from 'expo-constants';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import { Alert, Platform } from 'react-native';
import { create } from 'zustand';
import { notifyLimitError } from '../contexts/LimitErrorContext';
import { apiService } from '../services/api';
import { FileState, FileUpload, UploadProgress } from '../types';
import { extractLimitErrorData, limitErrorFromCaught } from '../utils/limitErrorUtils';
import { convertHeicToPng, compressImageForUpload, isHeicFile } from '../utils/imageConversion';
import {
  getUserPreferences,
  validateFileAgainstUploadSettings,
} from '../utils/userPreferences';
import {
  assertUploadAllowedForCurrentNetwork,
  WIFI_ONLY_UPLOAD_MESSAGE,
} from '../utils/wifiOnlyUpload';

// Check if running in Expo Go (which doesn't support custom native modules/plugins)
const isExpoGo = Constants.executionEnvironment === 'storeClient';

export interface PendingUpload {
  id: string;
  name: string;
  type: string;
  size?: number;
  /** Local clock when the placeholder was added (for handoff matching). */
  createdAt?: number;
  /** True after XHR+poll succeeds; documents list may clear the placeholder once the server row appears. */
  settled?: boolean;
}

interface FileStore extends FileState {
  // Global state
  isDocumentPickerOpen: boolean;
  isImagePickerOpen: boolean;
  lastUploadTime: number; // Track when upload happened for immediate refresh
  pendingUploads: PendingUpload[]; // Optimistic placeholder rows shown in the file list immediately
  /** Target folder for next upload (My Files folder context) */
  uploadFolderId: number | null;
  uploadWorkspaceId: number | null;
  setUploadFolderContext: (folderId: number | null, workspaceId: number | null) => void;
  
  // Actions
  fetchFiles: (page?: number, search?: string, category?: string) => Promise<void>;
  uploadFiles: (files: FileUpload[]) => Promise<boolean | null>;
  uploadFromCamera: () => Promise<boolean>;
  /** `true` success, `false` failure, `null` cancelled or limit already shown. */
  uploadFromGallery: () => Promise<boolean | null>;
  /** `true` success, `false` failure, `null` cancelled or limit already shown. */
  uploadFromDocuments: () => Promise<boolean | null>;
  deleteFile: (id: number) => Promise<boolean>;
  categorizeFile: (id: number, category: string) => Promise<boolean>;
  autoCategorizeFile: (id: number) => Promise<boolean>;
  downloadFile: (id: number) => Promise<string | null>;
  clearError: () => void;
  updateUploadProgress: (fileId: string, progress: Partial<UploadProgress>) => void;
  removeUploadProgress: (fileId: string) => void;
  addPendingUpload: (upload: PendingUpload) => void;
  removePendingUpload: (id: string) => void;
  setDocumentPickerOpen: (isOpen: boolean) => void;
  resetDocumentPicker: () => void;
  forceResetDocumentPicker: () => Promise<void>;
  setImagePickerOpen: (isOpen: boolean) => void;
  resetImagePicker: () => void;
  setLastUploadTime: (timestamp: number) => void;
}

export const useFileStore = create<FileStore>((set, get) => ({
  // Initial state
  files: [],
  isLoading: false,
  error: null,
  uploadProgress: {},
  isDocumentPickerOpen: false,
  isImagePickerOpen: false,
  lastUploadTime: 0,
  pendingUploads: [],
  uploadFolderId: null,
  uploadWorkspaceId: null,

  setUploadFolderContext: (folderId, workspaceId) => {
    set({ uploadFolderId: folderId, uploadWorkspaceId: workspaceId });
  },

  // Actions
  fetchFiles: async (page = 1, search?, category?) => {
    set({ isLoading: true, error: null });
    
    try {
      const response = await apiService.getFiles(page, 20, search, category);
      
      if (response.success && response.data) {
        const newFiles = response.data;
        const currentFiles = get().files;
        
        // If it's the first page, replace all files
        // Otherwise, append to existing files (pagination)
        const updatedFiles = page === 1 ? newFiles : [...currentFiles, ...newFiles];
        
        set({
          files: updatedFiles,
          isLoading: false,
          error: null,
        });
      } else {
        set({
          isLoading: false,
          error: response.message || 'Failed to fetch files',
        });
      }
    } catch (error: any) {
      set({
        isLoading: false,
        error: error.message || 'Failed to fetch files',
      });
    }
  },

  uploadFiles: async (files: FileUpload[]) => {
    if (files.length === 0) return false;

    try {
      await assertUploadAllowedForCurrentNetwork();
    } catch (error: any) {
      Alert.alert('Wi‑Fi Required', error?.message || WIFI_ONLY_UPLOAD_MESSAGE);
      return false;
    }

    const prefs = await getUserPreferences();
    try {
      for (const file of files) {
        validateFileAgainstUploadSettings(file, prefs);
      }
    } catch (error: any) {
      Alert.alert('Upload Blocked', error?.message || 'File does not meet upload settings.');
      return false;
    }

    let allSuccessful = true;
    let successCount = 0;
    let limitShown = false;
    const totalFiles = files.length;

    const { useProgressStore } = require('../services/progressService');
    const progressStore = useProgressStore.getState();

    // One shared bar for the whole batch (not one entry per file).
    const batchTitle =
      totalFiles === 1 ? `Uploading ${files[0].name}` : `Uploading ${totalFiles} files`;
    const progressId = progressStore.addProgress({
      title: batchTitle,
      progress: 0,
      status: 'in-progress',
      message: totalFiles === 1 ? 'Preparing upload...' : `Preparing 1 of ${totalFiles}...`,
    });

    const updateBatchProgress = (
      fileIndex: number,
      fileProgress: number,
      message?: string,
    ) => {
      const overall = ((fileIndex + Math.min(100, Math.max(0, fileProgress)) / 100) / totalFiles) * 100;
      progressStore.updateProgress(progressId, {
        progress: Math.min(99, Math.max(0, overall)),
        status: 'in-progress',
        message:
          message ||
          (totalFiles === 1
            ? `Uploading... ${Math.round(fileProgress)}%`
            : `File ${fileIndex + 1} of ${totalFiles}… ${Math.round(fileProgress)}%`),
      });
    };

    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      const file = files[fileIndex];
      const fileId = `upload_${Date.now()}_${Math.random()}`;
      const pendingUploadId = file.optimisticId ?? `pending_${fileId}`;

      if (!file.optimisticId) {
        get().addPendingUpload({ id: pendingUploadId, name: file.name, type: file.type, size: file.size });
      }

      get().updateUploadProgress(fileId, {
        fileId,
        progress: 0,
        status: 'uploading',
      });

      updateBatchProgress(
        fileIndex,
        0,
        totalFiles === 1
          ? 'Preparing upload...'
          : `Preparing ${fileIndex + 1} of ${totalFiles}: ${file.name}`,
      );

      let uploadSucceeded = false;
      try {
        let fileToUpload = file;

        if (isHeicFile(file)) {
          console.log(`🔄 Converting HEIC to PNG before upload: ${file.name}`);
          updateBatchProgress(fileIndex, 5, `Converting HEIC to PNG… ${file.name}`);

          fileToUpload = await convertHeicToPng(
            file,
            (progress, message) => {
              updateBatchProgress(fileIndex, 5 + progress * 0.1, message);
            }
          );

          // Keep list placeholder name in sync with the file that will land on the server
          // (HEIC → PNG rename), so handoff to the real row does not miss by filename.
          if (fileToUpload.name !== file.name) {
            set((state) => ({
              pendingUploads: state.pendingUploads.map((u) =>
                u.id === pendingUploadId
                  ? {
                      ...u,
                      name: fileToUpload.name,
                      type: fileToUpload.type,
                      size: fileToUpload.size,
                    }
                  : u
              ),
            }));
          }

          updateBatchProgress(fileIndex, 15, `Starting upload… ${fileToUpload.name}`);
        }

        if (prefs.file_management.compress_images) {
          const beforeCompress = fileToUpload;
          fileToUpload = await compressImageForUpload(
            fileToUpload,
            true,
            (progress, message) => {
              updateBatchProgress(fileIndex, 15 + progress * 0.05, message);
            },
          );
          if (fileToUpload.name !== beforeCompress.name) {
            set((state) => ({
              pendingUploads: state.pendingUploads.map((u) =>
                u.id === pendingUploadId
                  ? {
                      ...u,
                      name: fileToUpload.name,
                      type: fileToUpload.type,
                      size: fileToUpload.size,
                    }
                  : u
              ),
            }));
          }
        }

        const formData = new FormData();

        console.log('📤 Preparing upload:', {
          uri: fileToUpload.uri,
          type: fileToUpload.type,
          name: fileToUpload.name,
          size: fileToUpload.size,
          isExpoGo,
        });

        if (!fileToUpload.uri || (!fileToUpload.uri.startsWith('file://') &&
            !fileToUpload.uri.startsWith('content://') &&
            !fileToUpload.uri.startsWith('http://') &&
            !fileToUpload.uri.startsWith('https://'))) {
          throw new Error(`Invalid file URI: ${fileToUpload.uri}`);
        }

        formData.append('file', {
          uri: fileToUpload.uri,
          type: fileToUpload.type || 'image/jpeg',
          name: fileToUpload.name || `image_${Date.now()}.jpg`,
        } as any);

        const { uploadFolderId, uploadWorkspaceId } = get();
        if (uploadFolderId != null) {
          formData.append('folder_id', String(uploadFolderId));
        }
        if (uploadWorkspaceId != null) {
          formData.append('workspace_id', String(uploadWorkspaceId));
        }

        console.log('📤 FormData created, starting upload...');

        const response = await apiService.uploadFileWithProgressPolling(
          formData,
          (progress, message, phase) => {
            console.log(`📊 Upload progress: ${progress}% for ${file.name} - ${message} (${phase})`);
            updateBatchProgress(
              fileIndex,
              progress,
              totalFiles === 1
                ? (message || `Uploading... ${Math.round(progress)}%`)
                : `File ${fileIndex + 1} of ${totalFiles}: ${file.name}`,
            );
            get().updateUploadProgress(fileId, { progress });
          }
        );

        console.log('📁 Upload response in file store:', response);

        if (response.success) {
          const acceptedLimit = extractLimitErrorData(response) || extractLimitErrorData(response.data);
          if (acceptedLimit && notifyLimitError(acceptedLimit)) {
            limitShown = true;
            allSuccessful = false;
            get().updateUploadProgress(fileId, { status: 'error', error: acceptedLimit.message });
            break;
          }
          uploadSucceeded = true;
          successCount += 1;
          get().updateUploadProgress(fileId, {
            progress: 100,
            status: 'completed',
          });

          // Mark settled so the documents screen can hand off to the server row
          // without clearing mid-upload (e.g. when a same-named file already exists).
          set((state) => ({
            lastUploadTime: Date.now(),
            pendingUploads: state.pendingUploads.map((u) =>
              u.id === pendingUploadId ? { ...u, settled: true } : u
            ),
          }));
          get().fetchFiles(1);

          setTimeout(() => {
            get().removeUploadProgress(fileId);
          }, 2000);
        } else {
          console.log('📁 Upload failed - success:', response.success, 'data:', response.data);
          const limitData = extractLimitErrorData(response) || extractLimitErrorData(response.data);
          if (limitData && notifyLimitError(limitData)) {
            limitShown = true;
            allSuccessful = false;
            get().updateUploadProgress(fileId, { status: 'error', error: limitData.message });
            break;
          }
          allSuccessful = false;

          get().updateUploadProgress(fileId, {
            status: 'error',
            error: response.message || 'Upload failed',
          });
        }
      } catch (error: any) {
        console.error('📁 Upload exception:', error);
        console.error('📁 Upload error details:', {
          message: error.message,
          response: error.response?.data,
          status: error.response?.status,
          stack: error.stack,
          file: file.name,
          uri: file.uri,
        });
        allSuccessful = false;

        const limitData = limitErrorFromCaught(error);
        if (limitData && notifyLimitError(limitData)) {
          limitShown = true;
          get().updateUploadProgress(fileId, { status: 'error', error: limitData.message });
          break;
        }

        const errorMessage = error.response?.data?.message || error.message || 'Upload failed';
        get().updateUploadProgress(fileId, {
          status: 'error',
          error: errorMessage,
        });

        const fullErrorMessage = `Failed to upload ${file.name}: ${errorMessage}`;
        set({ error: fullErrorMessage });

        // Only alert immediately for single-file uploads; batch gets a summary at the end.
        if (totalFiles === 1) {
          Alert.alert('Upload Failed', fullErrorMessage, [{ text: 'OK' }]);
        }
      } finally {
        if (!uploadSucceeded) {
          // Failed uploads: drop the optimistic row immediately.
          get().removePendingUpload(pendingUploadId);
        } else {
          // Keep the placeholder until the documents list shows the server row.
          // Clearing here caused the list spinner to vanish, then reappear after reload.
          setTimeout(() => {
            get().removePendingUpload(pendingUploadId);
          }, 60_000);
        }
      }
    }

    console.log('📁 Upload batch completed. All successful:', allSuccessful);

    if (allSuccessful) {
      progressStore.updateProgress(progressId, {
        progress: 100,
        status: 'completed',
        message:
          totalFiles === 1
            ? 'Upload complete'
            : `Uploaded ${successCount} of ${totalFiles} files`,
      });
    } else if (!limitShown && successCount > 0) {
      progressStore.updateProgress(progressId, {
        progress: 100,
        status: 'completed',
        message: `Uploaded ${successCount} of ${totalFiles} files`,
      });
      Alert.alert(
        'Upload Incomplete',
        'Some files failed to upload. Please check the error messages and try again.',
        [{ text: 'OK' }]
      );
    } else {
      progressStore.updateProgress(progressId, {
        status: 'error',
        message: totalFiles === 1 ? 'Upload failed' : 'All uploads failed',
      });
      if (totalFiles > 1 && !limitShown) {
        Alert.alert(
          'Upload Incomplete',
          'Some files failed to upload. Please check the error messages and try again.',
          [{ text: 'OK' }]
        );
      }
    }

    setTimeout(() => {
      progressStore.removeProgress(progressId);
    }, allSuccessful || successCount > 0 ? 3000 : 5000);

    return limitShown ? null : allSuccessful;
  },

  uploadFromCamera: async () => {
    try {
      // Request camera permissions
      const permissionResult = await ImagePicker.requestCameraPermissionsAsync();
      
      if (!permissionResult.granted) {
        set({ error: 'Camera permission is required to take photos' });
        return false;
      }
      
      // Launch camera
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [4, 3],
        quality: 0.8,
      });
      
      if (!result.canceled && result.assets && result.assets.length > 0) {
        const asset = result.assets[0];
        // Detect actual file type from URI (iOS camera may capture HEIC)
        const file: FileUpload = {
          uri: asset.uri,
          name: `photo_${Date.now()}.${asset.type?.includes('heic') ? 'heic' : 'jpg'}`,
          // Use mimeType if available, fallback to type, then default
          type: asset.mimeType || asset.type || 'image/jpeg',
          size: asset.fileSize,
        };
        
        return await get().uploadFiles([file]);
      }
      
      return false;
    } catch (error: any) {
      set({ error: error.message || 'Failed to take photo' });
      return false;
    }
  },

  uploadFromGallery: async () => {
    try {
      console.log('🖼️ Simple gallery upload test...');
      
      // Set image picker state
      set({ isImagePickerOpen: true, error: null });
      
      // In Expo Go, MediaLibrary plugin isn't available, so use ImagePicker directly
      // In development/production builds, MediaLibrary supports all media types (images, videos, audio)
      if (isExpoGo) {
        console.log('🖼️ Running in Expo Go - using ImagePicker (photos only)...');
        const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync();
        console.log('🖼️ ImagePicker permission result:', permissionResult);
        
        if (!permissionResult.granted) {
          set({ error: 'Media library permission is required to select files', isImagePickerOpen: false });
          return false;
        }
      } else {
        // Try MediaLibrary first (supports images, videos, and audio) in dev/prod builds
        let mediaLibraryGranted = false;
        try {
          console.log('🖼️ Requesting media library permissions...');
          const { status } = await MediaLibrary.requestPermissionsAsync();
          console.log('🖼️ MediaLibrary permission status:', status);
          mediaLibraryGranted = status === 'granted';
        } catch (mediaLibraryError: any) {
          console.warn('🖼️ MediaLibrary permission request failed (app may need rebuild):', mediaLibraryError?.message);
          console.log('🖼️ Falling back to ImagePicker (photos only)...');
        }
        
        if (!mediaLibraryGranted) {
          // Fallback to ImagePicker permissions (only requests photo access, no audio needed)
          console.log('🖼️ Using ImagePicker for photo selection...');
          const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync();
          console.log('🖼️ ImagePicker permission result:', permissionResult);
          
          if (!permissionResult.granted) {
            set({ error: 'Media library permission is required to select files', isImagePickerOpen: false });
            return false;
          }
        }
      }
      
      console.log('🖼️ Launching simple image picker...');
      // Use the most basic configuration possible
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 1,
        allowsMultipleSelection: true,
      });
      console.log('🖼️ Simple picker result:', result);
      
      // Reset image picker state
      set({ isImagePickerOpen: false });
      
      if (!result.canceled && result.assets && result.assets.length > 0) {
        // Check mobile file limit (3 files max)
        const isMobile = Platform.OS === 'ios' || Platform.OS === 'android';
        if (isMobile && result.assets.length > 3) {
          Alert.alert(
            'Upload Limit',
            'Sorry, our maximum upload is 3',
            [{ text: 'OK' }]
          );
          // null = soft stop; callers must not show a second failure alert
          return null;
        }
        
        const files: FileUpload[] = [];

        for (let i = 0; i < result.assets.length; i++) {
          const asset = result.assets[i];
          const optimisticId = `pending_pick_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 11)}`;
          const originalFile: FileUpload = {
            uri: asset.uri,
            name: asset.fileName || `image_${Date.now()}_${i}.jpg`,
            type: asset.mimeType || asset.type || 'image/jpeg',
            size: asset.fileSize || 0,
            optimisticId,
          };

          // Show rows in the file list immediately (HEIC conversion runs inside uploadFiles)
          get().addPendingUpload({
            id: optimisticId,
            name: originalFile.name,
            type: originalFile.type,
            size: originalFile.size,
          });
          files.push(originalFile);
        }

        console.log('🖼️ Files prepared for upload:', files);
        return await get().uploadFiles(files);
      }
      
      console.log('🖼️ No images selected or picker was canceled');
      return null;
    } catch (error: any) {
      console.error('🖼️ Gallery upload error:', error);
      set({ error: error.message || 'Failed to select media', isImagePickerOpen: false });
      return false;
    }
  },

  uploadFromDocuments: async () => {
    const currentState = get();
    
    // Always force reset state first as safety measure
    console.log('🔄 Force resetting document picker before upload...');
    await currentState.forceResetDocumentPicker();
    
    try {
      currentState.setDocumentPickerOpen(true);
      
      // Launch document picker
      const result = await DocumentPicker.getDocumentAsync({
        type: ['application/pdf', 'image/*', 'application/msword',
               'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
        multiple: true,
        copyToCacheDirectory: true,
      });
      
      if (!result.canceled && result.assets && result.assets.length > 0) {
        // Check mobile file limit (3 files max)
        const isMobile = Platform.OS === 'ios' || Platform.OS === 'android';
        if (isMobile && result.assets.length > 3) {
          Alert.alert(
            'Upload Limit',
            'Sorry, our maximum upload is 3',
            [{ text: 'OK' }]
          );
          get().setDocumentPickerOpen(false);
          // null = soft stop; callers must not show a second failure alert
          return null;
        }
        
        const files: FileUpload[] = result.assets.map((asset) => ({
          uri: asset.uri,
          name: asset.name,
          type: asset.mimeType || 'application/octet-stream',
          size: asset.size,
        }));
        
        const success = await get().uploadFiles(files);
        get().setDocumentPickerOpen(false);
        return success;
      }
      
      get().setDocumentPickerOpen(false);
      return null;
    } catch (error: any) {
      set({ error: error.message || 'Failed to select documents' });
      get().setDocumentPickerOpen(false);
      return false;
    }
  },

  deleteFile: async (id: number) => {
    try {
      const response = await apiService.deleteFile(id);
      
      if (response.success) {
        // Remove file from the files list
        const currentFiles = get().files;
        const updatedFiles = currentFiles.filter((file) => file.id !== id);
        
        set({
          files: updatedFiles,
          error: null,
        });
        
        return true;
      } else {
        set({ error: response.message || 'Failed to delete file' });
        return false;
      }
    } catch (error: any) {
      set({ error: error.message || 'Failed to delete file' });
      return false;
    }
  },

  categorizeFile: async (id: number, category: string) => {
    try {
      const response = await apiService.categorizeFile(id, category);
      
      if (response.success && response.data) {
        // Update the file in the files list
        const currentFiles = get().files;
        const updatedFiles = currentFiles.map((file) =>
          file.id === id ? response.data! : file
        );
        
        set({
          files: updatedFiles,
          error: null,
        });
        
        return true;
      } else {
        set({ error: response.message || 'Failed to categorize file' });
        return false;
      }
    } catch (error: any) {
      set({ error: error.message || 'Failed to categorize file' });
      return false;
    }
  },

  autoCategorizeFile: async (id: number) => {
    try {
      const response = await apiService.autoCategorizeFile(id);
      
      if (response.success && response.data) {
        // Update the file in the files list
        const currentFiles = get().files;
        const updatedFiles = currentFiles.map((file) =>
          file.id === id ? response.data! : file
        );
        
        set({
          files: updatedFiles,
          error: null,
        });
        
        return true;
      } else {
        set({ error: response.message || 'Failed to auto-categorize file' });
        return false;
      }
    } catch (error: any) {
      set({ error: error.message || 'Failed to auto-categorize file' });
      return false;
    }
  },

  downloadFile: async (id: number) => {
    try {
      const result = await apiService.downloadFile(id);
      // Extract url from the result object
      return result?.url || null;
    } catch (error: any) {
      set({ error: error.message || 'Failed to download file' });
      return null;
    }
  },

  clearError: () => {
    set({ error: null });
  },

  updateUploadProgress: (fileId: string, progress: Partial<UploadProgress>) => {
    const currentProgress = get().uploadProgress;
    const existingProgress = currentProgress[fileId] || { fileId, progress: 0, status: 'uploading' };
    
    set({
      uploadProgress: {
        ...currentProgress,
        [fileId]: { ...existingProgress, ...progress },
      },
    });
  },

  removeUploadProgress: (fileId: string) => {
    const currentProgress = get().uploadProgress;
    const { [fileId]: removed, ...remainingProgress } = currentProgress;
    
    set({
      uploadProgress: remainingProgress,
    });
  },

  addPendingUpload: (upload: PendingUpload) => {
    set((state) => ({
      pendingUploads: [
        ...state.pendingUploads,
        { createdAt: Date.now(), ...upload },
      ],
    }));
  },

  removePendingUpload: (id: string) => {
    set((state) => ({ pendingUploads: state.pendingUploads.filter((u) => u.id !== id) }));
  },

  setDocumentPickerOpen: (isOpen: boolean) => {
    console.log('📁 Setting document picker state:', isOpen);
    set({ isDocumentPickerOpen: isOpen });
  },

  resetDocumentPicker: () => {
    console.log('🔄 Resetting document picker state');
    set({ isDocumentPickerOpen: false });
  },

  forceResetDocumentPicker: async () => {
    console.log('🔄 Force resetting document picker with delay...');
    set({ isDocumentPickerOpen: false });
    // Give extra time for native module to reset
    await new Promise(resolve => setTimeout(resolve, 1000));
    console.log('✅ Document picker force reset complete');
  },

  setImagePickerOpen: (isOpen: boolean) => {
    console.log('🖼️ Setting image picker state:', isOpen);
    set({ isImagePickerOpen: isOpen });
  },

  resetImagePicker: () => {
    console.log('🔄 Resetting image picker state');
    set({ isImagePickerOpen: false });
  },
  
  setLastUploadTime: (timestamp: number) => {
    set({ lastUploadTime: timestamp });
  },
})); 