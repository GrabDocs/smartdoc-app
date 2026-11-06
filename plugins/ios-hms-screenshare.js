/**
 * Expo config plugin: add 100ms Broadcast Upload Extension for iOS screenshare.
 * Creates the extension target, SampleHandler with HMSScreenRenderer, Podfile entry,
 * and App Group entitlements so screenshare works from iPhone/iPad without Xcode.
 *
 * Options: { appGroup?: string, extensionName?: string }
 * Defaults: appGroup: 'group.com.grabdocs.mobile', extensionName: 'GrabDocsBroadcastUpload'
 *
 * Set EXPO_PUBLIC_HMS_IOS_APP_GROUP and EXPO_PUBLIC_HMS_IOS_PREFERRED_EXTENSION in EAS
 * to match (or pass options). See docs/MOBILE_SCREENSHARE_WHITEBOARD.md
 */
const {
  withDangerousMod,
  withXcodeProject,
  withPodfile,
  withEntitlementsPlist,
} = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');
// @expo/plist exports { default: { parse, build } }; use .default for CommonJS
const plist = require('@expo/plist').default || require('@expo/plist');

const DEFAULT_APP_GROUP = 'group.com.grabdocs.mobile';
const DEFAULT_EXTENSION_NAME = 'GrabDocsBroadcastUpload';

const SAMPLE_HANDLER_SWIFT = `import ReplayKit
import HMSBroadcastExtensionSDK

class SampleHandler: RPBroadcastSampleHandler {

  let screenRenderer = HMSScreenRenderer(appGroup: "{{APP_GROUP}}")

  override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
  }

  override func broadcastPaused() {
  }

  override func broadcastResumed() {
  }

  override func broadcastFinished() {
    screenRenderer.invalidate()
  }

  override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
    switch sampleBufferType {
    case RPSampleBufferType.video:
      if let error = screenRenderer.process(sampleBuffer) {
        if error.code == .noActiveMeeting {
          finishBroadcastWithError(NSError(domain: "ScreenShare",
                                           code: error.code.rawValue,
                                           userInfo: [NSLocalizedFailureReasonErrorKey: "You are not in a meeting."]))
        }
      }
      break
    case RPSampleBufferType.audioApp:
      _ = self.screenRenderer.process(audioSampleBuffer: sampleBuffer)
      break
    case RPSampleBufferType.audioMic:
      break
    @unknown default:
      fatalError("Unknown type of sample buffer")
    }
  }
}
`;

function withBroadcastExtensionFiles(config, { appGroup, extensionName }) {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const extRoot = path.join(config.modRequest.platformProjectRoot, extensionName);
      await fs.promises.mkdir(extRoot, { recursive: true });

      const sampleHandler = SAMPLE_HANDLER_SWIFT.replace(/\{\{APP_GROUP\}\}/g, appGroup);
      await fs.promises.writeFile(path.join(extRoot, 'SampleHandler.swift'), sampleHandler);

      const bundleId = config.ios?.bundleIdentifier || 'com.grabdocs.mobile';
      const extBundleId = `${bundleId}.${extensionName}`;
      const extensionPlist = {
        CFBundleIdentifier: extBundleId,
        CFBundleName: extensionName,
        CFBundleDisplayName: extensionName,
        CFBundleExecutable: extensionName,
        CFBundlePackageType: 'XPC!',
        CFBundleShortVersionString: '1.0',
        CFBundleVersion: '1',
        NSExtension: {
          NSExtensionPointIdentifier: 'com.apple.broadcast-services-upload',
          NSExtensionPrincipalClass: '$(PRODUCT_MODULE_NAME).SampleHandler',
          RPBroadcastProcessMode: 'RPBroadcastProcessModeSampleBuffer',
        },
      };
      await fs.promises.writeFile(
        path.join(extRoot, 'Info.plist'),
        plist.build(extensionPlist)
      );

      const extEntitlements = {
        'com.apple.security.application-groups': [appGroup],
      };
      await fs.promises.writeFile(
        path.join(extRoot, `${extensionName}.entitlements`),
        plist.build(extEntitlements)
      );

      return config;
    },
  ]);
}

/**
 * Add the Broadcast Upload Extension target using the xcode project API.
 * Uses addTarget when available; otherwise builds the target via addToPbxNativeTargetSection
 * and related APIs so the target persists and CocoaPods can find it.
 */
