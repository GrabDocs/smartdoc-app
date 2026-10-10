import { Redirect } from 'expo-router';
import { APP_HOME_PATH } from '../utils/resolveAppDeepLinkPath';

/** Never show Expo's Unmatched Route UI — send users home. */
export default function NotFound() {
  return <Redirect href={APP_HOME_PATH as any} />;
}
