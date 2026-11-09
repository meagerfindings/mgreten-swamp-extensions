#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sources = [
  "extensions/domain.ts",
  "extensions/models/meal_planner_runtime.ts",
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function usage() {
  throw new Error(
    "Usage: node tools/stage-app-sources.mjs <stage|verify> <app-root>",
  );
}

async function regularFile(path, label) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} is missing.`);
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file.`);
  }
}

function isWithin(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function checkedPath(root, relativePath, expectedType, label) {
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  let current = root;

  for (const [index, segment] of segments.entries()) {
    const path = resolve(current, segment);
    if (!isWithin(root, path)) {
      throw new Error(`${label} escaped its root.`);
    }

    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (error?.code === "ENOENT") throw new Error(`${label} is missing.`);
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`${label} must not contain symlinks.`);
    }

    const isFinalSegment = index === segments.length - 1;
    if (isFinalSegment) {
      if (expectedType === "file" && !info.isFile()) {
        throw new Error(`${label} must be a regular file.`);
      }
      if (expectedType === "directory" && !info.isDirectory()) {
        throw new Error(`${label} must be a directory.`);
      }
    } else if (!info.isDirectory()) {
      throw new Error(`${label} parent must be a directory.`);
    }

    const actualPath = await realpath(path);
    if (!isWithin(root, actualPath)) {
      throw new Error(`${label} escaped its root.`);
    }
    current = actualPath;
  }

  if (segments.length === 0) {
    throw new Error(`${label} path is invalid.`);
  }
  return current;
}

async function canonicalSourceBytes(packageRootReal, relativePath) {
  const sourcePath = await checkedPath(
    packageRootReal,
    relativePath,
    "file",
    `Canonical source ${relativePath}`,
  );
  return await readFile(sourcePath);
}

async function inspectDestinationDirectories(appRootReal, relativePaths, mode) {
  const directories = new Set();
  for (const relativePath of relativePaths) {
    const segments = dirname(relativePath).split(/[\\/]+/).filter(Boolean);
    for (let index = 1; index <= segments.length; index += 1) {
      directories.add(segments.slice(0, index).join(sep));
    }
  }

  const orderedDirectories = [...directories].sort((left, right) =>
    left.split(/[\\/]+/).length - right.split(/[\\/]+/).length
  );
  const missingDirectories = [];
  for (const relativeDirectory of orderedDirectories) {
    const directoryPath = resolve(appRootReal, relativeDirectory);
    if (!isWithin(appRootReal, directoryPath)) {
      throw new Error(`App destination directory ${relativeDirectory} escaped the app root.`);
    }

    let info;
    try {
      info = await lstat(directoryPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (mode === "verify") {
        throw new Error(`App destination directory ${relativeDirectory} is missing.`);
      }
      missingDirectories.push(relativeDirectory);
      continue;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`App destination directory ${relativeDirectory} must be a non-symlink directory.`);
    }
    const actualPath = await realpath(directoryPath);
    if (!isWithin(appRootReal, actualPath)) {
      throw new Error(`App destination directory ${relativeDirectory} escaped the app root.`);
    }
  }
  return missingDirectories;
}

async function inspectDestinationFiles(appRootReal, files, mode) {
  for (const file of files) {
    let info;
    try {
      info = await lstat(file.targetPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (mode === "verify") {
        throw new Error(`Generated app source ${file.relativePath} is missing.`);
      }
      continue;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`Generated app source ${file.relativePath} must be a regular file.`);
    }
    const actualPath = await realpath(file.targetPath);
    if (!isWithin(appRootReal, actualPath)) {
      throw new Error(`Generated app source ${file.relativePath} escaped the app root.`);
    }
  }
}

async function createDestinationDirectories(appRootReal, relativeDirectories) {
  for (const relativeDirectory of relativeDirectories) {
    const directoryPath = resolve(appRootReal, relativeDirectory);
    try {
      await mkdir(directoryPath, { mode: 0o755 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    await checkedPath(
      appRootReal,
      relativeDirectory,
      "directory",
      `App destination directory ${relativeDirectory}`,
    );
  }
}

async function main() {
  const [mode, appRootArg, ...extra] = process.argv.slice(2);
  if (!((mode === "stage" || mode === "verify") && appRootArg && extra.length === 0)) {
    usage();
  }

  const appRoot = resolve(appRootArg);
  let appRootReal;
  try {
    appRootReal = await realpath(appRoot);
  } catch {
    throw new Error("App root must already exist.");
  }
  const appRootInfo = await lstat(appRootReal);
  if (!appRootInfo.isDirectory() || appRootInfo.isSymbolicLink()) {
    throw new Error("App root must be a directory.");
  }
  const packageRootReal = await realpath(packageRoot);

  const files = [];
  for (const relativePath of sources) {
    const bytes = await canonicalSourceBytes(packageRootReal, relativePath);
    files.push({ relativePath, bytes });
  }

  const missingDirectories = await inspectDestinationDirectories(
    appRootReal,
    files.map(({ relativePath }) => relativePath),
    mode,
  );
  if (mode === "stage") {
    await createDestinationDirectories(appRootReal, missingDirectories);
  }

  const resolvedFiles = [];
  for (const file of files) {
    const targetParentReal = await checkedPath(
      appRootReal,
      dirname(file.relativePath),
      "directory",
      `App destination directory for ${file.relativePath}`,
    );
    const targetPath = resolve(targetParentReal, basename(file.relativePath));
    if (!isWithin(appRootReal, targetPath)) {
      throw new Error(`App destination for ${file.relativePath} escaped the app root.`);
    }
    resolvedFiles.push({ ...file, targetPath, targetParentReal });
  }
  await inspectDestinationFiles(appRootReal, resolvedFiles, mode);

  if (mode === "stage") {
    for (const file of resolvedFiles) {
      const tempPath = resolve(
        file.targetParentReal,
        `.${basename(file.targetPath)}.stage-${process.pid}-${randomUUID()}`,
      );
      try {
        await writeFile(tempPath, file.bytes, { flag: "wx", mode: 0o644 });
        await rename(tempPath, file.targetPath);
      } finally {
        await unlink(tempPath).catch(() => {});
      }
    }
  }

  for (const file of resolvedFiles) {
    await regularFile(file.targetPath, `Generated app source ${file.relativePath}`);
    const stagedBytes = await readFile(file.targetPath);
    const sourceHash = sha256(file.bytes);
    const stagedHash = sha256(stagedBytes);
    if (sourceHash !== stagedHash) {
      throw new Error(`Generated app source ${file.relativePath} is stale.`);
    }
    process.stdout.write(`${mode} ${file.relativePath} sha256=${sourceHash}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`planner source staging failed: ${error.message}\n`);
  process.exitCode = 1;
});