function withBroadcastExtensionTarget(config, { extensionName }) {
  return withXcodeProject(config, async (config) => {
    const project = config.modResults;
    const bundleId = config.ios?.bundleIdentifier || 'com.grabdocs.mobile';
    const extBundleId = `${bundleId}.${extensionName}`;
    const quoted = (s) => `"${s}"`;

    // Check if the extension target was already added (e.g. by expo.ios.appExtensions).
    // If it exists, skip target creation but still apply build phases + build settings below.
    const nativeTargets = project.pbxNativeTargetSection && project.pbxNativeTargetSection();
    const existingExtTarget = nativeTargets && Object.values(nativeTargets).find(
      (t) => t && t.name && (t.name === extensionName || t.name === quoted(extensionName))
    );

    let targetUuid;
    let target;

    if (existingExtTarget) {
      // Target already exists — skip creation, jump straight to build settings patch below.
      targetUuid = Object.keys(nativeTargets).find((k) => {
        const t = nativeTargets[k];
        return t && t.name && (t.name === extensionName || t.name === quoted(extensionName));
      });
    }

    if (!existingExtTarget && typeof project.addTarget === 'function') {
      target = project.addTarget(extensionName, 'app_extension', extensionName, extBundleId);
      if (target && target.uuid) {
        targetUuid = target.uuid;
        // addTarget(app_extension) typically adds "Embed App Extensions" and the .appex product.
        // Do NOT add the phase again: duplicate phase/build file causes xcodeproj
        // "Consistency issue: no parent for object ... Copy Files, Embed App Extensions".
      }
    }

    if (!existingExtTarget && !targetUuid && typeof project.addToPbxNativeTargetSection === 'function') {
      const mainTarget = project.getFirstTarget && project.getFirstTarget();
      if (!mainTarget || !mainTarget.uuid) return config;

      targetUuid = project.generateUuid();
      const configListUuid = project.generateUuid();
      const debugConfigUuid = project.generateUuid();
      const releaseConfigUuid = project.generateUuid();

      const sharedBuildSettings = {
        INFOPLIST_FILE: quoted(`${extensionName}/Info.plist`),
        LD_RUNPATH_SEARCH_PATHS: quoted('$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks'),
        PRODUCT_NAME: quoted(extensionName),
        SKIP_INSTALL: 'YES',
        PRODUCT_BUNDLE_IDENTIFIER: quoted(extBundleId),
        CODE_SIGN_ENTITLEMENTS: quoted(`${extensionName}/${extensionName}.entitlements`),
        // Keep Automatic so Xcode can resolve signing when credentials are available.
        // EAS overrides to Manual when it injects provisioning profiles from EAS cloud.
        // Run `eas credentials --platform ios` once to register the extension bundle ID
        // (com.grabdocs.mobile.GrabDocsBroadcastUpload) with EAS so it can inject a profile.
        CODE_SIGN_STYLE: '"Automatic"',
        DEVELOPMENT_TEAM: '"Q33K3Q7Q53"',
        IPHONEOS_DEPLOYMENT_TARGET: '"16.0"',
        SWIFT_VERSION: '"5.0"',
        TARGETED_DEVICE_FAMILY: '"1,2"',
      };
      const buildConfigs = [
        { name: 'Debug',   isa: 'XCBuildConfiguration', buildSettings: { ...sharedBuildSettings } },
        { name: 'Release', isa: 'XCBuildConfiguration', buildSettings: { ...sharedBuildSettings } },
      ];
      const xcConfigList = project.addXCConfigurationList(buildConfigs, 'Release', `Build configuration list for PBXNativeTarget "${extensionName}"`);
      if (!xcConfigList || !xcConfigList.uuid) return config;

      const productFile = project.addProductFile(`${extensionName}.appex`, {
        group: 'Products',
        target: mainTarget.uuid,
        explicitFileType: 'wrapper.app-extension',
      });
      if (!productFile) return config;
      project.addToPbxBuildFileSection(productFile);

      target = {
        uuid: targetUuid,
        pbxNativeTarget: {
          isa: 'PBXNativeTarget',
          name: quoted(extensionName),
          productName: quoted(extensionName),
          productReference: productFile.fileRef,
          productType: '"com.apple.product-type.app-extension"',
          buildConfigurationList: xcConfigList.uuid,
          buildPhases: [],
          buildRules: [],
          dependencies: [],
        },
      };
      project.addToPbxNativeTargetSection(target);
      // CocoaPods finds the host by inspecting the main target's "Embed App Extensions" phase; name must match.
      project.addBuildPhase([], 'PBXCopyFilesBuildPhase', 'Embed App Extensions', mainTarget.uuid, 'app_extension');
      project.addToPbxCopyfilesBuildPhase(productFile);
      project.addToPbxProjectSection(target);
      project.addTargetDependency(mainTarget.uuid, [targetUuid]);
    }

    if (!targetUuid) return config;

    // CocoaPods 1.2.1+ requires the host target to list the extension in Target Dependencies
    // (not just Embed phase); otherwise "Unable to find host target(s) for GrabDocsBroadcastUpload".
    const mainTarget = project.getFirstTarget && project.getFirstTarget();
    if (mainTarget && mainTarget.uuid && typeof project.addTargetDependency === 'function') {
      try {
        project.addTargetDependency(mainTarget.uuid, [targetUuid]);
        console.log('[ios-hms-screenshare] ✅ Extension added as dependency of main target');
      } catch (depErr) {
        console.warn('[ios-hms-screenshare] ⚠️  Could not add extension target dependency:', depErr.message);
      }
    }

    if (!existingExtTarget) {
      // Target was created by this plugin — add all build phases fresh.
      project.addBuildPhase(
        [`${extensionName}/SampleHandler.swift`],
        'PBXSourcesBuildPhase',
        'Sources',
        targetUuid
      );
      project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', targetUuid);

      const replayKitFile = project.addFramework('ReplayKit.framework', { target: targetUuid, link: false });
      if (replayKitFile) {
        project.addBuildPhase(
          [replayKitFile.path || 'ReplayKit.framework'],
          'PBXFrameworksBuildPhase',
          'Frameworks',
          targetUuid
        );
      }
    } else {
      // Target was pre-created by expo.ios.appExtensions — ensure SampleHandler.swift is
      // listed in the Sources build phase (Expo creates an empty one with no files).
      try {
        const buildPhaseSection = project.pbxSourcesBuildPhaseObj && project.pbxSourcesBuildPhaseObj(targetUuid);
        const swiftPath = `${extensionName}/SampleHandler.swift`;
        if (buildPhaseSection && buildPhaseSection.files) {
          const alreadyListed = buildPhaseSection.files.some((f) => {
            const ref = project.pbxBuildFileSection && project.pbxBuildFileSection()[f.value];
            return ref && ref.fileRef_comment && ref.fileRef_comment.includes('SampleHandler.swift');
          });
          if (!alreadyListed) {
            project.addBuildPhase([swiftPath], 'PBXSourcesBuildPhase', 'Sources', targetUuid);
          }
        } else {
          project.addBuildPhase([swiftPath], 'PBXSourcesBuildPhase', 'Sources', targetUuid);
        }
      } catch (_) {
        // pbxSourcesBuildPhaseObj may not exist on all xcode versions; fall back to addBuildPhase
        project.addBuildPhase([`${extensionName}/SampleHandler.swift`], 'PBXSourcesBuildPhase', 'Sources', targetUuid);
      }
    }

    // Always patch build configurations — overwrite whatever appExtensions or addTarget set
    // so our HMS-specific settings (INFOPLIST_FILE, CODE_SIGN_ENTITLEMENTS, etc.) win.
    // updateBuildProperty's target-name filter is unreliable; we find the target's
    // XCConfigurationList and set properties on each XCBuildConfiguration directly.
    const nativeTargetSection = project.pbxNativeTargetSection && project.pbxNativeTargetSection();
    const configSection = project.pbxXCBuildConfigurationSection && project.pbxXCBuildConfigurationSection();
    const configListSection = project.pbxXCConfigurationList && project.pbxXCConfigurationList();

    if (nativeTargetSection && configSection && configListSection) {
      // Find the extension target entry (may have quotes around name in pbxproj)
      const extTargetEntry = Object.values(nativeTargetSection).find(
        (t) => t && t.name && (t.name === extensionName || t.name === quoted(extensionName))
      );

      if (extTargetEntry && extTargetEntry.buildConfigurationList) {
        const configListUuid = extTargetEntry.buildConfigurationList;
        const configListEntry = configListSection[configListUuid];
        if (configListEntry && configListEntry.buildConfigurations) {
          const configUuids = configListEntry.buildConfigurations.map((c) =>
            typeof c === 'object' ? c.value : c
          );
          for (const uuid of configUuids) {
            const buildConfig = configSection[uuid];
            if (buildConfig && buildConfig.buildSettings) {
              buildConfig.buildSettings.SWIFT_VERSION = '"5.0"';
              buildConfig.buildSettings.IPHONEOS_DEPLOYMENT_TARGET = '"16.0"';
              buildConfig.buildSettings.TARGETED_DEVICE_FAMILY = '"1,2"';
              buildConfig.buildSettings.SKIP_INSTALL = 'YES';
              buildConfig.buildSettings.DEVELOPMENT_TEAM = '"Q33K3Q7Q53"';
              buildConfig.buildSettings.INFOPLIST_FILE = quoted(`${extensionName}/Info.plist`);
              buildConfig.buildSettings.CODE_SIGN_ENTITLEMENTS = quoted(`${extensionName}/${extensionName}.entitlements`);
              buildConfig.buildSettings.PRODUCT_BUNDLE_IDENTIFIER = quoted(extBundleId);
              // Extension links HMSBroadcastExtensionSDK (built by CocoaPods for main target).
              // Use single-quoted form so Nanaimo (CocoaPods pbxproj parser) doesn't treat $(...) as a dict.
              buildConfig.buildSettings.FRAMEWORK_SEARCH_PATHS = "'$(inherited) $(PODS_CONFIGURATION_BUILD_DIR)/" + HMS_POD_NAME + "'";
              buildConfig.buildSettings.OTHER_LDFLAGS = "'$(inherited) -framework " + HMS_POD_NAME + "'";
              buildConfig.buildSettings.APPLICATION_EXTENSION_API_ONLY = 'YES';
              // Use Automatic signing so Xcode picks the profile we install (run script) by bundle ID.
              // Manual + PROVISIONING_PROFILE failed in EAS local (HOME/temp isolation); Automatic finds the profile in the standard dir.
              buildConfig.buildSettings.CODE_SIGN_STYLE = '"Automatic"';
              buildConfig.buildSettings.CODE_SIGNING_ALLOWED = '"YES"';
              buildConfig.buildSettings.DEVELOPMENT_TEAM = '"Q33K3Q7Q53"';
              if (buildConfig.buildSettings.PROVISIONING_PROFILE) delete buildConfig.buildSettings.PROVISIONING_PROFILE;
              if (buildConfig.buildSettings.PROVISIONING_PROFILE_SPECIFIER) delete buildConfig.buildSettings.PROVISIONING_PROFILE_SPECIFIER;
            }
          }
        }
      }
    }

    return config;
  });
}

