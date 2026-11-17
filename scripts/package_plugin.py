#!/usr/bin/env python3
"""Validate and package the CCUH user plugin with Python 3.9's stdlib."""

import argparse
import json
import os
import re
import stat
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Dict, Optional, Tuple


# Source path -> archive path. New repository files never enter a release by default.
PACKAGE_FILES = (
    ("plugin.json", "plugin.json"),
    (".codex-plugin/plugin.json", ".codex-plugin/plugin.json"),
    ("skills/ccuh/SKILL.md", "skills/ccuh/SKILL.md"),
    ("skills/ccuh/scripts/target-session.js", "skills/ccuh/scripts/target-session.js"),
    ("skills/ccuh-doctor/SKILL.md", "skills/ccuh-doctor/SKILL.md"),
    (
        "skills/ccuh-doctor/scripts/doctor.py",
        "skills/ccuh-doctor/scripts/doctor.py",
    ),
    ("README.md", "README.md"),
    ("README.ko.md", "README.ko.md"),
    ("LICENSE", "LICENSE"),
)

VERSION_PATTERN = re.compile(
    r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
    r"(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
)


class PackageError(ValueError):
    """A source file cannot be included in a CCUH release."""


def repository_root() -> Path:
    """Locate the repository from this script, independently of the caller's cwd."""
    return Path(__file__).resolve().parent.parent


def _source_bytes(root: Path, relative: str) -> bytes:
    source = root / relative
    current = source
    while current != root:
        if current.is_symlink():
            raise PackageError("Symlink source is not allowed: {}".format(relative))
        current = current.parent
    if not source.is_file():
        raise PackageError("Required regular file is missing: {}".format(relative))
    return source.read_bytes()


def _text(data: bytes, relative: str) -> str:
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise PackageError("Required file is not UTF-8: {}".format(relative)) from error


def _manifest(data: bytes, relative: str) -> Dict[str, object]:
    try:
        value = json.loads(_text(data, relative))
    except json.JSONDecodeError as error:
        raise PackageError("Invalid JSON manifest: {}".format(relative)) from error
    if not isinstance(value, dict):
        raise PackageError("Manifest must be a JSON object: {}".format(relative))
    if value.get("name") != "ccuh":
        raise PackageError("Manifest name must be ccuh: {}".format(relative))
    version = value.get("version")
    if not isinstance(version, str) or VERSION_PATTERN.fullmatch(version) is None:
        raise PackageError("Manifest requires an x.y.z version: {}".format(relative))
    return value


def _skill_frontmatter(data: bytes, relative: str, expected_name: str) -> None:
    """Check our two single-line metadata fields, not arbitrary YAML syntax."""
    lines = _text(data, relative).splitlines()
    if not lines or lines[0] != "---":
        raise PackageError("Skill must start with frontmatter: {}".format(relative))
    try:
        end = lines.index("---", 1)
    except ValueError as error:
        raise PackageError("Skill frontmatter is not closed: {}".format(relative)) from error
    fields = {}  # type: Dict[str, str]
    for line in lines[1:end]:
        match = re.match(r"^(name|description):[ \t]*(.*)$", line)
        if match is None:
            continue
        key, value = match.groups()
        if key in fields:
            raise PackageError("Duplicate skill {}: {}".format(key, relative))
        value = value.strip()
        if not value or value.startswith(("|", ">", "#")):
            raise PackageError(
                "Skill {} must be a nonempty single-line value: {}".format(key, relative)
            )
        if value[0] in ("'", '"'):
            if len(value) < 2 or value[-1] != value[0]:
                raise PackageError("Invalid quoted skill {}: {}".format(key, relative))
            value = value[1:-1].strip()
        fields[key] = value
    if fields.get("name") != expected_name:
        raise PackageError("Skill name must be {}: {}".format(expected_name, relative))
    if not fields.get("description"):
        raise PackageError("Skill description is required: {}".format(relative))


def _load_sources(root: Path) -> Tuple[str, Dict[str, bytes]]:
    root = Path(root).absolute()
    if root.is_symlink() or not root.is_dir():
        raise PackageError("Repository root must be a real directory")
    sources = {
        source: _source_bytes(root, source) for source, _destination in PACKAGE_FILES
    }
    # Every distributed text asset must be readable, including the helper. Never import it.
    for source, data in sources.items():
        _text(data, source)
    public = _manifest(sources["plugin.json"], "plugin.json")
    codex = _manifest(sources[".codex-plugin/plugin.json"], ".codex-plugin/plugin.json")
    if public["version"] != codex["version"]:
        raise PackageError("Manifest versions do not match")
    for skill in ("ccuh", "ccuh-doctor"):
        relative = "skills/{}/SKILL.md".format(skill)
        _skill_frontmatter(sources[relative], relative, skill)
    return str(public["version"]), sources


def check_plugin(root: Path) -> str:
    """Validate release sources without creating files or directories."""
    version, _sources = _load_sources(root)
    return version


def build_plugin(root: Path, output: Optional[Path] = None) -> Path:
    """Write the nine allowlisted assets, with manifests at the ZIP's root."""
    root = Path(root).absolute()
    version, sources = _load_sources(root)
    destination = Path(output) if output is not None else root / "dist" / (
        "ccuh-{}.zip".format(version)
    )
    destination = destination.absolute()
    if destination.is_symlink():
        raise PackageError("Archive output cannot be a symlink")
    if destination.resolve() in {
        (root / source).resolve() for source, _archive in PACKAGE_FILES
    }:
        raise PackageError("Archive output cannot overwrite a release source")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            prefix=".ccuh-package-", suffix=".zip", dir=destination.parent, delete=False
        ) as handle:
            temporary = Path(handle.name)
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for source, archive_path in PACKAGE_FILES:
                entry = zipfile.ZipInfo(archive_path, date_time=(1980, 1, 1, 0, 0, 0))
                entry.create_system = 3
                entry.compress_type = zipfile.ZIP_DEFLATED
                entry.external_attr = (stat.S_IFREG | 0o644) << 16
                archive.writestr(entry, sources[source])
        os.replace(str(temporary), str(destination))
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return destination


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="ZIP path (default: dist/ccuh-<version>.zip)")
    parser.add_argument("--check", action="store_true", help="Validate sources without writing a ZIP")
    args = parser.parse_args(argv)
    try:
        root = repository_root()
        if args.check:
            print("Validated CCUH {} (no archive written)".format(check_plugin(root)))
        else:
            print("Built {}".format(build_plugin(root, args.output)))
    except (PackageError, OSError) as error:
        print("Package error: {}".format(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
