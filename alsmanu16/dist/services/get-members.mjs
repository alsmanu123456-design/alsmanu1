// ════════════════════════════════════════════════════════════════════
//  ميزة /get — سحب أرقام أعضاء مجموعة وإضافتهم لمجموعة أخرى
//  (مدفوعة: اشتراك النخبة khariqpro)
//
//  الأوامر (تُرسَل من رقم المالك fromMe داخل واتساب):
//    /get 50        → اسحب حتى 50 رقماً من أعضاء المجموعة الحالية واحفظها
//    /get me        → أضِف الأرقام المحفوظة إلى المجموعة الحالية
//                     (≤50 دفعة واحدة، >50 على دفعات 15 عضو كل ساعتين)
//    /get del       → احذف الأرقام المحفوظة
//    /get           → اعرض دليل التعليمات
//
//  التصميم:
//    - المخزن يعيش داخل user.getPool  (أرقام نظيفة بلا @)
//    - مهام الإضافة المجدولة تعيش داخل user.getJobs وتُستعاد عند الإقلاع
//      (نفس نمط _startCleanSchedule) حتى تنجو من إعادة التشغيل.
// ════════════════════════════════════════════════════════════════════

// حجم الدفعة والفاصل الزمني للإضافة التدريجية
export const GET_BATCH_SIZE = 15;
export const GET_BATCH_INTERVAL_MS = 2 * 60 * 60 * 1000; // ساعتان
export const GET_INSTANT_LIMIT = 50; // ≤ هذا العدد يُضاف فوراً

// مؤقّتات نشطة في الذاكرة (userId:groupId → intervalId)
const activeTimers = new Map();

// ── أدوات مساعدة ────────────────────────────────────────────────────

// يحوّل JID واتساب إلى رقم دولي نظيف صالح للإضافة.
// لا نقبل قيمة LID نفسها كرقم لأنها معرّف داخلي وليست رقم هاتف.
function cleanPhoneFromJid(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.endsWith("@lid")) return "";
  const num = raw.split("@")[0].split(":")[0].replace(/\D/g, "");
  return num.length >= 8 && num.length <= 15 ? num : "";
}

// نفس طريقة /gm في قراءة meta.participants، مع خطوة إضافية ضرورية:
// أعضاء واتساب الحديثون يظهرون غالباً كـ @lid؛ نحوّل LID إلى PN الحقيقي
// من مخزن Baileys بدلاً من تجاهلهم (وهو سبب أن /get كان يرجع صفراً).
async function extractNumbersFromParticipants(sock, participants, logger) {
  const out = [];
  const seen = new Set();
  const lidMapping = sock?.signalRepository?.lidMapping;

  for (const p of participants || []) {
    const primary = p?.id || p?.jid || "";
    // إصدارات Baileys المختلفة قد تضع رقم الهاتف في أحد هذه الحقول.
    const candidates = [
      p?.phoneNumber,
      p?.pn,
      p?.participantPn,
      p?.phone,
      p?.jid,
      p?.id,
    ];

    let num = "";
    for (const candidate of candidates) {
      num = cleanPhoneFromJid(candidate);
      if (num) break;
    }

    // إن كان العضو LID ولا يوجد PN جاهز، استخدم محوّل Baileys الرسمي.
    if (!num && String(primary).endsWith("@lid") && typeof lidMapping?.getPNForLID === "function") {
      try {
        const pnJid = await lidMapping.getPNForLID(primary);
        num = cleanPhoneFromJid(pnJid);
      } catch (e) {
        logger?.debug?.({ lid: primary, e: e?.message }, "[/get] failed to map LID to phone number");
      }
    }

    if (!num || seen.has(num)) continue;
    seen.add(num);
    out.push(num);
  }
  return out;
}

function numToJid(num) {
  return `${String(num).replace(/\D/g, "")}@s.whatsapp.net`;
}

