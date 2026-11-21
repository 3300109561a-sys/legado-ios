"""Validate project.pbxproj: parse the OpenStep plist and check the object graph.

Catches the failure mode that actually breaks CI: dangling object references,
unbalanced braces, missing build phases, wrong product type, and a deployment
target that would exclude iPad 6 / iOS 16.3.1.
"""
import re
import sys
import os

PATH = sys.argv[1] if len(sys.argv) > 1 else (
    r"D:\Documents\deepseek-harness\default-workspace\legado-ios\ios\LegadoMobile.xcodeproj\project.pbxproj"
)

text = open(PATH, encoding="utf-8").read()

# strip the leading // !$*UTF8*$! marker and all /* ... */ comments
body = re.sub(r"^\s*//[^\n]*\n", "", text)
body = re.sub(r"/\*.*?\*/", "", body, flags=re.S)

# ---- tokenizer for OpenStep plist ----
TOKEN = re.compile(r'\s*(?:(?P<str>"(?:[^"\\]|\\.)*")|(?P<word>[^\s{}();,=]+)|(?P<punc>[{}();,=]))', re.S)

tokens = []
pos = 0
while pos < len(body):
    m = TOKEN.match(body, pos)
    if not m:
        rest = body[pos:pos + 40]
        if rest.strip() == "":
            break
        raise SystemExit(f"tokenize failed at {pos}: {rest!r}")
    pos = m.end()
    if m.group("str") is not None:
        tokens.append(("str", m.group("str")[1:-1]))
    elif m.group("word") is not None:
        tokens.append(("word", m.group("word")))
    elif m.group("punc") is not None:
        tokens.append(("punc", m.group("punc")))

i = 0


def parse_dict():
    global i
    assert tokens[i] == ("punc", "{"), f"expected '{{' at {i}: {tokens[i]}"
    i += 1
    d = {}
    while tokens[i] != ("punc", "}"):
        k = tokens[i][1]
        i += 1
        assert tokens[i] == ("punc", "="), f"expected '=' after {k}, got {tokens[i]}"
        i += 1
        v = parse_value()
        assert tokens[i] == ("punc", ";"), f"expected ';' after {k}, got {tokens[i]}"
        i += 1
        d[k] = v
    i += 1
    return d


def parse_value():
    global i
    t, v = tokens[i]
    if t == "punc" and v == "{":
        return parse_dict()
    if t == "punc" and v == "(":
        i += 1
        arr = []
        while tokens[i] != ("punc", ")"):
            arr.append(parse_value())
            if tokens[i] == ("punc", ","):
                i += 1
        i += 1
        return arr
    i += 1
    return v


root = parse_dict()
objs = root["objects"]
print(f"parsed OK: {len(objs)} objects")

errors = []
warnings = []

# ---- collect every referenced id ----
REF_KEYS = {
    "fileRef", "buildConfigurationList", "productReference", "mainGroup",
    "productRefGroup", "rootObject",
}
all_text_ids = set(re.findall(r"\b([0-9A-F]{24})\b", body))

def walk(node, path=""):
    if isinstance(node, dict):
        for k, v in node.items():
            if k in REF_KEYS and isinstance(v, str):
                if v not in objs:
                    errors.append(f"{path}.{k} -> missing object {v}")
            if k in ("children", "files", "buildPhases", "buildConfigurations",
                     "targets", "dependencies"):
                if isinstance(v, list):
                    for idx, item in enumerate(v):
                        if isinstance(item, str) and item not in objs:
                            errors.append(f"{path}.{k}[{idx}] -> missing object {item}")
            walk(v, f"{path}.{k}")
    elif isinstance(node, list):
        for idx, v in enumerate(node):
            walk(v, f"{path}[{idx}]")

walk(objs)

# ---- required sections ----
for isa in ["PBXProject", "PBXNativeTarget", "PBXSourcesBuildPhase",
            "PBXResourcesBuildPhase", "PBXFrameworksBuildPhase",
            "XCConfigurationList", "XCBuildConfiguration", "PBXGroup",
            "PBXBuildFile", "PBXFileReference"]:
    if not any(o.get("isa") == isa for o in objs.values() if isinstance(o, dict)):
        errors.append(f"missing required section {isa}")

# ---- the target must be an app, and must reference real phases ----
targets = [o for o in objs.values() if isinstance(o, dict) and o.get("isa") == "PBXNativeTarget"]
for t in targets:
    if t.get("productType") != "com.apple.product-type.application":
        errors.append(f"target {t.get('name')} has productType {t.get('productType')}")
    for ph in t.get("buildPhases", []):
        if ph not in objs:
            errors.append(f"target {t.get('name')} references missing phase {ph}")
    if not t.get("buildConfigurationList"):
        errors.append(f"target {t.get('name')} has no buildConfigurationList")

# ---- every Swift file in the sources phase must exist on disk ----
proj_dir = os.path.dirname(PATH)
src_root = os.path.join(proj_dir, "..", "LegadoMobile")
src_root = os.path.normpath(src_root)

file_refs = {k: v for k, v in objs.items()
             if isinstance(v, dict) and v.get("isa") == "PBXFileReference"}
src_phase_files = []
for o in objs.values():
    if isinstance(o, dict) and o.get("isa") == "PBXSourcesBuildPhase":
        for bf in o.get("files", []):
            entry = objs[bf]
            ref = entry.get("fileRef")
            fr = file_refs.get(ref)
            if not fr:
                errors.append(f"build file {bf} -> missing fileRef {ref}")
                continue
            src_phase_files.append(fr["path"])

for f in src_phase_files:
    full = os.path.join(src_root, f)
    if not os.path.exists(full):
        errors.append(f"sources phase references missing file: {full}")
    else:
        print(f"  source ok: {f}")

if not src_phase_files:
    warnings.append("no Swift files in the Sources build phase (CI would produce an empty app)")

# ---- resource refs must exist ----
for o in objs.values():
    if isinstance(o, dict) and o.get("isa") == "PBXResourcesBuildPhase":
        for bf in o.get("files", []):
            fr = file_refs.get(objs[bf].get("fileRef"))
            if not fr:
                errors.append(f"resource build file {bf} -> missing fileRef")
                continue
            full = os.path.join(src_root, fr["path"])
            if not os.path.exists(full):
                errors.append(f"resource missing on disk: {full}")
            else:
                print(f"  resource ok: {fr['path']}")

# ---- deployment target must include iOS 16.3.1 / arm64 ----
deploy = []
for o in objs.values():
    if isinstance(o, dict) and o.get("isa") == "XCBuildConfiguration":
        bs = o.get("buildSettings", {})
        if "IPHONEOS_DEPLOYMENT_TARGET" in bs:
            deploy.append(bs["IPHONEOS_DEPLOYMENT_TARGET"])
if not deploy:
    errors.append("no IPHONEOS_DEPLOYMENT_TARGET set")
else:
    for v in set(deploy):
        try:
            major = int(str(v).split(".")[0])
        except ValueError:
            errors.append(f"unparseable deployment target {v}")
            continue
        if major > 16:
            errors.append(f"deployment target {v} would exclude iOS 16.3.1")
        else:
            print(f"  deployment target ok: {v} (iPad 6 / iOS 16.3.1 runs 16.x)")

print()
for w in warnings:
    print("WARN", w)
for e in errors:
    print("ERROR", e)

if errors:
    raise SystemExit(f"{len(errors)} problem(s) found")
print("pbxproj validation passed")
