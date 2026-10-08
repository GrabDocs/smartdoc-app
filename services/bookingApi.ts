import { apiClient } from './api';

const client = () => apiClient.client;

export async function bookingGetProfile() {
  const response = await client().get('/api/v1/booking/profile');
  return response.data;
}

export async function bookingUpdateProfile(body: Record<string, unknown>) {
  const response = await client().put('/api/v1/booking/profile', body);
  return response.data;
}

export async function bookingListEventTypes() {
  const response = await client().get('/api/v1/booking/event-types');
  return response.data;
}

export async function bookingCreateEventType(body: Record<string, unknown>) {
  const response = await client().post('/api/v1/booking/event-types', body);
  return response.data;
}

export async function bookingAttachEventFile(typeId: number, fileId: number) {
  const response = await client().post(`/api/v1/booking/event-types/${typeId}/attachments`, { file_id: fileId });
  return response.data;
}

export async function bookingListSignups(typeId: number) {
  const response = await client().get(`/api/v1/booking/event-types/${typeId}/signups`);
  return response.data;
}

export async function bookingListForms() {
  const response = await client().get('/api/v1/booking/forms');
  return response.data;
}

export async function bookingUpdateEventType(typeId: number, body: Record<string, unknown>) {
  const response = await client().put(`/api/v1/booking/event-types/${typeId}`, body);
  return response.data;
}

export async function bookingDeactivateEventType(typeId: number) {
  const response = await client().delete(`/api/v1/booking/event-types/${typeId}`);
  return response.data;
}