/**
 * Enforce Automatic signing for every native target's build configurations.
 * Iterates all targets (GrabDocs, GrabDocsBroadcastUpload, any future ones) so we
 * are not dependent on bundle IDs or target names. Prevents Expo regeneration
 * from reintroducing manual signing.
 */
function withForceAllTargetsAutomaticSigning(config) {
  return withXcodeProject(config, async (config) => {
    const project = config.modResults;
    const nativeTargetSection = project.pbxNativeTargetSection && project.pbxNativeTargetSection();
    const configSection = project.pbxXCBuildConfigurationSection && project.pbxXCBuildConfigurationSection();
    const configListSection = project.pbxXCConfigurationList && project.pbxXCConfigurationList();

    if (!nativeTargetSection || !configSection || !configListSection) {
      return config;
    }

    const targetEntries = Object.values(nativeTargetSection);
    let touched = 0;

    for (const target of targetEntries) {
      if (!target || !target.buildConfigurationList) continue;

      const configListUuid = target.buildConfigurationList;
      const configListEntry = configListSection[configListUuid];
      if (!configListEntry || !configListEntry.buildConfigurations) continue;

      const configUuids = configListEntry.buildConfigurations.map((c) =>
        typeof c === 'object' && c != null && 'value' in c ? c.value : c
      );

      for (const uuid of configUuids) {
        const buildConfig = configSection[uuid];
        if (!buildConfig || !buildConfig.buildSettings) continue;

        const settings = buildConfig.buildSettings;
        settings.CODE_SIGN_STYLE = '"Automatic"';
        settings.CODE_SIGNING_ALLOWED = '"YES"';
        if (settings.PROVISIONING_PROFILE !== undefined) delete settings.PROVISIONING_PROFILE;
        if (settings.PROVISIONING_PROFILE_SPECIFIER !== undefined) delete settings.PROVISIONING_PROFILE_SPECIFIER;
        if (settings.CODE_SIGN_IDENTITY !== undefined) delete settings.CODE_SIGN_IDENTITY;
        if (!settings.DEVELOPMENT_TEAM) settings.DEVELOPMENT_TEAM = '"Q33K3Q7Q53"';
        touched++;
      }
    }

    if (touched > 0) {
      console.log('[ios-hms-screenshare] ✅ Forced CODE_SIGN_STYLE = Automatic for all', touched, 'build configuration(s) across all native targets');
    }

    return config;
  });
}

/** Main app target in Xcode/Podfile; must match exactly (plugin accepts both 'GrabDocs' and "GrabDocs" in Podfile). */
const MAIN_APP_TARGET_NAME = 'GrabDocs';

/**
 * Ensure legacy architecture is set so codegen and RNReanimated v2 resolve consistently.
 */
function podfileEnsureNewArchDisabled(contents) {
  if (contents.includes("RCT_NEW_ARCH_ENABLED")) return contents;
  const lineEnding = contents.includes('\r\n') ? '\r\n' : '\n';
  const line = "ENV['RCT_NEW_ARCH_ENABLED'] ||= '0'" + lineEnding;
  return line + contents;
}

/**
 * Remove conditional use_frameworks! from the main target.
 * 100ms + broadcast extension + use_frameworks! = fragile host resolution; we never want it enabled.
 */
function podfileStripConditionalUseFrameworks(contents) {
  const lineEnding = contents.includes('\r\n') ? '\r\n' : '\n';
  const lines = contents.split(/\r?\n/);
  const out = lines.filter((line) => {
    const t = line.trim();
    return !(
      t.startsWith("use_frameworks!") &&
      (t.includes("podfile_properties['ios.useFrameworks']") || t.includes("ENV['USE_FRAMEWORKS']"))
    );
  });
  return out.join(lineEnding);
}

const HMS_POD_NAME = 'HMSBroadcastExtensionSDK';

/**
 * Remove any nested "target 'GrabDocsBroadcastUpload' do ... end" block from the Podfile.
 * Used when switching to "main target only": extension is managed by Xcode, not CocoaPods.
 */
function podfileRemoveExtensionBlock(contents, extensionName) {
  const lineEnding = contents.includes('\r\n') ? '\r\n' : '\n';
  const lines = contents.split(/\r?\n/);
  const extRe = new RegExp("^\\s*target\\s+['\"]" + extensionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "['\"]\\s+do\\s*$");
  let start = -1;
  let indent = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(extRe);
    if (m) {
      start = i;
      indent = (lines[i].match(/^(\s*)/) || ['', ''])[1].length;
      break;
    }
  }
  if (start === -1) return contents;
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    const em = lines[i].match(/^(\s*)end(\s*(#.*)?)$/);
    if (em && em[1].length <= indent) {
      end = i;
      break;
    }
  }
  if (end === -1) return contents;
  const before = lines.slice(0, start).join(lineEnding);
  const after = lines.slice(end + 1).join(lineEnding);
  return before + (before.endsWith(lineEnding) ? '' : lineEnding) + after;
}

/**
 * Force HMSWebRTC to 1.0.6174 at the very start of the main target so HMSSDK (from
 * react-native-hms) and HMSBroadcastExtensionSDK both use it; 1.0.6173 download often returns 502.
 */
function podfileInjectHMSWebRTCPin(contents) {
  const marker = "# @generated ios-hms-screenshare HMSWebRTC pin";
  if (contents.includes(marker)) return contents;
  const lineEnding = contents.includes('\r\n') ? '\r\n' : '\n';
  const lines = contents.split(/\r?\n/);
  const targetDoRe = new RegExp("^\\s*target\\s+['\"]" + MAIN_APP_TARGET_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "['\"]\\s+do\\s*$");
  let mainLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (targetDoRe.test(lines[i])) {
      mainLine = i;
      break;
    }
  }
  if (mainLine === -1) return contents;
  const indent = (lines[mainLine].match(/^(\s*)/) || ['', ''])[1];
  const pinBlock = lineEnding + indent + '  ' + marker + lineEnding + indent + "  pod 'HMSWebRTC', '1.0.6174'" + lineEnding;
  const before = lines.slice(0, mainLine + 1).join(lineEnding);
  const after = lines.slice(mainLine + 1).join(lineEnding);
  return before + pinBlock + after;
}

