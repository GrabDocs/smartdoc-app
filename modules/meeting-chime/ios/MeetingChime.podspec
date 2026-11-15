Pod::Spec.new do |s|
  s.name           = 'MeetingChime'
  s.version        = '1.0.0'
  s.summary        = 'Meeting join chime that follows the phone ringer / silent setting'
  s.description    = 'Plays the Reach meeting join chime as an iOS system sound so the Ring/Silent switch mutes it.'
  s.license        = 'MIT'
  s.author         = 'GrabDocs'
  s.homepage       = 'https://grabdocs.com'
  s.platforms      = {
    :ios => '15.1'
  }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,swift}"
  s.resource_bundles = {
    'MeetingChime' => ['sounds/*.wav']
  }
end
