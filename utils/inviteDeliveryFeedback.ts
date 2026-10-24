export type InviteDeliveryResponse = {
  success?: boolean;
  message?: string;
  delivery_warning?: string | null;
  invite_notify_in_app?: boolean;
  existing?: boolean;
  no_email_sent?: boolean;
  delivery?: {
    email_requested?: boolean;
    phone_requested?: boolean;
    email_sent?: boolean | null;
    sms_sent?: boolean | null;
  };
};

export const IN_APP_INVITE_BANNER =
  'They already have a GrabDocs account. No email was sent — they were notified in the app.';

export const EXISTING_CHAT_NO_EMAIL_BANNER =
  'They already have GrabDocs. Chat opened — no invite email was sent.';

export function senderInviteBannerText(
  data?: InviteDeliveryResponse | { invite_notify_in_app?: boolean } | null,
): string | null {
  if (!data) return null;
  if (data.invite_notify_in_app) {
    return ('message' in data && data.message) || IN_APP_INVITE_BANNER;
  }
  if ('existing' in data && data.existing && data.no_email_sent) {
    return data.message || EXISTING_CHAT_NO_EMAIL_BANNER;
  }
  return null;
}

export function inviteDeliveryFailed(data: InviteDeliveryResponse): boolean {
  const delivery = data.delivery;
  if (!delivery) return false;
  return delivery.email_sent === false || delivery.sms_sent === false;
}

export function inviteDeliveryMessage(data: InviteDeliveryResponse): string {
  const parts = [data.message || 'Invite sent'];
  if (data.delivery_warning) parts.push(data.delivery_warning);
  return parts.join(' ');
}

/** Mobile: show toast for invite create/resend delivery result. */
export function showInviteDeliveryToastMobile(
  data: InviteDeliveryResponse,
  Toast: { show: (opts: { type: string; text1: string; text2?: string }) => void },
): void {
  const failed = inviteDeliveryFailed(data);
  Toast.show({
    type: failed ? 'error' : 'success',
    text1: failed ? 'Delivery issue' : data.message || 'Invite sent',
    text2: failed ? inviteDeliveryMessage(data) : undefined,
  });
}
