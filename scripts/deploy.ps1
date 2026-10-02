
# Deploy script for GrabDocs mobile app
# This script handles platform selection, environment selection, version updates, build number updates, and EAS build execution
#
# Usage:
#   Interactive mode: .\scripts\deploy.ps1
#   Direct parameters (Android): .\scripts\deploy.ps1 -Platform android -Environment prod -BuildNumber 11 -Version 1.0.3
#   Direct parameters (iOS):    .\scripts\deploy.ps1 -Platform ios -Environment prod -BuildNumber 1 -Version 1.0.18
#   iOS App Store: -Version = CFBundleShortVersionString (user-facing). After a version is live, bump -Version; build (-BuildNumber)
#   can restart at 1 for that new version. Re-using the same (version + build) as an already-uploaded binary always fails—usually
#   because the IPA still had the old version/build (CI not updating app.versions.json / workflow inputs), not because Apple ignores version.
#   With update reason: .\scripts\deploy.ps1 -Platform android -Environment prod -Version 1.0.4 -UpdateReason security
#   Local build (no EAS cloud): .\scripts\deploy.ps1 -Platform android -Environment prod -Local
#   Local build (iOS, requires macOS): .\scripts\deploy.ps1 -Platform ios -Environment prod -Local
#   OTA update: .\scripts\deploy.ps1 -Environment prod -DeployType ota -UpdateMessage "Added back button to prejoin screen"
#
#   In production, UpdateReason is prompted (1=security, 2=breaking, 3=feature) or use -UpdateReason param.
#   Interactive mode prompts: environment → deploy type (build/OTA) → platform (build only) → OTA message (OTA only).
#   Development fresh builds reuse version and build number from app.versions.json and do not write them back.
#   Pass -Version and -BuildNumber only to override that reuse. Production is the path that increments and saves them.
#
#   Interactive builds default to GitHub Actions (commit/push already done by the script). Use -Local for EAS on this machine.
#   For EAS cloud builds, run eas directly (e.g. eas build --profile production --platform android).
#
#   iOS dSYM: GitHub Actions uploads ios-dsym artifact when the iOS workflow runs. Download from the workflow run (Actions -> run -> Artifacts); use GrabDocs.app.dSYM for symbolication.

param(
    [string]$Platform,
    [string]$Environment,
    [string]$BuildNumber,
    [string]$Version,
    [string]$UpdateReason,
    [string]$DeployType,
    [string]$UpdateMessage,
    [switch]$Local
)

Write-Host "🚀 GrabDocs Deployment Script" -ForegroundColor Cyan
Write-Host "============================" -ForegroundColor Cyan

# Function to prompt for input with validation
function Prompt-WithValidation {
    param(
        [string]$Prompt,
        [array]$ValidOptions = @(),
        [string]$DefaultValue = ""
    )

    do {
        $response = Read-Host "$Prompt"
        if ($response -eq "" -and $DefaultValue -ne "") {
            $response = $DefaultValue
        }

        if ($ValidOptions.Count -gt 0) {
            $isValid = $ValidOptions -contains $response.ToLower()
            if (-not $isValid) {
                Write-Host "Invalid option. Please choose from: $($ValidOptions -join ', ')" -ForegroundColor Yellow
                continue
            }
        }
        break
    } while ($true)

    return $response.ToLower()
}

# Function to get current version from app.versions.json (app.config.js reads this)
function Get-CurrentVersion {
    try {
        $versionsPath = "$PSScriptRoot\..\app.versions.json"
        if (Test-Path $versionsPath) {
            $v = Get-Content $versionsPath -Raw | ConvertFrom-Json
            return $v.version
        }
    }
    catch {
        Write-Host "⚠️  Could not read current version: $($_.Exception.Message)" -ForegroundColor Yellow
    }

    return $null
}

# Function to get current build number
function Get-CurrentBuildNumber {
    param(
        [string]$Platform
    )

    # Normalize platform to lowercase to avoid case-sensitivity issues
    $Platform = $Platform.ToLower()

    try {
        $versionsPath = "$PSScriptRoot\..\app.versions.json"
        if (-not (Test-Path $versionsPath)) { return $null }
        $v = Get-Content $versionsPath -Raw | ConvertFrom-Json
        if ($Platform -eq "ios") {
            if ($v.ios -and $v.ios.buildNumber) { return $v.ios.buildNumber }
        }
        elseif ($Platform -eq "android") {
            if ($v.android -and $v.android.versionCode) { return $v.android.versionCode.ToString() }
        }
    }
    catch {
        Write-Host "⚠️  Could not read current build number: $($_.Exception.Message)" -ForegroundColor Yellow
    }

    return $null
}

