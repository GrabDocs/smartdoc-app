import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { notifyLimitError } from '../contexts/LimitErrorContext';
import { extractLimitErrorData, limitErrorFromCaught } from '../utils/limitErrorUtils';
import { apiService } from './api';

export interface ExternalFile {
  id: string;
  name: string;
  service: 'dropbox' | 'googledrive';
  type: 'file' | 'folder';
  path_display?: string;
  size?: number;
  modified?: string;
  downloadUrl?: string;
}

export interface ExternalFileResult {
  success: boolean;
  files?: ExternalFile[];
  error?: string;
  limit?: boolean;
}

export interface AuthResult {
  success: boolean;
  error?: string;
}

class ExternalFileService {
  private authTokens: Map<string, string> = new Map();

  async isAuthenticated(service: 'dropbox' | 'googledrive'): Promise<boolean> {
    try {
      // Check if we have a stored token for this service
      const token = this.authTokens.get(service);
      if (!token) return false;

      // TODO: Validate token by making a test API call
      return true;
    } catch (error) {
      console.error(`Authentication check failed for ${service}:`, error);
      return false;
    }
  }

  async authenticateDropbox(): Promise<AuthResult> {
    try {
      // Create the redirect URI that matches the app's deep linking
      const redirectUri = Linking.createURL('/--/auth');
      
      // Get auth URL from backend
      const response = await apiService.client.post('/api/v1/mobile/external-auth/dropbox', {
        redirect_uri: redirectUri,
        platform: 'mobile'
      });
      
      if (!response.data.success || !response.data.auth_url) {
        return { success: false, error: 'Failed to get Dropbox authorization URL' };
      }

      // Open browser for OAuth
      const result = await WebBrowser.openAuthSessionAsync(
        response.data.auth_url,
        redirectUri
      );

      if (result.type === 'success' && result.url) {
        // Extract authorization code from callback URL
        const url = new URL(result.url);
        const code = url.searchParams.get('code');
        
        if (!code) {
          return { success: false, error: 'Authorization code not found' };
        }

        // Exchange code for access token
        const tokenResponse = await apiService.client.post('/api/v1/mobile/external-auth/dropbox/exchange', {
          code,
          redirect_uri: redirectUri
        });

        if (tokenResponse.data.success && tokenResponse.data.access_token) {
          this.authTokens.set('dropbox', tokenResponse.data.access_token);
          return { success: true };
        } else {
          return { success: false, error: 'Failed to exchange authorization code' };
        }
      } else {
        return { success: false, error: 'Authentication cancelled' };
      }
    } catch (error: any) {
      console.error('Dropbox authentication error:', error);
      return { success: false, error: error.message || 'Dropbox authentication failed' };
    }
  }

  async authenticateGoogleDrive(): Promise<AuthResult> {
    try {
      // Create the redirect URI that matches the app's deep linking
      const redirectUri = Linking.createURL('/--/auth');
      
      // Get auth URL from backend
      const response = await apiService.client.post('/api/v1/mobile/external-auth/googledrive', {
        redirect_uri: redirectUri,
        platform: 'mobile'
      });
      
      if (!response.data.success || !response.data.auth_url) {
        return { success: false, error: 'Failed to get Google Drive authorization URL' };
      }

      // Open browser for OAuth
      const result = await WebBrowser.openAuthSessionAsync(
        response.data.auth_url,
        redirectUri
      );

      if (result.type === 'success' && result.url) {
        // Extract authorization code from callback URL
        const url = new URL(result.url);
        const code = url.searchParams.get('code');
        
        if (!code) {
          return { success: false, error: 'Authorization code not found' };
        }

        // Exchange code for access token
        const tokenResponse = await apiService.client.post('/api/v1/mobile/external-auth/googledrive/exchange', {
          code,
          redirect_uri: redirectUri
        });

        if (tokenResponse.data.success && tokenResponse.data.access_token) {
          this.authTokens.set('googledrive', tokenResponse.data.access_token);
          return { success: true };
        } else {
          return { success: false, error: 'Failed to exchange authorization code' };
        }
      } else {
        return { success: false, error: 'Authentication cancelled' };
      }
    } catch (error: any) {
      console.error('Google Drive authentication error:', error);
      return { success: false, error: error.message || 'Google Drive authentication failed' };
    }
  }

