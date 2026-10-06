// سامانه ثبت و پیگیری شکایات - Cloudflare Worker + D1
// تمام مسیرهای /api/* در این فایل مدیریت می‌شوند؛ فایل‌های ثابت از پوشه public ارائه می‌شوند.

const enc = new TextEncoder();

const SESSION_DAYS = 7;
const PBKDF2_ITERATIONS = 100000; // سقف مجاز Workers
const MAX_FILE_BYTES = 1000000;   // ۱ مگابایت برای هر فایل (ذخیره در D1)
const MAX_FILES_PER_CASE = 5;
const LOGIN_WINDOW_MIN = 15;
const LOGIN_MAX_FAILS = 8;

const CATEGORIES = { services: 'SV', financial: 'FN', administrative: 'AD', technical: 'TC', behavior: 'BH', other: 'OT' };
const STATUSES = ['submitted', 'reviewing', 'answered', 'closed', 'rejected'];
const STATUS_FA = { submitted: 'ثبت‌شده', reviewing: 'در حال بررسی', answered: 'پاسخ داده‌شده', closed: 'بسته‌شده', rejected: 'رد‌شده' };

const MIME_BY_EXT = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const INLINE_MIMES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);

/* ---------------------------------- ابزارها ---------------------------------- */

class HttpError extends Error {
  constructor(status, message, fields) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}
const fail = (status, message, fields) => { throw new HttpError(status, message, fields); };

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

