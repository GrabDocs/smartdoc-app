/**
 * ACTION_VIEW so GrabDocs appears in Android "Open with" for documents and calendar files.
 * Share (SEND) is registered by expo-share-intent. octet-stream is included because mail
 * apps often label a PDF that way; the app still accepts only known extensions.
 */
const { withAndroidManifest } = require('expo/config-plugins');

const MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/octet-stream',
  'text/calendar',
  'application/ics',
];

function withAndroidOpenDocuments(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults;
    const application = manifest.manifest?.application?.[0];
    const activities = application?.activity;
    if (!Array.isArray(activities)) return config;

    const main = activities.find((activity) =>
      String(activity.$?.['android:name'] || '').endsWith('MainActivity')
    ) || activities[0];
    if (!main) return config;

    main['intent-filter'] = main['intent-filter'] || [];
    const already = main['intent-filter'].some((filter) =>
      (filter.action || []).some((action) => action.$?.['android:name'] === 'android.intent.action.VIEW')
      && (filter.data || []).some((data) => data.$?.['android:mimeType'] === 'application/pdf')
    );
    if (already) return config;

    // Each data element pairs a scheme with a MIME type. A bare scheme would match every content URI.
    const data = [];
    for (const mimeType of MIME_TYPES) {
      for (const scheme of ['content', 'file']) {
        data.push({ $: { 'android:mimeType': mimeType, 'android:scheme': scheme } });
      }
    }
    main['intent-filter'].push({
      action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
      category: [
        { $: { 'android:name': 'android.intent.category.DEFAULT' } },
      ],
      data,
    });
    return config;
  });
}

module.exports = withAndroidOpenDocuments;
