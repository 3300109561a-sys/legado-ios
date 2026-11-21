"""Static checks for the iOS deliverables we cannot build locally.

Verifies:
  - Info.plist parses and carries the keys a sideloaded app needs
  - the workflow YAML parses and disables code signing
  - the bundled WebApp matches webapp/ (no stale copy)
  - assets required by CI exist
"""
import plistlib
import sys
import os
import hashlib

ROOT = r"D:\Documents\deepseek-harness\default-workspace\legado-ios"
errors = []
notes = []


def check(cond, msg):
    if cond:
        print("PASS ", msg)
    else:
        print("FAIL ", msg)
        errors.append(msg)


# ---------------- Info.plist ----------------
plist_path = os.path.join(ROOT, "ios", "LegadoMobile", "Info.plist")
with open(plist_path, "rb") as f:
    info = plistlib.load(f)
print(f"Info.plist parsed: {len(info)} keys")

check(info.get("CFBundleDisplayName") == "阅读", "display name is 阅读")
check(info.get("MinimumOSVersion") == "16.0", "MinimumOSVersion is 16.0 (iPad 6 runs 16.3.1)")
check(2 in info.get("UIDeviceFamily", []), "UIDeviceFamily includes iPad (2)")
check("arm64" in info.get("UIRequiredDeviceCapabilities", []), "requires arm64 (A10)")
check(info.get("NSAppTransportSecurity", {}).get("NSAllowsArbitraryLoads") is True,
      "ATS allows the LAN http server")
check(bool(info.get("NSLocalNetworkUsageDescription")), "local network usage description present")
check(info.get("CFBundleShortVersionString") == "1.0.0", "version string set")
launch_color = (info.get("UILaunchScreen") or {}).get("UIColorName", "")
check(bool(launch_color), f"UILaunchScreen names a colour ({launch_color})")
_color_path = os.path.join(ROOT, "ios", "LegadoMobile", "Assets.xcassets",
                           f"{launch_color}.colorset", "Contents.json")
check(os.path.exists(_color_path), f"asset catalog defines {launch_color}")

# ---------------- workflow ----------------
yaml_path = os.path.join(ROOT, ".github", "workflows", "build-ipa.yml")
try:
    import yaml  # noqa
    have_yaml = True
except ImportError:
    have_yaml = False
    notes.append("PyYAML not installed; workflow checked as text only")

wf = open(yaml_path, encoding="utf-8").read()
check("macos-" in wf, "workflow targets a macOS runner")
check("CODE_SIGNING_ALLOWED=NO" in wf, "workflow disables code signing")
check("CODE_SIGN_IDENTITY=\"\"" in wf, "workflow clears CODE_SIGN_IDENTITY")
check("Payload" in wf and "zip" in wf, "workflow packages Payload/*.app into an .ipa")
check("upload-artifact" in wf, "workflow uploads the ipa artifact")
check("-sdk iphoneos" in wf, "workflow builds for the device SDK, not the simulator")
check("ARCHS=arm64" in wf, "workflow builds arm64 (A10 is arm64, not arm64e)")

if have_yaml:
    import yaml
    try:
        doc = yaml.safe_load(wf)
        check(isinstance(doc, dict) and "jobs" in doc, "workflow YAML parses with a jobs key")
        job = doc["jobs"]["build"]
        check("runs-on" in job, "workflow job has runs-on")
        steps = job.get("steps", [])
        check(len(steps) >= 5, f"workflow has {len(steps)} steps")
    except Exception as e:  # noqa
        check(False, f"workflow YAML failed to parse: {e}")

# ---------------- required files ----------------
required = [
    "ios/LegadoMobile.xcodeproj/project.pbxproj",
    "ios/LegadoMobile.xcodeproj/xcshareddata/xcschemes/LegadoMobile.xcscheme",
    "ios/LegadoMobile/LegadoMobileApp.swift",
    "ios/LegadoMobile/Info.plist",
    "ios/LegadoMobile/Assets.xcassets/Contents.json",
    "ios/LegadoMobile/Assets.xcassets/AppIcon.appiconset/Contents.json",
    "ios/LegadoMobile/Assets.xcassets/LaunchBackground.colorset/Contents.json",
    "ios/LegadoMobile/Assets.xcassets/AppIcon.appiconset/icon-1024.png",
    "ios/LegadoMobile/WebApp/index.html",
]
for rel in required:
    full = os.path.join(ROOT, rel.replace("/", os.sep))
    check(os.path.exists(full), f"exists: {rel}")

# 1024 icon must have no alpha (App Store / asset catalog requirement)
from PIL import Image
icon = Image.open(os.path.join(ROOT, "ios", "LegadoMobile", "Assets.xcassets",
                               "AppIcon.appiconset", "icon-1024.png"))
check(icon.size == (1024, 1024), f"AppIcon is 1024x1024 (got {icon.size})")
check(icon.mode == "RGB", f"AppIcon has no alpha channel (mode {icon.mode})")

# ---------------- bundled WebApp must match webapp/ ----------------
def digest_tree(base):
    out = {}
    for dirpath, _dirs, files in os.walk(base):
        for fn in files:
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, base).replace(os.sep, "/")
            out[rel] = hashlib.sha256(open(full, "rb").read()).hexdigest()
    return out

a = digest_tree(os.path.join(ROOT, "webapp"))
b = digest_tree(os.path.join(ROOT, "ios", "LegadoMobile", "WebApp"))
missing = sorted(set(a) - set(b))
extra = sorted(set(b) - set(a))
diff = sorted(k for k in set(a) & set(b) if a[k] != b[k])
check(not missing and not extra and not diff,
      f"bundled WebApp matches webapp/ ({len(a)} files)"
      + (f" missing={missing} extra={extra} diff={diff}" if (missing or extra or diff) else ""))

print()
for n in notes:
    print("NOTE", n)
if errors:
    raise SystemExit(f"{len(errors)} problem(s)")
print("iOS deliverable checks passed")