function b64e(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64d(b64) {
  const s = atob(b64);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}
async function sha256hex(text) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function normDigits(s) {
  return String(s ?? '')
    .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .trim();
}
function str(v, max = 500, { multiline = false } = {}) {
  if (typeof v !== 'string') return '';
  const re = multiline ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g;
  const s = v.replace(re, ' ').trim();
  return s.length > max ? s.slice(0, max + 1) : s; // یک نویسه اضافه تا سرریز تشخیص داده شود
}
function normPhone(v) {
  let s = normDigits(typeof v === 'string' ? v : '').replace(/[\s\-()]/g, '');
  if (s.startsWith('+98')) s = '0' + s.slice(3);
  else if (s.startsWith('0098')) s = '0' + s.slice(4);
  else if (/^98\d{10}$/.test(s)) s = '0' + s.slice(2);
  else if (/^9\d{9}$/.test(s)) s = '0' + s;
  return /^09\d{9}$/.test(s) ? s : null;
}
function validNationalId(code) {
  if (!/^\d{10}$/.test(code) || /^(\d)\1{9}$/.test(code)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(code[i]) * (10 - i);
  const r = sum % 11;
  const k = Number(code[9]);
  return r < 2 ? k === r : k === 11 - r;
}
function clientIp(req) {
  return req.headers.get('CF-Connecting-IP') || 'unknown';
}
async function readJson(req) {
  try {
    const b = await req.json();
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('bad');
    return b;
  } catch {
    return fail(400, 'بدنه درخواست نامعتبر است.');
  }
}
function likePattern(q) {
  return '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
}
const isUnique = (e) => /UNIQUE/i.test(String(e && e.message));

/* ------------------------------- رمز عبور و نشست ------------------------------ */

async function hashPassword(password, saltB64) {
  const salt = saltB64 ? b64d(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return { hash: b64e(new Uint8Array(bits)), salt: b64e(salt) };
}

function sessionCookie(req, token, maxAge) {
  const secure = new URL(req.url).protocol === 'https:';
  return `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

async function createSession(env, userId) {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const token = b64e(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const exp = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  await env.DB.prepare('INSERT INTO sessions(user_id, token_hash, expires_at) VALUES(?, ?, ?)')
    .bind(userId, await sha256hex(token), exp)
    .run();
  return token;
}

function readSid(req) {
  const m = /(?:^|;\s*)sid=([A-Za-z0-9_-]{20,80})/.exec(req.headers.get('Cookie') || '');
  return m ? m[1] : null;
}

async function getUser(req, env) {
  const sid = readSid(req);
  if (!sid) return null;
  const row = await env.DB.prepare(
    "SELECT u.id, u.full_name, u.phone, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > datetime('now')",
  )
    .bind(await sha256hex(sid))
    .first();
  return row || null;
}

const publicUser = (u) => ({ id: u.id, full_name: u.full_name, phone: u.phone, role: u.role });
const homeFor = (u) => (u.role === 'admin' ? '/admin.html' : '/user.html');

/* ----------------------------------- ثبت وقایع ---------------------------------- */

const eventStmt = (env, caseId, actorId, type, message, from = null, to = null) =>
  env.DB.prepare('INSERT INTO case_events(case_id, actor_id, type, message, from_status, to_status) VALUES(?, ?, ?, ?, ?, ?)').bind(
    caseId, actorId, type, message, from, to,
  );

const auditStmt = (env, req, admin, action, targetType, targetId, details) =>
  env.DB.prepare('INSERT INTO admin_audit_logs(admin_id, action, target_type, target_id, details, ip) VALUES(?, ?, ?, ?, ?, ?)').bind(
    admin.id, action, targetType, targetId, details ? String(details).slice(0, 500) : null, clientIp(req),
  );

/* ------------------------------------ کد رهگیری ----------------------------------- */

// سال شمسی + ماه میلادی + روز قمری + سال میلادی + ساعت + نوع شکایت (بدون فاصله و خط تیره)
function trackingBase(category, date = new Date()) {
  const tz = 'Asia/Tehran';
  const part = (locale, opts, type) => {
    try {
      const parts = new Intl.DateTimeFormat(locale, { timeZone: tz, ...opts }).formatToParts(date);
      const p = parts.find((x) => x.type === type) || (type === 'year' ? parts.find((x) => x.type === 'relatedYear') : null);
      return p ? p.value : null;
    } catch {
      return null;
    }
  };
  const gy = part('en-US', { year: 'numeric' }, 'year');
  const gm = part('en-US', { month: '2-digit' }, 'month');
  let hh = part('en-US', { hour: '2-digit', hourCycle: 'h23' }, 'hour');
  hh = String(Number(hh) % 24).padStart(2, '0');
  let jy = part('en-US-u-ca-persian-nu-latn', { year: 'numeric' }, 'year');
  if (!jy || !/^\d{4}$/.test(jy)) {
    const mm = Number(gm);
    const dd = Number(part('en-US', { day: 'numeric' }, 'day'));
    jy = String(Number(gy) - (mm < 3 || (mm === 3 && dd < 21) ? 622 : 621));
  }
  let hd = part('en-US-u-ca-islamic-umalqura-nu-latn', { day: 'numeric' }, 'day')
    || part('en-US-u-ca-islamic-civil-nu-latn', { day: 'numeric' }, 'day') || '0';
  hd = String(hd).padStart(2, '0');
  return `${jy}${gm}${hd}${gy}${hh}${CATEGORIES[category]}`;
}

/* --------------------------------- فایل و امضا --------------------------------- */

function cleanName(name) {
  const n = String(name || 'file').replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_').trim().slice(0, 120);
  return n || 'file';
}
function sniff(ext, b) {
  const s = (i, n) => String.fromCharCode(...b.slice(i, i + n));
  switch (ext) {
    case 'pdf': return s(0, 4) === '%PDF';
    case 'png': return b[0] === 0x89 && s(1, 3) === 'PNG';
    case 'jpg':
    case 'jpeg': return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'webp': return s(0, 4) === 'RIFF' && s(8, 4) === 'WEBP';
    case 'docx': return b[0] === 0x50 && b[1] === 0x4b;
    case 'doc': return b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;
    default: return false;
  }
}
async function readUpload(file) {
  const filename = cleanName(file.name);
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) fail(400, `فرمت فایل «${filename}» مجاز نیست (PDF، تصویر، DOC یا DOCX).`, { files: 'فرمت فایل مجاز نیست.' });
  if (file.size > MAX_FILE_BYTES) fail(413, `حجم فایل «${filename}» بیشتر از ۱ مگابایت است.`, { files: 'حجم فایل زیاد است.' });
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.length) fail(400, `فایل «${filename}» خالی است.`, { files: 'فایل خالی است.' });
  if (!sniff(ext, bytes)) fail(400, `محتوای فایل «${filename}» با پسوند آن همخوانی ندارد.`, { files: 'فایل نامعتبر است.' });
  return { filename, mime, size: bytes.length, data: b64e(bytes) };
}
const isFile = (v) => v && typeof v === 'object' && typeof v.arrayBuffer === 'function';

function readSignature(v) {
  const bad = () => fail(400, 'امضای ثبت‌شده نامعتبر است. لطفاً دوباره امضا کنید.', { signature: 'امضا الزامی است.' });
  if (typeof v !== 'string' || !v.startsWith('data:image/png;base64,')) bad();
  if (v.length > 500000) fail(413, 'حجم امضا زیاد است.', { signature: 'حجم امضا زیاد است.' });
  let bytes;
  try { bytes = b64d(v.slice(22)); } catch { bad(); }
  if (bytes.length < 100 || bytes[0] !== 0x89 || bytes[1] !== 0x50) bad();
  return v;
}

/* ------------------------------------ احراز هویت ------------------------------------ */

async function register(req, env) {
  const b = await readJson(req);
  const fields = {};
  const full_name = str(b.full_name, 80);
  const phone = normPhone(b.phone);
  const password = typeof b.password === 'string' ? b.password : '';
  if (full_name.length < 3 || full_name.length > 80 || full_name.split(/\s+/).length < 2) fields.full_name = 'نام و نام خانوادگی را کامل وارد کنید.';
  if (!phone) fields.phone = 'شماره تلفن همراه معتبر نیست (مثال: 09123456789).';
  if (password.length < 8 || password.length > 128) fields.password = 'رمز عبور باید حداقل ۸ نویسه باشد.';
  else if (!/[A-Za-z\u0600-\u06FF]/.test(password) || !/\d/.test(password)) fields.password = 'رمز عبور باید شامل حرف و عدد باشد.';
  if (b.password_confirm !== password) fields.password_confirm = 'تکرار رمز عبور با رمز عبور یکسان نیست.';
  if (b.accept_terms !== true) fields.accept_terms = 'برای ثبت‌نام باید قوانین را بپذیرید.';
  if (Object.keys(fields).length) fail(400, 'اطلاعات واردشده را بررسی کنید.', fields);

  const exists = await env.DB.prepare('SELECT id FROM users WHERE phone = ?').bind(phone).first();
  if (exists) fail(409, 'این شماره قبلاً ثبت‌نام کرده است. وارد شوید.', { phone: 'این شماره قبلاً ثبت‌نام شده است.' });

  const { hash, salt } = await hashPassword(password);
  let id;
  try {
    // نقش همیشه 'user' است؛ هرگز از ورودی کاربر خوانده نمی‌شود.
    const res = await env.DB.prepare("INSERT INTO users(full_name, phone, password_hash, password_salt, role) VALUES(?, ?, ?, ?, 'user')")
      .bind(full_name, phone, hash, salt)
      .run();
    id = res.meta.last_row_id;
  } catch (e) {
    if (isUnique(e)) fail(409, 'این شماره قبلاً ثبت‌نام کرده است.', { phone: 'این شماره قبلاً ثبت‌نام شده است.' });
    throw e;
  }
  const user = { id, full_name, phone, role: 'user' };
  const token = await createSession(env, id);
  return json({ ok: true, user: publicUser(user), redirect: homeFor(user) }, 201, {
    'Set-Cookie': sessionCookie(req, token, SESSION_DAYS * 86400),
  });
}

async function login(req, env) {
  const b = await readJson(req);
  const phone = normPhone(b.phone);
  const password = typeof b.password === 'string' ? b.password : '';
  if (!phone || !password) fail(400, 'شماره تلفن و رمز عبور را وارد کنید.', { phone: !phone ? 'شماره تلفن معتبر نیست.' : undefined, password: !password ? 'رمز عبور را وارد کنید.' : undefined });

  const key = `${phone}|${clientIp(req)}`;
  const recent = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM login_attempts WHERE key = ? AND created_at > datetime('now', '-${LOGIN_WINDOW_MIN} minutes')`,
  ).bind(key).first();
  if (recent && recent.n >= LOGIN_MAX_FAILS) fail(429, 'تعداد تلاش‌های ناموفق زیاد است. چند دقیقه بعد دوباره تلاش کنید.');

  const row = await env.DB.prepare('SELECT id, full_name, phone, role, password_hash, password_salt FROM users WHERE phone = ?').bind(phone).first();
  // برای یکسان‌سازی زمان پاسخ، در هر حال هش محاسبه می‌شود
  const calc = await hashPassword(password, row ? row.password_salt : b64e(new Uint8Array(16)));
  if (!row || !safeEqual(calc.hash, row.password_hash)) {
    await env.DB.prepare('INSERT INTO login_attempts(key) VALUES(?)').bind(key).run();
    fail(401, 'شماره تلفن یا رمز عبور اشتباه است.');
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM login_attempts WHERE key = ?').bind(key),
    env.DB.prepare("DELETE FROM login_attempts WHERE created_at < datetime('now', '-1 day')"),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')"),
  ]);
  const user = { id: row.id, full_name: row.full_name, phone: row.phone, role: row.role };
  const token = await createSession(env, row.id);
  return json({ ok: true, user: publicUser(user), redirect: homeFor(user) }, 200, {
    'Set-Cookie': sessionCookie(req, token, SESSION_DAYS * 86400),
  });
}

async function logout(req, env) {
  const sid = readSid(req);
  if (sid) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256hex(sid)).run();
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(req, '', 0) });
}

