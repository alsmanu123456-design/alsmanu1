// dist/handlers/security-handler.mjs
// Domain: Security — /security + callbacks

export const pluginManifest = {
  name: 'security',
  version: '1.0.0',
  type: 'handler',
  description: 'حماية القناة والأمان: /security + callbacks',
  textOrder: 10,
  cbOrder: 9,
  enabled: true,
};

let _deps = null;
export function setDeps(d) { _deps = d; }

export async function handleText(bot, msg) {
  if (!msg.text) return false;
  const text = msg.text;
  const chatId = msg.chat.id;

  if (text === '/security') {
    // [SEC-REBUILD] توجيه للقائمة الجديدة المبنية داخل security.mjs (مع بوابة PIN)
    const userId = String(msg.from?.id);
    await _deps.handleSecurityCallback(bot, chatId, userId, 'menu_security');
    return true;
  }
  return false;
}

export async function handleCallback(bot, query) {
  const data = query.data || '';
  const chatId = query.message?.chat.id;
  const userId = String(query.from.id);

  if (data === 'menu_security' || data.startsWith('sec_')) {
    await _deps.handleSecurityCallback(bot, chatId, userId, data);
    return true;
  }

  return false;
}