/**
 * Add pod 'HMSBroadcastExtensionSDK' to the main app target only (before use_react_native!).
 * CocoaPods manages only GrabDocs; the extension links the framework built for the main app.
 */
function podfileAddHmsPodToMainTarget(contents) {
  if (contents.includes("pod '" + HMS_POD_NAME + "'")) return contents;
  const lineEnding = contents.includes('\r\n') ? '\r\n' : '\n';
  const lines = contents.split(/\r?\n/);
  const targetDoRe = new RegExp("^\\s*target\\s+['\"]" + MAIN_APP_TARGET_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "['\"]\\s+do\\s*$");
  let mainLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (targetDoRe.test(lines[i])) {
      mainLine = i;
      break;
    }
  }
  if (mainLine === -1) return contents;
  const useRnRe = /use_react_native!\s*\(/;
  let insertAt = -1;
  for (let i = mainLine + 1; i < lines.length; i++) {
    if (useRnRe.test(lines[i])) {
      insertAt = i;
      break;
    }
  }
  if (insertAt === -1) return contents;
  const indent = (lines[insertAt].match(/^(\s*)/) || ['', '  '])[1];
  const podLine = indent + "  pod '" + HMS_POD_NAME + "'  # for broadcast extension (linked by Xcode)";
  const before = lines.slice(0, insertAt).join(lineEnding);
  const after = lines.slice(insertAt).join(lineEnding);
  return before + lineEnding + podLine + lineEnding + after;
}

/**
 * Nest the extension as a CocoaPods target INSIDE the main app target so CocoaPods
 * can find the host (fixes "Unable to find host target(s) for GrabDocsBroadcastUpload").
 *
 * Strategy: find the main target's closing `end` by matching its indentation level,
 * then insert the extension block just before that `end`. This is robust regardless
 * of the internal structure of the main target block.
 */
function podfileEnsureExtensionBlock(contents, extensionName) {
  const marker = '# @generated ios-hms-screenshare extension-target';
  const lineEnding = contents.includes('\r\n') ? '\r\n' : '\n';

  let result = podfileRemoveExtensionBlock(contents, extensionName);
  result = result.split(/\r?\n/).filter(l => l.trim() !== marker.trim()).join(
    contents.includes('\r\n') ? '\r\n' : '\n'
  );

  const hasTargetBlock = new RegExp(`(^|\\n)target\\s+['"]${extensionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\s+do`).test(result);
  if (result.includes(marker) && hasTargetBlock) return result;

  const lines = result.split(/\r?\n/);
  const targetDoRe = new RegExp(
    '^(\\s*)target\\s+[\'"]' +
    MAIN_APP_TARGET_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
    '[\'"]\\s+do\\s*$'
  );

  let mainLine = -1;
  let mainIndent = '';
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(targetDoRe);
    if (m) { mainLine = i; mainIndent = m[1]; break; }
  }
  if (mainLine === -1) {
    console.warn('[ios-hms-screenshare] podfileEnsureExtensionBlock: could not find target ' + MAIN_APP_TARGET_NAME + ' in Podfile');
    return contents;
  }

  // Find the closing `end` for the main target by looking for an `end` at the same
  // indentation as the `target '...' do` line (items inside are at deeper indentation).
  const mainIndentLen = mainIndent.length;
  let endLine = -1;
  for (let i = mainLine + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)end\s*$/);
    if (m && m[1].length === mainIndentLen) {
      endLine = i;
      break;
    }
  }
  if (endLine === -1) {
    console.warn('[ios-hms-screenshare] podfileEnsureExtensionBlock: could not find closing end for target ' + MAIN_APP_TARGET_NAME);
    return contents;
  }

  const innerIndent = mainIndent + '  ';
  const extIndent = mainIndent + '    ';
  const block = [
    '',
    innerIndent + marker,
    innerIndent + `target '${extensionName}' do`,
    extIndent + `platform :ios, '16.0'`,
    extIndent + `inherit! :search_paths`,
    extIndent + `pod '${HMS_POD_NAME}'`,
    innerIndent + `end`,
  ].join(lineEnding);

  // Insert the block just before the closing `end` of the main target.
  const before = lines.slice(0, endLine).join(lineEnding);
  const after = lines.slice(endLine).join(lineEnding);
  return before + block + lineEnding + after;
}

/**
 * Podfile: do NOT declare the extension as a CocoaPods target. CocoaPods manages only the main app.
 * Add HMSBroadcastExtensionSDK to the main target so it is built; the extension links it in Xcode.
 */
function withPodfileEntry(config, { extensionName }) {
  return withPodfile(config, (config) => {
    const data = config.modResults;
    const src  = typeof data === 'string' ? data : (data?.contents ?? '');

    if (src.length === 0) {
      console.warn('[ios-hms-screenshare] withPodfile: empty content — skipping');
      return config;
    }

    let working = podfileEnsureNewArchDisabled(src);
    working = podfileStripConditionalUseFrameworks(working);
    working = podfileInjectHMSWebRTCPin(working);
    // podfileEnsureExtensionBlock internally calls podfileRemoveExtensionBlock first,
    // then nests the extension as a proper CocoaPods target inside the main target.
    working = podfileEnsureExtensionBlock(working, extensionName);

    if (typeof data === 'string') {
      config.modResults = working;
    } else {
      config.modResults = { ...data, contents: working };
    }
    console.log('[ios-hms-screenshare] ✅ withPodfile: nested extension target pod ' + HMS_POD_NAME);
    return config;
  });
}

/**
 * Fix the extension embed phase for CocoaPods. CocoaPods requires the .appex to be in a
 * phase named "Embed App Extensions" with dstSubfolderSpec = 13. xcode addTarget() may create
 * a phase with wrong name ("Copy Files") or no name. We find ANY phase containing the .appex
 * and ensure it has the correct name and dstSubfolderSpec.
 */