/* --------------------------------------- پرونده‌ها --------------------------------------- */

async function createCase(req, env, user) {
  let fd;
  try { fd = await req.formData(); } catch { fail(400, 'فرم ارسال‌شده نامعتبر است.'); }
  const fields = {};

  const filed_for = str(fd.get('filed_for') || '', 10);
  if (!['self', 'other'].includes(filed_for)) fields.filed_for = 'نوع ثبت را انتخاب کنید.';

  let complainant_name = user.full_name;
  let complainant_phone = user.phone;
  let complainant_national_id = null;
  if (filed_for === 'other') {
    complainant_name = str(fd.get('other_name') || '', 80);
    complainant_phone = normPhone(fd.get('other_phone') || '');
    complainant_national_id = normDigits(str(fd.get('other_national_id') || '', 20));
    if (complainant_name.length < 3 || complainant_name.split(/\s+/).length < 2) fields.other_name = 'نام و نام خانوادگی را کامل وارد کنید.';
    if (!complainant_phone) fields.other_phone = 'شماره تلفن معتبر نیست.';
    if (!validNationalId(complainant_national_id)) fields.other_national_id = 'کد ملی معتبر نیست (۱۰ رقم).';
  } else {
    const nid = normDigits(str(fd.get('other_national_id') || '', 20));
    if (nid) complainant_national_id = validNationalId(nid) ? nid : (fields.other_national_id = 'کد ملی معتبر نیست.', null);
  }

  const category = str(fd.get('category') || '', 30);
  if (!CATEGORIES[category]) fields.category = 'دسته‌بندی را انتخاب کنید.';
  const against_name = str(fd.get('against_name') || '', 120) || null;
  if (against_name && against_name.length > 120) fields.against_name = 'حداکثر ۱۲۰ نویسه.';
  const subject = str(fd.get('subject') || '', 150);
  if (subject.length < 3 || subject.length > 150) fields.subject = 'موضوع باید بین ۳ تا ۱۵۰ نویسه باشد.';
  const description = str(fd.get('description') || '', 5000, { multiline: true });
  if (description.length < 10 || description.length > 5000) fields.description = 'شرح شکایت باید بین ۱۰ تا ۵۰۰۰ نویسه باشد.';

  let signature = null;
  try { signature = readSignature(fd.get('signature')); } catch (e) { if (e instanceof HttpError) Object.assign(fields, e.fields || { signature: e.message }); else throw e; }

  const files = fd.getAll('files').filter((f) => isFile(f) && f.size > 0);
  if (files.length > MAX_FILES_PER_CASE) fields.files = `حداکثر ${MAX_FILES_PER_CASE} فایل مجاز است.`;
  if (Object.keys(fields).length) fail(400, 'اطلاعات واردشده را بررسی کنید.', fields);

  const uploads = [];
  for (const f of files) uploads.push(await readUpload(f));

  // درج پرونده با کد رهگیری یکتا (در صورت تکرار، شماره ترتیبی به انتهای کد افزوده می‌شود)
  const base = trackingBase(category);
  let caseId = null;
  let code = base;
  for (let n = 0; n < 50 && !caseId; n++) {
    code = n === 0 ? base : base + String(n + 1);
    try {
      const res = await env.DB.prepare(
        `INSERT INTO cases(tracking_code, user_id, filed_for, complainant_name, complainant_phone, complainant_national_id,
           against_name, category, subject, description, signature)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(code, user.id, filed_for, complainant_name, complainant_phone, complainant_national_id, against_name, category, subject, description, signature).run();
      caseId = res.meta.last_row_id;
    } catch (e) {
      if (!isUnique(e)) throw e;
    }
  }
  if (!caseId) fail(503, 'ثبت پرونده با خطا مواجه شد. دوباره تلاش کنید.');

  try {
    for (const u of uploads) {
      await env.DB.prepare('INSERT INTO attachments(case_id, uploaded_by, kind, filename, mime, size, data) VALUES(?, ?, ?, ?, ?, ?, ?)')
        .bind(caseId, user.id, 'complaint_file', u.filename, u.mime, u.size, u.data).run();
    }
    await eventStmt(env, caseId, user.id, 'created', uploads.length ? `پرونده با ${uploads.length} پیوست ثبت شد.` : 'پرونده ثبت شد.').run();
  } catch (e) {
    await env.DB.prepare('DELETE FROM cases WHERE id = ?').bind(caseId).run();
    throw e;
  }
  return json({ ok: true, case: { id: caseId, tracking_code: code } }, 201);
}

async function caseDetail(env, id) {
  const c = await env.DB.prepare(
    'SELECT c.*, u.full_name AS owner_name, u.phone AS owner_phone FROM cases c JOIN users u ON u.id = c.user_id WHERE c.id = ?',
  ).bind(id).first();
  if (!c) return null;
  const [events, attachments, notifications] = await Promise.all([
    env.DB.prepare(
      `SELECT e.id, e.type, e.message, e.from_status, e.to_status, e.created_at, u.full_name AS actor_name, u.role AS actor_role
       FROM case_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.case_id = ? ORDER BY e.id`,
    ).bind(id).all(),
    env.DB.prepare(
      `SELECT a.id, a.kind, a.filename, a.mime, a.size, a.created_at, u.full_name AS uploader
       FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by WHERE a.case_id = ? ORDER BY a.id`,
    ).bind(id).all(),
    env.DB.prepare(
      'SELECT id, case_id, title, body, requires_confirmation, created_at, viewed_at, confirmed_at FROM notifications WHERE case_id = ? ORDER BY id DESC',
    ).bind(id).all(),
  ]);
  return { case: c, events: events.results, attachments: attachments.results, notifications: notifications.results };
}

async function downloadAttachment(req, env, user, id, url) {
  const a = await env.DB.prepare(
    'SELECT a.filename, a.mime, a.data, c.user_id AS owner FROM attachments a JOIN cases c ON c.id = a.case_id WHERE a.id = ?',
  ).bind(id).first();
  if (!a || (user.role !== 'admin' && a.owner !== user.id)) fail(404, 'فایل یافت نشد.');
  const inline = url.searchParams.get('inline') === '1' && INLINE_MIMES.has(a.mime);
  const encoded = encodeURIComponent(a.filename);
  return new Response(b64d(a.data), {
    headers: {
      'Content-Type': a.mime,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encoded}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
    },
  });
}

/* --------------------------------------- اعلان‌ها --------------------------------------- */

async function notificationAction(env, user, id, action) {
  const n = await env.DB.prepare('SELECT id, case_id, requires_confirmation, viewed_at, confirmed_at FROM notifications WHERE id = ? AND user_id = ?')
    .bind(id, user.id).first();
  if (!n) fail(404, 'اعلان یافت نشد.');
  const stmts = [];
  if (action === 'view') {
    if (!n.viewed_at) {
      stmts.push(env.DB.prepare("UPDATE notifications SET viewed_at = datetime('now') WHERE id = ? AND user_id = ?").bind(id, user.id));
      stmts.push(eventStmt(env, n.case_id, user.id, 'notification_viewed', 'ابلاغیه مشاهده شد.'));
    }
  } else {
    if (!n.requires_confirmation) fail(400, 'این اعلان نیاز به تأیید ندارد.');
    if (!n.confirmed_at) {
      stmts.push(env.DB.prepare("UPDATE notifications SET confirmed_at = datetime('now'), viewed_at = COALESCE(viewed_at, datetime('now')) WHERE id = ? AND user_id = ?").bind(id, user.id));
      stmts.push(eventStmt(env, n.case_id, user.id, 'notification_confirmed', 'دریافت ابلاغیه تأیید شد.'));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  const fresh = await env.DB.prepare('SELECT id, viewed_at, confirmed_at FROM notifications WHERE id = ?').bind(id).first();
  return json({ ok: true, notification: fresh });
}

/* ------------------------------------------ مدیریت ------------------------------------------ */

async function adminStats(env) {
  const [byStatus, users] = await Promise.all([
    env.DB.prepare('SELECT status, COUNT(*) AS n FROM cases GROUP BY status').all(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM users').first(),
  ]);
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  let total = 0;
  for (const r of byStatus.results) { counts[r.status] = r.n; total += r.n; }
  return json({ ok: true, total, by_status: counts, users: users.n });
}

async function adminListCases(env, url) {
  const q = normDigits(url.searchParams.get('q') || '').toUpperCase().slice(0, 60);
  const status = url.searchParams.get('status') || '';
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const limit = 20;
  const where = [];
  const args = [];
  if (q) {
    const like = likePattern(q);
    where.push("(c.tracking_code LIKE ? ESCAPE '\\' OR c.complainant_name LIKE ? ESCAPE '\\' OR c.complainant_phone LIKE ? ESCAPE '\\' OR c.subject LIKE ? ESCAPE '\\')");
    args.push(like, like, like, like);
  }
  if (status) {
    if (!STATUSES.includes(status)) fail(400, 'وضعیت نامعتبر است.');
    where.push('c.status = ?');
    args.push(status);
  }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const [rows, total] = await Promise.all([
    env.DB.prepare(
      `SELECT c.id, c.tracking_code, c.subject, c.category, c.status, c.created_at, c.complainant_name, u.full_name AS owner_name
       FROM cases c JOIN users u ON u.id = c.user_id ${w} ORDER BY c.id DESC LIMIT ? OFFSET ?`,
    ).bind(...args, limit, (page - 1) * limit).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM cases c ${w}`).bind(...args).first(),
  ]);
  return json({ ok: true, cases: rows.results, total: total.n, page, pages: Math.max(1, Math.ceil(total.n / limit)) });
}

