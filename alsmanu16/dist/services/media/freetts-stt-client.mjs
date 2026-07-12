// dist/services/media/freetts-stt-client.mjs
// عميل تحويل صوت→نص عبر FreeTTS.org (نفس الـ endpoint الذي تستخدمه واجهتهم — استخدام مجهول
// عادي بدون أي انتحال هوية أو تدوير IP/عناوين، بحدود الاستخدام المجانية العادية).
// المسؤولية الوحيدة: رفع الصوت واستخراج النص المكتوب.

const BASE_URL = 'https://freetts.org';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function guessExt(mimetype) {
  const m = String(mimetype || '').toLowerCase();
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('mp4') || m.includes('m4a')) return 'mp4';
  if (m.includes('mp3') || m.includes('mpeg')) return 'mp3';
  if (m.includes('wav')) return 'wav';
  return 'webm';
}

/**
 * يحوّل صوتاً (Buffer) إلى نص عبر FreeTTS.org مع كشف اللغة تلقائياً.
 * @param {Buffer} audioBuffer
 * @param {{ mimetype?: string, language?: string }} opts
 * @returns {Promise<{ ok: true, text: string, segments: any[] } | { ok: false, error: string }>}
 */
// محاولة واحدة لطلب التفريغ — تُعيد إمّا نتيجة نهائية أو تُطلق خطأً قابلاً لإعادة المحاولة
async function _sttAttempt(audioBuffer, ext, mimetype, language) {
  const form = new FormData();
  const blob = new Blob([audioBuffer], { type: mimetype || `audio/${ext}` });
  form.append('audio', blob, `capture.${ext}`);
  form.append('language', language);
  form.append('diarization', 'false');
  form.append('durationSec', '0');

  const headers = {
    'User-Agent': BROWSER_UA,
    'Referer': `${BASE_URL}/`,
    'Origin': BASE_URL,
  };

  // مهلة صارمة لكل محاولة حتى لا تتعلّق الطلبات المعطّلة إلى ما لا نهاية
  const res = await fetch(`${BASE_URL}/api/speech-to-text`, {
    method: 'POST',
    headers,
    body: form,
    signal: AbortSignal.timeout(90000),
  });

  if (!res.ok) {
    const errJson = await res.json().catch(() => null);
    const msg = errJson?.error || errJson?.detail?.error || `HTTP ${res.status}`;
    const err = new Error(msg);
    // 5xx و 429 و 408 قابلة لإعادة المحاولة؛ غيرها أخطاء نهائية
    err._retryable = res.status >= 500 || res.status === 429 || res.status === 408;
    throw err;
  }

  const json = await res.json();
  return String(json?.transcript || '').trim();
}

/**
 * يحوّل صوتاً (Buffer) إلى نص عبر FreeTTS.org مع كشف اللغة تلقائياً.
 * موثوقية عالية: يعيد المحاولة حتى 4 مرات مع تصاعد زمني (backoff) عند
 * أخطاء الشبكة أو الأخطاء المؤقتة (5xx/429/408). هذا يضمن نجاح التفريغ
 * على الملفات الطويلة (المقسّمة لعدة أجزاء) حتى لو تعثّر جزء مؤقتاً.
 * @param {Buffer} audioBuffer
 * @param {{ mimetype?: string, language?: string }} opts
 * @returns {Promise<{ ok: true, text: string, segments: any[] } | { ok: false, error: string }>}
 */
export async function speechToText(audioBuffer, opts = {}) {
  if (!audioBuffer || !audioBuffer.length) {
    return { ok: false, error: 'لا يوجد صوت لتحويله' };
  }

  const ext = guessExt(opts.mimetype);
  const language = opts.language || 'auto';
  const MAX_ATTEMPTS = 4;
  let lastErr = 'سبب غير معروف';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const text = await _sttAttempt(audioBuffer, ext, opts.mimetype, language);
      if (!text) {
        // نص فارغ: قد يكون المقطع صامتاً فعلاً — لا فائدة من إعادة المحاولة
        return { ok: false, error: 'لم يتم التعرف على أي كلام في هذا المقطع' };
      }
      return { ok: true, text, segments: [] };
    } catch (e) {
      lastErr = String(e?.message || e);
      // خطأ نهائي (4xx غير قابل لإعادة المحاولة) — أوقف فوراً
      if (e && e._retryable === false && !/fetch|network|timeout|aborted/i.test(lastErr)) {
        return { ok: false, error: `فشل تحويل الصوت لنص: ${lastErr}` };
      }
      // خطأ مؤقت أو شبكة — أعد المحاولة مع backoff تصاعدي
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, attempt * 1500));
      }
    }
  }
  return { ok: false, error: `فشل تحويل الصوت لنص بعد ${MAX_ATTEMPTS} محاولات: ${lastErr}` };
}
