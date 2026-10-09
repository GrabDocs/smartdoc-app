import { apiService } from '../../services/api';
import {
  shareErrorMessage,
  shareErrorStatus,
  type ShareAccessAdapter,
  type ShareAccessSnapshot,
  type ShareRecipient,
  type ShareRole,
} from './types';

type DirectShare = {
  id: number;
  permissions?: string;
  recipient?: { id?: number; email?: string; firstName?: string; lastName?: string; username?: string };
};

type LinkShare = {
  id: number;
  share_type?: string;
  role?: string;
  general_access?: string;
  is_active?: boolean;
  revoked_at?: string | null;
  share_url?: string;
  phone_verification_required?: boolean;
  phone_number?: string | null;
};

const DIRECT_ROLES: ShareRole[] = [
  { id: 'view', label: 'Viewer' },
  { id: 'edit', label: 'Editor' },
];

/** API permits these link roles. Product labels stay on this adapter only. */
const LINK_ROLES: ShareRole[] = [
  { id: 'viewer', label: 'Viewer' },
  { id: 'member', label: 'Editor' },
  { id: 'admin', label: 'Admin' },
];

function personName(recipient?: DirectShare['recipient']): string {
  if (!recipient) return 'Person';
  const full = [recipient.firstName, recipient.lastName].filter(Boolean).join(' ').trim();
  return full || recipient.username || recipient.email || 'Person';
}

function directRole(permissions?: string): ShareRole {
  if (permissions === 'edit') return DIRECT_ROLES[1];
  if (permissions === 'download') return { id: 'download', label: 'Download' };
  return DIRECT_ROLES[0];
}

function usableLink(shares: LinkShare[]): LinkShare | null {
  return (
    shares.find(
      (share) =>
        share.share_type === 'link' &&
        share.is_active !== false &&
        !share.revoked_at &&
        !!share.share_url
    ) || null
  );
}

/**
 * File access only. Viewer/Editor map to this resource's API values.
 * Direct: view / edit. Link: viewer / member. Admin is included because the link API permits it.
 */