# Function to update version in app.versions.json (app.config.js reads this)
function Update-Version {
    param(
        [string]$Version
    )

    Write-Host "📝 Updating version to $Version..." -ForegroundColor Yellow

    try {
        $versionsPath = "$PSScriptRoot\..\app.versions.json"
        $v = Get-Content $versionsPath -Raw | ConvertFrom-Json
        $v.version = $Version
        $v | ConvertTo-Json -Depth 5 | Set-Content $versionsPath -Encoding UTF8
        Write-Host "✅ Updated version in app.versions.json" -ForegroundColor Green
    }
    catch {
        Write-Host "❌ Error updating version: $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }
}

# Function to update build numbers
function Update-BuildNumber {
    param(
        [string]$Platform,
        [string]$BuildNumber
    )

    # Normalize platform to lowercase to avoid case-sensitivity issues
    $Platform = $Platform.ToLower()

    Write-Host "📝 Updating build number to $BuildNumber for $Platform..." -ForegroundColor Yellow

    try {
        $versionsPath = "$PSScriptRoot\..\app.versions.json"
        if (-not (Test-Path $versionsPath)) {
            throw "app.versions.json not found at $versionsPath"
        }
        $v = Get-Content $versionsPath -Raw | ConvertFrom-Json
        if ($Platform -eq "ios") {
            if (-not $v.ios) { $v | Add-Member -MemberType NoteProperty -Name "ios" -Value @{} -Force }
            $v.ios.buildNumber = $BuildNumber
            $v | ConvertTo-Json -Depth 5 | Set-Content $versionsPath -Encoding UTF8
            Write-Host "✅ Updated iOS buildNumber in app.versions.json" -ForegroundColor Green
        }
        elseif ($Platform -eq "android") {
            if (-not $v.android) { $v | Add-Member -MemberType NoteProperty -Name "android" -Value @{} -Force }
            $v.android.versionCode = [int]$BuildNumber
            $tempPath = "$versionsPath.tmp"
            $v | ConvertTo-Json -Depth 5 | Set-Content $tempPath -Encoding UTF8
            Move-Item -Path $tempPath -Destination $versionsPath -Force
            Start-Sleep -Milliseconds 100
            $verifyV = Get-Content $versionsPath -Raw | ConvertFrom-Json
            if (-not $verifyV.android -or $null -eq $verifyV.android.versionCode) {
                throw "Failed to verify versionCode was written to app.versions.json"
            }
            $actualVersionCode = $verifyV.android.versionCode
            if ([int]$actualVersionCode -eq [int]$BuildNumber) {
                Write-Host "✅ Updated Android versionCode in app.versions.json to $actualVersionCode" -ForegroundColor Green
            } else {
                throw "Expected versionCode $BuildNumber but found $actualVersionCode in app.versions.json"
            }
            
            # Also update Android versionCode in build.gradle when android/ exists (e.g. after expo prebuild).
            # EAS Build generates android/ during prebuild and uses app.versions.json; no android folder is normal.
            $buildGradlePath = "$PSScriptRoot\..\android\app\build.gradle"
            if (Test-Path $buildGradlePath) {
                $content = Get-Content $buildGradlePath -Raw
                if ($content -notmatch 'versionCode') {
                    Write-Host "⚠️  versionCode not found in build.gradle" -ForegroundColor Yellow
                } else {
                    # More robust regex: match versionCode followed by whitespace and digits, replace the digits
                    if ($content -match '(?m)(^\s*versionCode\s+)(\d+)') {
                        $oldValue = $matches[2]
                        $content = $content -replace '(?m)(^\s*versionCode\s+)(\d+)', "`${1}$BuildNumber"
                        Set-Content $buildGradlePath $content -Encoding UTF8
                        $verifyContent = Get-Content $buildGradlePath -Raw
                        if ($verifyContent -match '(?m)^\s*versionCode\s+(\d+)') {
                            $actualValue = $matches[1]
                            if ([int]$actualValue -eq [int]$BuildNumber) {
                                Write-Host "✅ Updated Android versionCode in build.gradle from $oldValue to $actualValue" -ForegroundColor Green
                            } else {
                                Write-Host "⚠️  Warning: Expected versionCode $BuildNumber but found $actualValue in build.gradle" -ForegroundColor Yellow
                            }
                        }
                    } else {
                        Write-Host "⚠️  Could not find versionCode pattern in build.gradle to update" -ForegroundColor Yellow
                    }
                }
            } else {
                Write-Host "ℹ️  android/app/build.gradle not present (normal for EAS Build; versionCode from app.versions.json is used during prebuild)" -ForegroundColor Gray
            }
        } else {
            throw "Invalid platform: $Platform"
        }
    } catch {
        Write-Host "❌ Error updating build number: $($_.Exception.Message)" -ForegroundColor Red
        throw
    }
}

# Function to update LATEST_APP_VERSION, LATEST_APP_VERSION_CODE_ANDROID, and UPDATE_REASON in render.yaml (for production deploys)
# Android versionCode is read from app.versions.json (already updated by Update-BuildNumber) so backend can use it as min without MIN_* in Render.
function Update-RenderAppConfig {
    param(
        [string]$Version,
        [string]$UpdateReason
    )
    $renderPath = "$PSScriptRoot\..\manager-francis\render.yaml"
    $versionsPath = "$PSScriptRoot\..\app.versions.json"
    if (-not (Test-Path $renderPath)) {
        Write-Host "⚠️  render.yaml not found at $renderPath. Skipping app config update." -ForegroundColor Yellow
        return
    }
    $validReasons = @("security", "breaking", "feature")
    if ($UpdateReason -notin $validReasons) {
        $UpdateReason = "feature"
        Write-Host "⚠️  Invalid UpdateReason. Defaulting to 'feature'." -ForegroundColor Yellow
    }
    $androidVersionCode = ""
    if (Test-Path $versionsPath) {
        try {
            $v = Get-Content $versionsPath -Raw | ConvertFrom-Json
            if ($v.android.versionCode) {
                $androidVersionCode = $v.android.versionCode.ToString()
            }
        } catch {
            Write-Host "⚠️  Could not read Android versionCode from app.versions.json" -ForegroundColor Yellow
        }
    }
    try {
        $content = Get-Content $renderPath -Raw -Encoding UTF8
        $content = $content -replace '(- key: LATEST_APP_VERSION\s+value: )["'']?[^"'']*["'']?', "`${1}`"$Version`""
        if ($androidVersionCode -ne "") {
            $content = $content -replace '(- key: LATEST_APP_VERSION_CODE_ANDROID\s+value: )["'']?[^"'']*["'']?', "`${1}`"$androidVersionCode`""
        }
        $content = $content -replace '(- key: UPDATE_REASON\s+value: )["'']?[^"'']*["'']?', "`${1}$UpdateReason"
        Set-Content $renderPath $content -Encoding UTF8
        $msg = "LATEST_APP_VERSION=$Version, UPDATE_REASON=$UpdateReason"
        if ($androidVersionCode -ne "") { $msg += ", LATEST_APP_VERSION_CODE_ANDROID=$androidVersionCode" }
        Write-Host "✅ Updated render.yaml: $msg" -ForegroundColor Green
    } catch {
        Write-Host "❌ Error updating render.yaml: $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }
}

# Function to run EAS build
function Run-EasBuild {
    param(
        [string]$Platform,
        [string]$Profile,
        [switch]$Local
    )

    $buildType = if ($Local) { "EAS local" } else { "EAS cloud" }
    Write-Host "🏗️  Running $buildType build for $Platform ($Profile)..." -ForegroundColor Yellow

    # Use npx to run eas command (works even if eas is not globally installed)
    $command = "npx eas-cli build --platform $Platform --profile $Profile --non-interactive"
    if ($Local) {
        $command += " --local"
        Write-Host "ℹ️  Local build: runs on this machine (no EAS cloud charge). EAS local requires macOS or Linux (Windows not supported)." -ForegroundColor Cyan
    }

    Write-Host "Executing: $command" -ForegroundColor Gray

    try {
        # Change to project root directory
        Set-Location "$PSScriptRoot\.."

        # Run the build command
        Invoke-Expression $command

        if ($LASTEXITCODE -eq 0) {
            Write-Host "✅ Build completed successfully!" -ForegroundColor Green
        } else {
            Write-Host "❌ Build failed with exit code $LASTEXITCODE" -ForegroundColor Red
            exit $LASTEXITCODE
        }
    }
    catch {
        Write-Host "❌ Error running build: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "💡 Tip: Make sure you have Node.js installed and run 'npm install' in the project directory." -ForegroundColor Yellow
        exit 1
    }
}

# Function to run EAS OTA update
function Run-EasUpdate {
    param(
        [string]$Channel,
        [string]$Message
    )

    Write-Host "📡 Running EAS OTA update on channel '$Channel'..." -ForegroundColor Yellow
    Write-Host "   Message: $Message" -ForegroundColor Gray

    try {
        Set-Location "$PSScriptRoot\.."
        & npx eas update --channel $Channel --message $Message --non-interactive

        if ($LASTEXITCODE -eq 0) {
            Write-Host "✅ OTA update published successfully!" -ForegroundColor Green
        } else {
            Write-Host "❌ OTA update failed with exit code $LASTEXITCODE" -ForegroundColor Red
            exit 1
        }
    }
    catch {
        Write-Host "❌ Error running OTA update: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "💡 Tip: Make sure you have Node.js installed and run 'npm install' in the project directory." -ForegroundColor Yellow
        exit 1
    }
}

# Main script logic
try {
    # Prompt for environment if not provided
    if (-not $Environment) {
        $Environment = Prompt-WithValidation "Select environment (development/dev/production/prod)" @("development", "dev", "production", "prod")
    }

    # Validate and normalize environment
    $validEnvironments = @("development", "dev", "production", "prod")
    if ($Environment -notin $validEnvironments) {
        Write-Host "❌ Invalid environment. Must be 'development', 'dev', 'production', or 'prod'." -ForegroundColor Red
        exit 1
    }

    # Normalize environment names
    $normalizedEnv = switch ($Environment) {
        "dev" { "development" }
        "prod" { "production" }
        default { $Environment }
    }

    # Map environment to EAS profile
    $profile = switch ($normalizedEnv) {
        "development" { "development" }
        "production" { "production" }
    }

    # Map environment to EAS update channel
    $updateChannel = switch ($normalizedEnv) {
        "development" { "development" }
        "production" { "production" }
    }

    # Prompt for deploy type (fresh build vs OTA update)
    if (-not $DeployType) {
        Write-Host "`n📋 Deploy type:" -ForegroundColor Cyan
        Write-Host "   1 = fresh build   (native binary via GitHub Actions / EAS)" -ForegroundColor Gray
        Write-Host "   2 = OTA update    (JavaScript bundle via eas update)" -ForegroundColor Gray
        $deployChoice = Prompt-WithValidation "Select deploy type (1/2) [1]" @("1", "2") -DefaultValue "1"
        $DeployType = if ($deployChoice -eq "2") { "ota" } else { "build" }
    } else {
        $DeployType = $DeployType.ToLower()
    }

    if ($DeployType -notin @("build", "ota")) {
        Write-Host "❌ Invalid deploy type. Must be 'build' or 'ota'." -ForegroundColor Red
        exit 1
    }

    # Platform is only required for fresh builds (OTA updates both iOS and Android)
    if ($DeployType -eq "build") {
        if (-not $Platform) {
            $Platform = Prompt-WithValidation "Select platform (ios/android)" @("ios", "android")
        }

        $Platform = $Platform.ToLower()

        if ($Platform -notin @("ios", "android")) {
            Write-Host "❌ Invalid platform. Must be 'ios' or 'android'." -ForegroundColor Red
            exit 1
        }
    } elseif ($Platform) {
        Write-Host "ℹ️  Platform ignored for OTA updates (applies to iOS and Android)." -ForegroundColor Gray
        $Platform = $null
    }

    if ($DeployType -eq "ota") {
        if (-not $UpdateMessage) {
            $UpdateMessage = Read-Host "Enter OTA update message (e.g., Added back button to prejoin screen)"
        }
        if ([string]::IsNullOrWhiteSpace($UpdateMessage)) {
            Write-Host "❌ OTA update message cannot be empty." -ForegroundColor Red
            exit 1
        }
        Write-Host "ℹ️  OTA update will publish to channel: $updateChannel" -ForegroundColor Cyan
    }

    # Handle version name and build number for production fresh builds
    if ($DeployType -eq "build" -and $normalizedEnv -eq "production") {
        $currentVersion = Get-CurrentVersion
        $currentBuildNumber = Get-CurrentBuildNumber -Platform $Platform

        # Prompt for version name
        if (-not $Version) {
            if ($currentVersion) {
                Write-Host "📦 Current version name: $currentVersion" -ForegroundColor Cyan
                $useCurrentVersion = Prompt-WithValidation "Do you want to continue with existing version name ($currentVersion)? (y/n)" @("y", "n")
                if ($useCurrentVersion -eq "y") {
                    $Version = $currentVersion
                    Write-Host "ℹ️  Using current version name: $Version" -ForegroundColor Yellow
                } else {
                    $Version = Read-Host "Enter new version name for production (e.g., 1.0.1)"
                    if ([string]::IsNullOrWhiteSpace($Version)) {
                        Write-Host "❌ Version name cannot be empty." -ForegroundColor Red
                        exit 1
                    }
                }
            } else {
                $Version = Read-Host "Enter version name for production (e.g., 1.0.1)"
            }
        }

        # Validate version format (semantic versioning: x.y.z)
        if ($Version -match '^\d+\.\d+\.\d+$') {
            if ($Version -ne $currentVersion) {
                Update-Version -Version $Version
            } else {
                Write-Host "ℹ️  Version name unchanged: $Version" -ForegroundColor Yellow
            }
        } else {
            Write-Host "❌ Invalid version format. Must be in format x.y.z (e.g., 1.0.1)" -ForegroundColor Red
            exit 1
        }

        # Prompt for build number
        if (-not $BuildNumber) {
            if ($currentBuildNumber) {
                $buildLabel = if ($Platform -eq "ios") { "iOS build number" } else { "Android version code" }
                Write-Host "📦 Current ${buildLabel}: $currentBuildNumber" -ForegroundColor Cyan
                
                if ($Platform -eq "android") {
                    Write-Host "⚠️  Android requires increasing version code for new builds" -ForegroundColor Yellow
                    $useCurrentBuildNumber = Prompt-WithValidation "Do you want to continue with existing version code ($currentBuildNumber)? Note: Android requires incrementing for new builds. (y/n)" @("y", "n")
                    if ($useCurrentBuildNumber -eq "y") {
                        $BuildNumber = $currentBuildNumber
                        Write-Host "ℹ️  Using current ${buildLabel}: $BuildNumber" -ForegroundColor Yellow
                        Write-Host "⚠️  If this fails with 'already submitted', increment the version code." -ForegroundColor Red
                    } else {
                        $BuildNumber = Read-Host "Enter new ${buildLabel} for production (must be greater than $currentBuildNumber)"
                        if ([string]::IsNullOrWhiteSpace($BuildNumber)) {
                            Write-Host "❌ Build number cannot be empty." -ForegroundColor Red
                            exit 1
                        }
                    }
                } else {
                    # iOS
                    $useCurrentBuildNumber = Prompt-WithValidation "Do you want to continue with existing build number ($currentBuildNumber)? (y/n)" @("y", "n")
                    if ($useCurrentBuildNumber -eq "y") {
                        $BuildNumber = $currentBuildNumber
                        Write-Host "ℹ️  Using current ${buildLabel}: $BuildNumber" -ForegroundColor Yellow
                        Write-Host "⚠️  If this fails with 'already submitted', increment the build number." -ForegroundColor Red
                    } else {
                        $BuildNumber = Read-Host "Enter new ${buildLabel} for production"
                        if ([string]::IsNullOrWhiteSpace($BuildNumber)) {
                            Write-Host "❌ Build number cannot be empty." -ForegroundColor Red
                            exit 1
                        }
                    }
                }
            } else {
                $buildLabel = if ($Platform -eq "ios") { "iOS build number" } else { "Android version code" }
                $BuildNumber = Read-Host "Enter ${buildLabel} for production"
            }
        }

        if ($BuildNumber -match '^\d+$') {
            # For Android, validate that the build number is greater than current (unless user explicitly chose to keep existing)
            if ($Platform -eq "android" -and $currentBuildNumber) {
                $buildNumberInt = [int]$BuildNumber
                $currentBuildNumberInt = [int]$currentBuildNumber
                # Only validate if user entered a new value (not if they chose to keep existing)
                # If they're equal, it means user chose to keep existing, which is allowed with warning
                if ($buildNumberInt -lt $currentBuildNumberInt) {
                    Write-Host "❌ Invalid version code. Must be greater than or equal to current version code ($currentBuildNumber)." -ForegroundColor Red
                    exit 1
                } elseif ($buildNumberInt -eq $currentBuildNumberInt) {
                    Write-Host "⚠️  Warning: Using same version code as current. Android builds typically require incrementing." -ForegroundColor Yellow
                }
            }
            # iOS: no min check — new marketing version often resets build to 1; workflow + App Store enforce duplicates.

            try {
                Update-BuildNumber -Platform $Platform -BuildNumber $BuildNumber
            } catch {
                Write-Host "❌ Error updating build number: $($_.Exception.Message)" -ForegroundColor Red
                exit 1
            }
            # Prompt for update reason if not provided
            if (-not $UpdateReason) {
                Write-Host "`n📋 Update reason (for app-config):" -ForegroundColor Cyan
                Write-Host "   1 = security   (security fix)" -ForegroundColor Gray
                Write-Host "   2 = breaking   (breaking change)" -ForegroundColor Gray
                Write-Host "   3 = feature    (new features)" -ForegroundColor Gray
                $choice = Prompt-WithValidation "Select update reason (1/2/3) [3]" @("1", "2", "3") -DefaultValue "3"
                $UpdateReason = switch ($choice) { "1" { "security" } "2" { "breaking" } "3" { "feature" } }
            }
            # Update render.yaml with LATEST_APP_VERSION and UPDATE_REASON for backend app-config
            Update-RenderAppConfig -Version $Version -UpdateReason $UpdateReason
        } else {
            Write-Host "❌ Invalid build number. Must be a number." -ForegroundColor Red
            exit 1
        }
    }

    # Non-production fresh builds (development) reuse app.versions.json for the GitHub Actions
    # inputs. Those numbers are not written back; only a production deploy updates the file.
    if ($DeployType -eq "build" -and $normalizedEnv -ne "production") {
        if ([string]::IsNullOrWhiteSpace($Version)) {
            $Version = Get-CurrentVersion
        }
        if ([string]::IsNullOrWhiteSpace($BuildNumber)) {
            $BuildNumber = Get-CurrentBuildNumber -Platform $Platform
        }

        if ($Version -notmatch '^\d+\.\d+\.\d+$') {
            Write-Host "❌ Development build needs a version in app.versions.json (x.y.z), or pass -Version." -ForegroundColor Red
            exit 1
        }
        if ($BuildNumber -notmatch '^\d+$') {
            $buildLabel = if ($Platform -eq "ios") { "iOS build number" } else { "Android version code" }
            Write-Host "❌ Development build needs a ${buildLabel} in app.versions.json, or pass -BuildNumber." -ForegroundColor Red
            exit 1
        }

        $buildLabel = if ($Platform -eq "ios") { "iOS build number" } else { "Android version code" }
        Write-Host "ℹ️  Development build reuses current numbers (not saved): version $Version, ${buildLabel} $BuildNumber" -ForegroundColor Cyan
    }

    # Auto commit, push to francis, merge to main, and push main
    Write-Host "`n📦 Git Operations:" -ForegroundColor Cyan
    Set-Location "$PSScriptRoot\.."
    
    # Check if we're in a git repository
    $gitRoot = git rev-parse --show-toplevel 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "⚠️  Not a git repository. Skipping git operations." -ForegroundColor Yellow
    } else {
        $currentBranch = git rev-parse --abbrev-ref HEAD 2>&1
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($currentBranch)) {
            Write-Host "⚠️  Could not determine current branch. Skipping git operations." -ForegroundColor Yellow
        } else {
            $currentBranch = $currentBranch.Trim()
            Write-Host "   Current branch: $currentBranch" -ForegroundColor Gray
            
            # Ensure we're on francis branch first
            if ($currentBranch -ne "francis") {
                Write-Host "`n🔄 Switching to francis branch..." -ForegroundColor Yellow
                git checkout francis 2>&1 | Out-Null
                if ($LASTEXITCODE -ne 0) {
                    Write-Host "❌ Failed to switch to francis branch" -ForegroundColor Red
                    Write-Host "   Please ensure the francis branch exists: git checkout -b francis" -ForegroundColor Yellow
                    exit 1
                }
                Write-Host "✅ Switched to francis branch" -ForegroundColor Green
                $currentBranch = "francis"
            }
            
            # Ensure workflow files are tracked and committed
            $workflowFiles = @(".github/workflows/build-ios.yml", ".github/workflows/build-android.yml")
            $workflowNeedsCommit = $false
            foreach ($wf in $workflowFiles) {
                if (Test-Path $wf) {
                    # Check if file is tracked and has changes, or is untracked
                    $status = git status --porcelain $wf 2>&1
                    if ($status -match '^\?\?' -or $status -match '^ M' -or $status -match '^A ' -or $status -match '^AM') {
                        $workflowNeedsCommit = $true
                        Write-Host "   Found workflow file that needs to be committed: $wf" -ForegroundColor Gray
                    }
                }
            }
            
            # Check if there are changes to commit
            git diff --quiet --exit-code 2>&1 | Out-Null
            $hasUncommittedChanges = $LASTEXITCODE -ne 0
            
            git diff --cached --quiet --exit-code 2>&1 | Out-Null
            $hasStagedChanges = $LASTEXITCODE -ne 0
            
            $untrackedFiles = git ls-files --others --exclude-standard 2>&1
            $hasUntrackedFiles = $untrackedFiles.Count -gt 0
            
            if ($hasUncommittedChanges -or $hasStagedChanges -or $hasUntrackedFiles -or $workflowNeedsCommit) {
                Write-Host "`n📝 Staging changes..." -ForegroundColor Yellow
                
                # Explicitly add workflow files to ensure they're included
                foreach ($wf in $workflowFiles) {
                    if (Test-Path $wf) {
                        git add $wf 2>&1 | Out-Null
                        if ($LASTEXITCODE -eq 0) {
                            Write-Host "   Staged workflow file: $wf" -ForegroundColor Gray
                        }
                    }
                }
                
                # Stage all other changes including untracked files
                git add -A 2>&1 | Out-Null
                if ($LASTEXITCODE -ne 0) {
                    Write-Host "⚠️  Warning: git add failed. Continuing anyway..." -ForegroundColor Yellow
                }
                
                # Create commit message
                $commitMessage = if ($DeployType -eq "ota") {
                    "OTA update ($updateChannel): $UpdateMessage"
                } elseif ($normalizedEnv -eq "production") {
                    if ($Platform -eq "android") {
                        "Deploy Android v$Version (versionCode $BuildNumber) to production"
                    } else {
                        "Deploy iOS v$Version (buildNumber $BuildNumber) to production"
                    }
                } else {
                    "Deploy $Platform to $normalizedEnv"
                }
                
                # Check if there are actually staged changes before committing
                git diff --cached --quiet 2>&1 | Out-Null
                $hasStagedChanges = $LASTEXITCODE -ne 0
                
                if ($hasStagedChanges) {
                    Write-Host "   Committing changes..." -ForegroundColor Yellow
                    git commit -m $commitMessage 2>&1 | Out-Null
                    if ($LASTEXITCODE -eq 0) {
                        Write-Host "✅ Committed changes: $commitMessage" -ForegroundColor Green
                    } else {
                        Write-Host "⚠️  Warning: git commit failed unexpectedly" -ForegroundColor Yellow
                    }
                }
                # If no staged changes, silently continue (nothing to commit is normal)
            } else {
                Write-Host "   No changes to commit" -ForegroundColor Gray
            }
            
            # Push to francis branch
            Write-Host "`n⬆️  Pushing to francis branch..." -ForegroundColor Yellow
            git push origin francis 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) {
                Write-Host "❌ Failed to push to francis branch" -ForegroundColor Red
                Write-Host "   Error: git push origin francis failed" -ForegroundColor Red
                Write-Host "   Please check your git credentials and remote configuration" -ForegroundColor Yellow
                exit 1
            }
            Write-Host "✅ Pushed to francis branch" -ForegroundColor Green
            
            # Merge francis into main
            Write-Host "`n🔀 Merging francis into main..." -ForegroundColor Yellow
            
            # Check if main branch exists locally
            $mainExists = git show-ref --verify --quiet refs/heads/main 2>&1
            if ($LASTEXITCODE -ne 0) {
                # Try to checkout main from remote
                Write-Host "   Main branch doesn't exist locally. Checking out from remote..." -ForegroundColor Gray
                git checkout -b main origin/main 2>&1 | Out-Null
                if ($LASTEXITCODE -ne 0) {
                    Write-Host "⚠️  Warning: Could not checkout main branch from remote." -ForegroundColor Yellow
                    Write-Host "   Creating main branch..." -ForegroundColor Gray
                    git checkout -b main 2>&1 | Out-Null
                    if ($LASTEXITCODE -ne 0) {
                        Write-Host "❌ Failed to create main branch" -ForegroundColor Red
                        exit 1
                    }
                }
            } else {
                git checkout main 2>&1 | Out-Null
                if ($LASTEXITCODE -ne 0) {
                    Write-Host "❌ Failed to switch to main branch" -ForegroundColor Red
                    exit 1
                }
            }
            
            # Simplest approach: Reset main to match francis exactly, then force push
            # This avoids merge conflicts and ensures main always matches francis
            Write-Host "   Resetting main to match francis exactly..." -ForegroundColor Gray
            git reset --hard francis 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) {
                Write-Host "❌ Failed to reset main to francis" -ForegroundColor Red
                Write-Host "   Switching back to francis branch..." -ForegroundColor Yellow
                git checkout francis 2>&1 | Out-Null
                Write-Host "✅ Switched back to francis branch" -ForegroundColor Green
                exit 1
            }
            Write-Host "✅ Reset main to match francis exactly" -ForegroundColor Green
            
            # Force push main (required since we reset main's history)
            Write-Host "`n⬆️  Pushing main branch (force-with-lease)..." -ForegroundColor Yellow
            git push origin main --force-with-lease 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) {
                Write-Host "   Force-with-lease failed, trying regular force push..." -ForegroundColor Yellow
                git push origin main --force 2>&1 | Out-Null
                if ($LASTEXITCODE -ne 0) {
                    Write-Host "❌ Failed to push main branch" -ForegroundColor Red
                    Write-Host "   Switching back to francis branch..." -ForegroundColor Yellow
                    git checkout francis 2>&1 | Out-Null
                    Write-Host "✅ Switched back to francis branch" -ForegroundColor Green
                    Write-Host "   Push manually: git checkout main && git push origin main --force" -ForegroundColor Gray
                    exit 1
                }
            }
            Write-Host "✅ Pushed main branch" -ForegroundColor Green
            
            # Verify workflow file was included in the push (builds only; OTA does not trigger CI)
            if ($DeployType -eq "build") {
                $workflowFileCheck = if ($Platform -eq "android") { "build-android.yml" } else { "build-ios.yml" }
                $workflowPathCheck = ".github/workflows/$workflowFileCheck"
                Write-Host "   Verifying workflow file exists in pushed commit..." -ForegroundColor Gray
                
                # Get the current commit hash on main
                $currentCommit = git rev-parse HEAD 2>&1
                if ($LASTEXITCODE -eq 0 -and $currentCommit) {
                    $currentCommit = $currentCommit.Trim()
                    Write-Host "   Checking commit: $($currentCommit.Substring(0, 7))..." -ForegroundColor Gray
                    
                    # Check if workflow file exists in this commit (use full path pattern)
                    $workflowInCommit = git ls-tree HEAD --name-only | Select-String -Pattern "workflows.*$workflowFileCheck"
                    if ($workflowInCommit) {
                        Write-Host "   ✅ Workflow file confirmed in commit" -ForegroundColor Green
                    } else {
                        # Also check if file exists at all in the commit tree
                        $fileExists = git cat-file -e "HEAD:$workflowPathCheck" 2>&1
                        if ($LASTEXITCODE -eq 0) {
                            Write-Host "   ✅ Workflow file confirmed in commit (via cat-file)" -ForegroundColor Green
                        } else {
                            Write-Host "   ⚠️  Warning: Workflow file not found in commit" -ForegroundColor Yellow
                            Write-Host "   Ensuring workflow file is committed and pushed..." -ForegroundColor Yellow
                            # The file exists locally, so add and commit it
                            if (Test-Path $workflowPathCheck) {
                                git add $workflowPathCheck 2>&1 | Out-Null
                                if ($LASTEXITCODE -eq 0) {
                                    # Check if there are actually changes to commit
                                    git diff --cached --quiet $workflowPathCheck 2>&1 | Out-Null
                                    if ($LASTEXITCODE -ne 0) {
                                        git commit -m "Ensure workflow file is included for workflow_dispatch" 2>&1 | Out-Null
                                        if ($LASTEXITCODE -eq 0) {
                                            Write-Host "   ✅ Committed workflow file" -ForegroundColor Green
                                            Write-Host "   Pushing updated commit to main..." -ForegroundColor Yellow
                                            git push origin main --force-with-lease 2>&1 | Out-Null
                                            if ($LASTEXITCODE -ne 0) {
                                                git push origin main --force 2>&1 | Out-Null
                                            }
                                            if ($LASTEXITCODE -eq 0) {
                                                Write-Host "   ✅ Pushed workflow file to main" -ForegroundColor Green
                                            }
                                        }
                                    } else {
                                        Write-Host "   ℹ️  Workflow file already matches commit (no changes)" -ForegroundColor Gray
                                    }
                                }
                            }
                        }
                    }
                } else {
                    Write-Host "   ⚠️  Could not verify commit hash" -ForegroundColor Yellow
                }
            }
            
            # Switch back to francis branch for continued work
            Write-Host "`n🔄 Switching back to francis branch..." -ForegroundColor Yellow
            git checkout francis 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) {
                Write-Host "⚠️  Warning: Could not switch back to francis branch" -ForegroundColor Yellow
            } else {
                Write-Host "✅ Switched back to francis branch" -ForegroundColor Green
            }
        }
    }

    # Confirm before proceeding
    Write-Host "`n📋 Deployment Summary:" -ForegroundColor Cyan
    if ($DeployType -eq "ota") {
        Write-Host "   Platform: iOS + Android (OTA)" -ForegroundColor White
    } else {
        Write-Host "   Platform: $Platform" -ForegroundColor White
    }
    Write-Host "   Environment: $normalizedEnv" -ForegroundColor White
    if ($DeployType -eq "ota") {
        Write-Host "   Deploy type: OTA update" -ForegroundColor White
        Write-Host "   Channel: $updateChannel" -ForegroundColor White
        Write-Host "   Message: $UpdateMessage" -ForegroundColor White
    } else {
        Write-Host "   Deploy type: Fresh build" -ForegroundColor White
        Write-Host "   Profile: $profile" -ForegroundColor White
        if ($Local) {
            Write-Host "   Build: Local (--local)" -ForegroundColor White
        } elseif (-not $PSBoundParameters.ContainsKey('Local')) {
            Write-Host "   Build: GitHub Actions (default)" -ForegroundColor White
        } else {
            Write-Host "   Build: EAS cloud" -ForegroundColor White
        }
    }
    if ($DeployType -eq "build" -and $Version -and $BuildNumber) {
        Write-Host "   Version name: $Version" -ForegroundColor White
        $buildLabel = if ($Platform -eq "ios") { "Build number" } else { "Version code" }
        Write-Host "   ${buildLabel}: $BuildNumber" -ForegroundColor White
        if ($normalizedEnv -ne "production") {
            Write-Host "   Numbers reused from app.versions.json (production file unchanged)" -ForegroundColor Gray
        }
    }
    if ($DeployType -eq "build" -and $normalizedEnv -eq "production") {
        # Verify values in app.versions.json match what we expect
        Write-Host "`n🔍 Verifying app.versions.json values:" -ForegroundColor Cyan
        $versionsPath = "$PSScriptRoot\..\app.versions.json"
        $verifyV = Get-Content $versionsPath -Raw | ConvertFrom-Json
        if ($Platform -eq "android") {
            $actualVersionCode = $verifyV.android.versionCode
            Write-Host "   Android versionCode in app.versions.json: $actualVersionCode" -ForegroundColor $(if ([int]$actualVersionCode -eq [int]$BuildNumber) { "Green" } else { "Red" })
            if ([int]$actualVersionCode -ne [int]$BuildNumber) {
                Write-Host "   ⚠️  WARNING: Mismatch! Expected $BuildNumber but found $actualVersionCode" -ForegroundColor Red
            }
        } else {
            $actualBuildNumber = $verifyV.ios.buildNumber
            Write-Host "   iOS buildNumber in app.versions.json: $actualBuildNumber" -ForegroundColor $(if ($actualBuildNumber -eq $BuildNumber) { "Green" } else { "Red" })
            if ($actualBuildNumber -ne $BuildNumber) {
                Write-Host "   ⚠️  WARNING: Mismatch! Expected $BuildNumber but found $actualBuildNumber" -ForegroundColor Red
            }
        }
    }

    # OTA update: publish JS bundle to EAS channel (no native build)
    if ($DeployType -eq "ota") {
        $confirm = Prompt-WithValidation "`nProceed with OTA update? (y/n)" @("y", "n")
        if ($confirm -ne "y") {
            Write-Host "OTA update cancelled." -ForegroundColor Yellow
            exit 0
        }

        Run-EasUpdate -Channel $updateChannel -Message $UpdateMessage
        exit 0
    }

    # Default to GitHub Actions unless -Local (EAS on this machine). EAS cloud: use eas CLI directly.
    $useGitHubActions = -not $PSBoundParameters.ContainsKey('Local')

    # GitHub Actions: trigger workflow (branch already pushed earlier)
    if ($useGitHubActions) {
        Write-Host "`n🚀 Triggering GitHub Actions workflow..." -ForegroundColor Cyan
        Set-Location "$PSScriptRoot\.."
        
        # Verify we're in the right repo
        $remoteUrl = git remote get-url origin 2>&1
        if ($remoteUrl -match 'github\.com[/:]([^/]+)/([^/\.]+)') {
            $repoOwner = $matches[1]
            $repoName = $matches[2] -replace '\.git$', ''
            Write-Host "   Repository: $repoOwner/$repoName" -ForegroundColor Gray
        }
        
        # Use 'main' branch for workflow_dispatch (GitHub requires workflows on default branch)
        # The script already merged francis into main and pushed main earlier
        $workflowFile = if ($Platform -eq "android") { "build-android.yml" } else { "build-ios.yml" }
        $workflowPath = ".github/workflows/$workflowFile"
        
        # Verify workflow file exists locally and has workflow_dispatch
        if (-not (Test-Path $workflowPath)) {
            Write-Host "❌ Workflow file not found: $workflowPath" -ForegroundColor Red
            exit 1
        }
        $workflowContent = Get-Content $workflowPath -Raw
        if ($workflowContent -notmatch 'workflow_dispatch') {
            Write-Host "❌ Workflow file does not contain 'workflow_dispatch' trigger" -ForegroundColor Red
            Write-Host "   Please add 'workflow_dispatch:' to the 'on:' section in $workflowPath" -ForegroundColor Yellow
            exit 1
        }
        Write-Host "✅ Verified workflow file has workflow_dispatch trigger" -ForegroundColor Green
        
        if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
            $ghPaths = @("$env:ProgramFiles\GitHub CLI\gh.exe", "${env:ProgramFiles(x86)}\GitHub CLI\gh.exe", "$env:LOCALAPPDATA\Programs\GitHub CLI\gh.exe")
            foreach ($p in $ghPaths) {
                if (Test-Path $p) { $env:PATH = "$(Split-Path $p);$env:PATH"; break }
            }
        }
        
        # First, verify what GitHub sees on the remote main branch
        Write-Host "   Checking workflow on remote main branch..." -ForegroundColor Gray
        
        # Fetch latest from remote to ensure we have the latest main
        Write-Host "   Fetching latest from origin/main..." -ForegroundColor Gray
        git fetch origin main 2>&1 | Out-Null
        
        # Check what's actually in the remote main branch's workflow file
        Write-Host "   Checking workflow file content on origin/main..." -ForegroundColor Gray
        $remoteWorkflowContent = git show "origin/main:.github/workflows/$workflowFile" 2>&1
        if ($LASTEXITCODE -eq 0 -and $remoteWorkflowContent) {
            if ($remoteWorkflowContent -match 'workflow_dispatch') {
                Write-Host "   ✅ Remote main branch HAS workflow_dispatch in workflow file" -ForegroundColor Green
            } else {
                Write-Host "   ❌ Remote main branch does NOT have workflow_dispatch in workflow file" -ForegroundColor Red
                Write-Host "   This is the problem - the workflow file on main is outdated!" -ForegroundColor Red
                Write-Host "   Attempting to fix by ensuring workflow file is on main..." -ForegroundColor Yellow
                
                # Switch to main and ensure workflow file is there
                $currentBranch = git rev-parse --abbrev-ref HEAD
                git checkout main 2>&1 | Out-Null
                if ($LASTEXITCODE -eq 0) {
                    # Copy workflow file from francis if it exists there
                    git checkout francis -- $workflowPath 2>&1 | Out-Null
                    if ($LASTEXITCODE -eq 0 -and (Test-Path $workflowPath)) {
                        git add $workflowPath 2>&1 | Out-Null
                        git commit -m "Add workflow_dispatch to workflow file" 2>&1 | Out-Null
                        if ($LASTEXITCODE -eq 0) {
                            Write-Host "   ✅ Committed updated workflow file to main" -ForegroundColor Green
                            git push origin main --force-with-lease 2>&1 | Out-Null
                            if ($LASTEXITCODE -ne 0) {
                                git push origin main --force 2>&1 | Out-Null
                            }
                            if ($LASTEXITCODE -eq 0) {
                                Write-Host "   ✅ Pushed updated workflow file to main" -ForegroundColor Green
                                Write-Host "   Waiting 10 seconds for GitHub to process..." -ForegroundColor Yellow
                                Start-Sleep -Seconds 10
                            }
                        }
                    }
                    # Switch back to original branch
                    git checkout $currentBranch 2>&1 | Out-Null
                }
            }
        } else {
            Write-Host "   ⚠️  Could not read workflow file from origin/main" -ForegroundColor Yellow
        }
        
        # Also check via GitHub API
        $workflowInfo = gh workflow view $workflowFile --ref main 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "   ✅ Workflow exists on GitHub" -ForegroundColor Green
        } else {
            Write-Host "   ⚠️  Could not verify workflow on GitHub (may need sync time)" -ForegroundColor Yellow
        }
        
        # Retry mechanism: GitHub may need time to sync workflow file updates after push
        $maxRetries = 3
        $retryDelay = 15
        $triggered = $false
        $workflowName = if ($Platform -eq "android") { "Build Android (EAS local)" } else { "Build iOS (EAS local)" }
        $triggerArgs = @("-f", "profile=$profile", "--ref", "main")
        if ($Platform -eq "android") {
            if ($BuildNumber -notmatch '^\d+$') {
                Write-Host "❌ Android GitHub Actions requires -BuildNumber <n> (versionCode)." -ForegroundColor Red
                exit 1
            }
            $triggerArgs += @("-f", "android_version_code=$BuildNumber")
            Write-Host "   Workflow: android_version_code=$BuildNumber" -ForegroundColor Gray
        }
        if ($Platform -eq "ios") {
            if ($BuildNumber -notmatch '^\d+$') {
                Write-Host "❌ iOS GitHub Actions requires -BuildNumber <n> (CFBundleVersion)." -ForegroundColor Red
                exit 1
            }
            if ([string]::IsNullOrWhiteSpace($Version)) {
                Write-Host "❌ iOS GitHub Actions requires -Version <marketing> (e.g. 1.0.19) so the IPA matches App Store Connect." -ForegroundColor Red
                exit 1
            }
            $triggerArgs += @("-f", "ios_build_number=$BuildNumber", "-f", "ios_app_version=$Version")
            Write-Host "   Workflow: ios_build_number=$BuildNumber ios_app_version=$Version" -ForegroundColor Gray
        }
        if ($Platform -eq "android" -or $Platform -eq "ios") {
            Write-Host "   Waiting 20s so origin/main is consistent before Actions checkout..." -ForegroundColor Gray
            Start-Sleep -Seconds 20
        }

        for ($retry = 1; $retry -le $maxRetries; $retry++) {
            if ($retry -gt 1) {
                Write-Host "   Retry attempt $retry of $maxRetries (waiting ${retryDelay}s for GitHub sync)..." -ForegroundColor Yellow
                Start-Sleep -Seconds $retryDelay
                $retryDelay = $retryDelay * 2
            } else {
                Write-Host "Triggering $workflowFile for ref main (profile $profile)..." -ForegroundColor Cyan
            }

            # Try by filename first, then by workflow name (helps when GitHub has stale workflow_dispatch)
            $triggerOutput = gh workflow run $workflowFile @triggerArgs 2>&1
            if ($LASTEXITCODE -eq 0) {
                Write-Host "✅ Triggered $Platform build on main. See Actions tab for run." -ForegroundColor Green
                $triggered = $true
                break
            }
            if ($retry -eq 1) {
                Write-Host "   Error: $triggerOutput" -ForegroundColor Red
                if ($triggerOutput -match "workflow_dispatch|422") {
                    Write-Host "   Trying by workflow name in case GitHub sync is delayed..." -ForegroundColor Yellow
                    $triggerOutput2 = gh workflow run $workflowName @triggerArgs 2>&1
                    if ($LASTEXITCODE -eq 0) {
                        Write-Host "✅ Triggered $Platform build (by name). See Actions tab for run." -ForegroundColor Green
                        $triggered = $true
                        break
                    }
                }
            }
        }
        
        if (-not $triggered) {
            Write-Host "⚠️  Could not trigger workflow after $maxRetries attempts." -ForegroundColor Yellow
            Write-Host "`n   Troubleshooting:" -ForegroundColor Cyan
            
            # Check what GitHub API sees
            Write-Host "   Checking GitHub API for workflow..." -ForegroundColor Gray
            $apiCheck = gh api "repos/:owner/:repo/actions/workflows/$workflowFile" 2>&1
            if ($LASTEXITCODE -eq 0) {
                $hasDispatch = $apiCheck | ConvertFrom-Json | Select-Object -ExpandProperty state -ErrorAction SilentlyContinue
                Write-Host "   Workflow state from API: $hasDispatch" -ForegroundColor Gray
            }
            
            # Check remote file content
            Write-Host "   Checking remote workflow file content..." -ForegroundColor Gray
            $remoteContent = gh api "repos/:owner/:repo/contents/.github/workflows/$workflowFile?ref=main" 2>&1
            if ($LASTEXITCODE -eq 0) {
                try {
                    $contentJson = $remoteContent | ConvertFrom-Json
                    $decoded = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($contentJson.content))
                    if ($decoded -match 'workflow_dispatch') {
                        Write-Host "   ✅ Remote file HAS workflow_dispatch" -ForegroundColor Green
                        Write-Host "   ⚠️  GitHub may need more time to process the workflow file update" -ForegroundColor Yellow
                    } else {
                        Write-Host "   ❌ Remote file does NOT have workflow_dispatch" -ForegroundColor Red
                        Write-Host "   The workflow file on main may be outdated" -ForegroundColor Yellow
                    }
                } catch {
                    Write-Host "   Could not decode remote file content" -ForegroundColor Yellow
                }
            }
            
            Write-Host "`n   Next steps:" -ForegroundColor Cyan
            Write-Host "   1. Wait 60-120 seconds for GitHub to sync, then run: gh workflow run `"$workflowName`" -f profile=$profile --ref main" -ForegroundColor Gray
            Write-Host "   2. iOS: gh workflow run build-ios.yml -f profile=production -f ios_build_number=2 -f ios_app_version=1.0.19 --ref main" -ForegroundColor Gray
            Write-Host "   3. UI: set ios_build_number + ios_app_version (must match new App Store version)" -ForegroundColor Gray
            Write-Host "   4. workflow_dispatch 422: push workflow file to main, wait 60s, retry" -ForegroundColor Gray
            Write-Host "   5. gh workflow view $workflowFile --ref main" -ForegroundColor Gray
        }
        exit 0
    }

    # EAS local does not support Windows (macOS or Linux only). Warn and exit for local + Windows.
    if ($Local -and $Platform -eq "android" -and $env:OS -eq "Windows_NT") {
        Write-Host "❌ EAS local build for Android is not supported on Windows (Expo requires macOS or Linux)." -ForegroundColor Red
        Write-Host "   Options:" -ForegroundColor Yellow
        Write-Host "   1. Use GitHub Actions: push to main or run 'gh workflow run build-android.yml' (builds on Linux)." -ForegroundColor White
        Write-Host "   2. Use EAS cloud: eas build --profile <profile> --platform android (from repo root)." -ForegroundColor White
        Write-Host "   3. Use WSL: run this script from inside WSL (Linux) on your PC." -ForegroundColor White
        exit 1
    }
    if ($Local -and $Platform -eq "ios" -and $env:OS -eq "Windows_NT") {
        Write-Host "❌ EAS local build for iOS requires macOS (Xcode). Windows cannot build iOS." -ForegroundColor Red
        Write-Host "   Use GitHub Actions: 'gh workflow run build-ios.yml' or push to main." -ForegroundColor Yellow
        exit 1
    }

    $confirm = Prompt-WithValidation "`nProceed with deployment? (y/n)" @("y", "n")
    if ($confirm -ne "y") {
        Write-Host "Deployment cancelled." -ForegroundColor Yellow
        exit 0
    }

    # Run the build
    Run-EasBuild -Platform $Platform -Profile $profile -Local:$Local

} catch {
    Write-Host "❌ Script error: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
