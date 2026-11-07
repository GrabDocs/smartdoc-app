#!/usr/bin/env node
/**
 * Standalone script: ensures CocoaPods can find the host target for GrabDocsBroadcastUpload.
 * CocoaPods reads the Xcode project and requires:
 * 1. Main target (GrabDocs) has the extension in Target Dependencies
 * 2. Main target has "Embed App Extensions" phase with the .appex
 *
 * Run after `expo prebuild`, before `pod install`.
 *
 * Usage: node scripts/ensure-pbxproj-embed-phase.js
 */

const fs = require('fs');
const path = require('path');

const EXTENSION_NAME = 'GrabDocsBroadcastUpload';
const MAIN_TARGET_NAME = 'GrabDocs';

/**
 * Fix literal "undefined" in pbxproj that can confuse EAS/Expo's JavaScript parser.
 * EAS "Configure Xcode project" fails with "Could not find target with id 'undefined'"
 * when the parser sees unquoted "undefined" and returns JS undefined for target lookup.
 * File types must be set by path: .swift -> sourcecode.swift, .appex product -> wrapper.app-extension
 * (Xcode errors on "no rule to process file ... of type 'wrapper.app-extension'" for .swift sources).
 */
function fixUndefinedInPbxproj(pbx) {
  let changed = false;
  // Replace fileEncoding = undefined with fileEncoding = 4 (UTF-8)
  if (pbx.includes('fileEncoding = undefined')) {
    pbx = pbx.replace(/fileEncoding = undefined/g, 'fileEncoding = 4');
    changed = true;
  }
  // Context-aware file type: only set wrapper.app-extension for .appex product; use sourcecode.swift for .swift
  // Use flexible whitespace so we match EAS/pod-generated project format (tabs or spaces)
  const fileRefBlockRe = /(\t+[0-9A-F]{24}\s*\/\*[^*]*\*\/\s*=\s*\{)([\s\S]*?)(\n\s*\};)/g;
  pbx = pbx.replace(fileRefBlockRe, (_, open, block, close) => {
    const pathMatch = block.match(/path\s*=\s*["']([^"']+)["']/);
    const path = pathMatch ? pathMatch[1] : '';
    let newBlock = block;
    if (path.endsWith('.swift')) {
      if (block.includes('lastKnownFileType = undefined')) {
        newBlock = newBlock.replace(/lastKnownFileType = undefined/g, 'lastKnownFileType = "sourcecode.swift"');
        changed = true;
      }
      if (block.includes('explicitFileType = undefined')) {
        newBlock = newBlock.replace(/explicitFileType = undefined/g, 'explicitFileType = "sourcecode.swift"');
        changed = true;
      }
      if (block.includes('explicitFileType = ""')) {
        newBlock = newBlock.replace(/explicitFileType = ""/g, 'explicitFileType = "sourcecode.swift"');
        changed = true;
      }
    } else if (path.endsWith('.appex')) {
      if (block.includes('lastKnownFileType = undefined')) {
        newBlock = newBlock.replace(/lastKnownFileType = undefined/g, 'lastKnownFileType = "wrapper.app-extension"');
        changed = true;
      }
      if (block.includes('explicitFileType = undefined') || block.includes('explicitFileType = ""')) {
        newBlock = newBlock.replace(/explicitFileType = undefined/g, 'explicitFileType = "wrapper.app-extension"');
        newBlock = newBlock.replace(/explicitFileType = ""/g, 'explicitFileType = "wrapper.app-extension"');
        changed = true;
      }
    } else {
      // Other files: lastKnownFileType undefined -> text; explicitFileType -> non-empty if present
      if (block.includes('lastKnownFileType = undefined')) {
        newBlock = newBlock.replace(/lastKnownFileType = undefined/g, 'lastKnownFileType = "text"');
        changed = true;
      }
      if (block.includes('explicitFileType = undefined') || block.includes('explicitFileType = ""')) {
        newBlock = newBlock.replace(/explicitFileType = undefined/g, 'explicitFileType = "wrapper.app-extension"');
        newBlock = newBlock.replace(/explicitFileType = ""/g, 'explicitFileType = "wrapper.app-extension"');
        changed = true;
      }
    }
    return open + newBlock + close;
  });
  // Fallback: fix .swift file refs that still have wrapper.app-extension (e.g. block regex didn't match or pod install overwrote)
  const blockScope = '[\\s\\S]{0,400}?';
  if (pbx.includes('lastKnownFileType = "wrapper.app-extension"')) {
    const before = pbx;
    pbx = pbx.replace(/(path\s*=\s*["'][^"']*\.swift["'];[\s\S]*?)(lastKnownFileType = "wrapper\.app-extension")/g, '$1lastKnownFileType = "sourcecode.swift"');
    pbx = pbx.replace(new RegExp('(lastKnownFileType = "wrapper\\.app-extension")(' + blockScope + 'path\\s*=\\s*["\'][^"\']*\\.swift["\'])', 'g'), 'lastKnownFileType = "sourcecode.swift"$2');
    if (pbx !== before) changed = true;
  }
  if (pbx.includes('explicitFileType = "wrapper.app-extension"')) {
    const before = pbx;
    pbx = pbx.replace(/(path\s*=\s*["'][^"']*\.swift["'];[\s\S]*?)(explicitFileType = "wrapper\.app-extension")/g, '$1explicitFileType = "sourcecode.swift"');
    pbx = pbx.replace(new RegExp('(explicitFileType = "wrapper\\.app-extension")(' + blockScope + 'path\\s*=\\s*["\'][^"\']*\\.swift["\'])', 'g'), 'explicitFileType = "sourcecode.swift"$2');
    if (pbx !== before) changed = true;
  }
  // Catch-all: replace any remaining = undefined (includeInIndex, etc.) to prevent EAS parser errors.
  // Skip remoteGlobalIDString — fixRemoteGlobalIDStringUndefined replaces it with the real extension target UUID.
  if (pbx.includes(' = undefined')) {
    pbx = pbx.replace(/(\w+) = undefined/g, (_, key) =>
      key === 'remoteGlobalIDString'
        ? 'remoteGlobalIDString = undefined'
        : key === 'fileEncoding'
          ? 'fileEncoding = 4'
          : key === 'explicitFileType'
            ? 'explicitFileType = "wrapper.app-extension"'
            : key === 'lastKnownFileType'
              ? 'lastKnownFileType = "text"'
              : `${key} = ""`
    );
    changed = true;
  }
  return { pbx, changed };
}