function fixExtensionEmbedPhaseForCocoaPods(pbx, extensionName) {
  const escapedAppex = extensionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.appex';

  // Find ANY PBXCopyFilesBuildPhase that contains the .appex (require dstSubfolderSpec for reliable capture)
  const anyPhaseWithAppexRe = new RegExp(
    '\t\t([0-9A-F]{24})\\s*\\/\\*\\s*[^*]*\\*\\/\\s*=\\s*\\{\\s*\\n\\s*isa = PBXCopyFilesBuildPhase;[\\s\\S]*?files = \\([\\s\\S]*?' +
      escapedAppex +
      '[\\s\\S]*?\\);[\\s\\S]*?runOnlyForDeploymentPostprocessing = [^\\n]+\\n\\s*name = "([^"]*)";[\\s\\S]*?dstSubfolderSpec = ([0-9]+);',
    'g'
  );
  const phases = [];
  let m;
  while ((m = anyPhaseWithAppexRe.exec(pbx)) !== null) {
    phases.push({ uuid: m[1], name: m[2], dstSubfolderSpec: m[3] });
  }
  if (phases.length === 0) return pbx;

  // If we have both a correct "Embed App Extensions" phase and wrong ones (e.g. "Copy Files"),
  // remove the wrong phases. Otherwise fix the existing phase in place.
  const correctPhase = phases.find((p) => p.name === 'Embed App Extensions' && p.dstSubfolderSpec === '13');
  const wrongPhases = phases.filter((p) => p.name !== 'Embed App Extensions' || p.dstSubfolderSpec !== '13');

  if (correctPhase && wrongPhases.length > 0) {
    for (const p of wrongPhases) {
      const phaseUuid = p.uuid;
      const phaseRefPattern = new RegExp(
        '\\s*' + phaseUuid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\/\\*\\s*[^*]*\\*\\/,\\n?',
        'g'
      );
      const grabDocsBuildPhasesRe = new RegExp(
        '(\\/\\*\\s*GrabDocs\\s*\\*\\/\\s*=\\s*\\{[\\s\\S]*?buildPhases = \\()([\\s\\S]*?)(\\n\\s*\\);\\s*\\n\\s*buildRules)',
        'g'
      );
      pbx = pbx.replace(grabDocsBuildPhasesRe, (_, prefix, buildPhasesContent, suffix) => {
        const newBuildPhases = buildPhasesContent.replace(phaseRefPattern, '');
        return prefix + newBuildPhases + suffix;
      });
      const phaseBlockRe = new RegExp(
        '\t\t' + phaseUuid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\/\\*\\s*[^*]*\\*\\/\\s*=\\s*\\{[\\s\\S]*?\\};\\n?',
        'g'
      );
      pbx = pbx.replace(phaseBlockRe, '');
    }
  }

  // Fix wrong phase(s) in place (only when we don't have a correct one): ensure name and dstSubfolderSpec
  if (!correctPhase) {
    for (const p of wrongPhases) {
      const phaseUuid = p.uuid;
      const escapedUuid = phaseUuid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (p.dstSubfolderSpec) {
        pbx = pbx.replace(
          new RegExp(
            '(' + escapedUuid + '\\s*\\/\\*\\s*)[^*]*(\\*\\/\\s*=\\s*\\{[\\s\\S]*?name = ")[^"]*(";[\\s\\S]*?dstSubfolderSpec = )(\\d+)(;)',
            'g'
          ),
          (_, a, b, c, _num, d) => a + 'Embed App Extensions' + b + 'Embed App Extensions' + c + '13' + d
        );
      } else {
        pbx = pbx.replace(
          new RegExp(
            '(' + escapedUuid + '\\s*\\/\\*\\s*)[^*]*(\\*\\/\\s*=\\s*\\{[\\s\\S]*?name = ")[^"]*(";[\\s\\S]*?)(\\n\\s*\\};)',
            'g'
          ),
          '$1Embed App Extensions$2Embed App Extensions$3dstSubfolderSpec = 13;$4'
        );
      }
      pbx = pbx.replace(
        new RegExp(
          '(' + escapedUuid + '\\s*\\/\\*\\s*)[^*]*(\\s*\\*\\/)(?!\\s*=\\s*\\{)',
          'g'
        ),
        '$1Embed App Extensions$2'
      );
    }
  }

  return pbx;
}

/**
 * Ensure the extension .appex PBXFileReference is in the Products group so the xcodeproj
 * gem can assign a parent (fixes "no parent for object ... Copy Files, Embed App Extensions").
 */