async function adminSetStatus(req, env, admin, id) {
  const b = await readJson(req);
  const status = str(b.status, 30);
  const note = str(b.note, 1000, { multiline: true });
  if (!STATUSES.includes(status)) fail(400, 'وضعیت نامعتبر است.', { status: 'وضعیت نامعتبر است.' });
  if (note.length > 1000) fail(400, 'توضیح حداکثر ۱۰۰۰ نویسه است.', { note: 'حداکثر ۱۰۰۰ نویسه.' });
  const c = await env.DB.prepare('SELECT id, user_id, status, tracking_code FROM cases WHERE id = ?').bind(id).first();
  if (!c) fail(404, 'پرونده یافت نشد.');
  if (c.status === status) fail(400, 'پرونده هم‌اکنون در همین وضعیت است.', { status: 'وضعیت جدید را انتخاب کنید.' });
  const message = note || `وضعیت از «${STATUS_FA[c.status]}» به «${STATUS_FA[status]}» تغییر کرد.`;
  await env.DB.batch([
    env.DB.prepare("UPDATE cases SET status = ?, updated_at = datetime('now') WHERE id = ?").bind(status, id),
    eventStmt(env, id, admin.id, 'status_changed', message, c.status, status),
    env.DB.prepare('INSERT INTO notifications(case_id, user_id, created_by, title, body, requires_confirmation) VALUES(?, ?, ?, ?, ?, 0)').bind(
      id, c.user_id, admin.id, `تغییر وضعیت پرونده ${c.tracking_code}`,
      `وضعیت پرونده شما به «${STATUS_FA[status]}» تغییر کرد.` + (note ? `\nتوضیح: ${note}` : ''),
    ),
    auditStmt(env, req, admin, 'case.status_changed', 'case', id, `${c.status} -> ${status}${note ? ' | ' + note : ''}`),
  ]);
  return json({ ok: true });
}

