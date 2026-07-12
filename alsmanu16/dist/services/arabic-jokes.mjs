// ═══════════════════════════════════════════════════════════════
//  جالب النكت العربية العشوائية
//  يسحب نكتة عشوائية من مصادر عربية على الإنترنت، ويرجع لقائمة
//  احتياطية محلية موسّعة عند فشل كل المصادر — لضمان عدم فشل الأمر أبداً.
// ═══════════════════════════════════════════════════════════════

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36 WhatsAppBot/1.0";

// عدد صفوف مجموعة النكت العربية على Hugging Face (ثابتة)
const HF_JOKES_DATASET = "FatimahEmadEldin/arabic-ocr-jokes";
const HF_JOKES_ROWS = 510;

function clean(t) {
  return String(t || "")
    .replace(/\s+/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .trim();
}

// ── المصدر 1: مجموعة نكت عربية على Hugging Face (JSON موثوق) ──
async function fromHuggingFace() {
  const offset = Math.floor(Math.random() * HF_JOKES_ROWS);
  const url =
    `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(HF_JOKES_DATASET)}` +
    `&config=default&split=train&offset=${offset}&length=1`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`HF HTTP ${res.status}`);
  const json = await res.json();
  const row = json?.rows?.[0]?.row || {};
  const text = clean(row.Joke_Text || row.joke || row.text || Object.values(row)[0]);
  if (!text || text.length < 6) throw new Error("HF empty");
  return text;
}

// ── المصدر 2: نكت عربية من مستودع بيانات عام (JSON خام) ──
async function fromRawDataset() {
  const url =
    "https://raw.githubusercontent.com/alaeddine-13/arabic-jokes/master/jokes.json";
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`raw HTTP ${res.status}`);
  const arr = await res.json();
  if (!Array.isArray(arr) || arr.length === 0) throw new Error("raw empty");
  const pick = arr[Math.floor(Math.random() * arr.length)];
  const text = clean(typeof pick === "string" ? pick : pick?.joke || pick?.text);
  if (!text || text.length < 6) throw new Error("raw bad");
  return text;
}

// ── قائمة احتياطية محلية موسّعة (تعمل بدون إنترنت) ──
const LOCAL_JOKES = [
  "واحد بخيل اشترى مروحة بدون ريش، سألوه ليش؟ قال: عشان الهوا يطلع مجاناً بس التبريد بفلوس!",
  "معلم سأل تلميذ: لو عندك 10 ريال وطلبت من أبوك 10، كم يصير معك؟ قال: 10! قال المعلم: أنت ما تعرف حساب! قال: وأنت ما تعرف أبوي!",
  "واحد راح للدكتور قال له: كل ما أشرب قهوة يوجعني عيني! قال الدكتور: جرّب تشيل الملعقة من الكوب.",
  "مرة واحد غبي وقف قدام المرايا وسكّر عينه عشان يعرف شكله وهو نايم.",
  "سألوا نكتة: ليش الدجاجة عبرت الشارع؟ عشان توصل الجهة الثانية… النكتة إنك ضحكت!",
  "واحد بخيل دخل مطعم، طلب كأس ماء، حطّ فيه كاتشب مجاني، وقال: شوربة طماطم على البيت!",
  "معلم: اكتب جملة فيها كلمة (لكن). الطالب: أكلت التفاحة… لكن!",
  "واحد نسي وين ركن سيارته، فتّش ساعتين، طلع راكب تكسي أصلاً.",
  "واحد قال لصاحبه: عندي خبر حلو وخبر سيء. قال: ابدأ بالحلو. قال: ما في خبر سيء! هذا هو الحلو.",
  "سألوا الغبي: كم الساعة؟ قال: ما أعرف، الساعة تتغير كل دقيقة!",
  "واحد كسلان جداً، حط المنبّه في المطبخ عشان يضطر يقوم يمشي عشان يطفّيه… نام في المطبخ.",
  "واحد راح يشتري نظارة، قال للبائع: أبي وحدة أشوف فيها المستقبل. قال البائع: هذي تسمى (فلوس)، اشتغل بها!",
  "طفل قال لأمه: تعرفين إني ذكي؟ قالت: منين؟ قال: المعلم قال أنا استثناء… يعني مو مثل البقية!",
  "واحد بخيل عزم صاحبه على الغدا، لما جا الحساب قال: خلّينا نتقاسم الذكريات.",
  "سائق تكسي سأل الراكب: على طول؟ قال الراكب: لا، على حسب المزاج!",
];

function localJoke() {
  return LOCAL_JOKES[Math.floor(Math.random() * LOCAL_JOKES.length)];
}

/**
 * تُرجع نكتة عربية عشوائية كنص. تجرّب المصادر عبر الإنترنت بالترتيب،
 * ثم ترجع لقائمة محلية عند الفشل — لا تفشل أبداً.
 * @returns {Promise<string>}
 */
export async function getRandomArabicJoke() {
  const sources = [fromHuggingFace, fromRawDataset];
  // نبعثر ترتيب المصادر لتنويع النتائج
  sources.sort(() => Math.random() - 0.5);
  for (const src of sources) {
    try {
      const joke = await src();
      if (joke) return joke;
    } catch {
      /* جرّب المصدر التالي */
    }
  }
  return localJoke();
}
