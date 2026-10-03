import { FRONTEND_URL } from '../../constants/Config';
import { apiService } from '../../services/api';
import { bookingListEventTypes, bookingUpdateEventType } from '../../services/bookingApi';
import { buildUploadLinkUrl, getFullPublicUploadUrl } from '../../utils/uploadLinkHelpers';
import type { ShareAccessAdapter, ShareAccessSnapshot, ShareRecipient } from './types';

function formUrl(shareUrl?: string | null): string | null {
  if (!shareUrl) return null;
  const base = FRONTEND_URL.replace(/\/$/, '');
  return `${base}/form/${shareUrl}`;
}

/** Form link state and whether responses are accepted. Not file roles. */
export function createFormShareAdapter(formId: number): ShareAccessAdapter {
  return {
    async getState(): Promise<ShareAccessSnapshot> {
      const response = (await apiService.getFormById(formId)) as { form?: any; data?: any; title?: string; name?: string; is_published?: boolean; share_url?: string };
      const form = response.form || response.data || response;
      const published = !!form?.is_published;
      const url = published ? formUrl(form?.share_url) : null;
      return {
        title: form?.title || form?.name || 'Form',
        people: null,
        choices: [
          {
            id: 'responses',
            label: 'Response access',
            detail: published ? 'The form link accepts responses.' : 'The form link does not accept responses.',
            value: published ? 'open' : 'closed',
            options: [
              { id: 'open', label: 'Accepting responses' },
              { id: 'closed', label: 'Not accepting responses', confirm: 'Stop accepting responses on this form?' },
            ],
          },
        ],
        shareUrl: url,
      };
    },
    async setChoice(_choiceId, optionId) {
      await apiService.setFormPublished(formId, optionId === 'open');
    },
    async getShareUrl() {
      const response = (await apiService.getFormById(formId)) as { form?: any; data?: any; is_published?: boolean; share_url?: string };
      const form = response.form || response.data || response;
      if (!form?.is_published) return null;
      return formUrl(form?.share_url);
    },
  };
}

/** Upload-link active state, expiration, and the existing public URL. */
export function createUploadLinkShareAdapter(linkId: number): ShareAccessAdapter {
  const load = async () => {
    const response = (await apiService.getUploadLink(linkId)) as { upload_link?: any; link?: any };
    return response.upload_link || response.link;
  };
  return {
    async getState() {
      const link = await load();
      const active = link?.is_active !== false;
      const url = link?.url ? buildUploadLinkUrl(link.url) || getFullPublicUploadUrl(link.url) : null;
      const expires = link?.expires_at ? `Expires ${new Date(link.expires_at).toLocaleString()}` : 'No expiration set.';
      const max = link?.max_uploads != null ? `Upload limit: ${link.max_uploads}.` : '';
      return {
        title: link?.name || 'File request',
        people: null,
        choices: [
          {
            id: 'active',
            label: 'File request',
            detail: [expires, max].filter(Boolean).join(' '),
            value: active ? 'active' : 'inactive',
            options: [
              { id: 'active', label: 'Active' },
              { id: 'inactive', label: 'Inactive', confirm: 'Deactivate this file request? The link will stop accepting uploads.' },
            ],
          },
        ],
        shareUrl: active ? url : null,
      };
    },
    async setChoice(_choiceId, optionId) {
      await apiService.client.put(`/api/v1/mobile/upload-links/${linkId}`, { is_active: optionId === 'active' });
    },
    async getShareUrl() {
      const link = await load();
      if (link?.is_active === false || !link?.url) return null;
      return buildUploadLinkUrl(link.url) || getFullPublicUploadUrl(link.url);
    },
    async sendLinkEmail(emails, message) {
      await apiService.shareUploadLink(linkId, { emails, message });
    },
  };
}

