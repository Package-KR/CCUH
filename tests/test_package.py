import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/package_plugin.py"
SPEC = importlib.util.spec_from_file_location("ccuh_package", SCRIPT)
package = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(package)

EXPECTED_ARCHIVE = {
    "plugin.json",
    ".codex-plugin/plugin.json",
    "skills/ccuh/SKILL.md",
    "skills/ccuh/scripts/target-session.js",
    "skills/ccuh/scripts/target-discovery.js",
    "skills/ccuh-doctor/SKILL.md",
    "skills/ccuh-doctor/scripts/doctor.py",
    "skills/ccuh-doctor/scripts/recovery.py",
    "skills/ccuh-doctor/scripts/desktop_recovery.py",
    "README.md",
    "README.ko.md",
    "LICENSE",
}


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "source"
        self.root.mkdir()
        self.manifest = {"name": "ccuh", "version": "0.1.2", "description": "Fixture plugin"}
        self.write("plugin.json", json.dumps(self.manifest))
        self.write(".codex-plugin/plugin.json", json.dumps(self.manifest))
        self.write(
            "skills/ccuh/SKILL.md",
            "---\nname: ccuh\ndescription: Keep an exact target.\n---\n# CCUH\n",
        )
        self.write("skills/ccuh/scripts/target-session.js", "throw new Error('must not execute fixture runtime');\n")
        self.write("skills/ccuh/scripts/target-discovery.js", "throw new Error('must not execute fixture discovery');\n")
        self.write(
            "skills/ccuh-doctor/SKILL.md",
            "---\nname: ccuh-doctor\ndescription: Diagnose a selected failure.\n---\n"
            "Run `python3 <this-skill-directory>/scripts/doctor.py`.\n",
        )
        self.write("skills/ccuh-doctor/scripts/doctor.py", "print('fixture diagnostic')\n")
        self.write("skills/ccuh-doctor/scripts/recovery.py", "print('fixture recovery')\n")
        self.write("skills/ccuh-doctor/scripts/desktop_recovery.py", "print('fixture desktop recovery')\n")
        self.write(
            "README.md",
            "# CCUH\n[한국어](README.ko.md)\nUser installation instructions.\n[MIT](LICENSE)\n",
        )
        self.write("README.ko.md", "# CCUH\n[English](README.md)\n사용 안내.\n[MIT](LICENSE)\n")
        self.write("LICENSE", "MIT License\nCopyright (c) Fixture\n")

    def write(self, relative, text):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def install_builder(self):
        destination = self.root / "scripts/package_plugin.py"
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(SCRIPT, destination)
        return destination

    def cli(self, *arguments):
        builder = self.install_builder()
        return subprocess.run(
            [sys.executable, str(builder), *map(str, arguments)],
            cwd=self.temporary.name,
            capture_output=True,
            text=True,
            check=False,
        )

    def test_archive_contains_only_release_assets_at_root(self):
        for path in (
            ".git/config",
            ".claude-plugin/marketplace.json",
            "lab/secret.json",
            "tests/test_private.py",
            "notes/draft.md",
            "skills/ccuh-doctor/scripts/__pycache__/doctor.pyc",
            "arbitrary.log",
        ):
            self.write(path, "development-only fixture")
        output = package.build_plugin(self.root)
        self.assertEqual(output, self.root / "dist/ccuh-0.1.2.zip")
        with zipfile.ZipFile(output) as archive:
            self.assertEqual(set(archive.namelist()), EXPECTED_ARCHIVE)
            self.assertEqual(len(archive.namelist()), len(EXPECTED_ARCHIVE))
            for path in ("README.md", "README.ko.md", "LICENSE"):
                self.assertEqual(archive.read(path), (self.root / path).read_bytes())
            self.assertIsNone(archive.testzip())

    def test_manifests_and_both_skills_are_preserved_in_archive(self):
        with zipfile.ZipFile(package.build_plugin(self.root)) as archive:
            for path in ("plugin.json", ".codex-plugin/plugin.json"):
                value = json.loads(archive.read(path))
                self.assertEqual(value["name"], "ccuh")
                self.assertEqual(value["version"], "0.1.2")
            for name in ("ccuh", "ccuh-doctor"):
                path = "skills/{}/SKILL.md".format(name)
                self.assertEqual(archive.read(path), (self.root / path).read_bytes())
            for helper in (
                "skills/ccuh/scripts/target-session.js",
                "skills/ccuh/scripts/target-discovery.js",
                "skills/ccuh-doctor/scripts/doctor.py",
                "skills/ccuh-doctor/scripts/recovery.py",
                "skills/ccuh-doctor/scripts/desktop_recovery.py",
            ):
                self.assertEqual(archive.read(helper), (self.root / helper).read_bytes())

    def test_extracted_doctor_skill_has_its_helper_without_repository(self):
        output = package.build_plugin(self.root)
        installed = Path(self.temporary.name) / "installed"
        with zipfile.ZipFile(output) as archive:
            archive.extractall(installed)
        shutil.rmtree(self.root)
        for helper, expected in (
            ("doctor.py", "fixture diagnostic"),
            ("recovery.py", "fixture recovery"),
            ("desktop_recovery.py", "fixture desktop recovery"),
        ):
            with self.subTest(helper=helper):
                result = subprocess.run(
                    [sys.executable, str(installed / "skills/ccuh-doctor/scripts" / helper)],
                    cwd=self.temporary.name,
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), expected)

    def test_builder_does_not_import_or_execute_the_helper(self):
        self.write("skills/ccuh-doctor/scripts/doctor.py", "raise RuntimeError('must not execute')\n")
        self.write("skills/ccuh-doctor/scripts/recovery.py", "raise RuntimeError('must not execute recovery')\n")
        self.write("skills/ccuh-doctor/scripts/desktop_recovery.py", "raise RuntimeError('must not execute desktop recovery')\n")
        self.assertEqual(package.check_plugin(self.root), "0.1.2")
        self.assertTrue(package.build_plugin(self.root).is_file())

    def test_missing_required_file_fails_without_partial_archive(self):
        for relative, _archive in package.PACKAGE_FILES:
            path = self.root / relative
            original = path.read_bytes()
            with self.subTest(path=relative):
                path.unlink()
                with self.assertRaises(package.PackageError):
                    package.build_plugin(self.root)
                self.assertFalse((self.root / "dist").exists())
            path.write_bytes(original)

    def test_source_file_and_parent_directory_symlinks_are_rejected(self):
        helper = self.root / "skills/ccuh-doctor/scripts/doctor.py"
        external = Path(self.temporary.name) / "external.py"
        helper.rename(external)
        helper.symlink_to(external)
        with self.assertRaisesRegex(package.PackageError, "Symlink"):
            package.check_plugin(self.root)
        helper.unlink()
        helper.write_text("print('fixture diagnostic')\n", encoding="utf-8")
        scripts = helper.parent
        outside_directory = Path(self.temporary.name) / "external-scripts"
        scripts.rename(outside_directory)
        scripts.symlink_to(outside_directory, target_is_directory=True)
        with self.assertRaisesRegex(package.PackageError, "Symlink"):
            package.build_plugin(self.root)

    def test_manifest_name_version_and_json_validation(self):
        for manifest in (
            {"name": "other", "version": "0.1.2"},
            {"name": "ccuh", "version": "0.1.3"},
            {"name": "ccuh", "version": "../../outside"},
            {"name": "ccuh", "version": 12},
            [],
        ):
            with self.subTest(manifest=manifest):
                self.write(".codex-plugin/plugin.json", json.dumps(manifest))
                with self.assertRaises(package.PackageError):
                    package.check_plugin(self.root)
        self.write(".codex-plugin/plugin.json", "not JSON")
        with self.assertRaisesRegex(package.PackageError, "JSON"):
            package.check_plugin(self.root)

    def test_required_skill_metadata_is_checked_without_yaml_dependency(self):
        invalid = (
            "name: ccuh-doctor\ndescription: Missing boundaries\n",
            "---\nname: ccuh-doctor\ndescription: Unclosed\n",
            "---\nname: ccuh\ndescription: Wrong skill name\n---\n",
            "---\nname: ccuh-doctor\n---\n",
            "---\nname: ccuh-doctor\ndescription: ''\n---\n",
            "---\nname: ccuh-doctor\nname: ccuh-doctor\ndescription: Duplicate\n---\n",
            "---\nname: ccuh-doctor\ndescription: >\n  Unsupported multiline\n---\n",
        )
        for text in invalid:
            with self.subTest(frontmatter=text):
                self.write("skills/ccuh-doctor/SKILL.md", text)
                with self.assertRaises(package.PackageError):
                    package.check_plugin(self.root)

    def test_check_writes_nothing_even_with_output_option(self):
        output = Path(self.temporary.name) / "not-created" / "plugin.zip"
        result = self.cli("--check", "--output", output)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Validated CCUH 0.1.2", result.stdout)
        self.assertFalse(output.parent.exists())
        self.assertFalse((self.root / "dist").exists())

    def test_cli_detects_root_from_script_and_honors_output(self):
        output = Path(self.temporary.name) / "custom" / "ccuh.zip"
        result = self.cli("--output", output)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(output.is_file())
        with zipfile.ZipFile(output) as archive:
            self.assertEqual(set(archive.namelist()), EXPECTED_ARCHIVE)

    def test_cli_default_output_uses_manifest_version(self):
        result = self.cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.root / "dist/ccuh-0.1.2.zip").is_file())

    def test_invalid_cli_source_fails_without_output(self):
        (self.root / "plugin.json").unlink()
        result = self.cli()
        self.assertEqual(result.returncode, 1)
        self.assertIn("Required regular file is missing", result.stderr)
        self.assertFalse((self.root / "dist").exists())

    def test_output_cannot_overwrite_a_release_source_or_follow_symlink(self):
        original = (self.root / "plugin.json").read_bytes()
        with self.assertRaises(package.PackageError):
            package.build_plugin(self.root, self.root / "plugin.json")
        self.assertEqual((self.root / "plugin.json").read_bytes(), original)
        destination = Path(self.temporary.name) / "output.zip"
        destination.symlink_to(self.root / "plugin.json")
        with self.assertRaises(package.PackageError):
            package.build_plugin(self.root, destination)
        self.assertEqual((self.root / "plugin.json").read_bytes(), original)

    def test_identical_sources_build_reproducible_archives(self):
        first = package.build_plugin(self.root, self.root / "dist/first.zip")
        second = package.build_plugin(self.root, self.root / "dist/second.zip")
        self.assertEqual(first.read_bytes(), second.read_bytes())


if __name__ == "__main__":
    unittest.main()