/**
 * EAS fails with "Could not find target with id 'undefined'" when PBXContainerItemProxy has
 * remoteGlobalIDString = undefined (literal). Replace with the actual extension target UUID.
 */
function fixRemoteGlobalIDStringUndefined(pbx, extensionName) {
  const nativeTargetSection = pbx.match(/\/\* Begin PBXNativeTarget section \*\/[\s\S]*?\/\* End PBXNativeTarget section \*\//);
  if (!nativeTargetSection) return { pbx, changed: false };

  const extTargetMatch = nativeTargetSection[0].match(
    new RegExp('([0-9A-F]{24})\\s*\\/\\*\\s*"' + extensionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"\\s*\\*\\/\\s*=\\s*\\{[\\s\\S]*?productType = "com\\.apple\\.product-type\\.app-extension"')
  );
  const extensionTargetUuid = extTargetMatch ? extTargetMatch[1] : null;
  if (!extensionTargetUuid || !pbx.includes('remoteGlobalIDString = undefined')) return { pbx, changed: false };
  pbx = pbx.replace(/remoteGlobalIDString = undefined/g, `remoteGlobalIDString = ${extensionTargetUuid}`);
  return { pbx, changed: true };
}

/**
 * EAS "Could not find target with id 'undefined'" can also come from PBXTargetDependency
 * having "target = undefined" or "target = \"\"". The Expo parser uses dep.target directly;
 * if it resolves to JS undefined (missing field or literal "undefined"), it throws.
 * Replace with the real extension target UUID so EAS can look it up successfully.
 */
function fixTargetDependencyTargetUndefined(pbx, extensionTargetUuid) {
  if (!pbx.includes('PBXTargetDependency')) return { pbx, changed: false };
  const before = pbx;
  if (extensionTargetUuid) {
    // Replace target = undefined/empty with the actual extension UUID.
    pbx = pbx.replace(/\btarget = (?:undefined|"");/g, `target = ${extensionTargetUuid};`);
  } else {
    // Fallback (no UUID available): remove the broken line so at least there's no literal "undefined".
    pbx = pbx.replace(/(\t\tisa = PBXTargetDependency;\s*\n)(\s*target = (?:undefined|"");\s*\n)(\s*targetProxy)/g, '$1$3');
    if (pbx === before) {
      pbx = pbx.replace(/\n\s*target = (?:undefined|"");\s*\n/g, '\n');
    }
  }
  if (pbx === before) return { pbx, changed: false };
  return { pbx, changed: true };
}

function fixExtensionEmbedPhaseForCocoaPods(pbx, extensionName) {
  const escapedAppex = extensionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.appex';

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
  if (phases.length === 0) return { pbx, changed: false };

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

  return { pbx, changed: true };
}

/**
 * Remove ExpoModulesProvider (and similar) from the extension target's Sources build phase.
 * The extension is a minimal ReplayKit target and must not link Expo modules (e.g. ExpoCamera),
 * otherwise "Undefined symbols: protocol witness table for ExpoCamera.CameraViewModule".
 * We identify the extension's Sources phase as the one that contains SampleHandler.swift.
 */
function removeExpoModulesProviderFromExtensionTarget(pbx, extensionName) {
  let changed = false;
  const sourcesPhaseRe = /(\t\t[0-9A-F]{24}\s*\/\*[^*]*\*\/\s*=\s*\{\s*\n\s*isa = PBXSourcesBuildPhase;[\s\S]*?files = \()([\s\S]*?)(\)\s*;)/g;
  pbx = pbx.replace(sourcesPhaseRe, (_, before, filesContent, after) => {
    if (!filesContent.includes('SampleHandler.swift')) return _;
    const hasExpoProvider = /ExpoModulesProvider|ModulesProvider/i.test(filesContent);
    if (!hasExpoProvider) return _;
    const lines = filesContent.split('\n').filter((line) => {
      const comment = line.match(/\/\*\s*([^*]+)\s*\*\//);
      const name = comment ? comment[1] : '';
      return !/ExpoModulesProvider|ModulesProvider/i.test(name);
    });
    changed = true;
    return before + lines.join('\n') + after;
  });
  return { pbx, changed };
}

/**
 * Line-by-line fix: any PBXFileReference block that contains SampleHandler.swift must have
 * lastKnownFileType = "sourcecode.swift" (not wrapper.app-extension). Robust after pod install.
 */
function forceSwiftFileTypeForSampleHandler(pbx) {
  const lines = pbx.split(/\r?\n/);
  let changed = false;
  let inSwiftBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/path\s*=\s*["'][^"']*SampleHandler\.swift["']/.test(line)) {
      inSwiftBlock = true;
    }
    if (inSwiftBlock) {
      if (line.includes('lastKnownFileType = "wrapper.app-extension"')) {
        lines[i] = line.replace('lastKnownFileType = "wrapper.app-extension"', 'lastKnownFileType = "sourcecode.swift"');
        changed = true;
      }
      if (line.includes('explicitFileType = "wrapper.app-extension"')) {
        lines[i] = line.replace('explicitFileType = "wrapper.app-extension"', 'explicitFileType = "sourcecode.swift"');
        changed = true;
      }
      if (/^\s*\}\s*;\s*$/.test(line)) {
        inSwiftBlock = false;
      }
    }
  }
  return { pbx: lines.join('\n'), changed };
}

/**
 * The xcode npm lib has no mapping for .storyboard, so expo-share-intent's MainInterface.storyboard
 * gets lastKnownFileType = unknown. Xcode then copies it raw instead of compiling MainInterface.storyboardc,
 * and App Store Connect rejects the share extension (ITMS-90357, NSExtensionMainStoryboard).
 */
function fixStoryboardFileTypes(pbx) {
  const next = pbx.replace(/isa = PBXFileReference;[^}]*?\.storyboard"?;[^}]*\}/g, (entry) =>
    entry
      .replace(/explicitFileType = [^;]+;\s*/g, '')
      .replace(/lastKnownFileType = [^;]+;/g, 'lastKnownFileType = file.storyboard;')
  );
  return { pbx: next, changed: next !== pbx };
}