/** Intake submission access: active or archived, plus authorized senders. */
export function createIntakeShareAdapter(intakeId: number): ShareAccessAdapter {
  const load = async () => {
    const response = (await apiService.getIntake(intakeId)) as { intake?: any };
    return response.intake || response;
  };
  return {
    async getState() {
      const intake = await load();
      const archived = intake?.status === 'archived';
      const senders = (intake?.authorized_senders || []) as { name?: string; email?: string }[];
      const publicUrl = intake?.upload_link?.public_url as string | undefined;
      return {
        title: intake?.title || 'Intake',
        people: senders.map((sender, index) => ({
          id: String(index),
          name: sender.name || sender.email || 'Sender',
          detail: sender.email,
          roleId: 'sender',
          roleLabel: 'Can submit',
          canChangeRole: false,
          canRemove: !archived,
        })),
        choices: [
          {
            id: 'active',
            label: 'Intake',
            detail: 'People on this list can submit documents. This does not edit the intake setup.',
            value: archived ? 'inactive' : 'active',
            options: [
              { id: 'active', label: 'Active' },
              { id: 'inactive', label: 'Inactive', confirm: 'Archive this intake? The upload link will stop taking submissions.' },
            ],
          },
        ],
        shareUrl: !archived && publicUrl ? getFullPublicUploadUrl(publicUrl) : null,
      };
    },
    async searchPeople(query: string) {
      const email = query.trim();
      if (!email.includes('@')) return [];
      return [{ label: email, email, detail: email }];
    },
    async addPeople(people: ShareRecipient[]) {
      const intake = await load();
      const current = ((intake?.authorized_senders || []) as { name?: string; email?: string }[]).map((sender) => ({
        name: sender.name || sender.email || '',
        email: (sender.email || '').trim(),
      }));
      const emails = new Set(current.map((sender) => sender.email.toLowerCase()));
      for (const person of people) {
        const email = (person.email || '').trim();
        if (!email || emails.has(email.toLowerCase())) continue;
        emails.add(email.toLowerCase());
        current.push({ name: person.label || email, email });
      }
      await apiService.updateIntake(intakeId, { authorized_senders: current });
    },
    async removePerson(personId: string) {
      const intake = await load();
      const current = ((intake?.authorized_senders || []) as { name?: string; email?: string }[])
        .map((sender) => ({ name: sender.name || sender.email || '', email: sender.email || '' }))
        .filter((_, index) => String(index) !== personId);
      await apiService.updateIntake(intakeId, { authorized_senders: current });
    },
    async setChoice(_choiceId, optionId) {
      if (optionId === 'inactive') await apiService.archiveIntake(intakeId);
      else await apiService.unarchiveIntake(intakeId);
    },
    async getShareUrl() {
      const intake = await load();
      if (intake?.status === 'archived') return null;
      const publicUrl = intake?.upload_link?.public_url as string | undefined;
      return publicUrl ? getFullPublicUploadUrl(publicUrl) : null;
    },
  };
}

/** Booking page active state and the scheduling facts the event type already stores. */
export function createBookingShareAdapter(eventTypeId: number): ShareAccessAdapter {
  const load = async () => {
    const response = await bookingListEventTypes();
    const types = (response.event_types || []) as {
      id: number;
      name?: string;
      slug?: string;
      public_path?: string;
      active?: boolean;
      duration_minutes?: number;
      kind?: string;
      seat_limit?: number | null;
      add_reach_link?: boolean;
      form_id?: number | null;
    }[];
    const eventType = types.find((item) => item.id === eventTypeId);
    if (!eventType) throw new Error('Booking page not found.');
    return eventType;
  };
  return {
    async getState() {
      const eventType = await load();
      const kind = eventType.kind === 'group' ? `Group · ${eventType.seat_limit || 1} seats` : 'One-on-one';
      const reach = eventType.add_reach_link ? 'Reach link on.' : 'No Reach link.';
      return {
        title: eventType.name || 'Booking page',
        people: null,
        choices: [
          {
            id: 'active',
            label: 'Booking page',
            detail: `${eventType.duration_minutes || 0} minutes · ${kind}. ${reach}`,
            value: eventType.active === false ? 'inactive' : 'active',
            options: [
              { id: 'active', label: 'Active' },
              { id: 'inactive', label: 'Inactive', confirm: 'Deactivate this booking page?' },
            ],
          },
        ],
        shareUrl: eventType.active === false || !eventType.public_path ? null : `${FRONTEND_URL}${eventType.public_path}`,
      };
    },
    async setChoice(_choiceId, optionId) {
      const eventType = await load();
      await bookingUpdateEventType(eventTypeId, { active: optionId === 'active', name: eventType.name, slug: eventType.slug });
    },
    async getShareUrl() {
      const eventType = await load();
      if (eventType.active === false || !eventType.public_path) return null;
      return `${FRONTEND_URL}${eventType.public_path}`;
    },
  };
}