function ensureAppexInProductsGroup(pbx, extensionName) {
  const appexName = extensionName + '.appex';
  const fileRefSection = pbx.match(/\/\* Begin PBXFileReference section \*\/[\s\S]*?\/\* End PBXFileReference section \*\//);
  if (!fileRefSection) return pbx;
  const appexRefMatch = fileRefSection[0].match(
    new RegExp('([0-9A-F]{24})\\s*\\/\\*[^*]*\\*\\/\\s*=\\s*\\{[\\s\\S]*?path\\s*=\\s*["\']' + extensionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.appex["\']')
  );
  const appexRefUuid = appexRefMatch ? appexRefMatch[1] : null;
  if (!appexRefUuid) return pbx;

  let groupSection = pbx.match(/\/\* Begin PBXGroup section \*\/[\s\S]*?\/\* End PBXGroup section \*\//);
  if (!groupSection) return pbx;
  const productsBlockRe = /(\t\t[0-9A-F]{24}\s*\/\*\s*Products\s*\/\*\s*=\s*\{\s*isa = PBXGroup;\s*children = \()([\s\S]*?)(\n\t\t\t\);)/;
  const productsMatch = groupSection[0].match(productsBlockRe);
  if (productsMatch && !productsMatch[2].includes(appexRefUuid)) {
    const insertLine = '\n\t\t\t\t' + appexRefUuid + ' /* ' + appexName + ' */,';
    const newBlock = productsMatch[1] + productsMatch[2] + insertLine + productsMatch[3];
    pbx = pbx.replace(productsMatch[0], newBlock);
  }

  groupSection = pbx.match(/\/\* Begin PBXGroup section \*\/[\s\S]*?\/\* End PBXGroup section \*\//);
  if (groupSection) {
    const copyFilesRe = /(\t\t[0-9A-F]{24}\s*\/\*\s*Copy Files\s*\/\*\s*=\s*\{\s*isa = PBXGroup;\s*children = \()([\s\S]*?)(\n\t\t\t\);)/;
    const copyMatch = groupSection[0].match(copyFilesRe);
    if (copyMatch && copyMatch[2].includes(appexRefUuid)) {
      const withoutAppex = copyMatch[2].replace(new RegExp('\\s*' + appexRefUuid + '\\s*\\/\\*[^*]*\\*\\/,\\n?', 'g'), '');
      const newCopyBlock = copyMatch[1] + withoutAppex + copyMatch[3];
      pbx = pbx.replace(copyMatch[0], newCopyBlock);
    }
  }
  return pbx;
}

const EXTENSION_BUNDLE_ID = 'com.grabdocs.mobile.GrabDocsBroadcastUpload';

/**
 * Force the extension target's build configurations to Automatic signing and remove
 * manual profile keys so Xcode finds the profile we install (run script). Applied
 * directly in pbxproj so it persists regardless of EAS/post_integrate order.
 */
function forceExtensionAutomaticSigningInPbx(pbx, extensionName) {
  const escapedBundleId = EXTENSION_BUNDLE_ID.replace(/\./g, '\\.');
  // Match each XCBuildConfiguration block that contains the extension's bundle ID.
  // We match from that line to the end of its buildSettings (next \n\t\t};).
  const blockRe = new RegExp(
    '(PRODUCT_BUNDLE_IDENTIFIER = "' + escapedBundleId + '";)([\\s\\S]*?)(\\n\\s*\\};)',
    'g'
  );
  return pbx.replace(blockRe, (_, bundleLine, restOfBuildSettings, closing) => {
    let rest = restOfBuildSettings
      .replace(/\s*CODE_SIGN_STYLE = "[^"]*";\s*\n?/g, '')
      .replace(/\s*CODE_SIGNING_ALLOWED = "[^"]*";\s*\n?/g, '')
      .replace(/\s*PROVISIONING_PROFILE = "[^"]*";\s*\n?/g, '')
      .replace(/\s*PROVISIONING_PROFILE_SPECIFIER = "[^"]*";\s*\n?/g, '')
      .replace(/\s*CODE_SIGN_IDENTITY = "[^"]*";\s*\n?/g, '');
    rest = rest.trimEnd() + '\n\t\t\t\tCODE_SIGN_STYLE = "Automatic";\n\t\t\t\tCODE_SIGNING_ALLOWED = "YES";\n\t\t';
    if (!rest.includes('DEVELOPMENT_TEAM')) {
      rest = rest.trimEnd() + '\n\t\t\t\tDEVELOPMENT_TEAM = "Q33K3Q7Q53";\n\t\t\t';
    }
    return bundleLine + rest + closing;
  });
}

/**
 * Force a target's build configurations to Automatic signing and remove manual
 * profile keys. Used for both main app and extension (single-profile strategy).
 */
function forceAutomaticSigningInPbxForBundleId(pbx, bundleId, defaultTeamId) {
  const escaped = bundleId.replace(/\./g, '\\.');
  const blockRe = new RegExp(
    '(PRODUCT_BUNDLE_IDENTIFIER = "' + escaped + '";)([\\s\\S]*?)(\\n\\s*\\};)',
    'g'
  );
  return pbx.replace(blockRe, (_, bundleLine, restOfBuildSettings, closing) => {
    let rest = restOfBuildSettings
      .replace(/\s*CODE_SIGN_STYLE = "[^"]*";\s*\n?/g, '')
      .replace(/\s*CODE_SIGNING_ALLOWED = "[^"]*";\s*\n?/g, '')
      .replace(/\s*PROVISIONING_PROFILE = "[^"]*";\s*\n?/g, '')
      .replace(/\s*PROVISIONING_PROFILE_SPECIFIER = "[^"]*";\s*\n?/g, '')
      .replace(/\s*CODE_SIGN_IDENTITY = "[^"]*";\s*\n?/g, '');
    rest = rest.trimEnd() + '\n\t\t\t\tCODE_SIGN_STYLE = "Automatic";\n\t\t\t\tCODE_SIGNING_ALLOWED = "YES";\n\t\t';
    if (defaultTeamId && !rest.includes('DEVELOPMENT_TEAM')) {
      rest = rest.trimEnd() + '\n\t\t\t\tDEVELOPMENT_TEAM = "' + defaultTeamId + '";\n\t\t\t';
    }
    return bundleLine + rest + closing;
  });
}

/** Force main app target to Automatic signing (single-profile strategy). */
function forceMainAppAutomaticSigningInPbx(pbx) {
  return forceAutomaticSigningInPbxForBundleId(pbx, 'com.grabdocs.mobile', 'Q33K3Q7Q53');
}

/**
 * Patch project.pbxproj to add the extension as a Target Dependency of the main app.
 * CocoaPods 1.2.1+ requires this (not just Embed App Extensions); otherwise
 * "Unable to find host target(s) for GrabDocsBroadcastUpload". The xcode-js
 * addTargetDependency is not always available or applied, so we patch the file directly.
 */
function withPbxprojExtensionTargetDependency(config, { extensionName }) {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const iosRoot = config.modRequest.platformProjectRoot;
      const xcodeprojDir = fs.readdirSync(iosRoot).find((f) => f.endsWith('.xcodeproj'));
      if (!xcodeprojDir) return config;

      const pbxPath = path.join(iosRoot, xcodeprojDir, 'project.pbxproj');
      if (!fs.existsSync(pbxPath)) return config;

      let pbx = fs.readFileSync(pbxPath, 'utf8');

      // Resolve project UUID (PBXProject)
      const projectMatch = pbx.match(/([0-9A-F]{24})\s*\/\*\s*Project object\s*\*\/\s*=\s*\{\s*isa = PBXProject;/);
      const projectUuid = projectMatch ? projectMatch[1] : null;
      if (!projectUuid) {
        console.warn('[ios-hms-screenshare] ⚠️  Could not find Project object UUID in project.pbxproj');
        return config;
      }

      // Resolve main app target UUID (first PBXNativeTarget with product-type.application)
      const nativeTargetSection = pbx.match(/\/\* Begin PBXNativeTarget section \*\/[\s\S]*?\/\* End PBXNativeTarget section \*\//);
      if (!nativeTargetSection) return config;
      const appTargetMatch = nativeTargetSection[0].match(
        /([0-9A-F]{24})\s*\/\*\s*GrabDocs\s*\*\/\s*=\s*\{[\s\S]*?productType = "com\.apple\.product-type\.application"/
      );
      const mainTargetUuid = appTargetMatch ? appTargetMatch[1] : null;
      if (!mainTargetUuid) {
        console.warn('[ios-hms-screenshare] ⚠️  Could not find main app target (GrabDocs) UUID');
        return config;
      }

      // Resolve extension target UUID (PBXNativeTarget with GrabDocsBroadcastUpload)
      const extTargetMatch = nativeTargetSection[0].match(
        new RegExp('([0-9A-F]{24})\\s*\\/\\*\\s*"' + extensionName + '"\\s*\\*\\/\\s*=\\s*\\{[\\s\\S]*?productType = "com\\.apple\\.product-type\\.app-extension"')
      );
      const extensionTargetUuid = extTargetMatch ? extTargetMatch[1] : null;
      if (!extensionTargetUuid) {
        console.warn('[ios-hms-screenshare] ⚠️  Could not find extension target UUID in project.pbxproj');
        return config;
      }

      // Fix undefined written by xcode addTargetDependency — EAS fails with "Could not find target with id 'undefined'"
      // when PBXContainerItemProxy has remoteGlobalIDString = undefined or PBXTargetDependency has target = undefined.
      if (pbx.includes('remoteGlobalIDString = undefined')) {
        pbx = pbx.replace(/remoteGlobalIDString = undefined/g, `remoteGlobalIDString = ${extensionTargetUuid}`);
        console.log('[ios-hms-screenshare] ✅ Fixed remoteGlobalIDString = undefined in PBXContainerItemProxy');
      }
      if (pbx.includes('target = undefined') || pbx.includes('target = ""')) {
        // Replace with the real extension UUID — removing the line leaves target as JS undefined,
        // which EAS @expo/config-plugins reads as undefined and throws "Could not find target with id 'undefined'".
        pbx = pbx.replace(/\btarget = (?:undefined|"");/g, `target = ${extensionTargetUuid};`);
        console.log('[ios-hms-screenshare] ✅ Fixed target = undefined → real UUID in PBXTargetDependency');
      }

      // Check if extension is already in main target's dependencies (CocoaPods needs this for host detection)
      const mainTargetBlockRe = new RegExp(
        mainTargetUuid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?dependencies = \\(([\\s\\S]*?)\\)\\s*;',
        'g'
      );
      const mainTargetBlockMatch = mainTargetBlockRe.exec(pbx);
      const depsContent = mainTargetBlockMatch ? mainTargetBlockMatch[1] : '';
      const depSection = pbx.match(/\/\* Begin PBXTargetDependency section \*\/[\s\S]*?\/\* End PBXTargetDependency section \*\//);
      let hasExtensionDep = depsContent.includes(extensionName) || depsContent.includes(extensionTargetUuid);
      if (!hasExtensionDep && depSection) {
        const depRe = new RegExp(
          '([0-9A-F]{24})\\s*\\/\\*[^*]*\\*\\/\\s*=\\s*\\{[^}]*\\btarget = ' +
            extensionTargetUuid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
            '\\b',
          'g'
        );
        let depMatch;
        while ((depMatch = depRe.exec(depSection[0])) !== null) {
          if (depsContent.includes(depMatch[1])) {
            hasExtensionDep = true;
            break;
          }
        }
      }
      if (hasExtensionDep) {
        console.log('[ios-hms-screenshare] ✅ project.pbxproj: main target already has extension dependency');
        // Still run fixExtensionEmbedPhaseForCocoaPods and ensureAppexInProductsGroup below
      } else {
        // Add PBXContainerItemProxy and PBXTargetDependency for the extension
        const containerProxyUuid = 'A1B2C3D4E5F60718293A4B5C';
        const targetDependencyUuid = 'D4E5F60718293A4B5C6D7E8F';

        const containerProxyEntry = `\t\t${containerProxyUuid} /* PBXContainerItemProxy */ = {
\t\t\tisa = PBXContainerItemProxy;
\t\t\tcontainerPortal = ${projectUuid} /* Project object */;
\t\t\tproxyType = 1;
\t\t\tremoteGlobalIDString = ${extensionTargetUuid};
\t\t\tremoteInfo = "${extensionName}";
\t\t};
`;
        const targetDependencyEntry = `\t\t${targetDependencyUuid} /* PBXTargetDependency */ = {
\t\t\tisa = PBXTargetDependency;
\t\t\ttarget = ${extensionTargetUuid};
\t\t\ttargetProxy = ${containerProxyUuid} /* PBXContainerItemProxy */;
\t\t};
`;

        if (!pbx.includes('PBXContainerItemProxy')) {
          pbx = pbx.replace(
            /(\/\* End PBXProject section \*\/)/,
            `$1\n\n/* Begin PBXContainerItemProxy section */\n${containerProxyEntry}/* End PBXContainerItemProxy section */\n\n/* Begin PBXTargetDependency section */\n${targetDependencyEntry}/* End PBXTargetDependency section */`
          );
        } else {
          pbx = pbx.replace(/(\/\* End PBXContainerItemProxy section \*\/)/, containerProxyEntry + '$1');
          if (!pbx.includes('PBXTargetDependency')) {
            pbx = pbx.replace(
              /(\/\* End PBXContainerItemProxy section \*\/)/,
              `$1\n\n/* Begin PBXTargetDependency section */\n${targetDependencyEntry}/* End PBXTargetDependency section */`
            );
          } else {
            pbx = pbx.replace(/(\/\* End PBXTargetDependency section \*\/)/, targetDependencyEntry + '$1');
          }
        }

        // Add extension to main target's dependencies (empty or non-empty list)
        const mainTargetDepsPattern = new RegExp(
          '(' + mainTargetUuid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\/\\*\\s*GrabDocs\\s*\\*\\/\\s*=\\s*\\{[\\s\\S]*?)dependencies = \\(([\\s\\S]*?)\\)\\s*;'
        );
        pbx = pbx.replace(mainTargetDepsPattern, (_, prefix, existingDeps) => {
          const depLine = targetDependencyUuid + ' /* ' + extensionName + ' */';
          const items = existingDeps
            .split('\n')
            .map((line) => line.replace(/,\s*$/, '').trim())
            .filter((line) => line.length > 0);
          if (!items.includes(depLine)) items.push(depLine);
          const newDeps = '\n\t\t\t\t' + items.join(',\n\t\t\t\t') + ',\n\t\t\t';
          return prefix + 'dependencies = (' + newDeps + ');';
        });
      }

      if (pbx.includes(',,')) {
        pbx = pbx.replace(/,\s*,/g, ',');
      }

      // Nanaimo (CocoaPods pbxproj parser) treats $(...) inside double-quoted values as a dict and fails.
      // Force single-quoted form for extension's FRAMEWORK_SEARCH_PATHS and OTHER_LDFLAGS.
      const singleQuotedFrameworks = "'$(inherited) $(PODS_CONFIGURATION_BUILD_DIR)/" + HMS_POD_NAME + "'";
      const singleQuotedLdflags = "'$(inherited) -framework " + HMS_POD_NAME + "'";
      pbx = pbx.replace(
        /FRAMEWORK_SEARCH_PATHS = [^\n]*PODS_CONFIGURATION_BUILD_DIR[^\n]*;/g,
        "FRAMEWORK_SEARCH_PATHS = " + singleQuotedFrameworks + ";"
      );
      pbx = pbx.replace(
        new RegExp("OTHER_LDFLAGS = [^\\n]*-framework " + HMS_POD_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "[^\\n]*;", "g"),
        "OTHER_LDFLAGS = " + singleQuotedLdflags + ";"
      );

      // CocoaPods requires the .appex in a phase named "Embed App Extensions". Fix wrong
      // phase name (Copy Files → Embed App Extensions) or remove duplicate.
      pbx = fixExtensionEmbedPhaseForCocoaPods(pbx, extensionName);

      // xcodeproj gem "no parent for object .appex: Copy Files, Embed App Extensions": the .appex
      // file ref must be in a group that's in the project hierarchy. Ensure it's in Products.
      pbx = ensureAppexInProductsGroup(pbx, extensionName);

      // Single-profile strategy: force Automatic signing for both targets so Xcode
      // manages provisioning; no manual profile mapping (avoids CI credential breakage).
      pbx = forceMainAppAutomaticSigningInPbx(pbx);
      pbx = forceExtensionAutomaticSigningInPbx(pbx, extensionName);

      fs.writeFileSync(pbxPath, pbx);
      console.log('[ios-hms-screenshare] ✅ project.pbxproj: added extension as dependency of main target');
      return config;
    },
  ]);
}

/**
 * Add a Run Script build phase to the extension target that installs the
 * EXT_PROVISIONING_PROFILE (EAS file-type env var) into the provisioning profiles
 * directory. This runs DURING xcodebuild, when EAS has already set env vars and
 * credentials — so the profile is available when the extension target is signed.
 */
function withExtensionProfileInstallPhase(config, { extensionName }) {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const iosRoot = config.modRequest.platformProjectRoot;
      const xcodeprojDir = fs.readdirSync(iosRoot).find((f) => f.endsWith('.xcodeproj'));
      if (!xcodeprojDir) return config;

      const pbxPath = path.join(iosRoot, xcodeprojDir, 'project.pbxproj');
      if (!fs.existsSync(pbxPath)) return config;

      let pbx = fs.readFileSync(pbxPath, 'utf8');

      // Fix SampleHandler.swift file type: Xcode/Expo may create PBXFileReference with wrong type
      // (wrapper.app-extension). Swift sources must be sourcecode.swift or build fails with
      // "no rule to process file ... of type 'wrapper.app-extension'".
      if (pbx.includes('SampleHandler.swift')) {
        const lines = pbx.split(/\r?\n/);
        let inSwiftBlock = false;
        for (let i = 0; i < lines.length; i++) {
          if (/path\s*=\s*["'][^"']*SampleHandler\.swift["']/.test(lines[i])) inSwiftBlock = true;
          if (inSwiftBlock) {
            if (lines[i].includes('lastKnownFileType = "wrapper.app-extension"')) {
              lines[i] = lines[i].replace('lastKnownFileType = "wrapper.app-extension"', 'lastKnownFileType = "sourcecode.swift"');
            }
            if (lines[i].includes('explicitFileType = "wrapper.app-extension"')) {
              lines[i] = lines[i].replace('explicitFileType = "wrapper.app-extension"', 'explicitFileType = "sourcecode.swift"');
            }
            if (/^\s*\}\s*;\s*$/.test(lines[i])) inSwiftBlock = false;
          }
        }
        pbx = lines.join('\n');
      }

      const scriptBody = 'set +e\\\\nif [ -n \\"\\\\$EXT_PROVISIONING_PROFILE\\" ] && [ -f \\"\\\\$EXT_PROVISIONING_PROFILE\\" ]; then\\\\nmkdir -p \\"\\\\$HOME/Library/MobileDevice/Provisioning Profiles\\"\\\\ncp \\"\\\\$EXT_PROVISIONING_PROFILE\\" \\"\\\\$HOME/Library/MobileDevice/Provisioning Profiles/' + extensionName + '.mobileprovision\\"\\\\nelif [ -f /tmp/ext.mobileprovision ]; then\\\\nmkdir -p \\"\\\\$HOME/Library/MobileDevice/Provisioning Profiles\\"\\\\ncp /tmp/ext.mobileprovision \\"\\\\$HOME/Library/MobileDevice/Provisioning Profiles/' + extensionName + '.mobileprovision\\"\\\\nfi\\\\nexit 0\\\\n';
      const phaseId = 'A1B2C3D4E5F60718293A4B5C6D7E8F90';
      const mainPhaseId = 'B2C3D4E5F60718293A4B5C6D7E8F90A1';

      if (!pbx.includes('Install Extension Profile')) {
      const phaseBlock = `
		${phaseId} /* Install Extension Profile */ = {
			isa = PBXShellScriptBuildPhase;
			buildActionMask = 2147483647;
			files = (
			);
			inputPaths = (
			);
			name = "Install Extension Profile";
			outputPaths = (
			);
			runOnlyForDeploymentPostprocessing = 0;
			shellPath = /bin/sh;
			shellScript = "${scriptBody}";
		};
		${mainPhaseId} /* Install Extension Profile (Main) */ = {
			isa = PBXShellScriptBuildPhase;
			buildActionMask = 2147483647;
			files = (
			);
			inputPaths = (
			);
			name = "Install Extension Profile (Main)";
			outputPaths = (
			);
			runOnlyForDeploymentPostprocessing = 0;
			shellPath = /bin/sh;
			shellScript = "${scriptBody}";
		};
`;

      pbx = pbx.replace(
        /(\/\* Begin PBXShellScriptBuildPhase section \*\/)/,
        `$1${phaseBlock}`
      );

      // Add main app phase first so profile is installed before any target builds (EAS may build main before extension).
      const mainAppPattern = /(\/\*\s*GrabDocs\s*\*\/\s*=\s*\{[\s\S]*?buildPhases = \(\s*\n\s*)([A-F0-9]+\s*\/\*[^*]*\*\/,)/m;
      const mainAppMatch = pbx.match(mainAppPattern);
      if (mainAppMatch) {
        pbx = pbx.replace(mainAppMatch[0], mainAppMatch[1] + mainPhaseId + ' /* Install Extension Profile (Main) */,\n\t\t\t\t' + mainAppMatch[2]);
      }

      // Add our phase as the first build phase of the extension target.
      // Match the extension target by name (comment may be "Name" or Name) and prepend our phase.
      const extTargetName = extensionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const extPattern = new RegExp(
        '(\\/\\* ["]?' + extTargetName + '["]? \\*\\/\\s*=\\s*\\{[\\s\\S]*?buildPhases = \\(\\s*\\n\\s*)' +
        '([A-F0-9]+\\s*\\/\\*[^*]*\\*\\/,)',
        'm'
      );
      const extMatch = pbx.match(extPattern);
      if (extMatch) {
        pbx = pbx.replace(extMatch[0], extMatch[1] + phaseId + ' /* Install Extension Profile */,\n\t\t\t\t' + extMatch[2]);
      }
      console.log('[ios-hms-screenshare] ✅ Added Install Extension Profile run script phase');
      }

      fs.writeFileSync(pbxPath, pbx);
      return config;
    },
  ]);
}

/**
 * Safety-net: after all config-plugin Podfile mods are written to disk, read it back
 * and verify the extension is properly nested. If not (e.g. another plugin overwrote it or
 * the withPodfile modResults had empty content), patch the disk file directly.
 * withDangerousMod for ios runs AFTER withPodfile in Expo's mod pipeline, so this always
 * sees the final on-disk Podfile.
 */
/**
 * Safety net: re-apply main-target-only Podfile rules on disk (no extension target).
 */
function withPodfilePatchOnDisk(config, { extensionName }) {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const iosRoot = config.modRequest.platformProjectRoot;
      const podfilePath = path.join(iosRoot, 'Podfile');
      if (!fs.existsSync(podfilePath)) {
        console.warn('[ios-hms-screenshare] Podfile not found at', podfilePath, '— skipping disk patch');
        return config;
      }
      let contents = fs.readFileSync(podfilePath, 'utf8');
      contents = podfileStripConditionalUseFrameworks(contents);
      contents = podfileEnsureNewArchDisabled(contents);
      contents = podfileInjectHMSWebRTCPin(contents);
      contents = podfileEnsureExtensionBlock(contents, extensionName);
      fs.writeFileSync(podfilePath, contents);
      console.log('[ios-hms-screenshare] ✅ Podfile on disk: nested extension target ' + extensionName + ' + ' + HMS_POD_NAME);
      return config;
    },
  ]);
}

function withAppGroupEntitlements(config, { appGroup }) {
  return withEntitlementsPlist(config, (config) => {
    const ents = config.modResults;
    if (!ents['com.apple.security.application-groups']) {
      ents['com.apple.security.application-groups'] = [appGroup];
    } else if (!ents['com.apple.security.application-groups'].includes(appGroup)) {
      ents['com.apple.security.application-groups'].push(appGroup);
    }
    return config;
  });
}

function withHmsScreenshareExtension(config, options = {}) {
  const appGroup = options.appGroup || process.env.EXPO_PUBLIC_HMS_IOS_APP_GROUP?.trim() || DEFAULT_APP_GROUP;
  const extensionName = options.extensionName || process.env.EXPO_PUBLIC_HMS_IOS_PREFERRED_EXTENSION?.trim() || DEFAULT_EXTENSION_NAME;
  console.log('[ios-hms-screenshare] Plugin invoked: extensionName=' + extensionName + ' appGroup=' + appGroup);

  const podfileOpts = { extensionName };
  config = withBroadcastExtensionFiles(config, { appGroup, extensionName });
  config = withBroadcastExtensionTarget(config, { appGroup, extensionName });
  config = withForceAllTargetsAutomaticSigning(config);
  config = withPbxprojExtensionTargetDependency(config, podfileOpts);
  // No Install Extension Profile phase: single-profile strategy uses Xcode Automatic Signing.
  config = withPodfileEntry(config, podfileOpts);
  // Disk-level safety net: runs after withPodfile in Expo's pipeline; re-checks and re-patches if needed.
  config = withPodfilePatchOnDisk(config, podfileOpts);
  config = withAppGroupEntitlements(config, { appGroup });

  // expo.ios.appExtensions in app.json declares the extension to EAS so that
  // `eas credentials` shows it and manages a provisioning profile for it.
  // The plugin handles source files, Info.plist, entitlements, and Podfile — it
  // skips target creation when appExtensions has already created the target, but
  // always overwrites the build settings so HMS-specific values win.

  return config;
}

module.exports = withHmsScreenshareExtension;