/**
 * Remove "Install Extension Profile (Main)" phase from main app target so the phase never runs
 * (profile is already installed by custom build step; the phase can fail and break the build).
 */
function removeInstallExtensionProfileMainPhase(pbx) {
  const mainPhaseId = 'B2C3D4E5F60718293A4B5C6D7E8F90A1';
  if (!pbx.includes('Install Extension Profile (Main)')) return { pbx, changed: false };
  const phaseLineRe = new RegExp(
    '\\s*' + mainPhaseId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\/\\*\\s*Install Extension Profile \\(Main\\)\\s*\\*\\/,\\n?',
    'g'
  );
  const next = pbx.replace(phaseLineRe, '');
  return { pbx: next, changed: next !== pbx };
}

/**
 * Remove "Install Extension Profile" phase from the extension target.
 * EAS and the workflow install the profile; this run script can conflict with EAS signing
 * and cause the extension to be signed with the main app profile. Removing it avoids that.
 */
function removeInstallExtensionProfilePhase(pbx) {
  const phaseId = 'A1B2C3D4E5F60718293A4B5C6D7E8F90';
  if (!pbx.includes('Install Extension Profile */ = {')) return { pbx, changed: false };
  let next = pbx;
  // Remove the phase reference from extension target's buildPhases (comment is "Install Extension Profile" without "(Main)")
  const extPhaseRefRe = new RegExp(
    '\\s*' + phaseId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\/\\*\\s*Install Extension Profile\\s*\\*\\/,\\n?',
    'g'
  );
  next = next.replace(extPhaseRefRe, '');
  // Remove the phase block from PBXShellScriptBuildPhase section (block ends with \t\t};)
  const phaseBlockRe = new RegExp(
    '\\s*' + phaseId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\/\\*\\s*Install Extension Profile\\s*\\*\\/\\s*=\\s*\\{[\\s\\S]*?\\n\\t\\t\\};',
    'g'
  );
  next = next.replace(phaseBlockRe, '');
  return { pbx: next, changed: next !== pbx };
}

