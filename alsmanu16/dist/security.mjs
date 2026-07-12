// dist/security.mjs — [REBUILD 2026-07-12] مركز الأمان والخصوصية
// إعادة بناء كاملة: كل الميزات القديمة كانت أعلاماً تجميلية تُحفَظ ولا تُنفَّذ.
// الآن كل ميزة تُنفَّذ فعلياً على سيرفرات واتساب عبر Baileys Privacy APIs:
//   - إخفاء آخر ظهور    → sock.updateLastSeenPrivacy
//   - إخفاء علامة القراءة → sock.updateReadReceiptsPrivacy
//   - رفض المكالمات      → callSettings.autoReject (يُنفَّذ في registerCallHandler)
//   - الحظر              → sock.updateBlockStatus (حظر حقيقي على واتساب)
// + 5 ميزات جديدة فريدة:
//   1. حماية صورة الملف الشخصي  (updateProfilePicturePrivacy)
//   2. الرسائل ذاتية الاختفاء     (updateDefaultDisappearingMode)
//   3. درع المجموعات              (updateGroupsAddPrivacy)
//   4. وضع الطوارئ — أقصى حماية بضغطة واحدة مع استعادة
//   5. المدقّق الحقيقي — جلب إعدادات الخصوصية الفعلية من سيرفرات واتساب
// + قفل PIN أصبح حقيقياً: يمنع فتح قسم الأمان بدون إدخال الرمز (صلاحية 10 دقائق).

let _deps = {};
export function setDeps(d) { _deps = { ..._deps, ...d }; }

// ── أدوات مساعدة ─────────────────────────────────────────────────────────────

function _getSock(userId) {
  try {
    const { getSession } = _deps._getBaileys();
    const sess = getSession(String(userId));
    return sess?.sock || null;
  } catch { return null; }
}

function _logActivity(userId, action) {
  const { getUser, saveUser } = _deps;
  try {
    const user = getUser(userId);
    const logs = user.activityLog || [];
    logs.push({ action, date: new Date().toLocaleString("ar-SA") });
    if (logs.length > 30) logs.shift();
    saveUser(userId, { activityLog: logs });
  } catch { /* لا تُوقف الـ flow */ }
}

const PIN_UNLOCK_MS = 10 * 60 * 1000; // صلاحية فتح القفل: 10 دقائق

function _isPinLocked(user) {
  const sec = user.securitySettings || {};
  if (!sec.pin) return false;
  return Date.now() - (user.secUnlockedAt || 0) > PIN_UNLOCK_MS;
}

function _score(sec, user) {
  return [
    sec.pin,
    sec.hideLastSeen,
    sec.hideReadReceipt,
    sec.hideTyping,
    sec.rejectCalls,
    sec.ghostMode,
    sec.profilePicPrivacy && sec.profilePicPrivacy !== "all",
    sec.groupShield && sec.groupShield !== "all",
    (sec.disappearDuration || 0) > 0,
    sec.emergencyMode,
  ].filter(Boolean).length;
}

function _scoreLine(sec, user) {
  const s = _score(sec, user);
  const filled = Math.round((s / 10) * 5);
  const bar = "🟩".repeat(filled) + "⬜".repeat(5 - filled);
  const label = s <= 2 ? "ضعيف 🔴" : s <= 4 ? "مقبول 🟡" : s <= 6 ? "جيد 🟢" : s <= 8 ? "قوي 🟢" : "حصين 🏆";
  return `${bar}  *${s}/10 — ${label}*`;
}

const PP_LEVELS = { all: "الجميع 🌍", contacts: "جهات الاتصال 👥", none: "لا أحد 🔒" };
const GS_LEVELS = { all: "الجميع 🌍", contacts: "جهات الاتصال 👥" };
const DISAPPEAR_LABELS = { 0: "معطَّل", 86400: "24 ساعة", 604800: "7 أيام", 7776000: "90 يوماً" };

// ── القائمة الرئيسية الجديدة ─────────────────────────────────────────────────