async function adminSendNotification(req, env, admin, id) {
  const b = await readJson(req);
  const title = str(b.title, 120);
  const body = str(b.body, 2000, { multiline: true });
  const fields = {};
  if (title.length < 3 || title.length > 120) fields.title = 'عنوان باید بین ۳ تا ۱۲۰ نویسه باشد.';
  if (body.length < 3 || body.length > 2000) fields.body = 'متن باید بین ۳ تا ۲۰۰۰ نویسه باشد.';
  if (Object.keys(fields).length) fail(400, 'اطلاعات واردشده را بررسی کنید.', fields);
  const requires = b.requires_confirmation === true ? 1 : 0;
  const c = await env.DB.prepare('SELECT id, user_id FROM cases WHERE id = ?').bind(id).first();
  if (!c) fail(404, 'پرونده یافت نشد.');
  await env.DB.batch([
    env.DB.prepare('INSERT INTO notifications(case_id, user_id, created_by, title, body, requires_confirmation) VALUES(?, ?, ?, ?, ?, ?)').bind(id, c.user_id, admin.id, title, body, requires),
    eventStmt(env, id, admin.id, 'notification_sent', `ابلاغیه ارسال شد: ${title}`),
    auditStmt(env, req, admin, 'case.notification_sent', 'case', id, title),
  ]);
  return json({ ok: true }, 201);
}

