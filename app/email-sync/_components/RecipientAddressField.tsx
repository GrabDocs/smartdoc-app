import React, { useEffect, useRef, useState } from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';

export type AccountContact = {
  email: string;
  name?: string;
};

const AVATAR_COLORS = ['#e85d4c', '#3b6fd8', '#1f8a8a', '#1f7a4d', '#5f6b7a', '#8d6e63', '#7c5cbf'];

function avatarColor(email: string): string {
  let hash = 0;
  for (let i = 0; i < email.length; i += 1) hash = (hash + email.charCodeAt(i) * (i + 1)) % AVATAR_COLORS.length;
  return AVATAR_COLORS[hash];
}

function initial(contact: AccountContact): string {
  const source = (contact.name || contact.email || '?').trim();
  return (source[0] || '?').toUpperCase();
}

export function emailsFromAddressText(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of value.split(',')) {
    const token = part.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(token)) continue;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(token);
  }
  return out;
}

function activeQuery(value: string): string {
  const parts = value.split(',');
  return (parts[parts.length - 1] || '').trim();
}

type Props = {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  onCommit: (addresses: string[]) => void;
  editable?: boolean;
  placeholder?: string;
  textColor: string;
  secondaryColor: string;
  borderColor: string;
  menuColor: string;
  searchContacts: (query: string) => Promise<AccountContact[]>;
};

export function RecipientAddressField({
  label,
  value,
  onChangeText,
  onCommit,
  editable = true,
  placeholder,
  textColor,
  secondaryColor,
  borderColor,
  menuColor,
  searchContacts,
}: Props) {
  const [contacts, setContacts] = useState<AccountContact[]>([]);
  const seq = useRef(0);
  const valueRef = useRef(value);
  const searchRef = useRef(searchContacts);
  valueRef.current = value;
  searchRef.current = searchContacts;
  const query = activeQuery(value);
  const taken = new Set(
    emailsFromAddressText(value.slice(0, Math.max(0, value.lastIndexOf(',')))).map((e) => e.toLowerCase()),
  );
  const visible = contacts.filter((row) => row.email && !taken.has(row.email.toLowerCase()));

  useEffect(() => {
    if (!editable || query.length < 2) {
      setContacts([]);
      return;
    }
    const ticket = ++seq.current;
    const timer = setTimeout(() => {
      searchRef.current(query)
        .then((rows) => {
          if (ticket !== seq.current) return;
          setContacts(rows || []);
        })
        .catch(() => {
          if (ticket !== seq.current) return;
          setContacts([]);
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [query, editable]);

  const choose = (contact: AccountContact) => {
    const current = valueRef.current;
    const keep = current.includes(',') ? current.slice(0, current.lastIndexOf(',')) : '';
    const prefix = keep.trim() ? `${emailsFromAddressText(keep).join(', ')}, ` : '';
    const next = `${prefix}${contact.email}, `;
    valueRef.current = next;
    onChangeText(next);
    onCommit(emailsFromAddressText(next));
    setContacts([]);
  };

  return (
    <View style={{ borderBottomWidth: 1, borderBottomColor: borderColor, paddingVertical: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Text style={{ width: 40, fontSize: 13, color: secondaryColor }}>{label}</Text>
        <TextInput
          style={{ flex: 1, color: textColor, fontSize: 15, paddingVertical: 4 }}
          value={value}
          onChangeText={(v) => {
            valueRef.current = v;
            onChangeText(v);
          }}
          placeholder={placeholder}
          placeholderTextColor={secondaryColor}
          autoCapitalize="none"
          autoCorrect={false}
          editable={editable}
          onEndEditing={() => {
            setTimeout(() => onCommit(emailsFromAddressText(valueRef.current)), 50);
          }}
        />
      </View>
      {visible.length > 0 ? (
        <View
          style={{
            marginTop: 4,
            marginLeft: 40,
            borderRadius: 10,
            backgroundColor: menuColor,
            borderWidth: 1,
            borderColor,
            overflow: 'hidden',
          }}
        >
          {visible.map((contact) => {
            const title = contact.name || contact.email;
            return (
              <TouchableOpacity
                key={contact.email}
                onPress={() => choose(contact)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 10, paddingVertical: 8 }}
              >
                <View
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 16,
                    backgroundColor: avatarColor(contact.email),
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text style={{ color: '#fff', fontWeight: '700' }}>{initial(contact)}</Text>
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ color: textColor, fontSize: 14, fontWeight: '600' }} numberOfLines={1}>{title}</Text>
                  <Text style={{ color: secondaryColor, fontSize: 12 }} numberOfLines={1}>{contact.email}</Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}