export function createFileShareAdapter(file: { id: number; name: string }): ShareAccessAdapter {
  let peopleIndex: ShareRecipient[] | null = null;
  let knownDirect: DirectShare[] = [];

  const loadLink = async (): Promise<LinkShare | null> => {
    const response = await apiService.client.get(`/api/v1/web/files/${file.id}/external-shares`);
    return usableLink((response.data?.shares || []) as LinkShare[]);
  };

  const loadDirect = async (): Promise<{ shares: DirectShare[]; canManage: boolean }> => {
    try {
      const response = (await apiService.listFileDirectShares(file.id)) as { shares?: DirectShare[] };
      const shares = response.shares || [];
      knownDirect = shares;
      return { shares, canManage: true };
    } catch (error) {
      if (shareErrorStatus(error) === 404 || shareErrorStatus(error) === 403) {
        knownDirect = [];
        return { shares: [], canManage: false };
      }
      throw error;
    }
  };

  const adapter: ShareAccessAdapter = {
    async getState(): Promise<ShareAccessSnapshot> {
      const [direct, linkResult] = await Promise.all([
        loadDirect(),
        loadLink().catch((error) => {
          if (shareErrorStatus(error) === 403 || shareErrorStatus(error) === 401) return null;
          throw error;
        }),
      ]);
      const link = linkResult;
      const access = (link?.general_access || '').toLowerCase() === 'anyone' ? 'anyone' : 'restricted';
      const linkRole = LINK_ROLES.find((role) => role.id === (link?.role || 'viewer')) || LINK_ROLES[0];
      const people = direct.canManage
        ? [
            {
              id: 'owner',
              name: 'Owner',
              detail: 'You',
              roleId: 'owner',
              roleLabel: 'Owner',
              canChangeRole: false,
              canRemove: false,
            },
            ...direct.shares.map((share) => {
              const role = directRole(share.permissions);
              return {
                id: String(share.id),
                name: personName(share.recipient),
                detail: share.recipient?.email,
                roleId: role.id,
                roleLabel: role.label,
                canChangeRole: role.id !== 'owner',
                canRemove: true,
              };
            }),
          ]
        : null;
      return {
        title: file.name,
        readOnlyNote: direct.canManage ? undefined : 'Only the file owner can change who has access.',
        people,
        choices: direct.canManage
          ? [
              {
                id: 'general-access',
                label: 'General access',
                detail: link
                  ? access === 'anyone'
                    ? 'Anyone on the internet with this link can open the file.'
                    : 'Only people you add, and anyone signed in with this link, can open the file.'
                  : 'No share link yet.',
                value: link ? access : 'none',
                options: [
                  {
                    id: 'restricted',
                    label: 'Restricted',
                    detail: 'Only explicitly authorized people can use the link.',
                    confirm: link && access === 'anyone' ? 'Disable public link access? People you added directly will keep access.' : undefined,
                  },
                  { id: 'anyone', label: 'Anyone with the link', detail: 'Anyone on the internet with the link can open the file.' },
                ],
              },
              {
                id: 'link-role',
                label: 'Link role',
                detail: 'Applies to the share link, not to people added directly.',
                value: link ? linkRole.id : '',
                options: LINK_ROLES.map((role) => ({ id: role.id, label: role.label })),
              },
            ]
          : null,
        shareUrl: link?.share_url || null,
        phoneVerification: direct.canManage
          ? {
              required: Boolean(link?.phone_verification_required),
              phoneNumber: link?.phone_number || '',
            }
          : null,
      };
    },

    personRoles: () => DIRECT_ROLES,

    async searchPeople(query: string) {
      const q = query.trim().toLowerCase();
      if (!peopleIndex) {
        const workspaceResponse = (await apiService.searchFileShareWorkspaces()) as { workspaces?: { id: number; name: string }[] };
        const workspaces = workspaceResponse.workspaces || [];
        const lists = await Promise.all(
          workspaces.map(async (workspace) => {
            const response = (await apiService.listFileShareWorkspaceUsers(workspace.id)) as {
              users?: { id: number; email?: string; displayName?: string; firstName?: string; lastName?: string }[];
            };
            return (response.users || []).map(
              (user) => ({
                label: user.displayName || [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email || 'Person',
                detail: user.email,
                email: user.email,
                userId: user.id,
                workspaceId: workspace.id,
              })
            );
          })
        );
        const seen = new Set<number>();
        peopleIndex = [];
        for (const list of lists) {
          for (const person of list) {
            if (person.userId == null || seen.has(person.userId)) continue;
            seen.add(person.userId);
            peopleIndex.push(person);
          }
        }
      }
      if (!q) return peopleIndex.slice(0, 8);
      return peopleIndex
        .filter((person) => `${person.label} ${person.detail || ''}`.toLowerCase().includes(q))
        .slice(0, 8);
    },

    async addPeople(people, roleId = 'view') {
      const permissions = roleId === 'edit' ? 'edit' : roleId === 'download' ? 'download' : 'view';
      for (const person of people) {
        if (person.userId == null || person.workspaceId == null) {
          throw new Error('Choose a person from your workspace.');
        }
        try {
          await apiService.shareFileWithPerson({
            file_id: file.id,
            shared_with_id: person.userId,
            workspace_id: person.workspaceId,
            permissions,
          });
        } catch (error) {
          const message = shareErrorMessage(error, 'Could not share');
          const existing = knownDirect.find((share) => share.recipient?.id === person.userId);
          if (existing && /already shared/i.test(message)) {
            await apiService.updateFileDirectShareRole(existing.id, permissions);
            continue;
          }
          throw new Error(message);
        }
      }
    },

    async updatePersonRole(personId, roleId) {
      if (personId === 'owner') return;
      const permissions = roleId === 'edit' ? 'edit' : roleId === 'download' ? 'download' : 'view';
      await apiService.updateFileDirectShareRole(Number(personId), permissions);
    },

    async removePerson(personId) {
      if (personId === 'owner') return;
      await apiService.revokeFileDirectShare(Number(personId));
    },

    async setChoice(choiceId, optionId) {
      const link = await loadLink();
      if (choiceId === 'general-access') {
        const general = optionId === 'anyone' ? 'anyone' : 'restricted';
        if (!link) {
          await apiService.createFileShareLink(file.id, { role: 'viewer', general_access: general });
          return;
        }
        await apiService.updateFileLinkShare(file.id, link.id, { general_access: general });
        return;
      }
      if (choiceId === 'link-role') {
        const role = optionId === 'admin' || optionId === 'member' || optionId === 'viewer' ? optionId : 'viewer';
        if (!link) {
          await apiService.createFileShareLink(file.id, { role, general_access: 'restricted' });
          return;
        }
        await apiService.updateFileLinkShare(file.id, link.id, { role });
      }
    },

    async setPhoneVerification(required, phoneNumber) {
      const link = await loadLink();
      const body = {
        phone_verification_required: required,
        phone_number: required ? phoneNumber : '',
      };
      if (!link) {
        await apiService.createFileShareLink(file.id, {
          role: 'viewer',
          general_access: 'restricted',
          ...body,
        });
        return;
      }
      await apiService.updateFileLinkShare(file.id, link.id, body);
    },

    async getShareUrl() {
      const link = await loadLink();
      return link?.share_url || null;
    },

    async sendLinkEmail(emails, message) {
      const url = await adapter.getShareUrl?.();
      if (!url) throw new Error('Create a share link first.');
      await apiService.sendFileShareLinkEmail(file.id, { share_link: url, emails, message });
    },
  };

  return adapter;
}

type ShareSetRecord = {
  id: number;
  link?: string;
  role?: string;
  general_access?: string;
  phone_verification_required?: boolean;
  phone_number?: string | null;
};

/**
 * One link and one role for every file. Direct people are granted that same role on each file.
 */
export function createFileSetShareAdapter(files: { id: number; name: string }[]): ShareAccessAdapter {
  const fileIds = files.map((file) => file.id).filter((id) => Number.isFinite(id));
  let peopleIndex: ShareRecipient[] | null = null;
  let knownByFile = new Map<number, DirectShare[]>();
  let currentSet: ShareSetRecord | null = null;

  const loadSet = async (): Promise<ShareSetRecord | null> => {
    const response = (await apiService.matchFileShareSet(fileIds)) as { share?: ShareSetRecord | null };
    currentSet = response.share || null;
    return currentSet;
  };

  const loadAllDirect = async (): Promise<{ shares: DirectShare[][]; canManage: boolean }> => {
    const shares: DirectShare[][] = [];
    for (const fileId of fileIds) {
      try {
        const response = (await apiService.listFileDirectShares(fileId)) as { shares?: DirectShare[] };
        const rows = response.shares || [];
        knownByFile.set(fileId, rows);
        shares.push(rows);
      } catch (error) {
        if (shareErrorStatus(error) === 404 || shareErrorStatus(error) === 403) {
          knownByFile.set(fileId, []);
          return { shares: [], canManage: false };
        }
        throw error;
      }
    }
    return { shares, canManage: true };
  };

  const sharedPeople = (lists: DirectShare[][]): DirectShare[] => {
    if (!lists.length) return [];
    const [first, ...rest] = lists;
    return first.filter((share) => {
      const userId = share.recipient?.id;
      if (userId == null) return false;
      const roleId = directRole(share.permissions).id;
      return rest.every((list) =>
        list.some((other) => other.recipient?.id === userId && directRole(other.permissions).id === roleId)
      );
    });
  };

  const ensureSet = async (role: 'viewer' | 'member' | 'admin', general: 'anyone' | 'restricted') => {
    if (currentSet) {
      const response = (await apiService.updateFileShareSet(currentSet.id, { role, general_access: general })) as {
        share?: ShareSetRecord;
      };
      currentSet = response.share || currentSet;
      return currentSet;
    }
    const response = (await apiService.saveFileShareSet({
      file_ids: fileIds,
      role,
      general_access: general,
    })) as { share?: ShareSetRecord };
    currentSet = response.share || null;
    if (!currentSet) throw new Error('Could not create the share link');
    return currentSet;
  };

  const adapter: ShareAccessAdapter = {
    async getState(): Promise<ShareAccessSnapshot> {
      const [direct, setResult] = await Promise.all([
        loadAllDirect(),
        loadSet().catch((error) => {
          if (shareErrorStatus(error) === 403 || shareErrorStatus(error) === 401) return null;
          throw error;
        }),
      ]);
      const link = setResult;
      const access = (link?.general_access || '').toLowerCase() === 'anyone' ? 'anyone' : 'restricted';
      const linkRole = LINK_ROLES.find((role) => role.id === (link?.role || 'viewer')) || LINK_ROLES[0];
      const people = direct.canManage
        ? [
            {
              id: 'owner',
              name: 'Owner',
              detail: 'You',
              roleId: 'owner',
              roleLabel: 'Owner',
              canChangeRole: false,
              canRemove: false,
            },
            ...sharedPeople(direct.shares).map((share) => {
              const role = directRole(share.permissions);
              return {
                id: `user:${share.recipient?.id}`,
                name: personName(share.recipient),
                detail: share.recipient?.email,
                roleId: role.id,
                roleLabel: role.label,
                canChangeRole: true,
                canRemove: true,
              };
            }),
          ]
        : null;
      return {
        title: `${files.length} files`,
        readOnlyNote: direct.canManage ? undefined : 'Only the file owner can change who has access.',
        people,
        choices: direct.canManage
          ? [
              {
                id: 'general-access',
                label: 'General access',
                detail: link
                  ? access === 'anyone'
                    ? 'Anyone on the internet with this link can open these files.'
                    : 'Only people you add, and anyone signed in with this link, can open these files.'
                  : 'No share link yet. The same access applies to every file.',
                value: link ? access : 'none',
                options: [
                  {
                    id: 'restricted',
                    label: 'Restricted',
                    detail: 'Only explicitly authorized people can use the link.',
                    confirm:
                      link && access === 'anyone'
                        ? 'Disable public link access? People you added directly will keep access.'
                        : undefined,
                  },
                  {
                    id: 'anyone',
                    label: 'Anyone with the link',
                    detail: 'Anyone on the internet with the link can open these files.',
                  },
                ],
              },
              {
                id: 'link-role',
                label: 'Link role',
                detail: 'Applies to every file on this link, not to people added directly.',
                value: link ? linkRole.id : '',
                options: LINK_ROLES.map((role) => ({ id: role.id, label: role.label })),
              },
            ]
          : null,
        shareUrl: link?.link || null,
        phoneVerification: direct.canManage
          ? {
              required: Boolean(link?.phone_verification_required),
              phoneNumber: link?.phone_number || '',
            }
          : null,
      };
    },

    personRoles: () => DIRECT_ROLES,

    async searchPeople(query: string) {
      const q = query.trim().toLowerCase();
      if (!peopleIndex) {
        const workspaceResponse = (await apiService.searchFileShareWorkspaces()) as { workspaces?: { id: number; name: string }[] };
        const workspaces = workspaceResponse.workspaces || [];
        const lists = await Promise.all(
          workspaces.map(async (workspace) => {
            const response = (await apiService.listFileShareWorkspaceUsers(workspace.id)) as {
              users?: { id: number; email?: string; displayName?: string; firstName?: string; lastName?: string }[];
            };
            return (response.users || []).map((user) => ({
              label: user.displayName || [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email || 'Person',
              detail: user.email,
              email: user.email,
              userId: user.id,
              workspaceId: workspace.id,
            }));
          })
        );
        const seen = new Set<number>();
        peopleIndex = [];
        for (const list of lists) {
          for (const person of list) {
            if (person.userId == null || seen.has(person.userId)) continue;
            seen.add(person.userId);
            peopleIndex.push(person);
          }
        }
      }
      if (!q) return peopleIndex.slice(0, 8);
      return peopleIndex
        .filter((person) => `${person.label} ${person.detail || ''}`.toLowerCase().includes(q))
        .slice(0, 8);
    },

    async addPeople(people, roleId = 'view') {
      const permissions = roleId === 'edit' ? 'edit' : roleId === 'download' ? 'download' : 'view';
      for (const person of people) {
        if (person.userId == null || person.workspaceId == null) {
          throw new Error('Choose a person from your workspace.');
        }
        for (const fileId of fileIds) {
          try {
            await apiService.shareFileWithPerson({
              file_id: fileId,
              shared_with_id: person.userId,
              workspace_id: person.workspaceId,
              permissions,
            });
          } catch (error) {
            const message = shareErrorMessage(error, 'Could not share');
            const existing = (knownByFile.get(fileId) || []).find((share) => share.recipient?.id === person.userId);
            if (existing && /already shared/i.test(message)) {
              await apiService.updateFileDirectShareRole(existing.id, permissions);
              continue;
            }
            throw new Error(message);
          }
        }
      }
    },

    async updatePersonRole(personId, roleId) {
      if (personId === 'owner') return;
      const userId = Number(personId.replace('user:', ''));
      const permissions = roleId === 'edit' ? 'edit' : roleId === 'download' ? 'download' : 'view';
      for (const fileId of fileIds) {
        const existing = (knownByFile.get(fileId) || []).find((share) => share.recipient?.id === userId);
        if (!existing) continue;
        await apiService.updateFileDirectShareRole(existing.id, permissions);
      }
    },

    async removePerson(personId) {
      if (personId === 'owner') return;
      const userId = Number(personId.replace('user:', ''));
      for (const fileId of fileIds) {
        const existing = (knownByFile.get(fileId) || []).find((share) => share.recipient?.id === userId);
        if (!existing) continue;
        await apiService.revokeFileDirectShare(existing.id);
      }
    },

    async setChoice(choiceId, optionId) {
      const link = currentSet || (await loadSet());
      if (choiceId === 'general-access') {
        const general = optionId === 'anyone' ? 'anyone' : 'restricted';
        const role = (link?.role === 'member' || link?.role === 'admin' || link?.role === 'viewer' ? link.role : 'viewer') as
          | 'viewer'
          | 'member'
          | 'admin';
        await ensureSet(role, general);
        return;
      }
      if (choiceId === 'link-role') {
        const role = optionId === 'admin' || optionId === 'member' || optionId === 'viewer' ? optionId : 'viewer';
        const general = (link?.general_access || '').toLowerCase() === 'anyone' ? 'anyone' : 'restricted';
        await ensureSet(role, general);
      }
    },

    async setPhoneVerification(required, phoneNumber) {
      const link = currentSet || (await loadSet());
      const body = {
        phone_verification_required: required,
        phone_number: required ? phoneNumber : '',
      };
      if (!link) {
        const response = (await apiService.saveFileShareSet({
          file_ids: fileIds,
          role: 'viewer',
          general_access: 'restricted',
          ...body,
        })) as { share?: ShareSetRecord };
        currentSet = response.share || null;
        if (!currentSet) throw new Error('Could not create the share link');
        return;
      }
      const response = (await apiService.updateFileShareSet(link.id, body)) as { share?: ShareSetRecord };
      currentSet = response.share || link;
    },

    async getShareUrl() {
      const link = currentSet || (await loadSet());
      return link?.link || null;
    },

    async sendLinkEmail(emails, message) {
      const url = await adapter.getShareUrl?.();
      if (!url) throw new Error('Create a share link first.');
      await apiService.sendFileShareLinkEmail(fileIds[0], { share_link: url, emails, message });
    },
  };

  return adapter;
}