function _menuKeyboard(sec, user) {
  const on = (v) => (v ? "✅" : "▫️");
  return {
    inline_keyboard: [
      [{ text: sec.emergencyMode ? "🚨 إيقاف وضع الطوارئ" : "🚨 وضع الطوارئ — حماية قصوى", callback_data: sec.emergencyMode ? "sec_emergency_off" : "sec_emergency" }],
      [
        { text: `${on(sec.hideLastSeen)} آخر ظهور`, callback_data: "sec_lastseen" },
        { text: `${on(sec.hideReadReceipt)} علامة القراءة`, callback_data: "sec_readreceipt" },
      ],
      [
        { text: `${on(sec.hideTyping)} إخفاء "يكتب"`, callback_data: "sec_typing" },
        { text: `${on(sec.rejectCalls)} رفض المكالمات`, callback_data: "sec_reject_calls" },
      ],
      [
        { text: `🖼️ صورة الملف: ${PP_LEVELS[sec.profilePicPrivacy || "all"].split(" ")[0]}`, callback_data: "sec_profilepic" },
        { text: `👥 درع المجموعات: ${GS_LEVELS[sec.groupShield || "all"].split(" ")[0]}`, callback_data: "sec_groupshield" },
      ],
      [
        { text: `⏳ الاختفاء التلقائي: ${DISAPPEAR_LABELS[sec.disappearDuration || 0]}`, callback_data: "sec_disappear" },
        { text: `${on(sec.ghostMode)} وضع التخفي`, callback_data: "sec_ghost_mode" },
      ],
      [
        { text: "📵 قائمة الحظر", callback_data: "sec_blocklist" },
        { text: `🔐 قفل PIN ${sec.pin ? "✅" : "▫️"}`, callback_data: "sec_pin" },
      ],
      [
        { text: "🔍 المدقّق الحقيقي", callback_data: "sec_audit" },
        { text: "📝 سجل الأنشطة", callback_data: "sec_log" },
      ],
      [
        { text: "📋 تقرير شامل", callback_data: "sec_report" },
        { text: "🏠 الرئيسية", callback_data: "home" },
      ],
    ],
  };
}

async function _sendMenu(bot2, chatId, userId) {
  const { getUser } = _deps;
  const user = getUser(userId);
  const sec = user.securitySettings || {};
  const sock = _getSock(userId);
  await bot2.sendMessage(
    chatId,
    `🛡️ *مركز الأمان والخصوصية*\n\n` +
    `${_scoreLine(sec, user)}\n\n` +
    `${sock ? "🟢 واتساب متصل — كل الميزات تعمل فعلياً على حسابك" : "🔴 واتساب غير متصل — اربط رقمك لتفعيل ميزات الخصوصية"}\n\n` +
    `اضغط على أي ميزة لتفعيلها أو تعديلها:`,
    { parse_mode: "Markdown", reply_markup: _menuKeyboard(sec, user) }
  );
}

// ── نقطة الدخول ──────────────────────────────────────────────────────────────