async function adminAddAttachment(req, env, admin, id) {
  let fd;
  try { fd = await req.formData(); } catch { fail(400, 'فرم ارسال‌شده نامعتبر است.'); }
  const file = fd.get('file');
  if (!isFile(file) || !file.size) fail(400, 'یک فایل انتخاب کنید.', { file: 'فایل را انتخاب کنید.' });
  const note = str(fd.get('note') || '', 500, { multiline: true });
  const c = await env.DB.prepare('SELECT id, user_id, tracking_code FROM cases WHERE id = ?').bind(id).first();
  if (!c) fail(404, 'پرونده یافت نشد.');
  const up = await readUpload(file).catch((e) => { if (e instanceof HttpError) e.fields = { file: e.message }; throw e; });
  const res = await env.DB.prepare('INSERT INTO attachments(case_id, uploaded_by, kind, filename, mime, size, data) VALUES(?, ?, ?, ?, ?, ?, ?)')
    .bind(id, admin.id, 'petition', up.filename, up.mime, up.size, up.data).run();
  await env.DB.batch([
    eventStmt(env, id, admin.id, 'attachment_added', `شکواییه/دادخواست به پرونده افزوده شد: ${up.filename}${note ? ' | ' + note : ''}`),
    env.DB.prepare('INSERT INTO notifications(case_id, user_id, created_by, title, body, requires_confirmation) VALUES(?, ?, ?, ?, ?, 0)').bind(
      id, c.user_id, admin.id, `فایل جدید در پرونده ${c.tracking_code}`,
      `شکواییه/دادخواست «${up.filename}» به پرونده شما افزوده شد.` + (note ? `\nتوضیح: ${note}` : ''),
    ),
    auditStmt(env, req, admin, 'case.attachment_added', 'case', id, up.filename),
  ]);
  return json({ ok: true, attachment_id: res.meta.last_row_id }, 201);
}

