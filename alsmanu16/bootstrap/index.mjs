#!/usr/bin/env node
/**
 * مشغل آمن وثابت للبوت.
 * يمنع تشغيل نسختين، لا يعيد التثبيت بلا داعٍ، وينظف مؤقتات البوت فقط.
 */
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { banner, ok, wrn } from "../core/logger.mjs";
import { runAllChecks } from "../core/health.mjs";
import { loadConfig, applyDefaults } from "../core/config.mjs";
import { ensure as ensurePackages } from "../infrastructure/package-manager.mjs";
import { ensureYtDlp, ensureFfmpegStatic } from "../infrastructure/binary-manager.mjs";
import { spawnBot } from "../infrastructure/process-manager.mjs";
import { startEngine } from "../engine/index.mjs";

const BASE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME_DIR = join(BASE_DIR, ".runtime");
const PID_FILE = join(RUNTIME_DIR, "bootstrap.pid");
const DEPS_STAMP = join(RUNTIME_DIR, "dependencies.sha256");
const TMP_DIRS = [join(BASE_DIR, "tmp"), join(BASE_DIR, "temp"), join(BASE_DIR, "downloads")];
let runner = null;
let engine = null;
let shuttingDown = false;

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function acquireLock() {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  if (existsSync(PID_FILE)) {
    const oldPid = Number(readFileSync(PID_FILE, "utf8").trim());
    if (isAlive(oldPid)) throw new Error(`البوت يعمل مسبقاً (PID ${oldPid})`);
    rmSync(PID_FILE, { force: true });
  }
  writeFileSync(PID_FILE, String(process.pid), { flag: "wx", mode: 0o600 });
}

function dependencyFingerprint() {
  const hash = createHash("sha256");
  for (const name of ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"]) {
    const file = join(BASE_DIR, name);
    if (existsSync(file)) hash.update(name).update(readFileSync(file));
  }
  return hash.digest("hex");
}

async function ensureDependenciesOnce() {
  const fingerprint = dependencyFingerprint();
  const previous = existsSync(DEPS_STAMP) ? readFileSync(DEPS_STAMP, "utf8").trim() : "";
  const modulesReady = existsSync(join(BASE_DIR, "node_modules", "node-telegram-bot-api"));
  if (modulesReady && previous === fingerprint) {
    ok("التبعيات ثابتة — لا حاجة لإعادة التثبيت");
    return;
  }
  await ensurePackages(BASE_DIR);
  if (existsSync(join(BASE_DIR, "node_modules"))) writeFileSync(DEPS_STAMP, fingerprint, { mode: 0o600 });
}

function cleanBotTemp() {
  let removed = 0;
  const maxAge = 24 * 60 * 60 * 1000;
  const now = Date.now();
  for (const dir of TMP_DIRS) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const target = join(dir, name);
      try {
        if (now - statSync(target).mtimeMs >= maxAge) {
          rmSync(target, { recursive: true, force: true });
          removed++;
        }
      } catch {}
    }
  }
  if (removed) ok(`حُذفت ${removed} من مخلفات البوت القديمة`);
}

async function shutdown(signal, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  wrn(`إيقاف نظيف (${signal})`);
  try { await engine?.stop?.(); } catch {}
  try { runner?.stop?.(); } catch {}
  rmSync(PID_FILE, { force: true });
  setTimeout(() => process.exit(code), 1_500).unref();
}

async function main() {
  acquireLock();
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("uncaughtException", (error) => {
    console.error(error);
    shutdown("uncaughtException", 1);
  });
  process.once("unhandledRejection", (error) => {
    console.error(error);
    shutdown("unhandledRejection", 1);
  });
  process.once("exit", () => rmSync(PID_FILE, { force: true }));

  banner("WhatsApp Bot Pro — Safe Bootstrap");
  runAllChecks({ minNode: 18, minRAM: 150 });
  loadConfig(BASE_DIR);
  applyDefaults();
  cleanBotTemp();
  await ensureDependenciesOnce();
  if (process.argv.includes("--check-only")) {
    ok("فحص bootstrap اكتمل دون تشغيل البوت");
    return;
  }
  await ensureYtDlp(BASE_DIR);
  await ensureFfmpegStatic(BASE_DIR);

  const port = Number.parseInt(process.env.PORT ?? "5000", 10);
  runner = spawnBot(BASE_DIR, {
    autoRestart: true,
    onSpawn: (child) => engine?.setChildProcess?.(child),
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 8_000));
  engine = await startEngine({ baseDir: BASE_DIR, childProcess: runner.getChild(), port }).catch((error) => {
    wrn(`Session Engine لم يبدأ: ${error.message}`);
    return null;
  });
}

main().catch((error) => {
  console.error(`فشل التشغيل: ${error.message}`);
  rmSync(PID_FILE, { force: true });
  process.exit(1);
});