/**
 * Remove from the main target's dependencies list any ref that points to a
 * PBXTargetDependency whose proxy has remoteGlobalIDString = undefined.
 * EAS fails when it resolves such a ref and gets targetId "undefined".
 * Removing the ref ensures the parser never sees the broken dependency.
 */
function removeBrokenDependencyRefsFromMainTarget(pbx) {
  const nativeTargetSection = pbx.match(/\/\* Begin PBXNativeTarget section \*\/[\s\S]*?\/\* End PBXNativeTarget section \*\//);
  if (!nativeTargetSection) return { pbx, changed: false };
  const appTargetMatch = nativeTargetSection[0].match(
    /([0-9A-F]{24})\s*\/\*\s*GrabDocs\s*\*\/\s*=\s*\{[\s\S]*?productType = "com\.apple\.product-type\.application"/
  );
  const mainTargetUuid = appTargetMatch ? appTargetMatch[1] : null;
  if (!mainTargetUuid) return { pbx, changed: false };

  const proxySection = pbx.match(/\/\* Begin PBXContainerItemProxy section \*\/[\s\S]*?\/\* End PBXContainerItemProxy section \*\//);
  const depSection = pbx.match(/\/\* Begin PBXTargetDependency section \*\/[\s\S]*?\/\* End PBXTargetDependency section \*\//);
  if (!proxySection || !depSection) return { pbx, changed: false };

  const brokenProxyUuids = new Set();
  const proxyBlock = proxySection[0];
  const proxyEntryRe = /\t\t([0-9A-F]{24})\s*\/\*\s*[^*]*\*\/\s*=\s*\{[\s\S]*?remoteGlobalIDString = undefined[\s\S]*?\};/g;
  let m;
  while ((m = proxyEntryRe.exec(proxyBlock)) !== null) brokenProxyUuids.add(m[1]);

  if (brokenProxyUuids.size === 0) return { pbx, changed: false };

  const brokenDepUuids = new Set();
  const depBlock = depSection[0];
  for (const proxyUuid of brokenProxyUuids) {
    const depEntryRe = new RegExp(
      '\\t\\t([0-9A-F]{24})\\s*\\/\\*[^*]*\\*\\/\\s*=\\s*\\{[\\s\\S]*?targetProxy = ' + proxyUuid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?\\};',
      'g'
    );
    let dm;
    while ((dm = depEntryRe.exec(depBlock)) !== null) brokenDepUuids.add(dm[1]);
  }

  if (brokenDepUuids.size === 0) return { pbx, changed: false };

  const mainTargetBlockRe = new RegExp(
    '(' + mainTargetUuid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\/\\*\\s*GrabDocs\\s*\\*\\/\\s*=\\s*\\{[\\s\\S]*?dependencies = \\()([\\s\\S]*?)(\\n\\s*\\);)',
    'g'
  );
  const before = pbx;
  pbx = pbx.replace(mainTargetBlockRe, (_, prefix, depsContent, suffix) => {
    const lines = depsContent.split('\n');
    const kept = lines.filter((line) => {
      const uuidMatch = line.match(/([0-9A-F]{24})/);
      return !uuidMatch || !brokenDepUuids.has(uuidMatch[1]);
    });
    const newDeps = kept.join('\n').replace(/\n\s*\n/g, '\n').trim();
    return prefix + (newDeps ? newDeps + '\n\t\t\t\t' : '\n\t\t\t\t') + suffix;
  });
  return { pbx, changed: pbx !== before };
}

/**
 * True when the main target's dependencies list already points at a PBXTargetDependency
 * for this extension. The list stores the dependency object's UUID (comment often
 * "PBXTargetDependency"), not the extension target UUID or name.
 */
function dependencyListReferencesExtension(pbx, depsContent, extensionTargetUuid, extensionName) {
  if (depsContent.includes(extensionName)) return true;
  const depSection = pbx.match(/\/\* Begin PBXTargetDependency section \*\/[\s\S]*?\/\* End PBXTargetDependency section \*\//);
  if (depSection) {
    const re = new RegExp(
      '([0-9A-F]{24})\\s*\\/\\*[^*]*\\*\\/\\s*=\\s*\\{[^}]*\\btarget = ' +
        extensionTargetUuid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
        '\\b',
      'g'
    );
    let match;
    while ((match = re.exec(depSection[0])) !== null) {
      if (depsContent.includes(match[1])) return true;
    }
  }
  return depsContent.includes(extensionTargetUuid);
}

/** Rebuild a pbxproj list so items stay comma-separated. A trailing comma on the last existing item must not become ",,". */
function formatDependencyList(existingDeps, depLine) {
  const items = existingDeps
    .split('\n')
    .map((line) => line.replace(/,\s*$/, '').trim())
    .filter((line) => line.length > 0);
  if (!items.includes(depLine)) items.push(depLine);
  return '\n\t\t\t\t' + items.join(',\n\t\t\t\t') + ',\n\t\t\t';
}

/**
 * Ensure main app target has the extension in its Target Dependencies.
 * CocoaPods uses user_project.host_targets_for_embedded_target() which returns
 * targets that depend on the extension. Without this, "Unable to find host target(s)".
 */
function ensureTargetDependency(pbx, extensionName) {
  const nativeTargetSection = pbx.match(/\/\* Begin PBXNativeTarget section \*\/[\s\S]*?\/\* End PBXNativeTarget section \*\//);
  if (!nativeTargetSection) return { pbx, changed: false };

  const appTargetMatch = nativeTargetSection[0].match(
    /([0-9A-F]{24})\s*\/\*\s*GrabDocs\s*\*\/\s*=\s*\{[\s\S]*?productType = "com\.apple\.product-type\.application"/
  );
  const mainTargetUuid = appTargetMatch ? appTargetMatch[1] : null;
  if (!mainTargetUuid) return { pbx, changed: false };

  const extTargetMatch = nativeTargetSection[0].match(
    new RegExp('([0-9A-F]{24})\\s*\\/\\*\\s*"' + extensionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"\\s*\\*\\/\\s*=\\s*\\{[\\s\\S]*?productType = "com\\.apple\\.product-type\\.app-extension"')
  );
  const extensionTargetUuid = extTargetMatch ? extTargetMatch[1] : null;
  if (!extensionTargetUuid) return { pbx, changed: false };

  const mainTargetBlockRe = new RegExp(
    mainTargetUuid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?dependencies = \\(([\\s\\S]*?)\\)\\s*;',
    'g'
  );
  const mainTargetBlockMatch = mainTargetBlockRe.exec(pbx);
  const depsContent = mainTargetBlockMatch ? mainTargetBlockMatch[1] : '';
  if (dependencyListReferencesExtension(pbx, depsContent, extensionTargetUuid, extensionName)) {
    return { pbx, changed: false };
  }
  const projectMatch = pbx.match(/([0-9A-F]{24})\s*\/\*\s*Project object\s*\*\/\s*=\s*\{\s*isa = PBXProject;/);
  const projectUuid = projectMatch ? projectMatch[1] : null;
  if (!projectUuid) return { pbx, changed: false };

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

  const mainTargetDepsPattern = new RegExp(
    '(' + mainTargetUuid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\/\\*\\s*GrabDocs\\s*\\*\\/\\s*=\\s*\\{[\\s\\S]*?)dependencies = \\(([\\s\\S]*?)\\)\\s*;'
  );
  pbx = pbx.replace(mainTargetDepsPattern, (_, prefix, existingDeps) => {
    const depLine = targetDependencyUuid + ' /* ' + extensionName + ' */';
    return prefix + 'dependencies = (' + formatDependencyList(existingDeps, depLine) + ');';
  });

  return { pbx, changed: true };
}

const iosDir = path.join(process.cwd(), 'ios');
if (!fs.existsSync(iosDir)) {
  console.log('[ensure-pbxproj-embed-phase] ios/ not found — skipping');
  process.exit(0);
}

const xcodeproj = fs.readdirSync(iosDir).find((f) => f.endsWith('.xcodeproj'));
if (!xcodeproj) {
  console.log('[ensure-pbxproj-embed-phase] No .xcodeproj in ios/ — skipping');
  process.exit(0);
}

const pbxPath = path.join(iosDir, xcodeproj, 'project.pbxproj');
if (!fs.existsSync(pbxPath)) {
  console.log('[ensure-pbxproj-embed-phase] project.pbxproj not found — skipping');
  process.exit(0);
}

let pbx = fs.readFileSync(pbxPath, 'utf8');
let changed = false;

// Resolve extension target UUID once — used by several fixup functions below.
function resolveExtensionTargetUuid(pbxContent, extensionName) {
  const nativeTargetSection = pbxContent.match(/\/\* Begin PBXNativeTarget section \*\/[\s\S]*?\/\* End PBXNativeTarget section \*\//);
  if (!nativeTargetSection) return null;
  const m = nativeTargetSection[0].match(
    new RegExp('([0-9A-F]{24})\\s*\\/\\*\\s*"?' + extensionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"?\\s*\\*\\/\\s*=\\s*\\{[\\s\\S]*?productType = "com\\.apple\\.product-type\\.app-extension"')
  );
  return m ? m[1] : null;
}
const extensionTargetUuid = resolveExtensionTargetUuid(pbx, EXTENSION_NAME);

// Remove main-target dependency refs that point to proxies with remoteGlobalIDString = undefined
// (EAS then never resolves them and cannot hit "target with id 'undefined'").
const brokenRefsResult = removeBrokenDependencyRefsFromMainTarget(pbx);
if (brokenRefsResult.changed) {
  pbx = brokenRefsResult.pbx;
  changed = true;
  console.log('[ensure-pbxproj-embed-phase] ✅ Removed broken extension dependency refs from main target (EAS parse fix)');
}

// Fix literal "undefined" first - EAS parser can return JS undefined and fail with "target with id 'undefined'"
const undefinedResult = fixUndefinedInPbxproj(pbx);
if (undefinedResult.changed) {
  pbx = undefinedResult.pbx;
  changed = true;
  console.log('[ensure-pbxproj-embed-phase] ✅ Replaced literal "undefined" in pbxproj (EAS parser fix)');
}

// Fix remoteGlobalIDString = undefined in PBXContainerItemProxy (EAS "Could not find target with id 'undefined'")
const remoteIdResult = fixRemoteGlobalIDStringUndefined(pbx, EXTENSION_NAME);
if (remoteIdResult.changed) {
  pbx = remoteIdResult.pbx;
  changed = true;
  console.log('[ensure-pbxproj-embed-phase] ✅ Fixed remoteGlobalIDString = undefined (EAS target lookup)');
}

// Fix target = undefined/empty in PBXTargetDependency — replacing (not removing) with the real UUID.
// Removing the line leaves JS undefined when EAS reads the absent field, causing the same error.
const targetDepUndefResult = fixTargetDependencyTargetUndefined(pbx, extensionTargetUuid);
if (targetDepUndefResult.changed) {
  pbx = targetDepUndefResult.pbx;
  changed = true;
  console.log('[ensure-pbxproj-embed-phase] ✅ Fixed target = undefined → real UUID in PBXTargetDependency (EAS target lookup)');
}

// A previous patch could leave "dependencies = (UUID /* PBXTargetDependency */,,".
// Nanaimo rejects the double comma before pod install. Collapse it even when no new dep is added.
if (pbx.includes(',,')) {
  const collapsed = pbx.replace(/,\s*,/g, ',');
  if (collapsed !== pbx) {
    pbx = collapsed;
    changed = true;
    console.log('[ensure-pbxproj-embed-phase] ✅ Removed double comma in project.pbxproj (CocoaPods parse fix)');
  }
}

// Run target dependency first - CocoaPods needs this for host detection
const depResult = ensureTargetDependency(pbx, EXTENSION_NAME);
if (depResult.changed) {
  pbx = depResult.pbx;
  changed = true;
  console.log('[ensure-pbxproj-embed-phase] ✅ Added extension to main target Target Dependencies (CocoaPods host)');
}

const embedResult = fixExtensionEmbedPhaseForCocoaPods(pbx, EXTENSION_NAME);
if (embedResult.changed) {
  pbx = embedResult.pbx;
  changed = true;
  console.log('[ensure-pbxproj-embed-phase] ✅ Fixed Embed App Extensions phase');
}

const expoProviderResult = removeExpoModulesProviderFromExtensionTarget(pbx, EXTENSION_NAME);
if (expoProviderResult.changed) {
  pbx = expoProviderResult.pbx;
  changed = true;
  console.log('[ensure-pbxproj-embed-phase] ✅ Removed ExpoModulesProvider from extension target (avoids linking ExpoCamera)');
}

const swiftTypeResult = forceSwiftFileTypeForSampleHandler(pbx);
if (swiftTypeResult.changed) {
  pbx = swiftTypeResult.pbx;
  changed = true;
  console.log('[ensure-pbxproj-embed-phase] ✅ Forced SampleHandler.swift to sourcecode.swift (line-by-line fix)');
}

const storyboardResult = fixStoryboardFileTypes(pbx);
if (storyboardResult.changed) {
  pbx = storyboardResult.pbx;
  changed = true;
  console.log('[ensure-pbxproj-embed-phase] ✅ Set .storyboard file refs to file.storyboard (share extension compiles MainInterface.storyboardc)');
}

const removePhaseResult = removeInstallExtensionProfileMainPhase(pbx);
if (removePhaseResult.changed) {
  pbx = removePhaseResult.pbx;
  changed = true;
  console.log('[ensure-pbxproj-embed-phase] ✅ Removed Install Extension Profile (Main) phase (profile already installed by build step)');
}

const removeExtPhaseResult = removeInstallExtensionProfilePhase(pbx);
if (removeExtPhaseResult.changed) {
  pbx = removeExtPhaseResult.pbx;
  changed = true;
  console.log('[ensure-pbxproj-embed-phase] ✅ Removed Install Extension Profile phase from extension target (avoids EAS signing conflict)');
}

if (changed) {
  fs.writeFileSync(pbxPath, pbx);
  console.log('[ensure-pbxproj-embed-phase] ✅ Patched project.pbxproj for CocoaPods');
} else {
  console.log('[ensure-pbxproj-embed-phase] No change needed');
}
