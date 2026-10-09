/** Capability-gated share contract. A missing method means that control does not exist. */

export type ShareRole = {
  id: string;
  label: string;
};

export type SharePerson = {
  id: string;
  name: string;
  detail?: string;
  roleId: string;
  roleLabel: string;
  /** File owner rows set this. The sheet has no owner concept of its own. */
  canChangeRole: boolean;
  canRemove: boolean;
};

export type ShareChoice = {
  id: string;
  label: string;
  detail?: string;
  value: string;
  options: { id: string; label: string; detail?: string; confirm?: string }[];
};

export type ShareAccessSnapshot = {
  title: string;
  /** Shown when the current user can see access but must not change it. */
  readOnlyNote?: string;
  people: SharePerson[] | null;
  choices: ShareChoice[] | null;
  /** Null means no usable URL. Distinct from a restricted link that still has a URL. */
  shareUrl: string | null;
  /** Null when this resource has no phone check. One phone covers every file on the link. */
  phoneVerification?: { required: boolean; phoneNumber: string } | null;
};

export type ShareRecipient = {
  label: string;
  detail?: string;
  userId?: number;
  workspaceId?: number;
  email?: string;
};

export type ShareAccessAdapter = {
  getState: () => Promise<ShareAccessSnapshot>;
  searchPeople?: (query: string) => Promise<ShareRecipient[]>;
  addPeople?: (people: ShareRecipient[], roleId?: string) => Promise<void>;
  updatePersonRole?: (personId: string, roleId: string) => Promise<void>;
  removePerson?: (personId: string) => Promise<void>;
  personRoles?: () => ShareRole[];
  setChoice?: (choiceId: string, optionId: string) => Promise<void>;
  setPhoneVerification?: (required: boolean, phoneNumber: string) => Promise<void>;
  getShareUrl?: () => Promise<string | null>;
  sendLinkEmail?: (emails: string[], message?: string) => Promise<void>;
};

export function shareErrorMessage(error: unknown, fallback: string): string {
  const data = (error as { response?: { data?: { error?: unknown; message?: unknown } } })?.response?.data;
  const raw = data?.error ?? data?.message ?? (error as { message?: unknown })?.message;
  return typeof raw === 'string' && raw.trim() ? raw : fallback;
}

export function shareErrorStatus(error: unknown): number | undefined {
  const status = (error as { response?: { status?: number } })?.response?.status;
  return typeof status === 'number' ? status : undefined;
}