export async function handleSecurityCallback(bot2, chatId, userId, data) {
  const { getUser, saveUser, setState, cancelKeyboard } = _deps;
  // توافق خلفي مع أزرار الرسائل القديمة
  if (data === "sec_scan") data = "sec_audit";
  if (data === "sec_always_online") data = "menu_security";
  const user = getUser(userId);
  const sec = user.securitySettings || {};

  // ── بوابة PIN: القسم مقفول حتى إدخال الرمز الصحيح ──────────────────────────
  if (data === "menu_security") {
    if (_isPinLocked(user)) {
      setState(userId, "awaiting_security_pin_unlock");
      await bot2.sendMessage(chatId,
        "🔐 *قسم الأمان مقفول*\n\nأدخل رمز PIN لفتح القسم:",
        { parse_mode: "Markdown", reply_markup: cancelKeyboard() });
      return true;
    }
    await _sendMenu(bot2, chatId, userId);
    return true;
  }

  if (!data.startsWith("sec_")) return false;

  // كل أزرار sec_* محمية بالبوابة أيضاً (باستثناء لا شيء — الأمان أولاً)
  if (_isPinLocked(user)) {
    setState(userId, "awaiting_security_pin_unlock");
    await bot2.sendMessage(chatId, "🔐 أدخل رمز PIN أولاً:", { reply_markup: cancelKeyboard() });
    return true;
  }

  const sock = _getSock(userId);
  const needSock = async () => {
    await bot2.sendMessage(chatId,
      "🔴 *واتساب غير متصل*\n\nهذه الميزة تُطبَّق مباشرةً على حسابك في واتساب، لذا يجب ربط رقمك أولاً من قسم *أرقامي*.",
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🔙 رجوع", callback_data: "menu_security" }]] } });
    return true;
  };

  // ═══ 1) إخفاء آخر ظهور — تنفيذ حقيقي ═══
  if (data === "sec_lastseen") {
    if (!sock) return needSock();
    const val = !sec.hideLastSeen;
    try {
      await sock.updateLastSeenPrivacy(val ? "none" : "all");
      saveUser(userId, { securitySettings: { ...sec, hideLastSeen: val } });
      _logActivity(userId, val ? "👁️ إخفاء آخر ظهور (فعلي)" : "👁️ إظهار آخر ظهور");
      await bot2.sendMessage(chatId,
        `👁️ *آخر ظهور: ${val ? "مخفي ✅" : "ظاهر للجميع"}*\n\n${val ? "تم التطبيق على سيرفرات واتساب — لن يرى أحد متى كنت متصلاً." : "أصبح آخر ظهورك مرئياً للجميع."}`,
        { parse_mode: "Markdown", reply_markup: _menuKeyboard({ ...sec, hideLastSeen: val }, user) });
    } catch (err) {
      await bot2.sendMessage(chatId, `❌ تعذّر التطبيق: ${err?.message || "خطأ غير معروف"}`);
    }
    return true;
  }

  // ═══ 2) إخفاء علامة القراءة — تنفيذ حقيقي ═══
  if (data === "sec_readreceipt") {
    if (!sock) return needSock();
    const val = !sec.hideReadReceipt;
    try {
      await sock.updateReadReceiptsPrivacy(val ? "none" : "all");
      saveUser(userId, { securitySettings: { ...sec, hideReadReceipt: val } });
      _logActivity(userId, val ? "✓✓ إخفاء علامة القراءة (فعلي)" : "✓✓ إظهار علامة القراءة");
      await bot2.sendMessage(chatId,
        `✓✓ *علامة القراءة: ${val ? "مخفية ✅" : "ظاهرة"}*\n\n${val ? "تم التطبيق على واتساب — لن يعرف المرسِل أنك قرأت رسالته (ولن تعرف أنت أيضاً)." : "عادت علامات القراءة الزرقاء للعمل."}`,
        { parse_mode: "Markdown", reply_markup: _menuKeyboard({ ...sec, hideReadReceipt: val }, user) });
    } catch (err) {
      await bot2.sendMessage(chatId, `❌ تعذّر التطبيق: ${err?.message || "خطأ غير معروف"}`);
    }
    return true;
  }

  // ═══ 3) إخفاء "يكتب..." — يمنع البوت من إظهار حالة الكتابة ═══
  if (data === "sec_typing") {
    const val = !sec.hideTyping;
    saveUser(userId, { securitySettings: { ...sec, hideTyping: val } });
    _logActivity(userId, val ? '⌨️ إخفاء "يكتب..."' : '⌨️ إظهار "يكتب..."');
    await bot2.sendMessage(chatId,
      `⌨️ *حالة "يكتب...": ${val ? "مخفية ✅" : "ظاهرة"}*\n\n${val ? "لن يُظهر البوت حالة الكتابة عند الرد الآلي أو ردود الذكاء الاصطناعي." : "ستظهر حالة الكتابة كالمعتاد."}`,
      { parse_mode: "Markdown", reply_markup: _menuKeyboard({ ...sec, hideTyping: val }, user) });
    return true;
  }

  // ═══ 4) رفض المكالمات — الآن مربوط بالمعالج الفعلي ═══
  if (data === "sec_reject_calls") {
    const val = !sec.rejectCalls;
    const callSettings = { ...(user.callSettings || {}), autoReject: val };
    saveUser(userId, { securitySettings: { ...sec, rejectCalls: val }, callSettings });
    _logActivity(userId, val ? "🔇 تفعيل رفض المكالمات (فعلي)" : "🔇 تعطيل رفض المكالمات");
    await bot2.sendMessage(chatId,
      `🔇 *رفض المكالمات تلقائياً: ${val ? "مفعَّل ✅" : "معطَّل"}*\n\n${val ? "كل مكالمة واتساب واردة ستُرفض فوراً وسيصلك إشعار بها هنا." : "ستصلك المكالمات كالمعتاد."}`,
      { parse_mode: "Markdown", reply_markup: _menuKeyboard({ ...sec, rejectCalls: val }, user) });
    return true;
  }

  // ═══ 5) وضع التخفي — حزمة خصوصية فعلية ═══
  if (data === "sec_ghost_mode") {
    if (!sock) return needSock();
    const val = !sec.ghostMode;
    const newSec = { ...sec, ghostMode: val };
    try {
      if (val) {
        await sock.updateLastSeenPrivacy("none");
        await sock.updateOnlinePrivacy("match_last_seen");
        await sock.updateReadReceiptsPrivacy("none");
        newSec.hideLastSeen = true;
        newSec.hideReadReceipt = true;
        newSec.hideTyping = true;
      } else {
        await sock.updateLastSeenPrivacy("all");
        await sock.updateOnlinePrivacy("all");
        await sock.updateReadReceiptsPrivacy("all");
        newSec.hideLastSeen = false;
        newSec.hideReadReceipt = false;
        newSec.hideTyping = false;
      }
      saveUser(userId, { securitySettings: newSec });
      _logActivity(userId, val ? "👻 تفعيل وضع التخفي الكامل" : "👻 تعطيل وضع التخفي");
      await bot2.sendMessage(chatId,
        `👻 *وضع التخفي: ${val ? "مفعَّل ✅" : "معطَّل"}*\n\n` +
        (val
          ? "تم تطبيقها كلها فعلياً على واتساب:\n• آخر ظهور: مخفي\n• حالة الاتصال: مخفية\n• علامة القراءة: مخفية\n• حالة الكتابة: مخفية\n\nأنت الآن شبح 👻"
          : "عادت كل إعدادات الخصوصية للوضع الطبيعي (ظاهرة للجميع)."),
        { parse_mode: "Markdown", reply_markup: _menuKeyboard(newSec, user) });
    } catch (err) {
      await bot2.sendMessage(chatId, `❌ تعذّر التطبيق: ${err?.message || "خطأ غير معروف"}`);
    }
    return true;
  }

  // ═══ [جديد 1] حماية صورة الملف الشخصي ═══
  if (data === "sec_profilepic") {
    if (!sock) return needSock();
    const order = ["all", "contacts", "none"];
    const next = order[(order.indexOf(sec.profilePicPrivacy || "all") + 1) % order.length];
    try {
      await sock.updateProfilePicturePrivacy(next);
      saveUser(userId, { securitySettings: { ...sec, profilePicPrivacy: next } });
      _logActivity(userId, `🖼️ صورة الملف الشخصي → ${PP_LEVELS[next]}`);
      await bot2.sendMessage(chatId,
        `🖼️ *من يرى صورة ملفك الشخصي؟*\n\n👁️ الآن: *${PP_LEVELS[next]}*\n\n(اضغط الزر مجدداً للتبديل: الجميع ← جهات الاتصال ← لا أحد)`,
        { parse_mode: "Markdown", reply_markup: _menuKeyboard({ ...sec, profilePicPrivacy: next }, user) });
    } catch (err) {
      await bot2.sendMessage(chatId, `❌ تعذّر التطبيق: ${err?.message || "خطأ غير معروف"}`);
    }
    return true;
  }

  // ═══ [جديد 2] درع المجموعات — من يستطيع إضافتك ═══
  if (data === "sec_groupshield") {
    if (!sock) return needSock();
    const next = (sec.groupShield || "all") === "all" ? "contacts" : "all";
    try {
      await sock.updateGroupsAddPrivacy(next);
      saveUser(userId, { securitySettings: { ...sec, groupShield: next } });
      _logActivity(userId, `👥 درع المجموعات → ${GS_LEVELS[next]}`);
      await bot2.sendMessage(chatId,
        `👥 *درع المجموعات*\n\nمن يستطيع إضافتك إلى مجموعات؟\n👁️ الآن: *${GS_LEVELS[next]}*\n\n${next === "contacts" ? "🛡️ لن يستطيع الغرباء إضافتك لأي مجموعة — حماية فعالة ضد السبام." : "⚠️ أي شخص يمكنه إضافتك لمجموعات."}`,
        { parse_mode: "Markdown", reply_markup: _menuKeyboard({ ...sec, groupShield: next }, user) });
    } catch (err) {
      await bot2.sendMessage(chatId, `❌ تعذّر التطبيق: ${err?.message || "خطأ غير معروف"}`);
    }
    return true;
  }

  // ═══ [جديد 3] الرسائل ذاتية الاختفاء ═══
  if (data === "sec_disappear") {
    await bot2.sendMessage(chatId,
      `⏳ *الرسائل ذاتية الاختفاء*\n\nرسائلك في المحادثات *الجديدة* ستُحذف تلقائياً بعد المدة المختارة.\n\n👁️ الحالي: *${DISAPPEAR_LABELS[sec.disappearDuration || 0]}*`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: `24 ساعة ${(sec.disappearDuration === 86400) ? "✅" : ""}`, callback_data: "sec_disap_86400" },
              { text: `7 أيام ${(sec.disappearDuration === 604800) ? "✅" : ""}`, callback_data: "sec_disap_604800" },
            ],
            [
              { text: `90 يوماً ${(sec.disappearDuration === 7776000) ? "✅" : ""}`, callback_data: "sec_disap_7776000" },
              { text: `إيقاف ${(!sec.disappearDuration) ? "✅" : ""}`, callback_data: "sec_disap_0" },
            ],
            [{ text: "🔙 رجوع", callback_data: "menu_security" }],
          ],
        },
      });
    return true;
  }
  if (data.startsWith("sec_disap_")) {
    if (!sock) return needSock();
    const dur = parseInt(data.replace("sec_disap_", ""), 10) || 0;
    try {
      await sock.updateDefaultDisappearingMode(dur);
      saveUser(userId, { securitySettings: { ...sec, disappearDuration: dur } });
      _logActivity(userId, `⏳ الاختفاء التلقائي → ${DISAPPEAR_LABELS[dur]}`);
      await bot2.sendMessage(chatId,
        `⏳ *تم التطبيق!*\n\nالرسائل في المحادثات الجديدة: *${DISAPPEAR_LABELS[dur]}*`,
        { parse_mode: "Markdown", reply_markup: _menuKeyboard({ ...sec, disappearDuration: dur }, user) });
    } catch (err) {
      await bot2.sendMessage(chatId, `❌ تعذّر التطبيق: ${err?.message || "خطأ غير معروف"}`);
    }
    return true;
  }

  // ═══ [جديد 4] وضع الطوارئ — أقصى حماية بضغطة واحدة ═══
  if (data === "sec_emergency") {
    if (!sock) return needSock();
    try {
      const backup = { ...sec };
      await sock.updateLastSeenPrivacy("none");
      await sock.updateOnlinePrivacy("match_last_seen");
      await sock.updateReadReceiptsPrivacy("none");
      await sock.updateProfilePicturePrivacy("contacts");
      await sock.updateGroupsAddPrivacy("contacts");
      try { await sock.updateCallPrivacy("known"); } catch {}
      const newSec = {
        ...sec, emergencyMode: true, emergencyBackup: backup,
        hideLastSeen: true, hideReadReceipt: true, hideTyping: true,
        rejectCalls: true, ghostMode: true,
        profilePicPrivacy: "contacts", groupShield: "contacts",
      };
      saveUser(userId, {
        securitySettings: newSec,
        callSettings: { ...(user.callSettings || {}), autoReject: true },
      });
      _logActivity(userId, "🚨 تفعيل وضع الطوارئ — حماية قصوى");
      await bot2.sendMessage(chatId,
        `🚨 *وضع الطوارئ مفعَّل!*\n\nتم تطبيق أقصى حماية على حسابك فوراً:\n` +
        `• 👁️ آخر ظهور: مخفي\n• 🌐 حالة الاتصال: مخفية\n• ✓✓ علامة القراءة: مخفية\n` +
        `• 🖼️ صورة الملف: جهات الاتصال فقط\n• 👥 المجموعات: جهات الاتصال فقط\n` +
        `• 📞 المكالمات: معارفك فقط + رفض تلقائي\n• 👻 وضع التخفي: مفعَّل\n\n` +
        `للعودة لإعداداتك السابقة اضغط "إيقاف وضع الطوارئ".`,
        { parse_mode: "Markdown", reply_markup: _menuKeyboard(newSec, user) });
    } catch (err) {
      await bot2.sendMessage(chatId, `❌ تعذّر تفعيل وضع الطوارئ: ${err?.message || "خطأ غير معروف"}`);
    }
    return true;
  }
  if (data === "sec_emergency_off") {
    if (!sock) return needSock();
    try {
      const backup = sec.emergencyBackup || {};
      await sock.updateLastSeenPrivacy(backup.hideLastSeen ? "none" : "all");
      await sock.updateOnlinePrivacy(backup.hideLastSeen ? "match_last_seen" : "all");
      await sock.updateReadReceiptsPrivacy(backup.hideReadReceipt ? "none" : "all");
      await sock.updateProfilePicturePrivacy(backup.profilePicPrivacy || "all");
      await sock.updateGroupsAddPrivacy(backup.groupShield || "all");
      try { await sock.updateCallPrivacy("all"); } catch {}
      const newSec = { ...backup, emergencyMode: false, emergencyBackup: null };
      saveUser(userId, {
        securitySettings: newSec,
        callSettings: { ...(user.callSettings || {}), autoReject: !!backup.rejectCalls },
      });
      _logActivity(userId, "🚨 إيقاف وضع الطوارئ — استعادة الإعدادات السابقة");
      await bot2.sendMessage(chatId,
        "✅ *تم إيقاف وضع الطوارئ*\n\nعادت كل إعداداتك السابقة كما كانت قبل التفعيل.",
        { parse_mode: "Markdown", reply_markup: _menuKeyboard(newSec, user) });
    } catch (err) {
      await bot2.sendMessage(chatId, `❌ تعذّر الاستعادة: ${err?.message || "خطأ غير معروف"}`);
    }
    return true;
  }

  // ═══ [جديد 5] المدقّق الحقيقي — يقرأ إعدادات واتساب الفعلية من السيرفر ═══
  if (data === "sec_audit") {
    if (!sock) return needSock();
    try {
      const p = await sock.fetchPrivacySettings(true);
      const map = (v) => ({ all: "الجميع 🌍", contacts: "جهات الاتصال 👥", contact_blacklist: "الجهات عدا المستبعَدين", none: "لا أحد 🔒", match_last_seen: "مطابق لآخر ظهور", known: "المعارف فقط" }[v] || v || "غير معروف");
      await bot2.sendMessage(chatId,
        `🔍 *المدقّق الحقيقي*\n_قراءة مباشرة من سيرفرات واتساب — هذه إعداداتك الفعلية الآن:_\n\n` +
        `👁️ آخر ظهور: *${map(p.last)}*\n` +
        `🌐 الاتصال (متصل الآن): *${map(p.online)}*\n` +
        `✓✓ علامات القراءة: *${map(p.readreceipts)}*\n` +
        `🖼️ صورة الملف الشخصي: *${map(p.profile)}*\n` +
        `📝 الحالة (Status): *${map(p.status)}*\n` +
        `👥 إضافتي للمجموعات: *${map(p.groupadd)}*\n` +
        (p.calladd ? `📞 المكالمات: *${map(p.calladd)}*\n` : "") +
        `\n💡 إن وجدت اختلافاً عمّا ضبطته هنا فقد غيَّرته من تطبيق واتساب مباشرة.`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🔄 إعادة الفحص", callback_data: "sec_audit" }], [{ text: "🔙 رجوع", callback_data: "menu_security" }]] } });
    } catch (err) {
      await bot2.sendMessage(chatId, `❌ تعذّر جلب الإعدادات: ${err?.message || "خطأ غير معروف"}`);
    }
    return true;
  }

  // ═══ قائمة الحظر الحقيقية (حظر/فك حظر على واتساب مباشرة) ═══
  if (data === "sec_blocklist") {
    if (!sock) return needSock();
    try {
      const list = (await sock.fetchBlocklist()) || [];
      const rows = list.slice(0, 15).map((jid) => {
        const num = String(jid).split("@")[0];
        return [{ text: `🔓 فك حظر +${num}`, callback_data: `sec_unblk_${num}` }];
      });
      rows.push([{ text: "🚫 حظر رقم جديد", callback_data: "sec_block" }]);
      rows.push([{ text: "🔙 رجوع", callback_data: "menu_security" }]);
      await bot2.sendMessage(chatId,
        `📵 *قائمة الحظر الحقيقية*\n_من سيرفرات واتساب مباشرة_\n\n${list.length === 0 ? "لا توجد أرقام محظورة." : `المحظورون: *${list.length}* رقم${list.length > 15 ? " (يظهر أول 15)" : ""}`}`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } });
    } catch (err) {
      await bot2.sendMessage(chatId, `❌ تعذّر جلب القائمة: ${err?.message || "خطأ غير معروف"}`);
    }
    return true;
  }
  if (data === "sec_block") {
    if (!sock) return needSock();
    setState(userId, "awaiting_security_block_num");
    await bot2.sendMessage(chatId,
      "🚫 *حظر رقم على واتساب*\n\nأدخل الرقم مع كود الدولة بدون +\nمثال: `249912345678`",
      { parse_mode: "Markdown", reply_markup: cancelKeyboard() });
    return true;
  }
  if (data.startsWith("sec_unblk_")) {
    if (!sock) return needSock();
    const num = data.replace("sec_unblk_", "").replace(/\D/g, "");
    try {
      await sock.updateBlockStatus(`${num}@s.whatsapp.net`, "unblock");
      _logActivity(userId, `🔓 فك حظر +${num}`);
      await bot2.sendMessage(chatId, `✅ تم فك حظر +${num} على واتساب`, {
        reply_markup: { inline_keyboard: [[{ text: "📵 قائمة الحظر", callback_data: "sec_blocklist" }], [{ text: "🔙 رجوع", callback_data: "menu_security" }]] },
      });
    } catch (err) {
      await bot2.sendMessage(chatId, `❌ تعذّر فك الحظر: ${err?.message || "خطأ غير معروف"}`);
    }
    return true;
  }

  // ═══ قفل PIN — الآن حقيقي: يقفل قسم الأمان بالكامل ═══
  if (data === "sec_pin") {
    if (sec.pin) {
      await bot2.sendMessage(chatId,
        `🔐 *قفل PIN*\n\nالحالة: مفعَّل ✅\nقسم الأمان يُفتح فقط بالرمز (صلاحية الفتح 10 دقائق).`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔄 تغيير الرمز", callback_data: "sec_pin_change" }, { text: "🔓 إلغاء القفل", callback_data: "sec_pin_remove" }],
              [{ text: "🔒 قفل الآن", callback_data: "sec_pin_locknow" }],
              [{ text: "🔙 رجوع", callback_data: "menu_security" }],
            ],
          },
        });
    } else {
      setState(userId, "awaiting_security_pin");
      await bot2.sendMessage(chatId,
        "🔐 *إعداد قفل PIN*\n\nأدخل رمزاً من 4-8 أرقام.\nبعد التفعيل لن يُفتح قسم الأمان إلا به.",
        { parse_mode: "Markdown", reply_markup: cancelKeyboard() });
    }
    return true;
  }
  if (data === "sec_pin_change") {
    setState(userId, "awaiting_security_pin_change");
    await bot2.sendMessage(chatId, "🔄 أدخل الرمز الجديد (4-8 أرقام):", { reply_markup: cancelKeyboard() });
    return true;
  }
  if (data === "sec_pin_remove") {
    saveUser(userId, { securitySettings: { ...sec, pin: null }, secUnlockedAt: 0 });
    _logActivity(userId, "🔓 إلغاء قفل PIN");
    await bot2.sendMessage(chatId, "✅ تم إلغاء قفل PIN", { reply_markup: _menuKeyboard({ ...sec, pin: null }, user) });
    return true;
  }
  if (data === "sec_pin_locknow") {
    saveUser(userId, { secUnlockedAt: 0 });
    _logActivity(userId, "🔒 قفل قسم الأمان يدوياً");
    await bot2.sendMessage(chatId, "🔒 *تم قفل قسم الأمان*\n\nسيُطلب الرمز عند الدخول التالي.", { parse_mode: "Markdown" });
    return true;
  }

  // ═══ سجل الأنشطة ═══
  if (data === "sec_log") {
    const logs = user.activityLog || [];
    const backBtn = { inline_keyboard: [[{ text: "🔙 رجوع", callback_data: "menu_security" }]] };
    if (logs.length === 0) {
      await bot2.sendMessage(chatId,
        "📝 *سجل الأنشطة*\n\n_لا توجد أنشطة بعد — سيسجَّل هنا كل تغيير في إعدادات الأمان._",
        { parse_mode: "Markdown", reply_markup: backBtn });
      return true;
    }
    const text = logs.slice(-15).reverse().map((l) => `• ${l.action}\n   _${l.date}_`).join("\n");
    await bot2.sendMessage(chatId,
      `📝 *سجل الأنشطة (آخر ${Math.min(15, logs.length)}):*\n\n${text}`,
      { parse_mode: "Markdown", reply_markup: backBtn });
    return true;
  }

  // ═══ التقرير الشامل ═══
  if (data === "sec_report") {
    const on = (v) => (v ? "✅" : "❌");
    await bot2.sendMessage(chatId,
      `📋 *التقرير الأمني الشامل*\n\n` +
      `${_scoreLine(sec, user)}\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `🔐 قفل PIN: ${on(sec.pin)}\n` +
      `👁️ إخفاء آخر ظهور: ${on(sec.hideLastSeen)}\n` +
      `✓✓ إخفاء القراءة: ${on(sec.hideReadReceipt)}\n` +
      `⌨️ إخفاء "يكتب": ${on(sec.hideTyping)}\n` +
      `🔇 رفض المكالمات: ${on(sec.rejectCalls)}\n` +
      `👻 وضع التخفي: ${on(sec.ghostMode)}\n` +
      `🖼️ صورة الملف: ${PP_LEVELS[sec.profilePicPrivacy || "all"]}\n` +
      `👥 درع المجموعات: ${GS_LEVELS[sec.groupShield || "all"]}\n` +
      `⏳ الاختفاء التلقائي: ${DISAPPEAR_LABELS[sec.disappearDuration || 0]}\n` +
      `🚨 وضع الطوارئ: ${on(sec.emergencyMode)}\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `📝 أنشطة مسجَّلة: ${(user.activityLog || []).length}\n` +
      `${sock ? "🟢 واتساب متصل" : "🔴 واتساب غير متصل"}`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🔍 المدقّق الحقيقي", callback_data: "sec_audit" }], [{ text: "🔙 رجوع", callback_data: "menu_security" }]] } });
    return true;
  }

  return false;
}