  async getDropboxFiles(path?: string): Promise<ExternalFileResult> {
    try {
      const token = this.authTokens.get('dropbox');
      if (!token) {
        return { success: false, error: 'Not authenticated with Dropbox' };
      }

      const response = await apiService.client.post('/api/v1/mobile/external-files/dropbox', {
        access_token: token,
        path: path || ''
      });

      if (response.data.success && response.data.files) {
        const files: ExternalFile[] = response.data.files.map((file: any) => ({
          id: file.id,
          name: file.name,
          service: 'dropbox' as const,
          type: file.type,
          path_display: file.path_display,
          size: file.size,
          modified: file.modified
        }));

        return { success: true, files };
      } else {
        return { success: false, error: response.data.error || 'Failed to load Dropbox files' };
      }
    } catch (error: any) {
      console.error('Dropbox files error:', error);
      return { success: false, error: error.message || 'Failed to load Dropbox files' };
    }
  }

  async getGoogleDriveFiles(folderId?: string): Promise<ExternalFileResult> {
    try {
      const token = this.authTokens.get('googledrive');
      if (!token) {
        return { success: false, error: 'Not authenticated with Google Drive' };
      }

      const response = await apiService.client.post('/api/v1/mobile/external-files/googledrive', {
        access_token: token,
        folder_id: folderId || 'root'
      });

      if (response.data.success && response.data.files) {
        const files: ExternalFile[] = response.data.files.map((file: any) => ({
          id: file.id,
          name: file.name,
          service: 'googledrive' as const,
          type: file.type,
          size: file.size,
          modified: file.modified
        }));

        return { success: true, files };
      } else {
        return { success: false, error: response.data.error || 'Failed to load Google Drive files' };
      }
    } catch (error: any) {
      console.error('Google Drive files error:', error);
      return { success: false, error: error.message || 'Failed to load Google Drive files' };
    }
  }

  isFolder(file: ExternalFile): boolean {
    return file.type === 'folder';
  }

  canDownload(file: ExternalFile): boolean {
    return file.type === 'file';
  }

  getServiceName(service: 'dropbox' | 'googledrive'): string {
    switch (service) {
      case 'dropbox':
        return 'Dropbox';
      case 'googledrive':
        return 'Google Drive';
      default:
        return 'Unknown Service';
    }
  }

  async downloadFromExternalService(
    service: 'dropbox' | 'googledrive',
    fileId: string,
    fileName: string,
    onProgress?: (progress: number) => void
  ): Promise<{ success: boolean; error?: string; limit?: boolean }> {
    try {
      const token = this.authTokens.get(service);
      if (!token) {
        return { success: false, error: `Not authenticated with ${this.getServiceName(service)}` };
      }

      const endpoint = service === 'dropbox' 
        ? '/api/v1/mobile/external-download/dropbox'
        : '/api/v1/mobile/external-download/googledrive';

      const response = await apiService.client.post(endpoint, {
        access_token: token,
        file_id: fileId,
        file_name: fileName
      });

      if (response.data.success) {
        const limitData = extractLimitErrorData(response.data);
        if (limitData) {
          notifyLimitError(limitData);
          return { success: false, error: limitData.message, limit: true };
        }
        return { success: true };
      } else {
        const limitData = extractLimitErrorData(response.data);
        if (limitData) {
          notifyLimitError(limitData);
          return { success: false, error: limitData.message, limit: true };
        }
        return { success: false, error: response.data.error || response.data.message || 'Download failed' };
      }
    } catch (error: any) {
      console.error('External download error:', error);
      const limitData = limitErrorFromCaught(error);
      if (limitData && notifyLimitError(limitData)) {
        return { success: false, error: limitData.message, limit: true };
      }
      return { success: false, error: error.response?.data?.message || error.message || 'Download failed' };
    }
  }

  formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}

// Export singleton instance
export const externalFileService = new ExternalFileService();
export default externalFileService; 