#!/usr/bin/env node
// Prepares desktop/resources/python: an embedded Python 3.11 runtime plus the
// pinned moc-core wheel and its scientific dependencies.
//
// Windows: downloads the official embeddable distribution (sha256-pinned) and
// installs the wheels into site-packages so the app is fully offline.
// Linux/macOS (dev smoke only): reuses the system python3 interpreter and just
// stages site-packages; the desktop runtime also falls back to system python3
// when the embedded runtime is absent.
"use strict";

const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PYTHON_VERSION = "3.11.9";
const EMBEDDED_ZIP = `python-${PYTHON_VERSION}-embed-amd64.zip`;
const PINNED_SHA256 = "009d6bf7e3b2ddca3d784fa09f90fe54336d5b60f0e0f305c37f400bf83cfd3b";
const MIRROR_URLS = [
  `https://registry.npmmirror.com/-/binary/python/${PYTHON_VERSION}/${EMBEDDED_ZIP}`,
  `https://www.python.org/ftp/python/${PYTHON_VERSION}/${EMBEDDED_ZIP}`
];

const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const pythonRoot = path.join(desktopRoot, "resources", "python");
const sitePackages = path.join(pythonRoot, "site-packages");
const requirementsLock = path.join(repoRoot, "vendor", "moc-core", "requirements.lock");
const mocCoreWheel = path.join(repoRoot, "vendor", "moc-core", "astro_survey_moc_core-1.0.0-py3-none-any.whl");

function pipTarget(pythonExecutable, target) {
  execFileSync(
    pythonExecutable,
    ["-m", "pip", "install", "--no-compile", "--target", target, "-r", requirementsLock, mocCoreWheel],
    { stdio: "inherit" }
  );
}

async function downloadEmbeddedZip() {
  const target = path.join(desktopRoot, "build", EMBEDDED_ZIP);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  for (const url of MIRROR_URLS) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      const digest = crypto.createHash("sha256").update(buffer).digest("hex");
      if (digest !== PINNED_SHA256) {
        throw new Error(`sha256 mismatch for ${url}: got ${digest}`);
      }
      fs.writeFileSync(target, buffer);
      return target;
    } catch (error) {
      console.warn(`download failed (${url}): ${error.message}`);
    }
  }
  throw new Error(`could not download ${EMBEDDED_ZIP} from any mirror`);
}

async function main() {
  fs.rmSync(pythonRoot, { recursive: true, force: true });
  fs.mkdirSync(pythonRoot, { recursive: true });

  if (process.platform === "win32") {
    const zipPath = await downloadEmbeddedZip();
    execFileSync("powershell.exe", [
      "-NoProfile", "-Command",
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${pythonRoot}' -Force`
    ], { stdio: "inherit" });

    // Enable site-packages resolution in the embeddable distribution.
    const pthPath = path.join(pythonRoot, `python${PYTHON_VERSION.split(".").slice(0, 2).join("")}._pth`);
    const pth = fs.readFileSync(pthPath, "utf8");
    const patched = pth.replace(/^#import site$/m, "import site") + "\nsite-packages\n";
    fs.writeFileSync(pthPath, patched);

    const systemPython = process.env.PYTHON || "py";
    pipTarget(systemPython, sitePackages);
    console.log(`prepared embedded python ${PYTHON_VERSION} at ${pythonRoot}`);
    return;
  }

  // Dev smoke on Linux/macOS: stage site-packages for the system interpreter.
  const systemPython = process.env.PYTHON || "python3";
  pipTarget(systemPython, sitePackages);
  fs.writeFileSync(
    path.join(pythonRoot, "README.txt"),
    "Dev staging area. Windows installers ship an embedded Python 3.11 here instead.\n"
  );
  console.log(`staged moc-core site-packages for ${systemPython} at ${sitePackages}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