// ── جلب أعضاء المجموعة الحالية (مع مهلة صارمة وارتداد للكاش) ─────────
async function fetchGroupParticipants(sock, jid, inMemoryDB, userId, logger) {
  let participants = [];
  try {
    const meta = await Promise.race([
      sock.groupMetadata(jid),
      new Promise((r) => setTimeout(() => r(null), 12000)),
    ]);
    if (meta) participants = meta.participants || [];
  } catch (e) {
    logger?.warn?.({ e: e?.message }, "[/get] groupMetadata failed, trying cache");
  }
  if (participants.length === 0) {
    const cached = (inMemoryDB.groupsCache.get(String(userId)) || []).find((g) => g.id === jid);
    participants = cached?.participants || [];
  }
  return participants;
}

// ── إضافة الأرقام واحداً واحداً مع تخطي أي عضو مرفوض ────────────────
// الطلب الفردي يمنع رقم عليه خصوصية/قيد من إسقاط الدفعة كلها.
// لا تُرسل روابط دعوة؛ فقط تُسجّل النتيجة وتتابع الرقم التالي.
async function addBatch(sock, groupId, numbers, logger) {
  const stats = { added: 0, existing: 0, restricted: 0, privacy: 0, failed: 0 };

  for (let index = 0; index < numbers.length; index++) {
    const number = numbers[index];
    const targetJid = numToJid(number);
    try {
      const result = await sock.groupParticipantsUpdate(groupId, [targetJid], "add");
      const item = Array.isArray(result) ? result[0] : result;
      const status = String(item?.status || item?.code || "");
      const errorText = String(item?.error || item?.message || item?.content?.[0]?.attrs?.error || "").toLowerCase();

      if (status === "200" || (!status && !errorText)) stats.added++;
      else if (status === "409" || errorText.includes("already")) stats.existing++;
      else if (status === "403" || errorText.includes("privacy")) stats.privacy++;
      else if (errorText.includes("account_reachout_restricted") || errorText.includes("reachout")) stats.restricted++;
      else stats.failed++;
    } catch (e) {
      const errorText = String(e?.message || e || "").toLowerCase();
      if (errorText.includes("account_reachout_restricted") || errorText.includes("reachout")) stats.restricted++;
      else if (errorText.includes("privacy") || errorText.includes("403")) stats.privacy++;
      else if (errorText.includes("already") || errorText.includes("409")) stats.existing++;
      else stats.failed++;
      logger?.warn?.({ number, e: e?.message }, "[/get] single participant add skipped");
    }

    // فاصل خفيف بين الطلبات الفردية؛ لا تتوقف بسبب فشل أي عضو.
    if (index + 1 < numbers.length) await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  return stats;
}

// ════════════════════════════════════════════════════════════════════
//  المُجدوِل: يضيف دفعة كل GET_BATCH_INTERVAL_MS حتى ينتهي العدد
// ════════════════════════════════════════════════════════════════════
function timerKey(userId, groupId) {
  return `${userId}::${groupId}`;
}

// يبدأ/يستأنف مهمة إضافة تدريجية لمستخدم/مجموعة
export function startAddJob(deps, userId, groupId) {
  const { inMemoryDB, getUser, saveUser, logger } = deps;
  const key = timerKey(userId, groupId);
  // امنع ازدواج المؤقّت لنفس المهمة
  if (activeTimers.has(key)) return;

  const runBatch = async () => {
    const user = getUser(userId);
    const jobs = user.getJobs || {};
    const job = jobs[groupId];
    if (!job || !Array.isArray(job.remaining) || job.remaining.length === 0) {
      stopAddJob(userId, groupId, deps);
      return;
    }
    // ابحث عن سوكِت واتساب المرتبط بهذا المستخدم
    const sock = _resolveSock(inMemoryDB, userId);
    if (!sock) {
      logger?.warn?.({ userId }, "[/get] no active sock for scheduled add — will retry next tick");
      return; // نُبقي المؤقّت؛ ربما عاد الاتصال لاحقاً
    }
    const batchSize = Math.max(1, Math.min(50, Number(job.batchSize) || GET_BATCH_SIZE));
    const batch = job.remaining.slice(0, batchSize);
    const res = await addBatch(sock, groupId, batch, logger);
    // أزل الدفعة من المتبقّي (نجحت أو فشلت — لا نعيد المحاولة بلا نهاية)
    job.remaining = job.remaining.slice(batch.length);
    job.addedTotal = (job.addedTotal || 0) + res.added;
    job.lastRunAt = Date.now();
    jobs[groupId] = job;
    saveUser(userId, { getJobs: jobs });
    // أبلِغ المالك في محادثته الخاصة على واتساب
    try {
      const selfJid = `${userId}@s.whatsapp.net`;
      const remaining = job.remaining.length;
      const skipped = res.restricted + res.privacy + res.failed;
      if (remaining > 0) {
        const intervalMinutes = Math.round((Number(job.intervalMs) || GET_BATCH_INTERVAL_MS) / 60000);
        await sock.sendMessage(selfJid, {
          text: `مهمة /get\nتمت إضافة: ${res.added}\nموجودون مسبقاً: ${res.existing}\nتم تخطي المقيد/الخصوصية/الفاشل: ${skipped}\nالمتبقي: ${remaining}\nالدفعة التالية بعد ${intervalMinutes} دقيقة.`,
        });
      } else {
        await sock.sendMessage(selfJid, {
          text: `اكتملت مهمة /get\nإجمالي المضاف: ${job.addedTotal} عضو.`,
        });
      }
    } catch {}
    // انتهى العدد؟ أوقف المؤقّت ونظّف
    if (job.remaining.length === 0) {
      delete jobs[groupId];
      saveUser(userId, { getJobs: jobs });
      stopAddJob(userId, groupId, deps);
    }
  };

  // شغّل أول دفعة فوراً ثم كرّر وفق الفاصل المحفوظ في إعداد المهمة.
  const initialJob = (getUser(userId).getJobs || {})[groupId] || {};
  const intervalMs = Math.max(60_000, Number(initialJob.intervalMs) || GET_BATCH_INTERVAL_MS);
  const intervalId = setInterval(runBatch, intervalMs);
  activeTimers.set(key, intervalId);
  // أول دفعة تُنفَّذ فوراً (بدون انتظار ساعتين)
  runBatch().catch((e) => logger?.warn?.({ e: e?.message }, "[/get] first batch failed"));
}

export function stopAddJob(userId, groupId, deps) {
  const key = timerKey(userId, groupId);
  const t = activeTimers.get(key);
  if (t) { clearInterval(t); activeTimers.delete(key); }
}

function _resolveSock(inMemoryDB, userId) {
  const direct = inMemoryDB.sessions.get(String(userId)) || inMemoryDB.sessions.get(Number(userId));
  if (typeof direct?.groupParticipantsUpdate === "function") return direct;
  if (typeof direct?.sock?.groupParticipantsUpdate === "function") return direct.sock;
  for (const [k, v] of inMemoryDB.sessions.entries()) {
    if (!String(k).startsWith(`${userId}_`)) continue;
    if (typeof v?.groupParticipantsUpdate === "function") return v;
    if (typeof v?.sock?.groupParticipantsUpdate === "function") return v.sock;
  }
  return null;
}

// يُستدعى عند إقلاع البوت لإعادة تشغيل كل المهام غير المكتملة
export function restoreAllAddJobs(deps) {
  const { getAllUsers, logger } = deps;
  let restored = 0;
  try {
    for (const u of getAllUsers()) {
      const uid = String(u.telegramId);
      const jobs = u.getJobs || {};
      for (const groupId of Object.keys(jobs)) {
        const job = jobs[groupId];
        if (job && Array.isArray(job.remaining) && job.remaining.length > 0) {
          startAddJob(deps, uid, groupId);
          restored++;
        }
      }
    }
  } catch (e) {
    logger?.warn?.({ e: e?.message }, "[/get] restore jobs failed");
  }
  if (restored > 0) logger?.info?.({ count: restored }, "[/get] restored scheduled add-jobs on startup");
  return restored;
}

// ════════════════════════════════════════════════════════════════════
//  المعالج الرئيسي — يُستدعى من dispatcher واتساب عند مطابقة الأمر
//  deps: { inMemoryDB, getUser, saveUser, getAllUsers, logger }
//  ctx:  { sock, userId, jid, isGroup }
//  arg:  النص بعد "/get" (فارغ = دليل)
// ════════════════════════════════════════════════════════════════════
export async function handleGetCommand(deps, ctx, arg) {
  const { getUser, saveUser, inMemoryDB, logger } = deps;
  const { sock, userId, jid, isGroup, getSettings = {} } = ctx;
  const sub = (arg || "").trim();
  const configuredBatchSize = Math.max(1, Math.min(50, Number(getSettings.getBatchSize) || GET_BATCH_SIZE));
  const configuredIntervalMinutes = Math.max(1, Math.min(1440, Number(getSettings.getIntervalMinutes) || 120));
  const configuredIntervalMs = configuredIntervalMinutes * 60 * 1000;

  // ── /get بلا وسيط → دليل التعليمات ──────────────────────────────
  if (sub === "") {
    await sock.sendMessage(jid, { text: GET_HELP_TEXT });
    return;
  }

  // ── /get del → حذف المخزن ───────────────────────────────────────
  if (sub === "del" || sub === "حذف") {
    saveUser(userId, { getPool: [] });
    await sock.sendMessage(jid, { text: "🗑️ تم حذف كل الأرقام المحفوظة." });
    return;
  }

  // ── /get me → إضافة الأرقام المحفوظة للمجموعة الحالية ────────────
  if (sub === "me" || sub === "مي") {
    if (!isGroup) {
      await sock.sendMessage(jid, { text: "⚠️ أرسل `/get me` داخل المجموعة التي تريد إضافة الأعضاء إليها." });
      return;
    }
    const user = getUser(userId);
    const pool = Array.isArray(user.getPool) ? user.getPool.slice() : [];
    if (pool.length === 0) {
      await sock.sendMessage(jid, { text: "📭 لا توجد أرقام محفوظة. استخدم `/get 50` في مجموعة أولاً." });
      return;
    }
    // استبعد أعضاء المجموعة الحاليين لتفادي محاولات مكرّرة
    const existingParticipants = await fetchGroupParticipants(sock, jid, inMemoryDB, userId, logger);
    const existing = new Set(
      await extractNumbersFromParticipants(sock, existingParticipants, logger)
    );
    const toAdd = pool.filter((n) => !existing.has(n));
    if (toAdd.length === 0) {
      await sock.sendMessage(jid, { text: "✅ كل الأرقام المحفوظة موجودة بالفعل في هذه المجموعة." });
      return;
    }

    // ≤ 50: إضافة فورية دفعة واحدة
    if (toAdd.length <= GET_INSTANT_LIMIT) {
      await sock.sendMessage(jid, { text: `➕ جارٍ إضافة ${toAdd.length} عضو...` });
      // كل طلب يحتوي عضواً واحداً؛ المقيد يُتخطى وتستمر بقية الأرقام.
      const totals = { added: 0, existing: 0, restricted: 0, privacy: 0, failed: 0 };
      for (let i = 0; i < toAdd.length; i += configuredBatchSize) {
        const batch = toAdd.slice(i, i + configuredBatchSize);
        const res = await addBatch(sock, jid, batch, logger);
        for (const key of Object.keys(totals)) totals[key] += res[key] || 0;
        if (i + configuredBatchSize < toAdd.length) await new Promise((r) => setTimeout(r, 4000));
      }
      await sock.sendMessage(jid, {
        text: `انتهت محاولة الإضافة واحداً واحداً.\nتمت الإضافة: ${totals.added}\nموجودون مسبقاً: ${totals.existing}\nتعذر بسبب خصوصية العضو: ${totals.privacy}\nتم تخطي تقييد التواصل: ${totals.restricted}\nفشل آخر: ${totals.failed}\nالإجمالي: ${toAdd.length}`,
      });
      return;
    }

    // > 50: جدولة تدريجية 15 كل ساعتين
    const jobs = user.getJobs || {};
    jobs[jid] = {
      remaining: toAdd,
      total: toAdd.length,
      addedTotal: 0,
      batchSize: configuredBatchSize,
      intervalMs: configuredIntervalMs,
      startedAt: Date.now(),
    };
    saveUser(userId, { getJobs: jobs });
    await sock.sendMessage(jid, {
      text: `بدأت مهمة إضافة تدريجية.\nالعدد: ${toAdd.length}\nالدفعة: ${configuredBatchSize} عضو\nالفاصل: ${configuredIntervalMinutes} دقيقة\nستتم محاولة كل عضو منفرداً وتخطي المرفوض تلقائياً.\n\nالدفعة الأولى الآن...`,
    });
    startAddJob(deps, userId, jid);
    return;
  }

  // ── /get <عدد> → سحب أرقام من المجموعة الحالية وحفظها ────────────
  const count = parseInt(sub.replace(/\D/g, ""), 10);
  if (Number.isFinite(count) && count > 0) {
    if (!isGroup) {
      await sock.sendMessage(jid, { text: "⚠️ أرسل `/get <عدد>` داخل المجموعة التي تريد سحب الأرقام منها." });
      return;
    }
    // نجلب الأعضاء بنفس طريقة /gm من groupMetadata ثم نحوّل LID إلى PN صحيح.
    const participants = await fetchGroupParticipants(sock, jid, inMemoryDB, userId, logger);
    const allNums = await extractNumbersFromParticipants(sock, participants, logger);
    if (allNums.length === 0) {
      await sock.sendMessage(jid, {
        text: participants.length > 0
          ? "❌ تم جلب أعضاء القروب لكن تعذّر تحويل معرّفات LID إلى أرقام هاتف. أعد تشغيل البوت ثم جرّب /gm وبعده /get مرة أخرى."
          : "❌ تعذّر قراءة أعضاء هذه المجموعة.",
      });
      return;
    }
    const picked = allNums.slice(0, count);
    // ادمج مع المخزن السابق دون تكرار
    const user = getUser(userId);
    const prev = Array.isArray(user.getPool) ? user.getPool : [];
    const merged = Array.from(new Set([...prev, ...picked]));
    saveUser(userId, { getPool: merged });
    await sock.sendMessage(jid, {
      text: `✅ تم سحب ${picked.length} رقم وحفظها.\n📦 إجمالي المحفوظ الآن: ${merged.length} رقم.\n\nاذهب لأي مجموعة أخرى وأرسل \`/get me\` لإضافتهم.`,
    });
    return;
  }

  // وسيط غير مفهوم
  await sock.sendMessage(jid, { text: GET_HELP_TEXT });
}

export const GET_HELP_TEXT =
  "🧩 *أوامر /get* (ميزة النخبة)\n\n" +
  "• `/get 50` — اسحب 50 رقماً (أو أي عدد) من أعضاء المجموعة الحالية واحفظها.\n" +
  "• `/get me` — أضِف الأرقام المحفوظة إلى المجموعة الحالية.\n" +
  "     └ إذا كان العدد ≤ 50 تُضاف فوراً.\n" +
  "     └ إذا كان أكبر، تُضاف 15 عضو كل ساعتين تلقائياً حتى تكتمل.\n" +
  "• `/get del` — احذف كل الأرقام المحفوظة.\n\n" +
  "💡 المهام التدريجية تستمر تلقائياً حتى بعد إعادة تشغيل البوت.";
