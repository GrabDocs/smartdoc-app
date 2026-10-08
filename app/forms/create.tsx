import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    RefreshControl,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AppBackButton from '../../components/AppBackButton';
import AppHeaderTitle from '../../components/AppHeaderTitle';
import { FeedbackTouchable } from '../../components/FeedbackTouchable';
import { useThemeColors } from '../../hooks/useThemeColors';
import { apiService } from '../../services/api';
import { Form } from '../../types/form';
import { countFormFields, normalizeFormFields } from '../../utils/normalizeFormFields';

interface FormTemplate {
  id: number;
  name: string;
  description: string;
  category: string;
  fields: FormField[];
  preview_data: any;
}

interface FormField {
  id: string;
  type: 'text' | 'email' | 'phone' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'date' | 'number';
  label: string;
  placeholder?: string;
  required?: boolean;
  options?: string[];
  validation?: any;
}

export default function CreateFormScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const params = useLocalSearchParams<{ tab?: string }>();
  const [templates, setTemplates] = useState<FormTemplate[]>([]);
  const [userForms, setUserForms] = useState<Form[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<'recent' | 'templates'>(params.tab === 'recent' ? 'recent' : 'templates');
  const dynamicStyles = useMemo(() => ({
    page: { backgroundColor: colors.headerBackground },
    content: { flex: 1, backgroundColor: colors.background },
    card: { backgroundColor: colors.card, borderColor: colors.border },
    header: { backgroundColor: colors.headerBackground, borderBottomColor: colors.border },
    text: { color: colors.text },
    textSecondary: { color: colors.textSecondary },
  }), [colors]);

  useEffect(() => {
    loadData();
  }, []);

  // Refresh forms list when switching to "My Forms" tab
  useEffect(() => {
    if (activeTab === 'recent') {
      loadUserForms();
    }
  }, [activeTab]);

  // Add debounce to prevent excessive reloads
  const lastLoadTimeRef = useRef<number>(0);
  const RELOAD_DEBOUNCE_MS = 2000; // Don't reload if less than 2 seconds since last load
  
  // Refresh forms list when screen comes into focus (e.g., when returning from form builder)
  useFocusEffect(
    useCallback(() => {
      // Only refresh if we're on the "My Forms" tab
      if (activeTab === 'recent') {
        const now = Date.now();
        if (now - lastLoadTimeRef.current > RELOAD_DEBOUNCE_MS) {
          lastLoadTimeRef.current = now;
          loadUserForms();
        }
      }
    }, [activeTab])
  );

  const loadData = async () => {
    await Promise.all([
      loadFormTemplates(),
      loadUserForms()
    ]);
  };

  const loadUserForms = async () => {
    try {
      const response = await apiService.getForms();
      if (response.success && response.forms) {
        setUserForms(response.forms);
      } else {
        setUserForms([]);
      }
    } catch (error) {
      console.error('Failed to load user forms:', error);
      setUserForms([]);
    }
  };

  const loadFormTemplates = async () => {
    try {
      const response = await apiService.getFormTemplates();
      
      if (response.success && (response as any).templates) {
        console.log('✅ Loaded form templates from database:', (response as any).templates.length);
        
        // Map backend response to frontend format
        const mappedTemplates = (response as any).templates.map((template: any) => ({
          id: template.id,
          name: template.name,
          description: template.description,
          category: template.category || template.type,
          fields: normalizeFormFields(template.json_fields),
          preview_data: template.preview_data || null
        }));
        
        setTemplates(mappedTemplates);
      } else {
        console.log('❌ No templates found in database response:', response);
        // Provide fallback templates if none exist in database
        const fallbackTemplates: FormTemplate[] = [
          {
            id: 1,
            name: 'Contact Form',
            description: 'Basic contact form with name, email, and message fields',
            category: 'contact',
            fields: [
              { id: '1', type: 'text' as const, label: 'Full Name', required: true },
              { id: '2', type: 'email' as const, label: 'Email Address', required: true },
              { id: '3', type: 'textarea' as const, label: 'Message', required: true }
            ],
            preview_data: null
          },
          {
            id: 2,
            name: 'Survey Form',
            description: 'Multi-question survey with various field types',
            category: 'survey',
            fields: [
              { id: '1', type: 'text' as const, label: 'Name', required: true },
              { id: '2', type: 'radio' as const, label: 'How did you hear about us?', options: ['Social Media', 'Website', 'Referral', 'Other'], required: true },
              { id: '3', type: 'select' as const, label: 'Age Range', options: ['18-25', '26-35', '36-45', '46+'], required: true },
              { id: '4', type: 'textarea' as const, label: 'Additional Comments', required: false }
            ],
            preview_data: null
          }
        ];
        setTemplates(fallbackTemplates);
      }
    } catch (error) {
      console.error('❌ Failed to load form templates from database:', error);
      // Provide fallback templates on error
      const fallbackTemplates: FormTemplate[] = [
        {
          id: 1,
          name: 'Contact Form',
          description: 'Basic contact form with name, email, and message fields',
          category: 'contact',
          fields: [
            { id: '1', type: 'text' as const, label: 'Full Name', required: true },
            { id: '2', type: 'email' as const, label: 'Email Address', required: true },
            { id: '3', type: 'textarea' as const, label: 'Message', required: true }
          ],
          preview_data: null
        },
        {
          id: 2,
          name: 'Survey Form',
          description: 'Multi-question survey with various field types',
          category: 'survey',
          fields: [
            { id: '1', type: 'text' as const, label: 'Name', required: true },
            { id: '2', type: 'radio' as const, label: 'How did you hear about us?', options: ['Social Media', 'Website', 'Referral', 'Other'], required: true },
            { id: '3', type: 'select' as const, label: 'Age Range', options: ['18-25', '26-35', '36-45', '46+'], required: true },
            { id: '4', type: 'textarea' as const, label: 'Additional Comments', required: false }
          ],
          preview_data: null
        }
      ];
      setTemplates(fallbackTemplates);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const onRefresh = () => {
    setRefreshing(true);
    loadData();
  };

  const createBlankForm = () => {
    router.push({
      pathname: '/forms/builder',
      params: {
        templateId: 'blank',
        templateName: 'Blank Form',
      }
    });
  };

  const selectTemplate = (template: FormTemplate) => {
    router.push({
      pathname: '/forms/builder',
      params: {
        templateId: template.id.toString(),
        templateName: template.name,
        templateDescription: template.description || '',
      }
    });
  };

  const selectUserForm = (form: Form) => {
    router.push({
      pathname: '/forms/builder',
      params: {
        formId: form.id.toString(),
        templateName: form.title,
        isPublished: form.is_published ? 'true' : 'false',
      }
    });
  };

  const getTemplateIcon = (category?: string | null) => {
    switch ((category || '').toLowerCase()) {
      case 'contact':
        return 'mail';
      case 'feedback':
        return 'chatbubble-ellipses';
      case 'survey':
        return 'clipboard';
      case 'registration':
        return 'person-add';
      case 'rsvp':
        return 'calendar';
      case 'order':
        return 'bag';
      default:
        return 'document-text';
    }
  };

  const getTemplateColor = (category?: string | null, templateName?: string) => {
    // Handle specific templates first
    if (templateName) {
      switch (templateName.toLowerCase()) {
        case 'custom order form':
          return '#27AE60';        // Green
        case 'product order form':
          return '#F39C12';        // Orange
        default:
          break;
      }
    }
    
    // Then handle by category
    switch ((category || '').toLowerCase()) {
      case 'contact':
        return '#007AFF';        // Blue
      case 'feedback':
        return '#FF6B35';        // Orange-Red
      case 'survey':
        return '#9B59B6';        // Purple
      case 'registration':
        return '#3498DB';        // Light Blue
      case 'rsvp':
        return '#E74C3C';        // Red
      case 'order':
        return '#27AE60';        // Green (fallback)
      default:
        return '#8E8E93';        // Gray
    }
  };

  const renderTemplateItem = (item: FormTemplate) => (
    <TouchableOpacity key={item.id} style={[styles.templateCard, { backgroundColor: colors.card, borderColor: colors.border }]} onPress={() => selectTemplate(item)}>
      <View style={[styles.templateIcon, { backgroundColor: getTemplateColor(item.category, item.name) + '20' }]}>
        <Ionicons 
          name={getTemplateIcon(item.category) as any} 
          size={24} 
          color={getTemplateColor(item.category, item.name)} 
        />
      </View>
      <View style={styles.templateContent}>
        <Text style={[styles.templateName, { color: colors.text }]}>{item.name}</Text>
        <Text style={[styles.templateDescription, { color: colors.textSecondary }]}>{item.description}</Text>
        <View style={styles.templateMeta}>
          <View style={[styles.categoryBadge, { backgroundColor: getTemplateColor(item.category, item.name) }]}>
            <Text style={styles.categoryText}>{item.category}</Text>
          </View>
          <Text style={[styles.fieldsCount, { color: colors.textSecondary }]}>{item.fields.length} fields</Text>
        </View>
      </View>
      <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />
    </TouchableOpacity>
  );

  const deleteForm = async (form: Form) => {
    Alert.alert(
      'Delete Form',
      `Are you sure you want to delete "${form.title}"? This action cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              const response = await apiService.deleteForm(form.id);
              if (response.success) {
                // Remove from list and refresh
                setUserForms(prev => prev.filter(f => f.id !== form.id));
                Alert.alert('Success', 'Form deleted successfully');
              } else {
                Alert.alert('Error', response.message || 'Failed to delete form');
              }
            } catch (error: any) {
              console.error('❌ Failed to delete form:', error);
              Alert.alert('Error', error?.message || 'Failed to delete form');
            }
          }
        }
      ]
    );
  };

  const renderUserFormItem = (item: Form) => (
    <TouchableOpacity 
      key={item.id}
      style={[styles.templateCard, { backgroundColor: colors.card, borderColor: colors.border }]} 
      onPress={() => selectUserForm(item)}
      activeOpacity={0.7}
    >
      <View style={[styles.templateIcon, { backgroundColor: '#007AFF20' }]}>
        <Ionicons 
          name="document-text" 
          size={24} 
          color="#007AFF" 
        />
      </View>
      <View style={styles.templateContent}>
        <Text style={[styles.templateName, { color: colors.text }]}>{item.title}</Text>
        <Text style={[styles.templateDescription, { color: colors.textSecondary }]}>{item.description || 'No description'}</Text>
        <View style={styles.templateMeta}>
          <View style={[styles.categoryBadge, { backgroundColor: '#007AFF' }]}>
            <Text style={styles.categoryText}>My Form</Text>
          </View>
          <View style={styles.metaRight}>
            <Text style={[styles.fieldsCount, { color: colors.textSecondary }]}>
              {countFormFields(item.json_fields)} fields • {item.response_count || 0} responses
            </Text>
            <FeedbackTouchable
              style={styles.deleteButton}
              onPress={(e) => {
                e.stopPropagation(); // Prevent triggering the parent TouchableOpacity
                deleteForm(item);
              }}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              spinnerColor="#FF3B30"
              replaceWithSpinner={false}
            >
              <Ionicons name="trash-outline" size={18} color="#FF3B30" />
            </FeedbackTouchable>
          </View>
        </View>
      </View>
      <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />
    </TouchableOpacity>
  );

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, dynamicStyles.page]} edges={['top']}>
        <View style={[styles.header, dynamicStyles.header]}>
          <AppBackButton />
          <AppHeaderTitle>Create Form</AppHeaderTitle>
          <TouchableOpacity
            onPress={onRefresh}
            disabled={refreshing}
            accessibilityLabel="Refresh"
            accessibilityRole="button"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons
              name="refresh"
              size={28}
              color={refreshing ? '#999' : colors.primary || '#007AFF'}
            />
          </TouchableOpacity>
        </View>
        <View style={[styles.loadingContainer, dynamicStyles.content]}>
          <ActivityIndicator size="large" color={colors.primary || '#007AFF'} />
          <Text style={[styles.loadingText, dynamicStyles.textSecondary]}>Loading templates...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, dynamicStyles.page]} edges={['top']}>
      <View style={[styles.header, dynamicStyles.header]}>
        <AppBackButton />
        <AppHeaderTitle>Create Form</AppHeaderTitle>
        <TouchableOpacity
          onPress={onRefresh}
          disabled={refreshing}
          accessibilityLabel="Refresh"
          accessibilityRole="button"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons
            name="refresh"
            size={28}
            color={refreshing ? '#999' : colors.primary || '#007AFF'}
          />
        </TouchableOpacity>
      </View>

      <View style={dynamicStyles.content}>
      {/* Blank Form Option */}
      <View style={[styles.blankFormSection, dynamicStyles.card]}>
        <Text style={[styles.sectionTitle, dynamicStyles.text]}>Start Fresh</Text>
        <TouchableOpacity style={[styles.blankFormCard, dynamicStyles.card]} onPress={createBlankForm}>
          <View style={styles.blankFormIcon}>
            <Ionicons name="add" size={32} color={colors.primary || '#007AFF'} />
          </View>
          <View style={styles.blankFormContent}>
            <Text style={[styles.blankFormTitle, dynamicStyles.text]}>Create Blank Form</Text>
            <Text style={[styles.blankFormDescription, dynamicStyles.textSecondary]}>
              Start with an empty form and add your own fields
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color="#C7C7CC" />
        </TouchableOpacity>
      </View>

      {/* Tab Navigation */}
      <View style={[styles.tabContainer, dynamicStyles.card]}>
        <TouchableOpacity 
          style={[styles.tab, activeTab === 'templates' && styles.activeTab]} 
          onPress={() => {
            setActiveTab('templates');
          }}
        >
          <Text style={[styles.tabText, dynamicStyles.textSecondary, activeTab === 'templates' && styles.activeTabText]}>
            Templates
          </Text>
        </TouchableOpacity>
        <TouchableOpacity 
          style={[styles.tab, activeTab === 'recent' && styles.activeTab]} 
          onPress={() => {
            setActiveTab('recent');
            // Refresh will happen automatically via useEffect when activeTab changes
          }}
        >
          <Text style={[styles.tabText, dynamicStyles.textSecondary, activeTab === 'recent' && styles.activeTabText]}>
            My Forms
          </Text>
        </TouchableOpacity>
      </View>

      {/* Tab Content */}
      <ScrollView 
        style={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {activeTab === 'templates' ? (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, dynamicStyles.text]}>Choose Template</Text>
            <Text style={[styles.sectionSubtitle, dynamicStyles.textSecondary]}>
              Select a pre-built template to get started quickly
            </Text>
            
            {templates.map((item) => renderTemplateItem(item))}
          </View>
        ) : (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, dynamicStyles.text]}>Your Forms</Text>
            <Text style={[styles.sectionSubtitle, dynamicStyles.textSecondary]}>
              Continue working on your existing forms or create new ones based on them
              {userForms.length > 0 && ` (${userForms.length} found)`}
            </Text>
            
            {userForms.length === 0 ? (
              <View style={styles.emptyState}>
                <Ionicons name="document-outline" size={48} color="#C7C7CC" />
                <Text style={styles.emptyStateTitle}>No forms yet</Text>
                <Text style={styles.emptyStateDescription}>
                  Create your first form using a template or start with a blank form
                </Text>
              </View>
            ) : (
              userForms.map((item) => renderUserFormItem(item))
            )}
          </View>
        )}
      </ScrollView>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8f9fa',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 4,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#000',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 8,
    color: '#666',
  },
  content: {
    flex: 1,
  },
  blankFormSection: {
    paddingHorizontal: 16,
    paddingTop: 16,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
  },
  section: {
    marginTop: 24,
    paddingHorizontal: 16,
  },
  tabContainer: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
  },
  tab: {
    flex: 1,
    paddingVertical: 16,
    alignItems: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  activeTab: {
    borderBottomColor: '#007AFF',
  },
  tabText: {
    fontSize: 16,
    fontWeight: '500',
    color: '#666',
  },
  activeTabText: {
    color: '#007AFF',
    fontWeight: '600',
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 48,
    paddingHorizontal: 32,
  },
  emptyStateTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#000',
    marginTop: 16,
    marginBottom: 8,
  },
  emptyStateDescription: {
    fontSize: 14,
    color: '#666',
    textAlign: 'center',
    lineHeight: 20,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: '#000',
    marginBottom: 4,
  },
  sectionSubtitle: {
    fontSize: 14,
    color: '#666',
    marginBottom: 16,
  },
  blankFormCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  blankFormIcon: {
    width: 60,
    height: 60,
    borderRadius: 12,
    backgroundColor: '#f0f8ff',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 16,
  },
  blankFormContent: {
    flex: 1,
  },
  blankFormTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#000',
    marginBottom: 4,
  },
  blankFormDescription: {
    fontSize: 14,
    color: '#666',
    lineHeight: 20,
  },
  templateCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  deleteButton: {
    padding: 4,
    justifyContent: 'center',
    alignItems: 'center',
  },
  templateIcon: {
    width: 48,
    height: 48,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  templateContent: {
    flex: 1,
  },
  templateName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#000',
    marginBottom: 2,
  },
  templateDescription: {
    fontSize: 13,
    color: '#666',
    lineHeight: 18,
    marginBottom: 6,
  },
  templateMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  metaRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  categoryBadge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 3,
    marginRight: 6,
  },
  categoryText: {
    fontSize: 11,
    fontWeight: '500',
    color: '#fff',
  },
  fieldsCount: {
    fontSize: 11,
    color: '#8E8E93',
  },
}); 