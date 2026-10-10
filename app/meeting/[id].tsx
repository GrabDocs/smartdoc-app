import { Redirect, useLocalSearchParams } from 'expo-router';
import { APP_HOME_PATH } from '../../utils/resolveAppDeepLinkPath';

/**
 * Web App Link target https://app.grabdocs.com/meeting/:id — map to in-app join.
 */
export default function MeetingDeepLinkScreen() {
  const { id } = useLocalSearchParams<{ id?: string | string[] }>();
  const meetingId = typeof id === 'string' ? id : Array.isArray(id) ? id[0] : '';
  if (!meetingId?.trim()) {
    return <Redirect href={APP_HOME_PATH as any} />;
  }
  return (
    <Redirect
      href={{
        pathname: '/join-meeting',
        params: { meeting_id: meetingId.trim() },
      }}
    />
  );
}