async function adminAudit(env) {
  const rows = await env.DB.prepare(
    `SELECT l.id, l.action, l.target_type, l.target_id, l.details, l.created_at, u.full_name AS admin_name
     FROM admin_audit_logs l LEFT JOIN users u ON u.id = l.admin_id ORDER BY l.id DESC LIMIT 100`,
  ).all();
  return json({ ok: true, logs: rows.results });
}

/* ------------------------------------------- مسیریابی ------------------------------------------- */

async function handle(req, env, url) {
  const method = req.method;
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (method !== 'GET' && method !== 'HEAD') {
    const origin = req.headers.get('Origin');
    if ((origin && origin !== url.origin) || req.headers.get('X-Requested-With') !== 'fetch') fail(403, 'درخواست نامعتبر است.');
  }

  if (path === '/api/auth/register' && method === 'POST') return register(req, env);
  if (path === '/api/auth/login' && method === 'POST') return login(req, env);
  if (path === '/api/auth/logout' && method === 'POST') return logout(req, env);

  const user = await getUser(req, env);
  if (!user) fail(401, 'برای ادامه وارد حساب خود شوید.');

  if (path === '/api/auth/me' && method === 'GET') return json({ ok: true, user: publicUser(user) });

  if (path === '/api/user/summary' && method === 'GET') {
    const [cs, un] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS total, SUM(status = 'reviewing') AS reviewing, SUM(status = 'answered') AS answered FROM cases WHERE user_id = ?").bind(user.id).first(),
      env.DB.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND viewed_at IS NULL').bind(user.id).first(),
    ]);
    return json({ ok: true, user: publicUser(user), total: cs.total || 0, reviewing: cs.reviewing || 0, answered: cs.answered || 0, unread: un.n || 0 });
  }

  if (path === '/api/cases' && method === 'GET') {
    const rows = await env.DB.prepare('SELECT id, tracking_code, subject, category, status, created_at FROM cases WHERE user_id = ? ORDER BY id DESC LIMIT 200').bind(user.id).all();
    return json({ ok: true, cases: rows.results });
  }
  if (path === '/api/cases' && method === 'POST') return createCase(req, env, user);

  let m = /^\/api\/cases\/(\d+)$/.exec(path);
  if (m && method === 'GET') {
    const d = await caseDetail(env, Number(m[1]));
    if (!d || d.case.user_id !== user.id) fail(404, 'پرونده یافت نشد.');
    delete d.case.user_id;
    return json({ ok: true, ...d });
  }

  m = /^\/api\/attachments\/(\d+)$/.exec(path);
  if (m && method === 'GET') return downloadAttachment(req, env, user, Number(m[1]), url);

  if (path === '/api/notifications' && method === 'GET') {
    const rows = await env.DB.prepare(
      `SELECT n.id, n.case_id, c.tracking_code, n.title, n.body, n.requires_confirmation, n.created_at, n.viewed_at, n.confirmed_at
       FROM notifications n JOIN cases c ON c.id = n.case_id WHERE n.user_id = ? ORDER BY n.id DESC LIMIT 100`,
    ).bind(user.id).all();
    return json({ ok: true, notifications: rows.results });
  }
  m = /^\/api\/notifications\/(\d+)\/(view|confirm)$/.exec(path);
  if (m && method === 'POST') return notificationAction(env, user, Number(m[1]), m[2]);

  if (path.startsWith('/api/admin/')) {
    if (user.role !== 'admin') fail(403, 'دسترسی غیرمجاز.');
    if (path === '/api/admin/stats' && method === 'GET') return adminStats(env);
    if (path === '/api/admin/cases' && method === 'GET') return adminListCases(env, url);
    if (path === '/api/admin/audit' && method === 'GET') return adminAudit(env);

    m = /^\/api\/admin\/cases\/(\d+)$/.exec(path);
    if (m && method === 'GET') {
      const id = Number(m[1]);
      const d = await caseDetail(env, id);
      if (!d) fail(404, 'پرونده یافت نشد.');
      await auditStmt(env, req, user, 'case.viewed', 'case', id, d.case.tracking_code).run();
      return json({ ok: true, ...d });
    }
    m = /^\/api\/admin\/cases\/(\d+)\/(status|notifications|attachments)$/.exec(path);
    if (m && method === 'POST') {
      const id = Number(m[1]);
      if (m[2] === 'status') return adminSetStatus(req, env, user, id);
      if (m[2] === 'notifications') return adminSendNotification(req, env, user, id);
      return adminAddAttachment(req, env, user, id);
    }
  }

  return fail(404, 'مسیر درخواستی وجود ندارد.');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      return await handle(req, env, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ ok: false, error: e.message, fields: e.fields }, e.status);
      console.error(e);
      return json({ ok: false, error: 'خطای داخلی سرور. دوباره تلاش کنید.' }, 500);
    }
  },
};

export { trackingBase, normPhone, validNationalId };
